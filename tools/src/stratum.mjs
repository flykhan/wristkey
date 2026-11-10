import crypto from "node:crypto";
import { argon2id } from "hash-wasm";

export const STRONG_HEADER = "AUTHENTICATORPRO";
export const LEGACY_HEADER = "AuthenticatorPro";
export const DEFAULT_CATEGORY = "默认分类";
export const BASE32_RE = /^[A-Z2-7]+$/;

// ---- 格式嗅探 ----------------------------------------------------------

export function detectFormat(buf) {
  if (buf.length >= 16) {
    const head = buf.subarray(0, 16).toString("latin1");
    if (head === STRONG_HEADER) return "strong";
    if (head === LEGACY_HEADER) return "legacy";
  }
  const text = buf.toString("utf8").replace(/^\uFEFF/, "").trimStart();
  if (text.startsWith("{")) {
    try {
      const json = JSON.parse(text);
      if (getKey(json, "Authenticators")) return "plain";
      if (getKey(json, "entries")) return "aegis"; // 预留
      return "json-unknown";
    } catch (e) {
      return "text";
    }
  }
  if (/^otpauth:\/\//im.test(text)) return "uri-list";
  return "unknown";
}

// ---- 解密 --------------------------------------------------------------

export async function decryptStrong(buf, password) {
  assertHeader(buf, STRONG_HEADER);
  const salt = buf.subarray(16, 32);
  const iv = buf.subarray(32, 44);
  const payload = buf.subarray(44);
  if (payload.length <= 16) throw new Error("strong backup payload too short");
  const tag = payload.subarray(payload.length - 16);
  const ciphertext = payload.subarray(0, payload.length - 16);
  const key = await argon2id({
    password,
    salt,
    parallelism: 4,
    iterations: 3,
    memorySize: 65536, // KiB (64 MiB)
    hashLength: 32,
    outputType: "binary"
  });
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch (e) {
    throw badPasswordError();
  }
}

export function decryptLegacy(buf, password) {
  assertHeader(buf, LEGACY_HEADER);
  const salt = buf.subarray(16, 36);
  const iv = buf.subarray(36, 52);
  const ciphertext = buf.subarray(52);
  const key = crypto.pbkdf2Sync(password, salt, 64000, 32, "sha1");
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch (e) {
    throw badPasswordError();
  }
}

function badPasswordError() {
  const err = new Error("密码错误或备份文件损坏");
  err.code = "BAD_PASSWORD";
  return err;
}

function assertHeader(buf, header) {
  if (buf.length < 16 || buf.subarray(0, 16).toString("latin1") !== header) {
    throw new Error("备份文件头不匹配：" + header);
  }
}

// ---- 解析 --------------------------------------------------------------

export function parseBackupJson(text) {
  const json = JSON.parse(text);
  if (!getKey(json, "Authenticators")) throw new Error("不是 Stratum 备份：缺少 Authenticators");
  return json;
}

export function parseUriList(text) {
  const accounts = [];
  const skipped = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (!/^otpauth:\/\//i.test(line)) {
      skipped.push({ issuer: "", accountName: "", reason: "不是 otpauth:// 行" });
      continue;
    }
    try {
      accounts.push(parseOtpAuthUri(line));
    } catch (e) {
      skipped.push({ issuer: "", accountName: "", reason: e.message });
    }
  }
  return { accounts, skipped };
}

