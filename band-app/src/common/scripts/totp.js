/**
 * WristKey band app - pure TOTP/HOTP primitives.
 *
 * This module deliberately has NO dependency on the Vela runtime (@system.*),
 * so it can be unit-tested with plain Node.js (see tests/totp.test.mjs).
 *
 * Contents:
 *   - Base32 normalisation/decoding (A-Z2-7; spaces and '=' padding tolerated)
 *   - HMAC-SHA1 / HMAC-SHA256 / HMAC-SHA512 implemented in pure JS using
 *     32-bit integer arithmetic only (Math.imul and >>> keep values in range)
 *   - RFC 4226 HOTP / RFC 6238 TOTP
 *   - token view-model helpers (code grouping, countdown, progress)
 *
 * Digit counts 6-10 use the standard RFC 4226 31-bit dynamic truncation and
 * then modulus 10^digits, so 9/10 digit codes keep leading zeros. This matches
 * the convention used by the Android side (documented in NOTICE.md).
 *
 * Test vectors: RFC 6238 appendix B (SHA1/SHA256/SHA512, T=59,
 * 1111111109, 1111111111, 1234567890, 8 digits).
 */

export const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
export const ALGORITHMS = ["SHA1", "SHA256", "SHA512"]
export const DEFAULT_ALGORITHM = "SHA1"
export const DEFAULT_DIGITS = 6
export const DEFAULT_PERIOD = 30
export const MIN_DIGITS = 6
export const MAX_DIGITS = 10
export const MIN_PERIOD = 5
export const MAX_PERIOD = 300

// Steam Guard codes are not numeric TOTP: 5 characters from a custom alphabet,
// fixed 30 s period and HMAC-SHA1 (docs/protocol.md, "Steam Guard").
export const OTP_TYPE_TOTP = "totp"
export const OTP_TYPE_STEAM = "steam"
export const OTP_TYPES = [OTP_TYPE_TOTP, OTP_TYPE_STEAM]
export const STEAM_ALPHABET = "23456789BCDFGHJKMNPQRTVWXY"
export const STEAM_DIGITS = 5
export const STEAM_PERIOD = 30

const BLOCK_SIZES = { SHA1: 64, SHA256: 64, SHA512: 128 }
const HASH_FUNCTIONS = { SHA1: sha1, SHA256: sha256, SHA512: sha512 }

// SHA-256 round constants: floor(frac(cbrt(prime_i)) * 2^32), i = 0..63.
const K256 = [
  "428a2f98", "71374491", "b5c0fbcf", "e9b5dba5", "3956c25b", "59f111f1",
  "923f82a4", "ab1c5ed5", "d807aa98", "12835b01", "243185be", "550c7dc3",
  "72be5d74", "80deb1fe", "9bdc06a7", "c19bf174", "e49b69c1", "efbe4786",
  "0fc19dc6", "240ca1cc", "2de92c6f", "4a7484aa", "5cb0a9dc", "76f988da",
  "983e5152", "a831c66d", "b00327c8", "bf597fc7", "c6e00bf3", "d5a79147",
  "06ca6351", "14292967", "27b70a85", "2e1b2138", "4d2c6dfc", "53380d13",
  "650a7354", "766a0abb", "81c2c92e", "92722c85", "a2bfe8a1", "a81a664b",
  "c24b8b70", "c76c51a3", "d192e819", "d6990624", "f40e3585", "106aa070",
  "19a4c116", "1e376c08", "2748774c", "34b0bcb5", "391c0cb3", "4ed8aa4a",
  "5b9cca4f", "682e6ff3", "748f82ee", "78a5636f", "84c87814", "8cc70208",
  "90befffa", "a4506ceb", "bef9a3f7", "c67178f2"
].map(hex => parseInt(hex, 16))

