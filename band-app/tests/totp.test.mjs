import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"

import {
  buildTokenState,
  counterToBytes,
  decodeBase32,
  digest,
  generateSteam,
  generateTotp,
  groupCode,
  hmac,
  hotp,
  normalizeAlgorithm,
  normalizeBase32,
  normalizeDigits,
  normalizeOtpType,
  normalizePeriod,
  OTP_TYPE_STEAM,
  OTP_TYPE_TOTP,
  STEAM_ALPHABET,
  STEAM_DIGITS
} from "../src/common/scripts/totp.js"

// RFC 6238 appendix B seeds (public test data; never real credentials).
// SHA1   seed = "12345678901234567890"                  -> GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
// SHA256 seed = "12345678901234567890123456789012"      -> ...GEZA
// SHA512 seed = "12345678901234567890...1234" (64 bytes) -> ...GNA
const SEEDS = {
  SHA1: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
  SHA256: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA",
  SHA512:
    "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA"
}

// Raw seed bytes, used for the independent node:crypto reference implementation.
const SEED_BYTES = {
  SHA1: Buffer.from("12345678901234567890", "ascii"),
  SHA256: Buffer.from("12345678901234567890123456789012", "ascii"),
  SHA512: Buffer.from(
    "1234567890123456789012345678901234567890123456789012345678901234",
    "ascii"
  )
}

// RFC 6238 appendix B, 8 digits.
const RFC_TIMES = [59, 1111111109, 1111111111, 1234567890, 2000000000, 20000000000]
const RFC_EXPECTED = {
  SHA1: ["94287082", "07081804", "14050471", "89005924", "69279037", "65353130"],
  SHA256: ["46119246", "68084774", "67062674", "91819424", "90698825", "77737706"],
  SHA512: ["90693936", "25091201", "99943326", "93441116", "38618901", "47863826"]
}

function referenceHotp(algorithm, keyBytes, counter, digits) {
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const digestBytes = crypto
    .createHmac(algorithm.toLowerCase(), keyBytes)
    .update(message)
    .digest()
  const offset = digestBytes[digestBytes.length - 1] & 0x0f
  const binary =
    ((digestBytes[offset] & 0x7f) << 24) |
    ((digestBytes[offset + 1] & 0xff) << 16) |
    ((digestBytes[offset + 2] & 0xff) << 8) |
    (digestBytes[offset + 3] & 0xff)
  return String(binary % Math.pow(10, digits)).padStart(digits, "0")
}

test("RFC 6238 vectors: SHA1/SHA256/SHA512, 8 digits", () => {
  for (const algorithm of Object.keys(SEEDS)) {
    for (let index = 0; index < RFC_TIMES.length; index++) {
      const code = generateTotp(SEEDS[algorithm], RFC_TIMES[index] * 1000, 30, 8, algorithm)
      assert.equal(
        code,
        RFC_EXPECTED[algorithm][index],
        algorithm + " T=" + RFC_TIMES[index]
      )
    }
  }
})

test("SHA/HMAC digests match node:crypto across message and key sizes", () => {
  const lengths = [0, 1, 3, 55, 56, 63, 64, 111, 112, 127, 128, 129, 200]
  for (const algorithm of ["SHA1", "SHA256", "SHA512"]) {
    for (const length of lengths) {
      const message = crypto.randomBytes(length)
      const expected = crypto.createHash(algorithm.toLowerCase()).update(message).digest("hex")
      const actual = Buffer.from(digest(algorithm, Array.from(message))).toString("hex")
      assert.equal(actual, expected, algorithm + " hash length " + length)
    }
    for (const keyLength of [1, 20, 64, 65, 128, 129, 200]) {
      const key = crypto.randomBytes(keyLength)
      const message = crypto.randomBytes(37)
      const expected = crypto
        .createHmac(algorithm.toLowerCase(), key)
        .update(message)
        .digest("hex")
      const actual = Buffer.from(
        hmac(algorithm, Array.from(key), Array.from(message))
      ).toString("hex")
      assert.equal(actual, expected, algorithm + " hmac key length " + keyLength)
    }
  }
})

