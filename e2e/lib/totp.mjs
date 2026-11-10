// WristKey e2e — 独立 TOTP 参考实现（node:crypto HMAC，不依赖 band-app 代码）。
// 依据 RFC 4226 / RFC 6238；用于 RFC 向量自检与跨端对拍。

import { createHmac } from 'node:crypto';
import { base32Decode } from './encoding.mjs';

export const ALGORITHMS = ['SHA1', 'SHA256', 'SHA512'];

const DIGEST_BY_ALGORITHM = {
  SHA1: 'sha1',
  SHA256: 'sha256',
  SHA512: 'sha512'
};

// RFC 6238 Appendix B 公开测试种子（ASCII），仅用于测试。
export const RFC6238_SEEDS = {
  SHA1: '12345678901234567890',
  SHA256: '12345678901234567890123456789012',
  SHA512: '1234567890123456789012345678901234567890123456789012345678901234'
};

// RFC 6238 Appendix B 期望值（8 位）。time 为 Unix 秒。
export const RFC6238_VECTORS = [
  { time: 59, SHA1: '94287082', SHA256: '46119246', SHA512: '90693936' },
  { time: 1111111109, SHA1: '07081804', SHA256: '68084774', SHA512: '25091201' },
  { time: 1111111111, SHA1: '14050471', SHA256: '67062674', SHA512: '99943326' },
  { time: 1234567890, SHA1: '89005924', SHA256: '91819424', SHA512: '93441116' },
  { time: 2000000000, SHA1: '69279037', SHA256: '90698825', SHA512: '38618901' },
  { time: 20000000000, SHA1: '65353130', SHA256: '77737706', SHA512: '47863826' }
];

// Steam Guard：5 位字母数字码，字母表固定（不是 10 的幂 / 不补零）。
export const STEAM_ALPHABET = '23456789BCDFGHJKMNPQRTVWXY';
export const STEAM_DIGITS = 5;
export const STEAM_PERIOD = 30;

export function steamTotp(secret, timeMs) {
  const seconds = Math.floor(Number(timeMs) / 1000);
  const counter = BigInt(Math.floor(seconds / STEAM_PERIOD));
  const key = typeof secret === 'string' ? base32Decode(secret) : Uint8Array.from(secret);
  const mac = createHmac('sha1', key).update(counterToBuffer(counter)).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  let material =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  let code = '';
  for (let index = 0; index < STEAM_DIGITS; index++) {
    code += STEAM_ALPHABET[material % 26];
    material = Math.floor(material / 26);
  }
  return code;
}

export function counterToBuffer(counter) {
  const value = typeof counter === 'bigint' ? counter : BigInt(counter);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(value);
  return buffer;
}

/** counter 可为 number / bigint / 十进制字符串。 */
export function hotp(secret, counter, options) {
  const opts = options || {};
  const digits = Number(opts.digits == null ? 6 : opts.digits);
  const algorithm = String(opts.algorithm == null ? 'SHA1' : opts.algorithm).toUpperCase();
  const digest = DIGEST_BY_ALGORITHM[algorithm];
  if (!digest) {
    throw new Error('unsupported algorithm: ' + algorithm);
  }
  if (!Number.isInteger(digits) || digits < 6 || digits > 10) {
    throw new Error('invalid digits: ' + digits);
  }
  const key = typeof secret === 'string' ? base32Decode(secret) : Uint8Array.from(secret);
  const mac = createHmac(digest, key).update(counterToBuffer(counter)).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  return String(binary % Math.pow(10, digits)).padStart(digits, '0');
}

export function totp(secret, timeMs, options) {
  const opts = options || {};
  const period = Number(opts.period == null ? 30 : opts.period);
  if (!Number.isInteger(period) || period <= 0) {
    throw new Error('invalid period: ' + period);
  }
  const seconds = Math.floor(Number(timeMs) / 1000);
  const counter = BigInt(Math.floor(seconds / period));
  return hotp(secret, counter, opts);
}

export function totpAtSeconds(secret, seconds, options) {
  return totp(secret, Number(seconds) * 1000, options);
}

export function rfc6238SecretBase32(algorithm) {
  const seed = RFC6238_SEEDS[algorithm];
  if (!seed) {
    throw new Error('unknown RFC 6238 algorithm: ' + algorithm);
  }
  return Buffer.from(seed, 'ascii').toString('base64');
}