// SHA-512 round constants: floor(frac(cbrt(prime_i)) * 2^64), i = 0..79.
const K512_HEX = [
  "428a2f98d728ae22", "7137449123ef65cd", "b5c0fbcfec4d3b2f", "e9b5dba58189dbbc",
  "3956c25bf348b538", "59f111f1b605d019", "923f82a4af194f9b", "ab1c5ed5da6d8118",
  "d807aa98a3030242", "12835b0145706fbe", "243185be4ee4b28c", "550c7dc3d5ffb4e2",
  "72be5d74f27b896f", "80deb1fe3b1696b1", "9bdc06a725c71235", "c19bf174cf692694",
  "e49b69c19ef14ad2", "efbe4786384f25e3", "0fc19dc68b8cd5b5", "240ca1cc77ac9c65",
  "2de92c6f592b0275", "4a7484aa6ea6e483", "5cb0a9dcbd41fbd4", "76f988da831153b5",
  "983e5152ee66dfab", "a831c66d2db43210", "b00327c898fb213f", "bf597fc7beef0ee4",
  "c6e00bf33da88fc2", "d5a79147930aa725", "06ca6351e003826f", "142929670a0e6e70",
  "27b70a8546d22ffc", "2e1b21385c26c926", "4d2c6dfc5ac42aed", "53380d139d95b3df",
  "650a73548baf63de", "766a0abb3c77b2a8", "81c2c92e47edaee6", "92722c851482353b",
  "a2bfe8a14cf10364", "a81a664bbc423001", "c24b8b70d0f89791", "c76c51a30654be30",
  "d192e819d6ef5218", "d69906245565a910", "f40e35855771202a", "106aa07032bbd1b8",
  "19a4c116b8d2d0c8", "1e376c085141ab53", "2748774cdf8eeb99", "34b0bcb5e19b48a8",
  "391c0cb3c5c95a63", "4ed8aa4ae3418acb", "5b9cca4f7763e373", "682e6ff3d6b2b8a3",
  "748f82ee5defb2fc", "78a5636f43172f60", "84c87814a1f0ab72", "8cc702081a6439ec",
  "90befffa23631e28", "a4506cebde82bde9", "bef9a3f7b2c67915", "c67178f2e372532b",
  "ca273eceea26619c", "d186b8c721c0c207", "eada7dd6cde0eb1e", "f57d4f7fee6ed178",
  "06f067aa72176fba", "0a637dc5a2c898a6", "113f9804bef90dae", "1b710b35131c471b",
  "28db77f523047d84", "32caab7b40c72493", "3c9ebe0a15c9bebc", "431d67c49c100d4c",
  "4cc5d4becb3e42b6", "597f299cfc657e2a", "5fcb6fab3ad6faec", "6c44198c4a475817"
]
const K512 = K512_HEX.map(hexToPair)
const H512 = [
  "6a09e667f3bcc908", "bb67ae8584caa73b", "3c6ef372fe94f82b", "a54ff53a5f1d36f1",
  "510e527fade682d1", "9b05688c2b3e6c1f", "1f83d9abfb41bd6b", "5be0cd19137e2179"
].map(hexToPair)

/* --------------------------------------------------------------------------
 * Base32
 * ------------------------------------------------------------------------ */

/**
 * Normalise a Base32 secret.
 * @returns {{ok: true, value: string} | {ok: false, error: string}}
 */
export function normalizeBase32(input) {
  if (typeof input !== "string") {
    return { ok: false, error: "secret_not_string" }
  }
  const value = input.toUpperCase().replace(/[\s=]+/g, "")
  if (value.length === 0) {
    return { ok: false, error: "secret_empty" }
  }
  if (value.length > 1024) {
    return { ok: false, error: "secret_too_long" }
  }
  if (!/^[A-Z2-7]+$/.test(value)) {
    return { ok: false, error: "secret_invalid_char" }
  }
  return { ok: true, value: value }
}

/**
 * Decode a Base32 string to a byte array. Throws on invalid input; callers that
 * only need validation should use normalizeBase32().
 */
