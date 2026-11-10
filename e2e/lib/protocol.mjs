// WristKey e2e — 同步协议 v3 参考实现（手机端状态机 + 手环端接收状态机 + 入口图案消息）。
// 依据 docs/protocol.md（v3）独立实现，用于夹具生成与协议合法性校验。
//
// 依据 docs/protocol.md 的校验规则与“确定性约定”：
//   - 手环端解析 mfa_sync_begin/account/commit 接受 version ∈ {2, 3}；pin 消息仅接受 version == 3；
//   - 未知 type / 不在支持范围的 version → 忽略（不计错误、不清 staging）；
//   - 非法 begin（syncId 空/超长、accountCount 非 0-500 整数）→ 忽略，保留旧 staging；
//   - 收到 account 时校验 staging 超时（默认 120s 无新消息 → 丢弃 staging，不计错误）；
//   - account 字段违反校验规则（含 Steam 固定 5/30/SHA1、otpType 取值、v3 password）→ 丢弃并计入 errors；
//   - 同一 index 重复发送 → 后到覆盖先到（duplicate_index，不算失败）；
//     同一 account.id 出现在不同 index → 丢弃后到者；
//   - otpType：缺省 totp；steam 为 5 位字母数字码（Steam Guard，见 docs/protocol.md）；
//   - commit 校验 syncId / accountCount / 已暂存条数；失败原因码
//     no_active_begin / sync_id_mismatch / account_count_mismatch / incomplete_sync；
//     失败 → 丢弃 staging，旧快照不变。
//   - 密码合并：同一 account.id 再次同步时 password 缺省 = 保留旧值，显式 "" = 清空。
//     参考实现中 v2 同步没有 password 字段，等价于缺省 → 保留手环上已有密码（见 e2e/README.md）。
//   - 快照：v3 手环写 mfa_snapshot_v3（storageKey），v2 同步也写入同一活动快照，
//     snapshot.version 记录来源协议版本（v2/v3），便于兼容性断言。

import { createHash, pbkdf2Sync } from 'node:crypto';

import { normalizeProtocolSecret, isValidProtocolSecret } from './encoding.mjs';

export const PROTOCOL_VERSION = 3;
export const LEGACY_PROTOCOL_VERSION = 2;
/** 手环/手机解析同步消息时接受的版本（兼容矩阵）。 */
export const SYNC_VERSIONS = [LEGACY_PROTOCOL_VERSION, PROTOCOL_VERSION];
export const PIN_MESSAGE_VERSION = 3;
export const MAX_MESSAGE_BYTES = 1024;
export const STAGING_TIMEOUT_MS = 120000;
export const ACK_TIMEOUT_MS = 8000;
export const DEFAULT_CATEGORY = '默认分类';
export const ALGORITHM_NAMES = ['SHA1', 'SHA256', 'SHA512'];
export const OTP_TYPES = ['totp', 'steam'];
export const MAX_ACCOUNT_COUNT = 500;
export const STEAM_DIGITS = 5;
export const STEAM_PERIOD = 30;
export const MAX_PASSWORD_LENGTH = 128;

export const SNAPSHOT_KEY_V2 = 'mfa_snapshot_v2';
export const SNAPSHOT_KEY_V3 = 'mfa_snapshot_v3';
export const PIN_STORAGE_KEY = 'wristkey_pin_v1';

export const PIN_ALGORITHM = 'PBKDF2-SHA256';
export const PIN_SALT_HEX_LENGTH = 32;
export const PIN_HASH_HEX_LENGTH = 64;
export const PIN_ITERATIONS_MIN = 1000;
export const PIN_ITERATIONS_MAX = 20000;
export const PIN_ITERATIONS_DEFAULT = 1200;
export const PIN_PATTERN_REGEX = /^[TSC]{5}$/;

export const PIN_ACK_ERRORS = ['invalid_pin_payload', 'invalid_version', 'storage_error'];
export const SYNC_ACK_ERRORS = [
  'no_active_begin',
  'sync_id_mismatch',
  'account_count_mismatch',
  'incomplete_sync'
];

export const MESSAGE_TYPES = Object.freeze({
  BEGIN: 'mfa_sync_begin',
  ACCOUNT: 'mfa_sync_account',
  COMMIT: 'mfa_sync_commit',
  ACK: 'mfa_sync_ack',
  REQUEST: 'mfa_sync_request',
  PIN_SET: 'mfa_pin_set',
  PIN_QUERY: 'mfa_pin_query',
  PIN_CLEAR: 'mfa_pin_clear',
  PIN_ACK: 'mfa_pin_ack',
  PIN_STATE: 'mfa_pin_state'
});

