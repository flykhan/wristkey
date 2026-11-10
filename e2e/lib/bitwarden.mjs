// WristKey e2e — Bitwarden 未加密 Vault JSON 参考解析（测试专用）。
// 依据 docs/bitwarden-format.md 独立实现，用于夹具生成与 Android 导入映射对拍。
//
// 识别：顶层 items 数组，且条目含 login 字段 → 未加密 Vault；
//       顶层 encrypted === true（通常含 data/salt/kdf 字段）→ 加密导出（拒绝）；
//       其它 Bitwarden 导出（如 Authenticator App，无 login）→ 不识别。
//
// 映射（docs/bitwarden-format.md）：
//   items[].name         → issuer（trim；空 → "Bitwarden"）
//   login.username       → accountName；空 → otpauth label 账号部分；仍空 → issuer
//   login.totp           → otpauth URI 或纯 Base32（SHA1/6/30）
//   folders/folderId     → 忽略，分类统一 "默认分类"
//   非登录 type(≠1)      → 跳过；无 totp/非法 totp → 跳过并报告

import { isValidProtocolSecret, normalizeProtocolSecret } from './encoding.mjs';
import {
  DEFAULT_CATEGORY,
  FIXTURE_UPDATED_AT,
  parseOtpAuthUri,
  secretToAccountId
} from './stratum.mjs';

export const BITWARDEN_ISSUER = 'Bitwarden';
export const BITWARDEN_ENCRYPTED_MESSAGE = 'Bitwarden 加密导出暂不支持，请导出未加密 JSON';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value) {
  return value == null ? '' : String(value);
}

function readField(object, name) {
  if (!isPlainObject(object)) {
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(object, name)) {
    return object[name];
  }
  return undefined;
}

/**
 * Bitwarden 内容嗅探。
 * @returns {'encrypted'|'vault'|'unknown'} encrypted 表示加密 Vault（应拒绝）
 */
export function detectBitwarden(value) {
  if (!isPlainObject(value)) {
    return 'unknown';
  }
  const items = readField(value, 'items');
  const encrypted = readField(value, 'encrypted');
  if (encrypted === true) {
    return 'encrypted';
  }
  if (!Array.isArray(items)) {
    return 'unknown';
  }
  const hasLogin = items.some(function (item) {
    const login = readField(item, 'login');
    return isPlainObject(login);
  });
  if (!hasLogin) {
    return 'unknown';
  }
  return 'vault';
}

function parseRawBase32(totp) {
  if (!isValidProtocolSecret(totp)) {
    return { ok: false, code: 'INVALID_BASE32', reason: '纯 Base32 secret 非法' };
  }
  return {
    ok: true,
    parsed: {
      issuer: '',
      accountName: '',
      secret: normalizeProtocolSecret(totp),
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      otpType: 'totp'
    }
  };
}

function parseTotpField(totp) {
  const text = String(totp == null ? '' : totp).trim();
  if (!text) {
    return { ok: false, code: 'NO_TOTP', reason: 'login.totp 为空或缺失（普通密码条目）' };
  }
  if (/^otpauth:\/\//i.test(text)) {
    const parsed = parseOtpAuthUri(text);
    if (!parsed.ok) {
      return { ok: false, code: parsed.code, reason: parsed.reason };
    }
    const account = parsed.account;
    return {
      ok: true,
      parsed: {
        issuer: '',
        accountName: account.accountName,
        secret: account.secret,
        algorithm: account.algorithm,
        digits: account.digits,
        period: account.period,
        otpType: account.otpType
      }
    };
  }
  if (isValidProtocolSecret(text)) {
    return parseRawBase32(text);
  }
  return { ok: false, code: 'INVALID_TOTP', reason: 'login.totp 既不是 otpauth:// URI 也不是合法 Base32' };
}

/** 未加密 Vault JSON → 协议 account 列表 + 跳过报告（保持 items 顺序）。 */
export function mapBitwardenToAccounts(value, options) {
  const opts = options || {};
  const updatedAt = opts.updatedAt == null ? FIXTURE_UPDATED_AT : opts.updatedAt;
  const kind = detectBitwarden(value);
  if (kind === 'encrypted') {
    const error = new Error(BITWARDEN_ENCRYPTED_MESSAGE);
    error.code = 'BITWARDEN_ENCRYPTED';
    throw error;
  }
  if (kind !== 'vault') {
    const error = new Error('不是 Bitwarden 未加密 Vault JSON');
    error.code = 'NOT_BITWARDEN';
    throw error;
  }

  const items = readField(value, 'items');
  const accounts = [];
  const skipped = [];
  const seenSecrets = new Set();

  items.forEach(function (item, index) {
    const itemName = asString(readField(item, 'name')).trim();
    const itemType = readField(item, 'type');
    const login = readField(item, 'login');
    const loginObject = isPlainObject(login) ? login : {};
    const username = asString(readField(loginObject, 'username')).trim();

    function skip(code, reason) {
      skipped.push({ itemIndex: index, name: itemName, username, code, reason });
    }

    if (Number(itemType) !== 1) {
      skip('NOT_LOGIN_TYPE', 'item.type=' + asString(itemType) + ' 不是登录条目（1）');
      return;
    }
    const totp = readField(loginObject, 'totp');
    const totpText = asString(totp).trim();
    if (!totpText) {
      skip('NO_TOTP', 'login.totp 为空或缺失（普通密码条目）');
      return;
    }
    const parsed = parseTotpField(totpText);
    if (!parsed.ok) {
      skip(parsed.code, parsed.reason);
      return;
    }

    const issuer = itemName || BITWARDEN_ISSUER;
    const accountName = username || parsed.parsed.accountName || issuer;
    const secret = parsed.parsed.secret;
    if (seenSecrets.has(secret)) {
      skip('DUPLICATE_SECRET', '同一导出中 secret 重复');
      return;
    }
    seenSecrets.add(secret);
    accounts.push({
      id: secretToAccountId(secret),
      issuer,
      accountName,
      category: DEFAULT_CATEGORY,
      secret,
      algorithm: parsed.parsed.algorithm,
      digits: parsed.parsed.digits,
      period: parsed.parsed.period,
      otpType: parsed.parsed.otpType,
      updatedAt
    });
  });

  return {
    accounts,
    skipped,
    stats: { total: items.length, imported: accounts.length, skipped: skipped.length }
  };
}