export function decodeBase32(input) {
  const normalized = normalizeBase32(input)
  if (!normalized.ok) {
    throw new Error("invalid base32 secret: " + normalized.error)
  }
  const value = normalized.value
  const bytes = []
  let bits = 0
  let bitLength = 0
  for (let index = 0; index < value.length; index++) {
    bits = (bits << 5) | BASE32_ALPHABET.indexOf(value[index])
    bitLength += 5
    if (bitLength >= 8) {
      bytes.push((bits >>> (bitLength - 8)) & 0xff)
      bitLength -= 8
    }
  }
  return bytes
}

/* --------------------------------------------------------------------------
 * Algorithms
 * ------------------------------------------------------------------------ */

/**
 * Normalise the OTP type. Missing/empty means "totp" (old snapshots and older
 * phone apps do not send otpType). Returns null for unknown values.
 */
export function normalizeOtpType(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return OTP_TYPE_TOTP
  }
  const name = String(value).trim().toLowerCase()
  if (name === OTP_TYPE_TOTP) {
    return OTP_TYPE_TOTP
  }
  if (name === OTP_TYPE_STEAM) {
    return OTP_TYPE_STEAM
  }
  return null
}

/** Normalise an algorithm name; returns null when unsupported. */
export function normalizeAlgorithm(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_ALGORITHM
  }
  const name = String(value).trim().toUpperCase()
  return HASH_FUNCTIONS[name] ? name : null
}

/** Normalise a digit count; returns null when out of the supported 6-10 range. */
export function normalizeDigits(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_DIGITS
  }
  const parsed = Number(value)
  if (!isFinite(parsed) || Math.floor(parsed) !== parsed) {
    return null
  }
  if (parsed < MIN_DIGITS || parsed > MAX_DIGITS) {
    return null
  }
  return parsed
}

/** Normalise a period (seconds); returns null when out of the supported 5-300 range. */
export function normalizePeriod(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_PERIOD
  }
  const parsed = Number(value)
  if (!isFinite(parsed) || Math.floor(parsed) !== parsed) {
    return null
  }
  if (parsed < MIN_PERIOD || parsed > MAX_PERIOD) {
    return null
  }
  return parsed
}

/** Digest helper (mostly useful for tests): hash bytes with SHA1/SHA256/SHA512. */
export function digest(algorithm, messageBytes) {
  const name = normalizeAlgorithm(algorithm)
  if (!name) {
    throw new Error("unsupported algorithm: " + algorithm)
  }
  return HASH_FUNCTIONS[name](messageBytes.slice(0))
}

/* --------------------------------------------------------------------------
 * HMAC / HOTP / TOTP
 * ------------------------------------------------------------------------ */

/** 8-byte big-endian counter encoding (RFC 4226). */
export function counterToBytes(counter) {
  const bytes = new Array(8)
  let remaining = Math.floor(counter)
  for (let index = 7; index >= 0; index--) {
    bytes[index] = remaining % 256
    remaining = Math.floor(remaining / 256)
  }
  return bytes
}

/** HMAC with SHA1/SHA256/SHA512. */
export function hmac(algorithm, keyBytes, messageBytes) {
  const name = normalizeAlgorithm(algorithm)
  if (!name) {
    throw new Error("unsupported algorithm: " + algorithm)
  }
  const hash = HASH_FUNCTIONS[name]
  const blockSize = BLOCK_SIZES[name]
  let key = keyBytes.slice(0)
  if (key.length > blockSize) {
    key = hash(key)
  }
  while (key.length < blockSize) {
    key.push(0)
  }
  const inner = new Array(blockSize)
  const outer = new Array(blockSize)
  for (let index = 0; index < blockSize; index++) {
    inner[index] = key[index] ^ 0x36
    outer[index] = key[index] ^ 0x5c
  }
  return hash(outer.concat(hash(inner.concat(messageBytes))))
}