export function messageBytes(message) {
  return Buffer.byteLength(JSON.stringify(message), 'utf8');
}

export function isMessageWithinSizeLimit(message) {
  return messageBytes(message) < MAX_MESSAGE_BYTES;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isInteger(value) {
  return typeof value === 'number' && Number.isInteger(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isLowerHex(value, length) {
  return typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value);
}

/** 手环端 account 校验与归一化。返回 {ok:true, account} 或 {ok:false, reason}。
 * options.version：消息协议版本；v2 消息忽略 password 字段（视为无密码），v3 才校验。
 */
export function validateAccount(raw, index, options) {
  const opts = options || {};
  const allowPassword = opts.version === undefined ? true : opts.version >= PROTOCOL_VERSION;

  if (!isPlainObject(raw)) {
    return { ok: false, reason: 'account 不是对象' };
  }

  let id;
  const rawId = raw.id;
  if (rawId === undefined || rawId === null || rawId === '') {
    id = 'idx_' + String(index);
  } else if (typeof rawId !== 'string') {
    return { ok: false, reason: 'id 不是字符串' };
  } else if (rawId.length > 64) {
    return { ok: false, reason: 'id 超过 64 字符' };
  } else {
    id = rawId;
  }

  const issuer = raw.issuer == null ? '' : raw.issuer;
  const accountName = raw.accountName == null ? '' : raw.accountName;
  if (typeof issuer !== 'string' || typeof accountName !== 'string') {
    return { ok: false, reason: 'issuer / accountName 不是字符串' };
  }
  if (issuer.length > 64 || accountName.length > 64) {
    return { ok: false, reason: 'issuer / accountName 超过 64 字符' };
  }
  if (issuer.trim() === '' && accountName.trim() === '') {
    return { ok: false, reason: 'issuer 与 accountName 同时为空' };
  }

  let category = DEFAULT_CATEGORY;
  if (raw.category !== undefined && raw.category !== null && raw.category !== '') {
    if (typeof raw.category !== 'string') {
      return { ok: false, reason: 'category 不是字符串' };
    }
    if (raw.category.length > 32) {
      return { ok: false, reason: 'category 超过 32 字符' };
    }
    category = raw.category;
  }

  if (typeof raw.secret !== 'string' || !isValidProtocolSecret(raw.secret)) {
    return { ok: false, reason: 'secret 不是合法 Base32（A-Z2-7，可含空格/=）' };
  }
  const secret = normalizeProtocolSecret(raw.secret);

  let otpType = 'totp';
  if (raw.otpType !== undefined && raw.otpType !== null) {
    if (typeof raw.otpType !== 'string' || OTP_TYPES.indexOf(raw.otpType.toLowerCase()) < 0) {
      return { ok: false, reason: 'otpType 不是 totp/steam' };
    }
    otpType = raw.otpType.toLowerCase();
  }

  let algorithm;
  let digits;
  let period;
  if (otpType === 'steam') {
    // Steam Guard：固定 SHA1 / 5 位字母数字 / 30s；显式给出其它值视为非法
    if (raw.algorithm !== undefined && raw.algorithm !== null) {
      if (typeof raw.algorithm !== 'string' || raw.algorithm.toUpperCase() !== 'SHA1') {
        return { ok: false, reason: 'steam 账号 algorithm 固定 SHA1' };
      }
    }
    if (raw.digits !== undefined && raw.digits !== null && raw.digits !== STEAM_DIGITS) {
      return { ok: false, reason: 'steam 账号 digits 固定 5' };
    }
    if (raw.period !== undefined && raw.period !== null && raw.period !== STEAM_PERIOD) {
      return { ok: false, reason: 'steam 账号 period 固定 30' };
    }
    algorithm = 'SHA1';
    digits = STEAM_DIGITS;
    period = STEAM_PERIOD;
  } else {
    algorithm = 'SHA1';
    if (raw.algorithm !== undefined && raw.algorithm !== null) {
      if (typeof raw.algorithm !== 'string' || ALGORITHM_NAMES.indexOf(raw.algorithm.toUpperCase()) < 0) {
        return { ok: false, reason: 'algorithm 不是 SHA1/SHA256/SHA512' };
      }
      algorithm = raw.algorithm.toUpperCase();
    }

    digits = 6;
    if (raw.digits !== undefined && raw.digits !== null) {
      if (!isInteger(raw.digits) || raw.digits < 6 || raw.digits > 10) {
        return { ok: false, reason: 'digits 不是 6-10 的整数' };
      }
      digits = raw.digits;
    }

    period = 30;
    if (raw.period !== undefined && raw.period !== null) {
      if (!isInteger(raw.period) || raw.period < 5 || raw.period > 300) {
        return { ok: false, reason: 'period 不是 5-300 的整数' };
      }
      period = raw.period;
    }
  }

  const account = {
    id,
    issuer,
    accountName,
    category,
    secret,
    algorithm,
    digits,
    period,
    otpType
  };

  if (allowPassword && raw.password !== undefined) {
    if (typeof raw.password !== 'string') {
      return { ok: false, reason: 'password 不是字符串' };
    }
    if (raw.password.length > MAX_PASSWORD_LENGTH) {
      return { ok: false, reason: 'password 超过 ' + MAX_PASSWORD_LENGTH + ' 字符' };
    }
    if (/[\u0000-\u001f]/.test(raw.password)) {
      return { ok: false, reason: 'password 不允许 U+0000-U+001F 控制字符' };
    }
    // "" 是合法的“清空”语义；是否保留/清空由 commit 合并阶段决定
    account.password = raw.password;
  }

  if (raw.updatedAt !== undefined && raw.updatedAt !== null) {
    if (typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt)) {
      return { ok: false, reason: 'updatedAt 不是数字' };
    }
    account.updatedAt = raw.updatedAt;
  }
  return { ok: true, account };
}

/** 校验信封。options.versions：允许的 version 列表（默认 [2,3]）。 */
export function validateEnvelope(message, options) {
  const opts = options || {};
  const versions = opts.versions || SYNC_VERSIONS;
  if (!isPlainObject(message)) {
    return { ok: false, reason: '消息不是单个 JSON 对象' };
  }
  if (typeof message.type !== 'string' || message.type.length === 0) {
    return { ok: false, reason: 'type 缺失或不是字符串' };
  }
  if (versions.indexOf(message.version) < 0) {
    return { ok: false, reason: 'version 不在支持范围（' + versions.join('/') + '）' };
  }
  if (!isInteger(message.sentAt)) {
    return { ok: false, reason: 'sentAt 不是整数毫秒时间戳' };
  }
  return { ok: true };
}

function parseMessage(raw) {
  if (typeof raw === 'string') {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return { ok: false, reason: '不是合法 JSON' };
    }
    if (Array.isArray(parsed)) {
      return { ok: false, reason: '消息不是单个 JSON 对象' };
    }
    return { ok: true, message: parsed, bytes: Buffer.byteLength(raw, 'utf8') };
  }
  if (isPlainObject(raw)) {
    return { ok: true, message: raw, bytes: messageBytes(raw) };
  }
  return { ok: false, reason: '消息不是 JSON 字符串或对象' };
}

