// WristKey e2e — Stratum 备份格式参考实现（测试专用，不进入发布产物）。
// 依据 docs/stratum-format.md 与 research/stratum/doc/BACKUP_FORMAT.md 独立实现。
//
// 覆盖：
//   - 格式嗅探（内容优先：Strong / Legacy / 明文 JSON / URI 列表）
//   - Strong:  header AUTHENTICATORPRO + salt16 + iv12 + AES-256-GCM(Argon2id p4 m65536 t3 out32) + tag16
//   - Legacy:  header AuthenticatorPro + salt20 + iv16 + AES-256-CBC/PKCS7(PBKDF2-SHA1 64000 dk32)
//   - 明文 JSON 解析 → 协议 account 映射（含跳过项报告与排序）
//   - otpauth:// URI 列表解析

import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { argon2id } from 'hash-wasm';

import {
  isValidProtocolSecret,
  isValidStratumSecret,
  normalizeBase32,
  normalizeProtocolSecret
} from './encoding.mjs';

export const STRONG_HEADER = Buffer.from('AUTHENTICATORPRO', 'ascii');
export const LEGACY_HEADER = Buffer.from('AuthenticatorPro', 'ascii');
export const STRONG_SALT_LENGTH = 16;
export const STRONG_IV_LENGTH = 12;
export const GCM_TAG_LENGTH = 16;
export const LEGACY_SALT_LENGTH = 20;
export const LEGACY_IV_LENGTH = 16;
export const ARGON2_PARAMS = Object.freeze({
  parallelism: 4,
  iterations: 3,
  memorySize: 65536,
  hashLength: 32
});
export const PBKDF2_PARAMS = Object.freeze({
  iterations: 64000,
  hashLength: 32,
  digest: 'sha1'
});
export const FIXTURE_PASSWORD = 'test-password';
// 夹具固定时间戳：保证生成物可复现，便于 git diff 与跨端对齐。
export const FIXTURE_UPDATED_AT = 1760000000000;
export const DEFAULT_CATEGORY = '默认分类';

export const ALGORITHM_NAMES = ['SHA1', 'SHA256', 'SHA512'];

const STRATUM_TYPE = { HOTP: 1, TOTP: 2, MOBILE_OTP: 3, STEAM: 4, YANDEX: 5 };
export const STRATUM_TYPES = STRATUM_TYPE;

export function toBuffer(input) {
  if (Buffer.isBuffer(input)) {
    return input;
  }
  if (input instanceof Uint8Array) {
    return Buffer.from(input);
  }
  return Buffer.from(String(input == null ? '' : input), 'utf8');
}

function startsWith(buffer, header) {
  return buffer.length >= header.length && buffer.subarray(0, header.length).equals(header);
}

// ---------------------------------------------------------------- 格式嗅探
export function detectFormat(input) {
  const buffer = toBuffer(input);
  if (startsWith(buffer, STRONG_HEADER)) {
    return 'strong';
  }
  if (startsWith(buffer, LEGACY_HEADER)) {
    return 'legacy';
  }
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        if (readField(parsed, 'authenticators') !== undefined) {
          return 'json';
        }
      }
    } catch (error) {
      // 落到 URI 判断
    }
  }
  const lines = trimmed
    .split(/\r?\n/)
    .map(function (line) {
      return line.trim();
    })
    .filter(Boolean);
  if (lines.length > 0) {
    const allUris = lines.every(function (line) {
      return /^otpauth:\/\//i.test(line);
    });
    if (allUris) {
      return 'uri';
    }
  }
  return 'unknown';
}

// ---------------------------------------------------------------- Strong
export async function deriveStrongKey(password, salt) {
  const key = await argon2id({
    password: String(password == null ? '' : password),
    salt: Uint8Array.from(salt),
    parallelism: ARGON2_PARAMS.parallelism,
    iterations: ARGON2_PARAMS.iterations,
    memorySize: ARGON2_PARAMS.memorySize,
    hashLength: ARGON2_PARAMS.hashLength,
    outputType: 'binary'
  });
  return Buffer.from(key);
}