/**
 * RFC 4226 HOTP value.
 * @param {string|number[]} secret Base32 string or raw key bytes
 * @param {number} counter moving factor
 * @param {number} [digits=6] 6-10
 * @param {string} [algorithm="SHA1"]
 * @returns {string} zero-padded code
 */
export function hotp(secret, counter, digits, algorithm) {
  const name = normalizeAlgorithm(algorithm)
  if (!name) {
    throw new Error("unsupported algorithm: " + algorithm)
  }
  const digitCount = normalizeDigits(digits)
  if (digitCount === null) {
    throw new Error("unsupported digits: " + digits)
  }
  if (!isFinite(counter) || counter < 0) {
    throw new Error("invalid counter: " + counter)
  }
  const keyBytes = typeof secret === "string" ? decodeBase32(secret) : secret
  const digestBytes = hmac(name, keyBytes, counterToBytes(counter))
  const offset = digestBytes[digestBytes.length - 1] & 0x0f
  const binary =
    (digestBytes[offset] & 0x7f) * 0x1000000 +
    (digestBytes[offset + 1] & 0xff) * 0x10000 +
    (digestBytes[offset + 2] & 0xff) * 0x100 +
    (digestBytes[offset + 3] & 0xff)
  const otp = binary % Math.pow(10, digitCount)
  return padLeft(String(otp), digitCount)
}

/**
 * RFC 6238 TOTP value.
 * @param {string|number[]} secret Base32 string or raw key bytes
 * @param {number} timestamp Unix time in milliseconds
 * @param {number} [period=30] seconds, 5-300
 * @param {number} [digits=6] 6-10
 * @param {string} [algorithm="SHA1"]
 * @returns {string} zero-padded code
 */
export function generateTotp(secret, timestamp, period, digits, algorithm) {
  const time = typeof timestamp === "number" ? timestamp : Date.now()
  const step = normalizePeriod(period)
  if (step === null) {
    throw new Error("unsupported period: " + period)
  }
  const counter = Math.floor(Math.floor(time / 1000) / step)
  return hotp(secret, counter, digits, algorithm)
}

/**
 * Steam Guard code: HMAC-SHA1 + RFC 4226 31-bit dynamic truncation, then five
 * divmod-26 steps emitting the least significant character first (this is the
 * order Steam clients display). Fixed 5 characters, 30 s period, SHA1.
 * @param {string|number[]} secret Base32 string or raw key bytes
 * @param {number} timestamp Unix time in milliseconds
 * @returns {string} 5 characters from STEAM_ALPHABET
 */
export function generateSteam(secret, timestamp) {
  const time = typeof timestamp === "number" ? timestamp : Date.now()
  const counter = Math.floor(Math.floor(time / 1000) / STEAM_PERIOD)
  const keyBytes = typeof secret === "string" ? decodeBase32(secret) : secret
  const digestBytes = hmac("SHA1", keyBytes, counterToBytes(counter))
  const offset = digestBytes[digestBytes.length - 1] & 0x0f
  let material =
    (digestBytes[offset] & 0x7f) * 0x1000000 +
    (digestBytes[offset + 1] & 0xff) * 0x10000 +
    (digestBytes[offset + 2] & 0xff) * 0x100 +
    (digestBytes[offset + 3] & 0xff)
  let code = ""
  for (let index = 0; index < STEAM_DIGITS; index++) {
    code += STEAM_ALPHABET.charAt(material % 26)
    material = Math.floor(material / 26)
  }
  return code
}

/* --------------------------------------------------------------------------
 * View model helpers (used by pages, safe to unit-test)
 * ------------------------------------------------------------------------ */

/**
 * Build the display state for one account at a given time.
 * Dispatches on account.otpType: "totp" (default, unchanged behaviour) or
 * "steam" (5 character Steam Guard code, never zero padded / digit grouped).
 * Never throws: an unusable secret results in a placeholder code and status.
 */
