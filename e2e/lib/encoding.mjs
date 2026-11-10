// WristKey e2e — Base32 helpers (RFC 4648). 测试专用，不进入发布产物。
// 与 band-app/android-app 的实现相互独立，用于夹具生成与交叉验证。

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** 去掉空白与尾部填充，转大写：用于计算稳定的 secret 主键。 */
export function normalizeBase32(value) {
  return String(value == null ? '' : value)
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/=+$/, '');
}

/** 手环端归一化规则：去掉空白、'-'、'='，转大写（对齐 BandOTP 参考实现）。 */
export function normalizeProtocolSecret(value) {
  return String(value == null ? '' : value)
    .toUpperCase()
    .replace(/[\s=-]/g, '');
}

/** Stratum 明文备份要求：大写、无空格、允许 '=' 填充。 */
export function isValidStratumSecret(value) {
  return typeof value === 'string' && /^[A-Z2-7]+=*$/.test(value);
}

export function isValidProtocolSecret(value) {
  const normalized = normalizeProtocolSecret(value);
  return normalized.length > 0 && /^[A-Z2-7]+$/.test(normalized);
}

export function base32Encode(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || []);
  let bits = 0;
  let bitLength = 0;
  let out = '';
  for (let index = 0; index < data.length; index++) {
    bits = (bits << 8) | data[index];
    bitLength += 8;
    while (bitLength >= 5) {
      out += ALPHABET[(bits >>> (bitLength - 5)) & 0x1f];
      bitLength -= 5;
    }
  }
  if (bitLength > 0) {
    out += ALPHABET[(bits << (5 - bitLength)) & 0x1f];
  }
  while (out.length % 8 !== 0) {
    out += '=';
  }
  return out;
}

/** 宽松解码：忽略空白与填充；遇到非法字符抛错。 */
export function base32Decode(value) {
  const normalized = normalizeBase32(value);
  const bytes = [];
  let bits = 0;
  let bitLength = 0;
  for (let index = 0; index < normalized.length; index++) {
    const alphabetIndex = ALPHABET.indexOf(normalized[index]);
    if (alphabetIndex < 0) {
      throw new Error('invalid base32 character: ' + normalized[index]);
    }
    bits = (bits << 5) | alphabetIndex;
    bitLength += 5;
    if (bitLength >= 8) {
      bytes.push((bits >>> (bitLength - 8)) & 0xff);
      bitLength -= 8;
    }
  }
  return Uint8Array.from(bytes);
}

export function decodeBase32OrNull(value) {
  try {
    return base32Decode(value);
  } catch (error) {
    return null;
  }
}

export function bytesToHex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

export function utf8Bytes(value) {
  return Buffer.from(String(value == null ? '' : value), 'utf8');
}