test("counter is encoded as 8-byte big endian", () => {
  assert.deepEqual(counterToBytes(0), [0, 0, 0, 0, 0, 0, 0, 0])
  assert.deepEqual(counterToBytes(1), [0, 0, 0, 0, 0, 0, 0, 1])
  assert.deepEqual(counterToBytes(0x01020304050607), [0, 1, 2, 3, 4, 5, 6, 7])
  assert.deepEqual(counterToBytes(0xffffffff), [0, 0, 0, 0, 255, 255, 255, 255])
  // Values above 2^32 must set the high word (counters stay below 2^53 in TOTP).
  assert.deepEqual(counterToBytes(0x100000000), [0, 0, 0, 1, 0, 0, 0, 0])
})

test("digits 6-10: length, zero padding and node:crypto agreement", () => {
  const timestamps = [59, 1111111109, 1234567890, 1700000000, 2000000000]
  const periods = [5, 30, 60, 300]
  for (const algorithm of Object.keys(SEED_BYTES)) {
    for (let digits = 6; digits <= 10; digits++) {
      for (const period of periods) {
        for (const timestamp of timestamps) {
          const code = generateTotp(
            SEEDS[algorithm],
            timestamp * 1000,
            period,
            digits,
            algorithm
          )
          const counter = Math.floor(timestamp / period)
          const expected = referenceHotp(algorithm, SEED_BYTES[algorithm], counter, digits)
          assert.equal(code, expected, algorithm + " " + digits + "d " + period + "s")
          assert.equal(code.length, digits)
          assert.match(code, /^[0-9]+$/)
        }
      }
    }
  }

  // 10-digit codes derive from the 31-bit RFC 4226 truncation, so some
  // timestamps need a leading zero to stay 10 digits long.
  let sawLeadingZero = false
  for (let timestamp = 0; timestamp < 120; timestamp++) {
    const tenDigit = generateTotp(SEEDS.SHA1, timestamp * 1000, 30, 10, "SHA1")
    assert.equal(tenDigit.length, 10)
    if (tenDigit.slice(0, 1) === "0") {
      sawLeadingZero = true
    }
  }
  assert.equal(sawLeadingZero, true)
  // Explicit RFC 6238 vector with a leading zero (8 digits).
  assert.equal(generateTotp(SEEDS.SHA1, 1111111109 * 1000, 30, 8, "SHA1"), "07081804")
})

test("hotp accepts raw key bytes and honours the counter", () => {
  const keyBytes = Array.from(Buffer.from("12345678901234567890", "ascii"))
  assert.equal(hotp(keyBytes, 1, 8, "SHA1"), "94287082")
  assert.notEqual(hotp(keyBytes, 1, 8, "SHA1"), hotp(keyBytes, 2, 8, "SHA1"))
})

test("period boundary rolls the code over", () => {
  const before = generateTotp(SEEDS.SHA1, 29999, 30, 6, "SHA1")
  const after = generateTotp(SEEDS.SHA1, 30000, 30, 6, "SHA1")
  assert.notEqual(before, after)
})

test("Base32 normalisation tolerates case, spaces and padding", () => {
  assert.deepEqual(normalizeBase32("JBSWY3DP"), { ok: true, value: "JBSWY3DP" })
  assert.deepEqual(normalizeBase32("jbsw y3dp===="), { ok: true, value: "JBSWY3DP" })
  assert.deepEqual(normalizeBase32(" JBSW Y3DP = "), { ok: true, value: "JBSWY3DP" })
  assert.deepEqual(normalizeBase32("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"), {
    ok: true,
    value: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
  })
})