export function parseOtpAuthUri(raw) {
  const url = new URL(raw);
  if (url.protocol !== "otpauth:") throw new Error("不是 otpauth 链接");
  const kind = (url.host || "").toLowerCase();
  if (kind !== "totp") throw new Error("仅支持 TOTP（当前为 " + kind + "）");
  const label = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const params = url.searchParams;
  const secret = normalizeSecret(params.get("secret") || "");
  if (!isValidBase32(secret)) throw new Error("secret 不是合法 Base32");
  const parts = label.split(":");
  const labelIssuer = parts.length > 1 ? parts[0].trim() : "";
  const accountName = (parts.length > 1 ? parts.slice(1).join(":") : label).trim();
  const issuer = (params.get("issuer") || labelIssuer || "").trim();
  if (!issuer && !accountName) throw new Error("issuer 与 accountName 均为空");
  // Steam 标记：裸 &steam（Stratum）、encoder=steam（Aegis）或 issuer/label 前缀 Steam
  const encoder = (params.get("encoder") || "").toLowerCase();
  const isSteam =
    params.has("steam") ||
    encoder === "steam" ||
    issuer.toLowerCase() === "steam" ||
    labelIssuer.toLowerCase() === "steam";

  if (isSteam) {
    return {
      id: deriveId(secret),
      issuer: issuer || "Steam",
      accountName,
      category: DEFAULT_CATEGORY,
      secret,
      algorithm: "SHA1",
      digits: 5,
      period: 30,
      otpType: "steam",
      updatedAt: Date.now()
    };
  }

  const algorithm = (params.get("algorithm") || "SHA1").toUpperCase();
  if (!["SHA1", "SHA256", "SHA512"].includes(algorithm)) throw new Error("不支持的算法 " + algorithm);
  const digits = Number(params.get("digits") || 6);
  const period = Number(params.get("period") || 30);
  if (!(digits >= 6 && digits <= 10)) throw new Error("digits 越界：" + digits);
  if (!(period >= 5 && period <= 300)) throw new Error("period 越界：" + period);
  return {
    id: deriveId(secret),
    issuer,
    accountName,
    category: DEFAULT_CATEGORY,
    secret,
    algorithm,
    digits,
    period,
    otpType: "totp",
    updatedAt: Date.now()
  };
}

// ---- 映射到同步快照 ------------------------------------------------------

const TYPE_NAMES = { 1: "HOTP", 2: "TOTP", 3: "Mobile-OTP", 4: "Steam", 5: "Yandex" };