function previousAccountsById(snapshot) {
  const map = new Map();
  if (snapshot && Array.isArray(snapshot.accounts)) {
    for (const account of snapshot.accounts) {
      if (account && typeof account.id === 'string') {
        map.set(account.id, account);
      }
    }
  }
  return map;
}

/** 密码合并：缺省保留旧值，"" 清空，非空覆盖。 */
export function mergeAccountPassword(incoming, previous) {
  const merged = {};
  for (const key of Object.keys(incoming)) {
    merged[key] = incoming[key];
  }
  if (incoming.password !== undefined) {
    if (incoming.password === '') {
      delete merged.password;
    }
  } else if (previous && previous.password !== undefined) {
    merged.password = previous.password;
  }
  return merged;
}

/** 手环端接收状态机（v3；可配置只支持 v2 以模拟旧手环）。 */
export class BandSyncReceiver {
  constructor(options) {
    const opts = options || {};
    this.now = typeof opts.now === 'function' ? opts.now : function () {
      return Date.now();
    };
    this.snapshot = opts.initialSnapshot == null ? null : opts.initialSnapshot;
    this.staging = null;
    this.lastAck = null;
    this.lastPinAck = null;
    this.pin = null;
    this.pinFailures = 0;
    this.receivedRequests = [];
    this.supportedVersions = Array.isArray(opts.supportedVersions)
      ? opts.supportedVersions.slice()
      : SYNC_VERSIONS.slice();
    this.snapshotKey = opts.snapshotKey || SNAPSHOT_KEY_V3;
  }