export function splitStrongLayout(data) {
  const buffer = toBuffer(data);
  if (!startsWith(buffer, STRONG_HEADER)) {
    throw new Error('not a Strong (AUTHENTICATORPRO) backup');
  }
  const salt = buffer.subarray(STRONG_HEADER.length, STRONG_HEADER.length + STRONG_SALT_LENGTH);
  const ivStart = STRONG_HEADER.length + STRONG_SALT_LENGTH;
  const iv = buffer.subarray(ivStart, ivStart + STRONG_IV_LENGTH);
  const payload = buffer.subarray(ivStart + STRONG_IV_LENGTH);
  if (salt.length !== STRONG_SALT_LENGTH || iv.length !== STRONG_IV_LENGTH || payload.length <= GCM_TAG_LENGTH) {
    throw new Error('strong backup truncated');
  }
  const ciphertext = payload.subarray(0, payload.length - GCM_TAG_LENGTH);
  const tag = payload.subarray(payload.length - GCM_TAG_LENGTH);
  return { salt, iv, ciphertext, tag };
}

export async function decryptStrong(data, password) {
  const layout = splitStrongLayout(data);
  const key = await deriveStrongKey(password, layout.salt);
  const decipher = createDecipheriv('aes-256-gcm', key, layout.iv);
  decipher.setAuthTag(layout.tag);
  try {
    const plain = Buffer.concat([decipher.update(layout.ciphertext), decipher.final()]);
    return plain.toString('utf8');
  } catch (error) {
    throw new Error('密码错误或文件损坏（Strong: GCM tag 校验失败）');
  }
}

export async function encryptStrong(plainText, password, salt, iv) {
  if (!Buffer.isBuffer(salt) || salt.length !== STRONG_SALT_LENGTH) {
    throw new Error('strong salt must be ' + STRONG_SALT_LENGTH + ' bytes');
  }
  if (!Buffer.isBuffer(iv) || iv.length !== STRONG_IV_LENGTH) {
    throw new Error('strong iv must be ' + STRONG_IV_LENGTH + ' bytes');
  }
  const key = await deriveStrongKey(password, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plainText, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([STRONG_HEADER, salt, iv, ciphertext, tag]);
}

// ---------------------------------------------------------------- Legacy
export function deriveLegacyKey(password, salt) {
  return pbkdf2Sync(
    Buffer.from(String(password == null ? '' : password), 'utf8'),
    toBuffer(salt),
    PBKDF2_PARAMS.iterations,
    PBKDF2_PARAMS.hashLength,
    PBKDF2_PARAMS.digest
  );
}

export function splitLegacyLayout(data) {
  const buffer = toBuffer(data);
  if (!startsWith(buffer, LEGACY_HEADER)) {
    throw new Error('not a Legacy (AuthenticatorPro) backup');
  }
  const saltStart = LEGACY_HEADER.length;
  const salt = buffer.subarray(saltStart, saltStart + LEGACY_SALT_LENGTH);
  const ivStart = saltStart + LEGACY_SALT_LENGTH;
  const iv = buffer.subarray(ivStart, ivStart + LEGACY_IV_LENGTH);
  const payload = buffer.subarray(ivStart + LEGACY_IV_LENGTH);
  if (salt.length !== LEGACY_SALT_LENGTH || iv.length !== LEGACY_IV_LENGTH || payload.length === 0 || payload.length % 16 !== 0) {
    throw new Error('legacy backup truncated or misaligned');
  }
  return { salt, iv, payload };
}

export function decryptLegacy(data, password) {
  const layout = splitLegacyLayout(data);
  const key = deriveLegacyKey(password, layout.salt);
  const decipher = createDecipheriv('aes-256-cbc', key, layout.iv);
  try {
    const plain = Buffer.concat([decipher.update(layout.payload), decipher.final()]);
    return plain.toString('utf8');
  } catch (error) {
    throw new Error('密码错误或文件损坏（Legacy: CBC 填充非法）');
  }
}

export function encryptLegacy(plainText, password, salt, iv) {
  if (!Buffer.isBuffer(salt) || salt.length !== LEGACY_SALT_LENGTH) {
    throw new Error('legacy salt must be ' + LEGACY_SALT_LENGTH + ' bytes');
  }
  if (!Buffer.isBuffer(iv) || iv.length !== LEGACY_IV_LENGTH) {
    throw new Error('legacy iv must be ' + LEGACY_IV_LENGTH + ' bytes');
  }
  const key = deriveLegacyKey(password, salt);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plainText, 'utf8')), cipher.final()]);
  return Buffer.concat([LEGACY_HEADER, salt, iv, ciphertext]);
}