export function buildTokenState(account, now) {
  const timestamp = typeof now === "number" ? now : Date.now()
  const source = account || {}
  const otpType = normalizeOtpType(source.otpType) || OTP_TYPE_TOTP
  const isSteam = otpType === OTP_TYPE_STEAM
  const period = isSteam ? STEAM_PERIOD : (normalizePeriod(source.period) || DEFAULT_PERIOD)
  const digits = isSteam ? STEAM_DIGITS : (normalizeDigits(source.digits) || DEFAULT_DIGITS)
  const algorithm = isSteam
    ? "SHA1"
    : (normalizeAlgorithm(source.algorithm) || DEFAULT_ALGORITHM)
  const periodMilliseconds = period * 1000
  const elapsedMilliseconds = timestamp % periodMilliseconds
  const remainingMilliseconds = periodMilliseconds - elapsedMilliseconds
  const remaining = Math.ceil(remainingMilliseconds / 1000)

  const token = {
    id: source.id || "",
    issuer: source.issuer || "",
    accountName: source.accountName || "",
    category: source.category || "",
    otpType: otpType,
    isSteam: isSteam,
    algorithm: algorithm,
    digits: digits,
    period: period,
    code: repeat("-", digits),
    groupedCode: repeat("-", digits),
    remaining: remaining,
    progress: Math.round((remainingMilliseconds * 100) / periodMilliseconds),
    status: remaining <= 5 ? "即将刷新" : "可用",
    valid: false
  }

  try {
    const code = isSteam
      ? generateSteam(source.secret, timestamp)
      : generateTotp(source.secret, timestamp, period, digits, algorithm)
    token.code = code
    token.groupedCode = isSteam ? code : groupCode(code)
    token.valid = true
  } catch (error) {
    token.status = "密钥异常"
  }
  return token
}

/** Split a code for readability, e.g. "123456" -> "123 456". */
export function groupCode(code) {
  const value = String(code === undefined || code === null ? "" : code)
  if (value.length <= 4) {
    return value
  }
  const split = Math.ceil(value.length / 2)
  return value.slice(0, split) + " " + value.slice(split)
}

function padLeft(value, length) {
  let result = value
  while (result.length < length) {
    result = "0" + result
  }
  return result
}

function repeat(character, count) {
  let result = ""
  for (let index = 0; index < count; index++) {
    result += character
  }
  return result
}

/* --------------------------------------------------------------------------
 * SHA-1
 * ------------------------------------------------------------------------ */

function sha1(messageBytes) {
  const bytes = messageBytes.slice(0)
  const bitLength = bytes.length * 8
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) {
    bytes.push(0)
  }
  pushUint64BigEndian(bytes, bitLength)

  let h0 = 0x67452301
  let h1 = 0xefcdab89
  let h2 = 0x98badcfe
  let h3 = 0x10325476
  let h4 = 0xc3d2e1f0
  const words = new Array(80)

  for (let chunk = 0; chunk < bytes.length; chunk += 64) {
    for (let index = 0; index < 16; index++) {
      const offset = chunk + index * 4
      words[index] =
        ((bytes[offset] << 24) |
          (bytes[offset + 1] << 16) |
          (bytes[offset + 2] << 8) |
          bytes[offset + 3]) | 0
    }
    for (let index = 16; index < 80; index++) {
      words[index] = rotateLeft(
        words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16],
        1
      )
    }

    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4

    for (let index = 0; index < 80; index++) {
      let f
      let k
      if (index < 20) {
        f = (b & c) | (~b & d)
        k = 0x5a827999
      } else if (index < 40) {
        f = b ^ c ^ d
        k = 0x6ed9eba1
      } else if (index < 60) {
        f = (b & c) | (b & d) | (c & d)
        k = 0x8f1bbcdc
      } else {
        f = b ^ c ^ d
        k = 0xca62c1d6
      }
      const temp = (rotateLeft(a, 5) + f + e + k + words[index]) | 0
      e = d
      d = c
      c = rotateLeft(b, 30)
      b = a
      a = temp
    }

    h0 = (h0 + a) | 0
    h1 = (h1 + b) | 0
    h2 = (h2 + c) | 0
    h3 = (h3 + d) | 0
    h4 = (h4 + e) | 0
  }

  return wordsToBytes([h0, h1, h2, h3, h4])
}