test("Base32 rejects empty, non-string and non-alphabet input", () => {
  assert.equal(normalizeBase32("").ok, false)
  assert.equal(normalizeBase32("   ").ok, false)
  assert.equal(normalizeBase32(null).ok, false)
  assert.equal(normalizeBase32(12345).ok, false)
  assert.equal(normalizeBase32("JBSWY3DP1").ok, false)
  assert.equal(normalizeBase32("JBSWY3DP0").ok, false)
  assert.equal(normalizeBase32("JBSWY3DP8").ok, false)
  assert.equal(normalizeBase32("JBSWY3DP9").ok, false)
  assert.equal(normalizeBase32("JBSWY3DP-").ok, false)
  assert.equal(normalizeBase32("JBSWY3DP€").ok, false)
})

test("decodeBase32 output and error behaviour", () => {
  assert.deepEqual(decodeBase32("JBSWY3DP"), [72, 101, 108, 108, 111])
  assert.deepEqual(decodeBase32("jbsw y3dp===="), [72, 101, 108, 108, 111])
  // "MZXW6===" is "foo"
  assert.deepEqual(decodeBase32("MZXW6==="), [102, 111, 111])
  // Non-multiple-of-8 lengths are decoded bit by bit (protocol: pad support).
  assert.equal(decodeBase32("JBSWY3DPEHPK3PXP").length, 10)
  assert.throws(() => decodeBase32("JBSWY3DP1"), /invalid base32 secret/)
  assert.throws(() => decodeBase32(""), /invalid base32 secret/)
})

test("algorithm/digits/period normalisation", () => {
  assert.equal(normalizeAlgorithm("sha1"), "SHA1")
  assert.equal(normalizeAlgorithm("Sha256"), "SHA256")
  assert.equal(normalizeAlgorithm(undefined), "SHA1")
  assert.equal(normalizeAlgorithm("md5"), null)
  assert.equal(normalizeDigits(6), 6)
  assert.equal(normalizeDigits(10), 10)
  assert.equal(normalizeDigits(5), null)
  assert.equal(normalizeDigits(11), null)
  assert.equal(normalizeDigits(6.5), null)
  assert.equal(normalizeDigits(undefined), 6)
  assert.equal(normalizePeriod(5), 5)
  assert.equal(normalizePeriod(300), 300)
  assert.equal(normalizePeriod(4), null)
  assert.equal(normalizePeriod(301), null)
  assert.equal(normalizePeriod(undefined), 30)
  assert.throws(() => generateTotp(SEEDS.SHA1, 0, 4, 6, "SHA1"), /unsupported period/)
  assert.throws(() => generateTotp(SEEDS.SHA1, 0, 30, 11, "SHA1"), /unsupported digits/)
  assert.throws(() => generateTotp(SEEDS.SHA1, 0, 30, 6, "MD5"), /unsupported algorithm/)
})

test("groupCode splits 6/8/10 digit codes", () => {
  assert.equal(groupCode("123456"), "123 456")
  assert.equal(groupCode("12345678"), "1234 5678")
  assert.equal(groupCode("1234567890"), "12345 67890")
  assert.equal(groupCode("123"), "123")
})

test("buildTokenState reports countdown, progress and validity", () => {
  const account = {
    id: "a1",
    issuer: "GitHub",
    accountName: "me@example.com",
    category: "开发",
    secret: "JBSWY3DPEHPK3PXP",
    algorithm: "SHA1",
    digits: 6,
    period: 30
  }
  const fresh = buildTokenState(account, 30000)
  assert.equal(fresh.valid, true)
  assert.equal(fresh.code.length, 6)
  assert.equal(fresh.remaining, 30)
  assert.equal(fresh.progress, 100)
  assert.equal(fresh.status, "可用")
  assert.equal(fresh.algorithm, "SHA1")

  const expiring = buildTokenState(account, 58000)
  assert.equal(expiring.remaining, 2)
  assert.equal(expiring.status, "即将刷新")
  assert.equal(expiring.progress, 7)

  const invalid = buildTokenState({ ...account, secret: "NOT-BASE32" }, 30000)
  assert.equal(invalid.valid, false)
  assert.equal(invalid.code, "------")
  assert.equal(invalid.status, "密钥异常")
})

/* --------------------------------------------------------------------------
 * Steam Guard (docs/protocol.md "Steam Guard")
 * ------------------------------------------------------------------------ */