  receive(raw) {
    const now = this.now();
    const parsed = parseMessage(raw);
    if (!parsed.ok) {
      return { status: 'ignored', reason: parsed.reason };
    }
    const message = parsed.message;

    if (this.staging && now - this.staging.lastAt > STAGING_TIMEOUT_MS) {
      this.staging = null;
      this.lastTimeoutReason = 'staging 超时（' + STAGING_TIMEOUT_MS + 'ms 无新消息），已丢弃';
    }

    const envelope = validateEnvelope(message, { versions: this.supportedVersions });
    if (!envelope.ok) {
      return { status: 'ignored', reason: envelope.reason };
    }

    switch (message.type) {
      case MESSAGE_TYPES.BEGIN:
        return this.handleBegin(message, now);
      case MESSAGE_TYPES.ACCOUNT:
        return this.handleAccount(message, now);
      case MESSAGE_TYPES.COMMIT:
        return this.handleCommit(message, now);
      case MESSAGE_TYPES.PIN_SET:
      case MESSAGE_TYPES.PIN_QUERY:
      case MESSAGE_TYPES.PIN_CLEAR:
        return this.handlePin(message, now);
      default:
        return { status: 'ignored', reason: '未知或不适用于手环端的 type: ' + message.type };
    }
  }

  handleBegin(message, now) {
    if (!isNonEmptyString(message.syncId) || message.syncId.length > 128) {
      return { status: 'ignored', reason: 'begin: syncId 缺失/非法' };
    }
    if (!isInteger(message.accountCount) || message.accountCount < 0 || message.accountCount > MAX_ACCOUNT_COUNT) {
      // docs/protocol.md：非法 begin 忽略，保留当前 staging 与已存快照
      return { status: 'ignored', reason: 'begin: accountCount 不是 0-' + MAX_ACCOUNT_COUNT + ' 的整数' };
    }
    this.staging = {
      syncId: message.syncId,
      version: message.version,
      accountCount: message.accountCount,
      byIndex: new Map(),
      byId: new Map(),
      errors: 0,
      duplicates: 0,
      startedAt: now,
      lastAt: now
    };
    return {
      status: 'accepted',
      kind: 'begin',
      syncId: message.syncId,
      version: message.version,
      accountCount: message.accountCount
    };
  }

  handleAccount(message, now) {
    if (!this.staging) {
      return { status: 'dropped', reason: '没有进行中的 staging，丢弃 account' };
    }
    const staging = this.staging;
    staging.lastAt = now;
    if (message.syncId !== staging.syncId) {
      staging.errors += 1;
      return { status: 'dropped', reason: 'syncId 与当前 staging 不一致' };
    }
    if (!isInteger(message.index) || message.index < 0) {
      staging.errors += 1;
      return { status: 'dropped', reason: 'index 不是非负整数' };
    }
    const result = validateAccount(message.account, message.index, { version: staging.version });
    if (!result.ok) {
      staging.errors += 1;
      return { status: 'dropped', reason: result.reason, errors: staging.errors };
    }
    const incoming = result.account;
    const existingIndex = staging.byId.get(incoming.id);
    if (existingIndex !== undefined && existingIndex !== message.index) {
      // docs/protocol.md：同一 account.id 出现在不同 index → 丢弃后到者
      staging.errors += 1;
      return { status: 'dropped', reason: '同一 account.id 出现在不同 index，丢弃后到者', errors: staging.errors };
    }
    const replaced = staging.byIndex.get(message.index);
    if (replaced !== undefined) {
      staging.duplicates += 1;
      if (replaced.id !== incoming.id) {
        staging.byId.delete(replaced.id);
      }
      staging.byIndex.set(message.index, incoming);
      staging.byId.set(incoming.id, message.index);
      return {
        status: 'replaced',
        kind: 'account',
        id: incoming.id,
        index: message.index,
        duplicateIndex: staging.duplicates,
        received: staging.byIndex.size
      };
    }
    staging.byIndex.set(message.index, incoming);
    staging.byId.set(incoming.id, message.index);
    return {
      status: 'accepted',
      kind: 'account',
      id: incoming.id,
      received: staging.byIndex.size
    };
  }

  handleCommit(message, now) {
    if (!this.staging) {
      this.lastAck = buildAck({
        syncId: message.syncId == null ? '' : String(message.syncId),
        ok: false,
        received: 0,
        committed: 0,
        error: 'no_active_begin',
        now
      });
      return { status: 'failed', reason: 'no_active_begin: 没有进行中的 staging', ack: this.lastAck };
    }
    const staging = this.staging;
    staging.lastAt = now;

    let error = null;
    if (message.syncId !== staging.syncId) {
      error = 'sync_id_mismatch';
    } else if (message.accountCount !== staging.accountCount) {
      error = 'account_count_mismatch';
    } else if (staging.byIndex.size !== staging.accountCount) {
      error = 'incomplete_sync';
    }

    if (error) {
      this.staging = null;
      this.lastAck = buildAck({
        syncId: staging.syncId,
        ok: false,
        received: staging.byIndex.size,
        committed: 0,
        error,
        now
      });
      return { status: 'failed', reason: error, ack: this.lastAck };
    }

    const indices = Array.from(staging.byIndex.keys()).sort(function (left, right) {
      return left - right;
    });
    const previous = previousAccountsById(this.snapshot);
    const accounts = indices.map(function (index) {
      const incoming = staging.byIndex.get(index);
      return mergeAccountPassword(incoming, previous.get(incoming.id));
    });
    this.snapshot = {
      version: staging.version,
      storageKey: this.snapshotKey,
      updatedAt: now,
      accounts
    };
    this.staging = null;
    this.lastAck = buildAck({
      syncId: staging.syncId,
      ok: true,
      received: accounts.length,
      committed: accounts.length,
      error: null,
      now
    });
    return { status: 'committed', ack: this.lastAck, snapshot: this.snapshot };
  }