/* --------------------------------------------------------------------------
 * SHA-256
 * ------------------------------------------------------------------------ */

function sha256(messageBytes) {
  const bytes = messageBytes.slice(0)
  const bitLength = bytes.length * 8
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) {
    bytes.push(0)
  }
  pushUint64BigEndian(bytes, bitLength)

  let h0 = 0x6a09e667
  let h1 = 0xbb67ae85
  let h2 = 0x3c6ef372
  let h3 = 0xa54ff53a
  let h4 = 0x510e527f
  let h5 = 0x9b05688c
  let h6 = 0x1f83d9ab
  let h7 = 0x5be0cd19
  const words = new Array(64)

  for (let chunk = 0; chunk < bytes.length; chunk += 64) {
    for (let index = 0; index < 16; index++) {
      const offset = chunk + index * 4
      words[index] =
        ((bytes[offset] << 24) |
          (bytes[offset + 1] << 16) |
          (bytes[offset + 2] << 8) |
          bytes[offset + 3]) | 0
    }
    for (let index = 16; index < 64; index++) {
      const previous15 = words[index - 15]
      const previous2 = words[index - 2]
      const s0 =
        rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3)
      const s1 =
        rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10)
      words[index] =
        (words[index - 16] + s0 + words[index - 7] + s1) | 0
    }

    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    let f = h5
    let g = h6
    let h = h7

    for (let index = 0; index < 64; index++) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      const choose = (e & f) ^ (~e & g)
      const temp1 = (h + sum1 + choose + K256[index] + words[index]) | 0
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (sum0 + majority) | 0
      h = g
      g = f
      f = e
      e = (d + temp1) | 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) | 0
    }

    h0 = (h0 + a) | 0
    h1 = (h1 + b) | 0
    h2 = (h2 + c) | 0
    h3 = (h3 + d) | 0
    h4 = (h4 + e) | 0
    h5 = (h5 + f) | 0
    h6 = (h6 + g) | 0
    h7 = (h7 + h) | 0
  }

  return wordsToBytes([h0, h1, h2, h3, h4, h5, h6, h7])
}

/* --------------------------------------------------------------------------
 * SHA-512 (64-bit words represented as [high, low] pairs of uint32)
 * ------------------------------------------------------------------------ */

