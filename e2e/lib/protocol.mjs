// WristKey e2e — 同步协议 v2 参考实现（手机端状态机 + 手环端接收状态机）。
// 依据 docs/protocol.md 独立实现，用于夹具生成与协议合法性校验。
//
// 依据 docs/protocol.md 的校验规则与“确定性约定”：
//   - 未知 type / version != 2 → 忽略（不计错误、不清 staging）；
//   - 非法 begin（syncId 空/超长、accountCount 非 0-500 整数）→ 忽略，保留旧 staging；
//   - 收到 account 时校验 staging 超时（默认 120s 无新消息 → 丢弃 staging，不计错误）；
//   - account 字段违反校验规则（含 Steam 固定 5/30/SHA1、otpType 取值）→ 丢弃并计入 errors；
//   - 同一 index 重复发送 → 后到覆盖先到（duplicate_index，不算失败）；
//     同一 account.id 出现在不同 index → 丢弃后到者；
//   - otpType：缺省 totp；steam 为 5 位字母数字码（Steam Guard，见 docs/protocol.md）；
//   - commit 校验 syncId / accountCount / 已暂存条数；失败原因码
//     no_active_begin / sync_id_mismatch / account_count_mismatch / incomplete_sync；
//     失败 → 丢弃 staging，旧快照不变。

import { normalizeProtocolSecret, isValidProtocolSecret } from './encoding.mjs';

export const PROTOCOL_VERSION = 2;
export const MAX_MESSAGE_BYTES = 1024;
export const STAGING_TIMEOUT_MS = 120000;
export const DEFAULT_CATEGORY = '默认分类';
export const ALGORITHM_NAMES = ['SHA1', 'SHA256', 'SHA512'];
export const OTP_TYPES = ['totp', 'steam'];
export const MAX_ACCOUNT_COUNT = 500;
export const STEAM_DIGITS = 5;
export const STEAM_PERIOD = 30;

export const MESSAGE_TYPES = Object.freeze({
  BEGIN: 'mfa_sync_begin',
  ACCOUNT: 'mfa_sync_account',
  COMMIT: 'mfa_sync_commit',
  ACK: 'mfa_sync_ack',
  REQUEST: 'mfa_sync_request'
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

/** 手环端 account 校验与归一化。返回 {ok:true, account} 或 {ok:false, reason}。 */
export function validateAccount(raw, index) {
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
  if (raw.updatedAt !== undefined && raw.updatedAt !== null) {
    if (typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt)) {
      return { ok: false, reason: 'updatedAt 不是数字' };
    }
    account.updatedAt = raw.updatedAt;
  }
  return { ok: true, account };
}

export function validateEnvelope(message) {
  if (!isPlainObject(message)) {
    return { ok: false, reason: '消息不是单个 JSON 对象' };
  }
  if (typeof message.type !== 'string' || message.type.length === 0) {
    return { ok: false, reason: 'type 缺失或不是字符串' };
  }
  if (message.version !== PROTOCOL_VERSION) {
    return { ok: false, reason: 'version 不是 2' };
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

/** 手环端接收状态机。 */
export class BandSyncReceiver {
  constructor(options) {
    const opts = options || {};
    this.now = typeof opts.now === 'function' ? opts.now : function () {
      return Date.now();
    };
    this.snapshot = opts.initialSnapshot == null ? null : opts.initialSnapshot;
    this.staging = null;
    this.lastAck = null;
    this.receivedRequests = [];
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

    const envelope = validateEnvelope(message);
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
      accountCount: message.accountCount,
      byIndex: new Map(),
      byId: new Map(),
      errors: 0,
      duplicates: 0,
      startedAt: now,
      lastAt: now
    };
    return { status: 'accepted', kind: 'begin', syncId: message.syncId, accountCount: message.accountCount };
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
    const result = validateAccount(message.account, message.index);
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
    const accounts = indices.map((index) => staging.byIndex.get(index));
    this.snapshot = {
      version: PROTOCOL_VERSION,
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
  if (message.ok === false && (message.error === null || message.error === undefined)) {
    return { ok: false, reason: '失败 ack 必须带 error' };
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

/** 生成一次全量同步的消息序列（begin → account×N → commit）。 */
export function buildSyncSession(accounts, options) {
  const opts = options || {};
  const sentAt = opts.sentAt == null ? Date.now() : opts.sentAt;
  const syncId = opts.syncId || 'sync-' + sentAt + '-fixture';
  const list = Array.isArray(accounts) ? accounts : [];
  const messages = [
    {
      type: MESSAGE_TYPES.BEGIN,
      version: PROTOCOL_VERSION,
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
    if (account.updatedAt !== undefined) {
      payload.updatedAt = account.updatedAt;
    }
    messages.push({
      type: MESSAGE_TYPES.ACCOUNT,
      version: PROTOCOL_VERSION,
      sentAt: sentAt + index + 1,
      syncId,
      index,
      account: payload
    });
  });
  messages.push({
    type: MESSAGE_TYPES.COMMIT,
    version: PROTOCOL_VERSION,
    sentAt: sentAt + list.length + 1,
    syncId,
    accountCount: list.length
  });
  return { syncId, messages };
}

/** 极简手机端状态机：发送全量同步、处理 ack / request。 */
export class PhoneSyncClient {
  constructor(options) {
    const opts = options || {};
    this.now = typeof opts.now === 'function' ? opts.now : function () {
      return Date.now();
    };
    this.status = 'idle';
    this.lastAck = null;
    this.lastError = null;
  }

  buildSync(accounts, options) {
    const opts = options || {};
    const session = buildSyncSession(accounts, {
      sentAt: opts.sentAt == null ? this.now() : opts.sentAt,
      syncId: opts.syncId
    });
    this.status = 'sending';
    this.lastError = null;
    return session;
  }

  handleAck(message) {
    const check = validateAck(message);
    if (!check.ok) {
      this.lastError = check.reason;
      return { ok: false, reason: check.reason };
    }
    this.lastAck = message;
    if (message.ok) {
      this.status = 'confirmed';
      return { ok: true, status: 'confirmed' };
    }
    this.status = 'failed';
    this.lastError = message.error || '手环端提交失败';
    return { ok: false, reason: this.lastError };
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
