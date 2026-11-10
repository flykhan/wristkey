import test from "node:test"
import assert from "node:assert/strict"
import { pbkdf2Sync } from "node:crypto"

import {
  DEFAULT_PBKDF2_ITERATIONS,
  HASH_HEX_LENGTH,
  LOCK_AFTER_FAILURES,
  LOCK_STEP_MS,
  PATTERN_LENGTH,
  PATTERN_SYMBOLS,
  PIN_LOCK_STORAGE_KEY,
  PIN_STORAGE_KEY,
  SALT_HEX_LENGTH,
  createPinRecord,
  derivePatternHash,
  emptyLockState,
  formatLockCountdown,
  isLocked,
  lockRemainingMs,
  nextLockAfterFailure,
  normalizeLockState,
  normalizePattern,
  normalizePinRecord,
  patternSymbols,
  pbkdf2Sha256,
  resetLockState,
  verifyPattern
} from "../src/common/scripts/pin.js"
import {
  LOCK_IDLE_TIMEOUT_MS,
  getLastUnlockedAt,
  markUnlocked,
  resetSession,
  shouldRelock
} from "../src/common/scripts/pinSession.js"

const NOW = 1760000000000
const SALT_HEX = "00112233445566778899aabbccddeeff"
const PATTERN = "TSCCT"

test("pin storage keys and pattern rules are stable", () => {
  assert.equal(PIN_STORAGE_KEY, "wristkey_pin_v1")
  assert.equal(PIN_LOCK_STORAGE_KEY, "wristkey_pin_lock_v1")
  assert.equal(PATTERN_LENGTH, 5)
  assert.equal(PATTERN_SYMBOLS.map(symbol => symbol.key).join(""), "TSC")
  assert.equal(PATTERN_SYMBOLS[0].color, "#6EE7C7")
  assert.equal(PATTERN_SYMBOLS[1].color, "#7AA2F7")
  assert.equal(PATTERN_SYMBOLS[2].color, "#F2B880")
})

test("normalizePattern accepts lowercase/padded patterns and rejects bad ones", () => {
  assert.equal(normalizePattern("tscct"), "TSCCT")
  assert.equal(normalizePattern("  TSCCT  "), "TSCCT")
  assert.equal(normalizePattern("TSCCT".toLowerCase()), "TSCCT")
  for (const value of ["TSC", "TSCCTX", "TS1CT", "", "   ", null, 42, ["TSCCT"]]) {
    assert.equal(normalizePattern(value), "", JSON.stringify(value))
  }
  assert.deepEqual(
    patternSymbols("TSCTT").map(symbol => symbol.glyph),
    ["▲", "■", "●", "▲", "▲"]
  )
  assert.deepEqual(patternSymbols("bad"), [])
})

test("PBKDF2-HMAC-SHA256 matches node:crypto for the pattern alphabet", () => {
  const salt = Buffer.from(SALT_HEX, "hex")
  const password = Buffer.from(PATTERN, "utf8")
  const expected = pbkdf2Sync(password, salt, DEFAULT_PBKDF2_ITERATIONS, 32, "sha256").toString("hex")
  const actual = Buffer.from(
    pbkdf2Sha256(Array.from(password), Array.from(salt), DEFAULT_PBKDF2_ITERATIONS, 32)
  ).toString("hex")
  assert.equal(actual, expected)
  assert.equal(expected.length, HASH_HEX_LENGTH)

  // A different pattern/salt/iteration count must derive a different hash.
  const other = derivePatternHash("TSSCC", SALT_HEX, DEFAULT_PBKDF2_ITERATIONS)
  assert.match(other, /^[0-9a-f]{64}$/)
  assert.notEqual(other, expected)
  assert.equal(derivePatternHash("TSCCT", SALT_HEX, 1201) === expected, false)
  assert.equal(derivePatternHash("bad", SALT_HEX, 1200), "")
  assert.equal(derivePatternHash(PATTERN, "00", 1200), "")
  assert.equal(pbkdf2Sha256([], Array.from(salt), 1200, 32), null)
  assert.equal(pbkdf2Sha256(Array.from(password), [], 1200, 32), null)
  assert.equal(pbkdf2Sha256(Array.from(password), Array.from(salt), 1, 32), null)
})

test("createPinRecord stores only salt/hash/iterations/updatedAt", () => {
  const created = createPinRecord(PATTERN, {
    saltHex: SALT_HEX,
    iterations: DEFAULT_PBKDF2_ITERATIONS,
    updatedAt: NOW
  })
  assert.equal(created.ok, true)
  assert.deepEqual(Object.keys(created.record).sort(), ["hash", "iterations", "salt", "updatedAt"])
  assert.equal(created.record.salt, SALT_HEX)
  assert.equal(created.record.salt.length, SALT_HEX_LENGTH)
  assert.equal(created.record.hash.length, HASH_HEX_LENGTH)
  assert.equal(created.record.iterations, DEFAULT_PBKDF2_ITERATIONS)
  assert.equal(created.record.updatedAt, NOW)

  const verified = verifyPattern("tscct", created.record)
  assert.equal(verified.ok, true)
  assert.equal(verified.matched, true)
  assert.equal(verifyPattern("TSSCC", created.record).matched, false)
  assert.equal(verifyPattern("TSC", created.record).matched, false)
  assert.equal(verifyPattern(PATTERN, { salt: "bad" }).matched, false)
  assert.equal(createPinRecord("TSC", { saltHex: SALT_HEX }).error, "pattern_invalid")
  assert.equal(createPinRecord(PATTERN, { saltHex: "zz" }).error, "salt_invalid")
  assert.equal(createPinRecord(PATTERN, { saltHex: SALT_HEX, iterations: 999 }).error, "iterations_out_of_range")
})