  /** 处理入口图案消息；仅接受 version == 3。 */
  handlePin(message, now) {
    if (message.version !== PIN_MESSAGE_VERSION) {
      this.lastPinAck = buildPinAck({
        ok: false,
        enabled: this.pin !== null,
        error: 'invalid_version',
        now
      });
      return { status: 'rejected', reason: 'pin 消息 version 必须为 3', ack: this.lastPinAck };
    }

    if (message.type === MESSAGE_TYPES.PIN_SET) {
      const check = validatePinPayload(message.pin);
      if (!check.ok) {
        this.lastPinAck = buildPinAck({
          ok: false,
          enabled: this.pin !== null,
          error: 'invalid_pin_payload',
          now
        });
        return { status: 'rejected', reason: check.reason, ack: this.lastPinAck };
      }
      this.pin = {
        algorithm: check.pin.algorithm,
        salt: check.pin.salt,
        hash: check.pin.hash,
        iterations: check.pin.iterations,
        updatedAt: now
      };
      this.pinFailures = 0;
      this.lastPinAck = buildPinAck({ ok: true, enabled: true, error: null, now });
      const state = buildPinState({ enabled: true, updatedAt: now, now });
      return { status: 'pin_set', ack: this.lastPinAck, state, pin: this.pin };
    }

    if (message.type === MESSAGE_TYPES.PIN_QUERY) {
      const check = validatePinQuery(message);
      if (!check.ok) {
        return { status: 'ignored', reason: check.reason };
      }
      const state = buildPinState({
        enabled: this.pin !== null,
        updatedAt: this.pin === null ? 0 : this.pin.updatedAt,
        requestId: message.requestId,
        now
      });
      return { status: 'pin_state', state, requestId: message.requestId };
    }

    // PIN_CLEAR
    this.pin = null;
    this.pinFailures = 0;
    this.lastPinAck = buildPinAck({ ok: true, enabled: false, error: null, now });
    const state = buildPinState({ enabled: false, updatedAt: now, now });
    return { status: 'pin_clear', ack: this.lastPinAck, state };
  }

  /** 手环端主动请求手机推送全量快照（无快照 / 用户点重新同步）。 */
  buildRequest(requestId, now) {
    const sentAt = now == null ? this.now() : now;
    const request = {
      type: MESSAGE_TYPES.REQUEST,
      version: PROTOCOL_VERSION,
      sentAt,
      requestId: requestId || 'req-' + sentAt + '-1'
    };
    return request;
  }
}

export function buildAck(options) {
  const opts = options || {};
  return {
    type: MESSAGE_TYPES.ACK,
    version: PROTOCOL_VERSION,
    sentAt: opts.now == null ? Date.now() : opts.now,
    syncId: opts.syncId,
    ok: !!opts.ok,
    received: opts.received == null ? 0 : opts.received,
    committed: opts.committed == null ? 0 : opts.committed,
    error: opts.error == null ? null : opts.error
  };
}

export function validateAck(message) {
  const envelope = validateEnvelope(message);
  if (!envelope.ok) {
    return envelope;
  }
  if (message.type !== MESSAGE_TYPES.ACK) {
    return { ok: false, reason: 'type 不是 mfa_sync_ack' };
  }
  if (typeof message.syncId !== 'string' || message.syncId.length === 0) {
    return { ok: false, reason: 'ack.syncId 缺失' };
  }
  if (typeof message.ok !== 'boolean') {
    return { ok: false, reason: 'ack.ok 不是布尔' };
  }
  if (!isInteger(message.received) || message.received < 0) {
    return { ok: false, reason: 'ack.received 不是非负整数' };
  }
  if (!isInteger(message.committed) || message.committed < 0) {
    return { ok: false, reason: 'ack.committed 不是非负整数' };
  }
  if (message.ok === false) {
    if (message.error == null) {
      return { ok: false, reason: '失败 ack 必须带 error' };
    }
    if (SYNC_ACK_ERRORS.indexOf(message.error) < 0) {
      return { ok: false, reason: '未知失败 ack 原因码: ' + message.error };
    }
  }
  return { ok: true };
}