export function mapStratumBackup(backup) {
  const auths = asArray(getKey(backup, "Authenticators"));
  const categories = asArray(getKey(backup, "Categories"));
  const links = asArray(getKey(backup, "AuthenticatorCategories"));

  const catById = new Map();
  const catRanking = new Map();
  for (const c of categories) {
    const id = str(getKey(c, "Id"));
    const name = str(getKey(c, "Name")).trim();
    if (!id || !name) continue;
    catById.set(id, name);
    catRanking.set(name, num(getKey(c, "Ranking"), 0));
  }

  // secret -> 分类（同一账号多分类时取 AuthenticatorCategory.Ranking 最小者）
  const secretCategory = new Map();
  for (const link of links) {
    const secret = normalizeSecret(str(getKey(link, "AuthenticatorSecret")));
    const catId = str(getKey(link, "CategoryId"));
    const name = catById.get(catId);
    if (!secret || !name) continue;
    const ranking = num(getKey(link, "Ranking"), 0);
    const prev = secretCategory.get(secret);
    if (!prev || ranking < prev.ranking) {
      secretCategory.set(secret, { name, ranking });
    }
  }

  const accounts = [];
  const skipped = [];
  const seenSecrets = new Set();

  for (const auth of auths) {
    const type = num(getKey(auth, "Type"), 2);
    const issuer = str(getKey(auth, "Issuer")).trim();
    const accountName = str(getKey(auth, "Username")).trim();
    const rawSecret = str(getKey(auth, "Secret"));
    const secret = normalizeSecret(rawSecret);
    const label = issuer || accountName || "(无名称)";
    const skip = (reason) => skipped.push({ issuer, accountName, secret: maskSecret(secret), reason });

    const isSteam = type === 4;
    if (type !== 2 && !isSteam) {
      skip("不支持的 OTP 类型：" + (TYPE_NAMES[type] || type));
      continue;
    }
    if (!issuer && !accountName) {
      skip("issuer 与 accountName 均为空");
      continue;
    }
    if (!isValidBase32(secret)) {
      skip("secret 不是合法 Base32（A-Z2-7）");
      continue;
    }
    if (seenSecrets.has(secret)) {
      skip("secret 重复（Stratum 主键重复）");
      continue;
    }
    // Steam Guard 固定 5 位 / 30 秒 / SHA1（忽略备份中的 Digits/Period/Algorithm）
    let algorithm;
    let digits;
    let period;
    if (isSteam) {
      algorithm = "SHA1";
      digits = 5;
      period = 30;
    } else {
      algorithm = algorithmName(num(getKey(auth, "Algorithm"), 0));
      if (!algorithm) {
        skip("不支持的算法编号");
        continue;
      }
      digits = num(getKey(auth, "Digits"), 6);
      if (!(digits >= 6 && digits <= 10)) {
        skip("digits 越界：" + digits);
        continue;
      }
      period = num(getKey(auth, "Period"), 30);
      if (!(period >= 5 && period <= 300)) {
        skip("period 越界：" + period);
        continue;
      }
    }

    const category = secretCategory.get(secret)?.name || DEFAULT_CATEGORY;
    const ranking = num(getKey(auth, "Ranking"), 0);
    const updatedAt = Date.now();
    seenSecrets.add(secret);
    accounts.push({
      id: deriveId(secret),
      issuer,
      accountName,
      category,
      secret,
      algorithm,
      digits,
      period,
      otpType: isSteam ? "steam" : "totp",
      updatedAt,
      // 内部排序用，输出 snapshot 前删除
      _ranking: ranking,
      _categoryRanking: catRanking.get(category) ?? 0
    });
    void label;
  }

  accounts.sort((a, b) => {
    if (a._categoryRanking !== b._categoryRanking) return a._categoryRanking - b._categoryRanking;
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    if (a._ranking !== b._ranking) return a._ranking - b._ranking;
    return (a.issuer + " " + a.accountName).localeCompare(b.issuer + " " + b.accountName);
  });
  const cleanAccounts = accounts.map(({ _ranking, _categoryRanking, ...rest }) => rest);
  return { accounts: cleanAccounts, skipped };
}

export function buildSnapshot(accounts, now) {
  return {
    version: 2,
    updatedAt: now || Date.now(),
    accounts: accounts.map((a) => ({
      id: a.id,
      issuer: a.issuer,
      accountName: a.accountName,
      category: a.category,
      secret: a.secret,
      algorithm: a.algorithm,
      digits: a.digits,
      period: a.period,
      otpType: a.otpType || "totp",
      updatedAt: a.updatedAt
    }))
  };
}

// ---- 工具 --------------------------------------------------------------

export function normalizeSecret(value) {
  return String(value || "").toUpperCase().replace(/[\s=-]/g, "");
}

export function isValidBase32(secret) {
  return typeof secret === "string" && secret.length >= 8 && BASE32_RE.test(secret);
}

export function deriveId(secret) {
  const hex = crypto.createHash("sha1").update(normalizeSecret(secret), "utf8").digest("hex");
  return "s_" + hex.slice(0, 12);
}

function algorithmName(value) {
  switch (value) {
    case 0: return "SHA1";
    case 1: return "SHA256";
    case 2: return "SHA512";
    default: return null;
  }
}

export function maskSecret(secret) {
  if (!secret) return "";
  if (secret.length <= 8) return "*".repeat(secret.length);
  return secret.slice(0, 4) + "..." + secret.slice(-4);
}

function getKey(obj, key) {
  if (!obj || typeof obj !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  const lower = key.charAt(0).toLowerCase() + key.slice(1);
  if (Object.prototype.hasOwnProperty.call(obj, lower)) return obj[lower];
  return undefined;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function str(value) {
  return value === null || value === undefined ? "" : String(value);
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