// ---------------------------------------------------------------- 明文 JSON
export function parseBackupJson(input) {
  const text = typeof input === 'string' ? input : toBuffer(input).toString('utf8');
  const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('backup JSON 必须是对象');
  }
  return parsed;
}

/** PascalCase 字段读取，同时容忍 camelCase。 */
export function readField(object, name) {
  if (!object || typeof object !== 'object') {
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(object, name)) {
    return object[name];
  }
  const lowerName = String(name).toLowerCase();
  for (const key of Object.keys(object)) {
    if (key.toLowerCase() === lowerName) {
      return object[key];
    }
  }
  return undefined;
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value) {
  return value == null ? '' : String(value);
}

/** 确定性字符串比较（UTF-16 code unit），避免 localeCompare 的平台/ICU 差异。 */
function compareStrings(left, right) {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** 用于 id 的 secret 规范形：大写、去空白/'-'/'='（与 tools/src/stratum.mjs 的 normalizeSecret 一致）。 */
export function canonicalSecretForId(secret) {
  return normalizeProtocolSecret(secret);
}

/** 协议 account.id：'s_' + sha1(规范 secret 十六进制)[0:12]。 */
export function secretToAccountId(secret) {
  const hex = createHash('sha1').update(canonicalSecretForId(secret), 'utf8').digest('hex');
  return 's_' + hex.slice(0, 12);
}

function pickCategory(secret, bindingsBySecret, categoryById) {
  const candidates = [];
  const bindings = bindingsBySecret.get(secret) || [];
  for (const binding of bindings) {
    const category = categoryById.get(binding.categoryId);
    if (!category) {
      continue;
    }
    candidates.push({ category, bindingRanking: binding.ranking });
  }
  if (candidates.length === 0) {
    return { name: DEFAULT_CATEGORY, categoryRanking: Number.POSITIVE_INFINITY, bindingRanking: Number.POSITIVE_INFINITY };
  }
  candidates.sort(function (left, right) {
    if (left.bindingRanking !== right.bindingRanking) {
      return left.bindingRanking - right.bindingRanking;
    }
    if (left.category.ranking !== right.category.ranking) {
      return left.category.ranking - right.category.ranking;
    }
    return compareStrings(left.category.name, right.category.name);
  });
  const chosen = candidates[0];
  return { name: chosen.category.name, categoryRanking: chosen.category.ranking, bindingRanking: chosen.bindingRanking };
}

/**
 * 明文 Stratum 备份 → 协议 account 列表 + 跳过报告。
 * 排序规则（参考实现，文档未强制）：分类内按 AuthenticatorCategories.Ranking，
 * 分类之间按 Category.Ranking，无分类归入「默认分类」排最后；同键按 Authenticator.Ranking、secret。
 */
export function mapBackupToAccounts(backup, options) {
  const opts = options || {};
  const updatedAt = opts.updatedAt == null ? FIXTURE_UPDATED_AT : opts.updatedAt;
  const authenticators = toArray(readField(backup, 'authenticators'));
  const categories = toArray(readField(backup, 'categories'));
  const bindings = toArray(readField(backup, 'authenticatorCategories'));

  const categoryById = new Map();
  categories.forEach(function (category, index) {
    const id = asString(readField(category, 'id'));
    categoryById.set(id, {
      id,
      name: asString(readField(category, 'name')),
      ranking: numberOr(readField(category, 'ranking'), index)
    });
  });

  const bindingsBySecret = new Map();
  for (const binding of bindings) {
    const secret = canonicalSecretForId(asString(readField(binding, 'authenticatorSecret')));
    const list = bindingsBySecret.get(secret) || [];
    list.push({
      categoryId: asString(readField(binding, 'categoryId')),
      ranking: numberOr(readField(binding, 'ranking'), 0)
    });
    bindingsBySecret.set(secret, list);
  }

  const entries = [];
  const skipped = [];
  const seenSecrets = new Set();

  authenticators.forEach(function (authenticator, stratumIndex) {
    const issuer = asString(readField(authenticator, 'issuer'));
    const username = asString(readField(authenticator, 'username'));
    const rawSecret = readField(authenticator, 'secret');
    const secret = typeof rawSecret === 'string' ? rawSecret.trim() : '';

    function skip(code, reason) {
      skipped.push({ stratumIndex, issuer, username, code, reason });
    }

    const type = readField(authenticator, 'type');
    const typeNumber = Number(type);
    const isSteam = typeNumber === STRATUM_TYPE.STEAM;
    if (typeNumber !== STRATUM_TYPE.TOTP && !isSteam) {
      skip('UNSUPPORTED_OTP_TYPE', 'Type=' + asString(type) + ' 不受支持（仅 TOTP=2 / Steam=4）');
      return;
    }
    if (!secret) {
      skip('EMPTY_SECRET', 'secret 为空');
      return;
    }
    if (!isValidStratumSecret(secret)) {
      skip('INVALID_BASE32', '非法 Base32（要求 A-Z2-7，允许 = 填充）');
      return;
    }
    const canonical = canonicalSecretForId(secret);
    if (seenSecrets.has(canonical)) {
      skip('DUPLICATE_SECRET', '与前面的条目 secret 重复（Stratum 以 secret 为主键）');
      return;
    }

    let algorithm;
    let digits;
    let period;
    let otpType;
    if (isSteam) {
      // SteamOtp 固定 5 位 / 30s / SHA1；忽略备份中存储的 Digits/Period/Algorithm
      otpType = 'steam';
      algorithm = 0;
      digits = 5;
      period = 30;
    } else {
      const algorithmValue = readField(authenticator, 'algorithm');
      algorithm = algorithmValue == null ? 0 : Number(algorithmValue);
      if (algorithm !== 0 && algorithm !== 1 && algorithm !== 2) {
        skip('INVALID_ALGORITHM', 'Algorithm=' + asString(algorithmValue) + ' 不是 0/1/2');
        return;
      }

      const digitsValue = readField(authenticator, 'digits');
      digits = digitsValue == null ? 6 : Number(digitsValue);
      if (!Number.isInteger(digits) || digits < 6 || digits > 10) {
        skip('DIGITS_OUT_OF_RANGE', 'Digits=' + asString(digitsValue) + ' 不在 6-10');
        return;
      }

      const periodValue = readField(authenticator, 'period');
      period = periodValue == null ? 30 : Number(periodValue);
      if (!Number.isInteger(period) || period < 5 || period > 300) {
        skip('PERIOD_OUT_OF_RANGE', 'Period=' + asString(periodValue) + ' 不在 5-300');
        return;
      }
      otpType = 'totp';
    }

    if (issuer.trim() === '' && username.trim() === '') {
      skip('EMPTY_ISSUER_AND_USERNAME', 'issuer 与 username 同时为空');
      return;
    }

    const category = pickCategory(canonical, bindingsBySecret, categoryById);
    const authenticatorRanking = numberOr(readField(authenticator, 'ranking'), 0);
    const normalizedSecret = normalizeProtocolSecret(secret);
    const account = {
      id: secretToAccountId(normalizedSecret),
      issuer,
      accountName: username,
      category: category.name,
      secret: normalizedSecret,
      algorithm: ALGORITHM_NAMES[algorithm],
      digits,
      period,
      otpType,
      updatedAt
    };
    seenSecrets.add(canonical);
    entries.push({
      account,
      categoryRanking: category.categoryRanking,
      bindingRanking: category.bindingRanking,
      authenticatorRanking
    });
  });

  entries.sort(function (left, right) {
    const leftCategorized = Number.isFinite(left.categoryRanking);
    const rightCategorized = Number.isFinite(right.categoryRanking);
    if (leftCategorized !== rightCategorized) {
      return leftCategorized ? -1 : 1;
    }
    if (leftCategorized) {
      if (left.categoryRanking !== right.categoryRanking) {
        return left.categoryRanking - right.categoryRanking;
      }
      if (left.bindingRanking !== right.bindingRanking) {
        return left.bindingRanking - right.bindingRanking;
      }
    }
    if (left.authenticatorRanking !== right.authenticatorRanking) {
      return left.authenticatorRanking - right.authenticatorRanking;
    }
    return compareStrings(left.account.secret, right.account.secret);
  });

  const accounts = entries.map(function (entry) {
    return entry.account;
  });
  return {
    accounts,
    skipped,
    stats: { total: authenticators.length, imported: accounts.length, skipped: skipped.length }
  };
}

// ---------------------------------------------------------------- URI 列表
export function buildOtpAuthUri(account) {
  const issuer = asString(account.issuer);
  const accountName = asString(account.accountName);
  const label = encodeURIComponent(issuer ? issuer + ':' + accountName : accountName) || encodeURIComponent('account');
  if (account.otpType === 'steam') {
    // docs/stratum-format.md：Stratum 导出为 otpauth://totp/Steam:...；
    // issuer 不是 Steam 时追加裸 &steam 标记，保证导入端能识别。
    let steamUri = 'otpauth://totp/' + label + '?secret=' + canonicalSecretForId(account.secret);
    if (issuer) {
      steamUri += '&issuer=' + encodeURIComponent(issuer);
    }
    if (issuer.trim().toLowerCase() !== 'steam') {
      steamUri += '&steam';
    }
    return steamUri;
  }
  const params = new URLSearchParams();
  params.set('secret', canonicalSecretForId(account.secret));
  if (issuer) {
    params.set('issuer', issuer);
  }
  if (account.algorithm && account.algorithm !== 'SHA1') {
    params.set('algorithm', account.algorithm);
  }
  if (account.digits && Number(account.digits) !== 6) {
    params.set('digits', String(account.digits));
  }
  if (account.period && Number(account.period) !== 30) {
    params.set('period', String(account.period));
  }
  return 'otpauth://totp/' + label + '?' + params.toString();
}

export function parseOtpAuthUri(uri, options) {
  const opts = options || {};
  const updatedAt = opts.updatedAt == null ? FIXTURE_UPDATED_AT : opts.updatedAt;
  const text = String(uri == null ? '' : uri).trim();
  let url;
  try {
    url = new URL(text);
  } catch (error) {
    return { ok: false, code: 'INVALID_URI', reason: '无法解析的 otpauth URI' };
  }
  if (url.protocol !== 'otpauth:') {
    return { ok: false, code: 'INVALID_URI', reason: '不是 otpauth:// URI' };
  }
  const type = url.host.toLowerCase();
  if (type !== 'totp') {
    return { ok: false, code: 'TYPE_NOT_TOTP', reason: 'otpauth 类型 ' + type + ' 不是 totp' };
  }
  const labelRaw = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  const separatorIndex = labelRaw.indexOf(':');
  const labelIssuer = separatorIndex >= 0 ? labelRaw.slice(0, separatorIndex) : '';
  const labelName = separatorIndex >= 0 ? labelRaw.slice(separatorIndex + 1) : labelRaw;
  const params = url.searchParams;
  const issuer = params.get('issuer') == null ? labelIssuer : params.get('issuer');
  const accountName = labelName === '' ? labelIssuer : labelName;
  const secretRaw = params.get('secret');
  if (!secretRaw || !isValidProtocolSecret(secretRaw)) {
    return { ok: false, code: 'INVALID_BASE32', reason: 'secret 缺失或非法 Base32' };
  }
  const issuerText = issuer == null ? '' : String(issuer);
  const accountNameText = accountName == null ? '' : String(accountName);
  if (issuerText.trim() === '' && accountNameText.trim() === '') {
    return { ok: false, code: 'EMPTY_ISSUER_AND_USERNAME', reason: 'issuer 与 username 同时为空' };
  }

  // docs/stratum-format.md：任一命中即按 Steam 导入：
  // 裸 steam 标记 / encoder=steam / issuer 或 label 前缀为 Steam（大小写不敏感）；
  // digits=5 且 issuer 为 Steam 被 issuer 前缀规则覆盖。
  const issuerLower = issuerText.trim().toLowerCase();
  const labelLower = labelRaw.trim().toLowerCase();
  const encoder = String(params.get('encoder') || '').toLowerCase();
  const isSteam =
    params.has('steam') ||
    encoder === 'steam' ||
    issuerLower.startsWith('steam') ||
    labelLower.startsWith('steam');
  const secret = normalizeProtocolSecret(secretRaw).toUpperCase();
  if (isSteam) {
    return {
      ok: true,
      account: {
        id: secretToAccountId(secret),
        issuer: issuerText,
        accountName: accountNameText,
        category: DEFAULT_CATEGORY,
        secret,
        algorithm: 'SHA1',
        digits: 5,
        period: 30,
        otpType: 'steam',
        updatedAt
      }
    };
  }

  const algorithm = String(params.get('algorithm') || 'SHA1').toUpperCase();
  if (ALGORITHM_NAMES.indexOf(algorithm) < 0) {
    return { ok: false, code: 'INVALID_ALGORITHM', reason: 'algorithm=' + algorithm + ' 不受支持' };
  }
  const digits = params.get('digits') == null ? 6 : Number(params.get('digits'));
  if (!Number.isInteger(digits) || digits < 6 || digits > 10) {
    return { ok: false, code: 'DIGITS_OUT_OF_RANGE', reason: 'digits=' + String(params.get('digits')) + ' 不在 6-10' };
  }
  const period = params.get('period') == null ? 30 : Number(params.get('period'));
  if (!Number.isInteger(period) || period < 5 || period > 300) {
    return { ok: false, code: 'PERIOD_OUT_OF_RANGE', reason: 'period=' + String(params.get('period')) + ' 不在 5-300' };
  }
  return {
    ok: true,
    account: {
      id: secretToAccountId(secret),
      issuer: issuerText,
      accountName: accountNameText,
      category: DEFAULT_CATEGORY,
      secret,
      algorithm,
      digits,
      period,
      otpType: 'totp',
      updatedAt
    }
  };
}

export function parseUriList(text, options) {
  const lines = String(text == null ? '' : text)
    .split(/\r?\n/)
    .map(function (line) {
      return line.trim();
    })
    .filter(Boolean);
  const accounts = [];
  const skipped = [];
  lines.forEach(function (line, index) {
    const result = parseOtpAuthUri(line, options);
    if (result.ok) {
      accounts.push(result.account);
    } else {
      skipped.push({ lineNumber: index + 1, uri: line, code: result.code, reason: result.reason });
    }
  });
  return { accounts, skipped, stats: { total: lines.length, imported: accounts.length, skipped: skipped.length } };
}