// Public test secret for Steam Guard vectors, independently verified with a
// Python steam_totp implementation (never a real credential).
const STEAM_SECRET = "OJZ2BP7STWSLUD7I23Q5AYZELZB5OAFU"
const STEAM_VECTORS = [
  [59, "3DP36"],
  [1111111109, "GX57J"],
  [1111111111, "TCJ4Y"],
  [1234567890, "VYNVB"],
  [1640846388, "2Y4TM"],
  [1735689600, "DQ5KF"]
]

test("Steam Guard vectors (HMAC-SHA1, 5 characters, fixed 30 s)", () => {
  for (const [timestamp, expected] of STEAM_VECTORS) {
    const code = generateSteam(STEAM_SECRET, timestamp * 1000)
    assert.equal(code, expected, "T=" + timestamp)
    assert.equal(code.length, STEAM_DIGITS)
    for (const character of code) {
      assert.ok(
        STEAM_ALPHABET.indexOf(character) >= 0,
        "character " + character + " not in Steam alphabet"
      )
    }
  }
})

test("Steam codes are not decimal TOTP codes and are not padded", () => {
  const code = generateSteam(STEAM_SECRET, 59000)
  assert.equal(code, "3DP36")
  // Same secret/time as a normal TOTP would yield a very different 6 digit code.
  const numeric = generateTotp(STEAM_SECRET, 59000, 30, 6, "SHA1")
  assert.match(numeric, /^[0-9]{6}$/)
  assert.notEqual(code, numeric)
  assert.equal(generateSteam(STEAM_SECRET, 59000).length, 5)
})

test("generateSteam rejects invalid secrets and accepts raw key bytes", () => {
  assert.throws(() => generateSteam("NOT-BASE32", 59000), /invalid base32 secret/)
  const keyBytes = decodeBase32(STEAM_SECRET)
  assert.equal(generateSteam(keyBytes, 59000), "3DP36")
})

test("normalizeOtpType defaults to totp and accepts steam case-insensitively", () => {
  assert.equal(normalizeOtpType(undefined), OTP_TYPE_TOTP)
  assert.equal(normalizeOtpType(null), OTP_TYPE_TOTP)
  assert.equal(normalizeOtpType(""), OTP_TYPE_TOTP)
  assert.equal(normalizeOtpType("totp"), OTP_TYPE_TOTP)
  assert.equal(normalizeOtpType("TOTP"), OTP_TYPE_TOTP)
  assert.equal(normalizeOtpType("steam"), OTP_TYPE_STEAM)
  assert.equal(normalizeOtpType(" Steam "), OTP_TYPE_STEAM)
  assert.equal(normalizeOtpType("hotp"), null)
})

test("buildTokenState dispatches Steam accounts and keeps TOTP unchanged", () => {
  const steamAccount = {
    id: "steam",
    issuer: "Steam",
    accountName: "me",
    category: "游戏",
    secret: STEAM_SECRET,
    otpType: "steam",
    // Deliberately conflicting values: the view model must force Steam rules.
    algorithm: "SHA1",
    digits: 5,
    period: 30
  }
  const steam = buildTokenState(steamAccount, 59000)
  assert.equal(steam.valid, true)
  assert.equal(steam.otpType, "steam")
  assert.equal(steam.isSteam, true)
  assert.equal(steam.code, "3DP36")
  assert.equal(steam.groupedCode, "3DP36") // no digit grouping / no padding
  assert.equal(steam.code.length, 5)
  assert.equal(steam.digits, 5)
  assert.equal(steam.period, 30)
  assert.equal(steam.algorithm, "SHA1")
  assert.equal(steam.remaining, 1)

  const numeric = buildTokenState(
    { ...steamAccount, otpType: undefined, digits: 6, secret: "JBSWY3DPEHPK3PXP" },
    59000
  )
  assert.equal(numeric.otpType, "totp")
  assert.equal(numeric.isSteam, false)
  assert.equal(numeric.code.length, 6)
  assert.match(numeric.groupedCode, /^[0-9]{3} [0-9]{3}$/)
})