export function validateRequest(message) {
  const envelope = validateEnvelope(message);
  if (!envelope.ok) {
    return envelope;
  }
  if (message.type !== MESSAGE_TYPES.REQUEST) {
    return { ok: false, reason: 'type 不是 mfa_sync_request' };
  }
  if (!isNonEmptyString(message.requestId) || message.requestId.length > 128) {
    return { ok: false, reason: 'requestId 缺失/非法' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------- 入口图案

export function validatePinPattern(pattern) {
  if (typeof pattern !== 'string' || !PIN_PATTERN_REGEX.test(pattern)) {
    return { ok: false, reason: '图案必须是 5 位 T/S/C（例如 TSCCT）' };
  }
  return { ok: true };
}

/** 图案规范串 → PBKDF2-HMAC-SHA256 32B 小写十六进制。 */
export function derivePinHash(pattern, saltHex, iterations) {
  const patternCheck = validatePinPattern(pattern);
  if (!patternCheck.ok) {
    throw new Error(patternCheck.reason);
  }
  if (!isLowerHex(saltHex, PIN_SALT_HEX_LENGTH)) {
    throw new Error('salt 必须是 ' + PIN_SALT_HEX_LENGTH + ' 位小写十六进制');
  }
  if (!isInteger(iterations) || iterations < PIN_ITERATIONS_MIN || iterations > PIN_ITERATIONS_MAX) {
    throw new Error('iterations 必须是 ' + PIN_ITERATIONS_MIN + '-' + PIN_ITERATIONS_MAX + ' 的整数');
  }
  return pbkdf2Sync(Buffer.from(pattern, 'utf8'), Buffer.from(saltHex, 'hex'), iterations, 32, 'sha256').toString('hex');
}

export function validatePinPayload(pin) {
  if (!isPlainObject(pin)) {
    return { ok: false, reason: 'pin 不是对象' };
  }
  if (pin.algorithm !== PIN_ALGORITHM) {
    return { ok: false, reason: 'pin.algorithm 必须是 ' + PIN_ALGORITHM };
  }
  if (!isLowerHex(pin.salt, PIN_SALT_HEX_LENGTH)) {
    return { ok: false, reason: 'pin.salt 必须是 ' + PIN_SALT_HEX_LENGTH + ' 位小写十六进制' };
  }
  if (!isLowerHex(pin.hash, PIN_HASH_HEX_LENGTH)) {
    return { ok: false, reason: 'pin.hash 必须是 ' + PIN_HASH_HEX_LENGTH + ' 位小写十六进制' };
  }
  if (!isInteger(pin.iterations) || pin.iterations < PIN_ITERATIONS_MIN || pin.iterations > PIN_ITERATIONS_MAX) {
    return { ok: false, reason: 'pin.iterations 必须是 ' + PIN_ITERATIONS_MIN + '-' + PIN_ITERATIONS_MAX + ' 的整数' };
  }
  return {
    ok: true,
    pin: {
      algorithm: PIN_ALGORITHM,
      salt: pin.salt,
      hash: pin.hash,
      iterations: pin.iterations
    }
  };
}

export function buildPinSet(pin, options) {
  const opts = options || {};
  const sentAt = opts.sentAt == null ? Date.now() : opts.sentAt;
  const check = validatePinPayload(pin);
  if (!check.ok) {
    throw new Error(check.reason);
  }
  return {
    type: MESSAGE_TYPES.PIN_SET,
    version: PIN_MESSAGE_VERSION,
    sentAt,
    pin: check.pin
  };
}

export function buildPinQuery(requestId, options) {
  const opts = options || {};
  const sentAt = opts.sentAt == null ? Date.now() : opts.sentAt;
  if (!isNonEmptyString(requestId) || requestId.length > 128) {
    throw new Error('requestId 缺失/非法');
  }
  return {
    type: MESSAGE_TYPES.PIN_QUERY,
    version: PIN_MESSAGE_VERSION,
    sentAt,
    requestId
  };
}

export function buildPinClear(options) {
  const opts = options || {};
  return {
    type: MESSAGE_TYPES.PIN_CLEAR,
    version: PIN_MESSAGE_VERSION,
    sentAt: opts.sentAt == null ? Date.now() : opts.sentAt
  };
}

export function buildPinAck(options) {
  const opts = options || {};
  return {
    type: MESSAGE_TYPES.PIN_ACK,
    version: PIN_MESSAGE_VERSION,
    sentAt: opts.now == null ? Date.now() : opts.now,
    ok: !!opts.ok,
    enabled: !!opts.enabled,
    error: opts.error == null ? null : opts.error
  };
}

export function buildPinState(options) {
  const opts = options || {};
  const state = {
    type: MESSAGE_TYPES.PIN_STATE,
    version: PIN_MESSAGE_VERSION,
    sentAt: opts.now == null ? Date.now() : opts.now,
    enabled: !!opts.enabled,
    updatedAt: opts.updatedAt == null ? 0 : opts.updatedAt
  };
  if (opts.requestId !== undefined && opts.requestId !== null) {
    state.requestId = opts.requestId;
  }
  return state;
}

export function validatePinSet(message) {
  const envelope = validateEnvelope(message, { versions: [PIN_MESSAGE_VERSION] });
  if (!envelope.ok) {
    return envelope;
  }
  if (message.type !== MESSAGE_TYPES.PIN_SET) {
    return { ok: false, reason: 'type 不是 mfa_pin_set' };
  }
  return validatePinPayload(message.pin);
}

export function validatePinQuery(message) {
  const envelope = validateEnvelope(message, { versions: [PIN_MESSAGE_VERSION] });
  if (!envelope.ok) {
    return envelope;
  }
  if (message.type !== MESSAGE_TYPES.PIN_QUERY) {
    return { ok: false, reason: 'type 不是 mfa_pin_query' };
  }
  if (!isNonEmptyString(message.requestId) || message.requestId.length > 128) {
    return { ok: false, reason: 'requestId 缺失/非法' };
  }
  return { ok: true };
}

export function validatePinClear(message) {
  const envelope = validateEnvelope(message, { versions: [PIN_MESSAGE_VERSION] });
  if (!envelope.ok) {
    return envelope;
  }
  if (message.type !== MESSAGE_TYPES.PIN_CLEAR) {
    return { ok: false, reason: 'type 不是 mfa_pin_clear' };
  }
  return { ok: true };
}

export function validatePinAck(message) {
  const envelope = validateEnvelope(message, { versions: [PIN_MESSAGE_VERSION] });
  if (!envelope.ok) {
    return envelope;
  }
  if (message.type !== MESSAGE_TYPES.PIN_ACK) {
    return { ok: false, reason: 'type 不是 mfa_pin_ack' };
  }
  if (typeof message.ok !== 'boolean') {
    return { ok: false, reason: 'pin_ack.ok 不是布尔' };
  }
  if (typeof message.enabled !== 'boolean') {
    return { ok: false, reason: 'pin_ack.enabled 不是布尔' };
  }
  if (message.ok === false) {
    if (PIN_ACK_ERRORS.indexOf(message.error) < 0) {
      return { ok: false, reason: 'pin_ack.error 非法: ' + message.error };
    }
  } else if (message.error != null) {
    return { ok: false, reason: '成功 pin_ack 不应带 error' };
  }
  return { ok: true };
}

export function validatePinState(message) {
  const envelope = validateEnvelope(message, { versions: [PIN_MESSAGE_VERSION] });
  if (!envelope.ok) {
    return envelope;
  }
  if (message.type !== MESSAGE_TYPES.PIN_STATE) {
    return { ok: false, reason: 'type 不是 mfa_pin_state' };
  }
  if (typeof message.enabled !== 'boolean') {
    return { ok: false, reason: 'pin_state.enabled 不是布尔' };
  }
  if (!isIntegersafe(message.updatedAt)) {
    return { ok: false, reason: 'pin_state.updatedAt 不是整数毫秒时间戳' };
  }
  if (message.requestId !== undefined && message.requestId !== null) {
    if (!isNonEmptyString(message.requestId) || message.requestId.length > 128) {
      return { ok: false, reason: 'pin_state.requestId 缺失/非法' };
    }
  }
  return { ok: true };
}

function isIntegersafe(value) {
  return isInteger(value) && value >= 0;
}

/** 生成一次全量同步的消息序列（begin → account×N → commit）。
 * options.version：2 用于生成旧手机（v2）消息；默认 3。
 */
export function buildSyncSession(accounts, options) {
  const opts = options || {};
  const version = opts.version == null ? PROTOCOL_VERSION : opts.version;
  const sentAt = opts.sentAt == null ? Date.now() : opts.sentAt;
  const syncId = opts.syncId || 'sync-' + sentAt + '-fixture';
  const list = Array.isArray(accounts) ? accounts : [];
  const messages = [
    {
      type: MESSAGE_TYPES.BEGIN,
      version,
      sentAt,
      syncId,
      accountCount: list.length
    }
  ];
  list.forEach(function (account, index) {
    const payload = {
      id: account.id,
      issuer: account.issuer,
      accountName: account.accountName,
      category: account.category,
      secret: account.secret,
      algorithm: account.algorithm,
      digits: account.digits,
      period: account.period,
      otpType: account.otpType === 'steam' ? 'steam' : 'totp'
    };
    if (account.password !== undefined && version >= PROTOCOL_VERSION) {
      payload.password = account.password;
    }
    if (account.updatedAt !== undefined) {
      payload.updatedAt = account.updatedAt;
    }
    messages.push({
      type: MESSAGE_TYPES.ACCOUNT,
      version,
      sentAt: sentAt + index + 1,
      syncId,
      index,
      account: payload
    });
  });
  messages.push({
    type: MESSAGE_TYPES.COMMIT,
    version,
    sentAt: sentAt + list.length + 1,
    syncId,
    accountCount: list.length
  });
  return { syncId, version, messages };
}

/** 极简手机端状态机：发送全量同步、处理 ack / request / pin 消息。 */
export class PhoneSyncClient {
  constructor(options) {
    const opts = options || {};
    this.now = typeof opts.now === 'function' ? opts.now : function () {
      return Date.now();
    };
    this.status = 'idle';
    this.lastAck = null;
    this.lastError = null;
    this.pinState = null;
    this.pendingSyncSentAt = null;
    this.ackTimeoutMs = opts.ackTimeoutMs == null ? ACK_TIMEOUT_MS : opts.ackTimeoutMs;
  }

  buildSync(accounts, options) {
    const opts = options || {};
    const sentAt = opts.sentAt == null ? this.now() : opts.sentAt;
    const session = buildSyncSession(accounts, {
      sentAt,
      syncId: opts.syncId,
      version: opts.version == null ? PROTOCOL_VERSION : opts.version
    });
    this.status = 'sending';
    this.lastError = null;
    this.pendingSyncSentAt = sentAt;
    return session;
  }

  handleAck(message) {
    const check = validateAck(message);
    if (!check.ok) {
      this.lastError = check.reason;
      return { ok: false, reason: check.reason };
    }
    this.lastAck = message;
    this.pendingSyncSentAt = null;
    if (message.ok) {
      this.status = 'confirmed';
      return { ok: true, status: 'confirmed' };
    }
    this.status = 'failed';
    this.lastError = message.error || '手环端提交失败';
    return { ok: false, reason: this.lastError };
  }

  /** v3 手机发同步后 8s 无 ack → 提示升级旧手环应用。 */
  checkAckTimeout(now) {
    if (this.status !== 'sending' || this.pendingSyncSentAt === null) {
      return { timedOut: false };
    }
    const current = now == null ? this.now() : now;
    if (current - this.pendingSyncSentAt >= this.ackTimeoutMs) {
      this.lastError = '手环应用版本过低，请升级手环应用后重试';
      return { timedOut: true, suggestion: this.lastError };
    }
    return { timedOut: false };
  }

  handlePinAck(message) {
    const check = validatePinAck(message);
    if (!check.ok) {
      this.lastError = check.reason;
      return { ok: false, reason: check.reason };
    }
    if (this.pinState === null) {
      this.pinState = { enabled: message.enabled };
    } else {
      this.pinState.enabled = message.enabled;
    }
    return { ok: true, enabled: message.enabled };
  }

  handlePinState(message) {
    const check = validatePinState(message);
    if (!check.ok) {
      this.lastError = check.reason;
      return { ok: false, reason: check.reason };
    }
    this.pinState = {
      enabled: message.enabled,
      updatedAt: message.updatedAt
    };
    return { ok: true, state: this.pinState };
  }

  /** 返回 'resync' 表示应执行一次完整同步；'ignored' 表示消息非法/未连接。 */
  handleRequest(message, connected) {
    const check = validateRequest(message);
    if (!check.ok) {
      return { action: 'ignored', reason: check.reason };
    }
    if (connected === false) {
      return { action: 'ignored', reason: '未连接/未授权，忽略 mfa_sync_request' };
    }
    return { action: 'resync', requestId: message.requestId };
  }
}

/** 辅助：导出 account.id 参考算法（s_ + sha1(归一化 secret) 前 12 位）。 */
export function accountIdForSecret(secret) {
  const normalized = normalizeProtocolSecret(secret);
  return 's_' + createHash('sha1').update(normalized, 'utf8').digest('hex').slice(0, 12);
}