function sha512(messageBytes) {
  const bytes = messageBytes.slice(0)
  const bitLength = bytes.length * 8
  bytes.push(0x80)
  while (bytes.length % 128 !== 112) {
    bytes.push(0)
  }
  // 128-bit big-endian length; the upper 64 bits are always zero here.
  pushUint64BigEndian(bytes, 0)
  pushUint64BigEndian(bytes, bitLength)

  const stateHi = H512.map(pair => pair[0])
  const stateLo = H512.map(pair => pair[1])
  const wordsHi = new Array(80)
  const wordsLo = new Array(80)

  for (let chunk = 0; chunk < bytes.length; chunk += 128) {
    for (let index = 0; index < 16; index++) {
      const offset = chunk + index * 8
      wordsHi[index] =
        ((bytes[offset] << 24) |
          (bytes[offset + 1] << 16) |
          (bytes[offset + 2] << 8) |
          bytes[offset + 3]) >>> 0
      wordsLo[index] =
        ((bytes[offset + 4] << 24) |
          (bytes[offset + 5] << 16) |
          (bytes[offset + 6] << 8) |
          bytes[offset + 7]) >>> 0
    }

    for (let index = 16; index < 80; index++) {
      const w15Hi = wordsHi[index - 15]
      const w15Lo = wordsLo[index - 15]
      const w2Hi = wordsHi[index - 2]
      const w2Lo = wordsLo[index - 2]
      const r15a = rotateRight64(w15Hi, w15Lo, 1)
      const r15b = rotateRight64(w15Hi, w15Lo, 8)
      const s15c = shiftRight64(w15Hi, w15Lo, 7)
      const s0Hi = (r15a[0] ^ r15b[0] ^ s15c[0]) >>> 0
      const s0Lo = (r15a[1] ^ r15b[1] ^ s15c[1]) >>> 0
      const r2a = rotateRight64(w2Hi, w2Lo, 19)
      const r2b = rotateRight64(w2Hi, w2Lo, 61)
      const s2c = shiftRight64(w2Hi, w2Lo, 6)
      const s1Hi = (r2a[0] ^ r2b[0] ^ s2c[0]) >>> 0
      const s1Lo = (r2a[1] ^ r2b[1] ^ s2c[1]) >>> 0
      const sum1 = add64(wordsHi[index - 16], wordsLo[index - 16], s0Hi, s0Lo)
      const sum2 = add64(sum1[0], sum1[1], wordsHi[index - 7], wordsLo[index - 7])
      const sum3 = add64(sum2[0], sum2[1], s1Hi, s1Lo)
      wordsHi[index] = sum3[0]
      wordsLo[index] = sum3[1]
    }

    let aHi = stateHi[0]
    let aLo = stateLo[0]
    let bHi = stateHi[1]
    let bLo = stateLo[1]
    let cHi = stateHi[2]
    let cLo = stateLo[2]
    let dHi = stateHi[3]
    let dLo = stateLo[3]
    let eHi = stateHi[4]
    let eLo = stateLo[4]
    let fHi = stateHi[5]
    let fLo = stateLo[5]
    let gHi = stateHi[6]
    let gLo = stateLo[6]
    let hHi = stateHi[7]
    let hLo = stateLo[7]

    for (let index = 0; index < 80; index++) {
      const eRot1 = rotateRight64(eHi, eLo, 14)
      const eRot2 = rotateRight64(eHi, eLo, 18)
      const eRot3 = rotateRight64(eHi, eLo, 41)
      const sum1Hi = (eRot1[0] ^ eRot2[0] ^ eRot3[0]) >>> 0
      const sum1Lo = (eRot1[1] ^ eRot2[1] ^ eRot3[1]) >>> 0
      const chooseHi = ((eHi & fHi) ^ (~eHi & gHi)) >>> 0
      const chooseLo = ((eLo & fLo) ^ (~eLo & gLo)) >>> 0

      let temp1 = add64(hHi, hLo, sum1Hi, sum1Lo)
      temp1 = add64(temp1[0], temp1[1], chooseHi, chooseLo)
      temp1 = add64(temp1[0], temp1[1], K512[index][0], K512[index][1])
      temp1 = add64(temp1[0], temp1[1], wordsHi[index], wordsLo[index])

      const aRot1 = rotateRight64(aHi, aLo, 28)
      const aRot2 = rotateRight64(aHi, aLo, 34)
      const aRot3 = rotateRight64(aHi, aLo, 39)
      const sum0Hi = (aRot1[0] ^ aRot2[0] ^ aRot3[0]) >>> 0
      const sum0Lo = (aRot1[1] ^ aRot2[1] ^ aRot3[1]) >>> 0
      const majorityHi = ((aHi & bHi) ^ (aHi & cHi) ^ (bHi & cHi)) >>> 0
      const majorityLo = ((aLo & bLo) ^ (aLo & cLo) ^ (bLo & cLo)) >>> 0
      const temp2 = add64(sum0Hi, sum0Lo, majorityHi, majorityLo)

      hHi = gHi
      hLo = gLo
      gHi = fHi
      gLo = fLo
      fHi = eHi
      fLo = eLo
      const nextE = add64(dHi, dLo, temp1[0], temp1[1])
      eHi = nextE[0]
      eLo = nextE[1]
      dHi = cHi
      dLo = cLo
      cHi = bHi
      cLo = bLo
      bHi = aHi
      bLo = aLo
      const nextA = add64(temp1[0], temp1[1], temp2[0], temp2[1])
      aHi = nextA[0]
      aLo = nextA[1]
    }

    let next = add64(stateHi[0], stateLo[0], aHi, aLo)
    stateHi[0] = next[0]
    stateLo[0] = next[1]
    next = add64(stateHi[1], stateLo[1], bHi, bLo)
    stateHi[1] = next[0]
    stateLo[1] = next[1]
    next = add64(stateHi[2], stateLo[2], cHi, cLo)
    stateHi[2] = next[0]
    stateLo[2] = next[1]
    next = add64(stateHi[3], stateLo[3], dHi, dLo)
    stateHi[3] = next[0]
    stateLo[3] = next[1]
    next = add64(stateHi[4], stateLo[4], eHi, eLo)
    stateHi[4] = next[0]
    stateLo[4] = next[1]
    next = add64(stateHi[5], stateLo[5], fHi, fLo)
    stateHi[5] = next[0]
    stateLo[5] = next[1]
    next = add64(stateHi[6], stateLo[6], gHi, gLo)
    stateHi[6] = next[0]
    stateLo[6] = next[1]
    next = add64(stateHi[7], stateLo[7], hHi, hLo)
    stateHi[7] = next[0]
    stateLo[7] = next[1]
  }

  const result = []
  for (let index = 0; index < 8; index++) {
    pushUint32BigEndian(result, stateHi[index])
    pushUint32BigEndian(result, stateLo[index])
  }
  return result
}