test("normalizePinRecord rejects malformed phone payloads", () => {
  const base = {
    algorithm: "PBKDF2-SHA256",
    salt: SALT_HEX,
    hash: "a".repeat(64),
    iterations: 1200,
    updatedAt: NOW
  }
  const ok = normalizePinRecord(base, { requireAlgorithm: true, timestamp: NOW })
  assert.equal(ok.ok, true)
  assert.deepEqual(Object.keys(ok.record).sort(), ["hash", "iterations", "salt", "updatedAt"])

  const cases = [
    [{ ...base, algorithm: undefined }, "pin_algorithm_invalid"],
    [{ ...base, algorithm: "PBKDF2-SHA1" }, "pin_algorithm_invalid"],
    [{ ...base, salt: "abc" }, "pin_salt_invalid"],
    [{ ...base, salt: "g".repeat(32) }, "pin_salt_invalid"],
    [{ ...base, hash: "b".repeat(63) }, "pin_hash_invalid"],
    [{ ...base, iterations: 999 }, "pin_iterations_invalid"],
    [{ ...base, iterations: 20001 }, "pin_iterations_invalid"],
    [null, "pin_not_object"],
    [[], "pin_not_object"]
  ]
  for (const [payload, error] of cases) {
    const result = normalizePinRecord(payload, { requireAlgorithm: true, timestamp: NOW })
    assert.equal(result.ok, false, error)
    assert.equal(result.error, error)
  }

  // Stored records have no algorithm field and do not require one.
  const stored = normalizePinRecord(
    { salt: SALT_HEX, hash: "a".repeat(64), iterations: 1200, updatedAt: NOW },
    { timestamp: NOW }
  )
  assert.equal(stored.ok, true)
})

test("lock state machine locks 30s on the 5th failure and increments", () => {
  assert.deepEqual(emptyLockState(), { failures: 0, lockedUntil: 0, updatedAt: 0 })

  let lock = emptyLockState()
  for (let attempt = 1; attempt <= 4; attempt++) {
    lock = nextLockAfterFailure(lock, NOW + attempt)
    assert.equal(lock.failures, attempt)
    assert.equal(lock.locked, false)
    assert.equal(lock.lockedUntil, 0)
  }

  lock = nextLockAfterFailure(lock, NOW + 5)
  assert.equal(lock.failures, LOCK_AFTER_FAILURES)
  assert.equal(lock.locked, true)
  assert.equal(lock.lockMs, LOCK_STEP_MS)
  assert.equal(lock.lockedUntil, NOW + 5 + LOCK_STEP_MS)
  assert.equal(isLocked(lock, NOW + 5), true)
  assert.equal(lockRemainingMs(lock, NOW + 5), LOCK_STEP_MS)
  assert.equal(lockRemainingMs(lock, NOW + 5 + LOCK_STEP_MS), 0)
  assert.equal(formatLockCountdown(30000), "30s")
  assert.equal(formatLockCountdown(1), "1s")
  assert.equal(formatLockCountdown(0), "")

  lock = nextLockAfterFailure(lock, NOW + 6)
  assert.equal(lock.failures, 6)
  assert.equal(lock.lockMs, LOCK_STEP_MS * 2)

  const reset = resetLockState(NOW + 7)
  assert.deepEqual(reset, { failures: 0, lockedUntil: 0, updatedAt: NOW + 7 })
  assert.deepEqual(normalizeLockState("garbage"), emptyLockState())
  assert.deepEqual(normalizeLockState({ failures: -2, lockedUntil: "x" }), {
    failures: 0,
    lockedUntil: 0,
    updatedAt: 0
  })
})

test("pin session relocks after the idle timeout", () => {
  resetSession()
  assert.equal(getLastUnlockedAt(), 0)
  assert.equal(shouldRelock(NOW), true)
  assert.equal(LOCK_IDLE_TIMEOUT_MS, 120000)

  markUnlocked(NOW)
  assert.equal(getLastUnlockedAt(), NOW)
  assert.equal(shouldRelock(NOW + 119999), false)
  assert.equal(shouldRelock(NOW + 120000), true)
  assert.equal(shouldRelock(NOW + 1, 5), false)
  assert.equal(shouldRelock(NOW + 5, 5), true)

  resetSession()
  assert.equal(getLastUnlockedAt(), 0)
})