/* --------------------------------------------------------------------------
 * Shared helpers
 * ------------------------------------------------------------------------ */

function hexToPair(hex) {
  return [parseInt(hex.slice(0, 8), 16) >>> 0, parseInt(hex.slice(8, 16), 16) >>> 0]
}

function rotateLeft(value, bits) {
  return (value << bits) | (value >>> (32 - bits))
}

function rotateRight(value, bits) {
  return (value >>> bits) | (value << (32 - bits))
}

function rotateRight64(hi, lo, bits) {
  if (bits === 0) {
    return [hi >>> 0, lo >>> 0]
  }
  if (bits < 32) {
    return [
      ((hi >>> bits) | (lo << (32 - bits))) >>> 0,
      ((lo >>> bits) | (hi << (32 - bits))) >>> 0
    ]
  }
  if (bits === 32) {
    return [lo >>> 0, hi >>> 0]
  }
  return rotateRight64(lo, hi, bits - 32)
}

function shiftRight64(hi, lo, bits) {
  if (bits < 32) {
    return [hi >>> bits, ((lo >>> bits) | (hi << (32 - bits))) >>> 0]
  }
  if (bits === 32) {
    return [0, hi >>> 0]
  }
  return [0, hi >>> (bits - 32)]
}

function add64(aHi, aLo, bHi, bLo) {
  const lo = (aLo + bLo) >>> 0
  const carry = lo < (aLo >>> 0) ? 1 : 0
  const hi = (aHi + bHi + carry) >>> 0
  return [hi, lo]
}

function pushUint32BigEndian(bytes, value) {
  bytes.push((value >>> 24) & 0xff)
  bytes.push((value >>> 16) & 0xff)
  bytes.push((value >>> 8) & 0xff)
  bytes.push(value & 0xff)
}

function pushUint64BigEndian(bytes, value) {
  const high = Math.floor(value / 0x100000000)
  const low = value >>> 0
  pushUint32BigEndian(bytes, high)
  pushUint32BigEndian(bytes, low)
}

function wordsToBytes(words) {
  const bytes = []
  for (let index = 0; index < words.length; index++) {
    pushUint32BigEndian(bytes, words[index])
  }
  return bytes
}
