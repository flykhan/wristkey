/**
 * WristKey band app - pattern lock primitives (pure functions).
 *
 * The entry lock is a fixed 5-shape sequence (T triangle / S square /
 * C circle). Only a PBKDF2-HMAC-SHA256 derived value is ever persisted:
 *
 *   wristkey_pin_v1      {"salt":"<32 hex>","hash":"<64 hex>",
 *                         "iterations":10,"updatedAt":<ms>}
 *   wristkey_pin_lock_v1 {"failures":<n>,"lockedUntil":<ms>,"updatedAt":<ms>}
 *
 * The lock counters are persisted too, otherwise killing the app would reset
 * the 5-attempt / 30 s lockout. This module has no @system.* dependency so the
 * derivation and the lock state machine are covered by tests/pin.test.mjs.
 */

import { hmac } from "./totp.js"

export const PIN_STORAGE_KEY = "wristkey_pin_v1"
export const PIN_LOCK_STORAGE_KEY = "wristkey_pin_lock_v1"

export const PATTERN_LENGTH = 5
export const PATTERN_REGEX = /^[TSC]{5}$/
export const PATTERN_SYMBOLS = [
  { key: "T", label: "三角", glyph: "▲", color: "#6EE7C7" },
  { key: "S", label: "方形", glyph: "■", color: "#7AA2F7" },
  { key: "C", label: "圆形", glyph: "●", color: "#F2B880" }
]
export const PATTERN_SYMBOL_KEYS = ["T", "S", "C"]

export const PBKDF2_ALGORITHM = "PBKDF2-SHA256"
// Vela's JS engine has no JIT and PBKDF2-SHA256 costs roughly 25 ms per
// iteration on the band (1200 iterations blocked the UI for > 30 s). The
// pattern space is only 3^5 = 243 and the real defence against guessing is the
// persisted 5-attempt lockout below, so keep the derivation deliberately cheap
// (10 iterations) and document the trade-off in docs/security.md.
export const DEFAULT_PBKDF2_ITERATIONS = 10
export const MIN_PBKDF2_ITERATIONS = 1
export const MAX_PBKDF2_ITERATIONS = 20000
export const SALT_BYTES = 16
export const HASH_BYTES = 32
export const SALT_HEX_LENGTH = SALT_BYTES * 2
export const HASH_HEX_LENGTH = HASH_BYTES * 2

export const LOCK_AFTER_FAILURES = 5
export const LOCK_STEP_MS = 30000

/** Uppercase canonical pattern string, or "" when invalid. */
export function normalizePattern(value) {
  if (typeof value !== "string") {
    return ""
  }
  const text = value.trim().toUpperCase()
  return PATTERN_REGEX.test(text) ? text : ""
}

/** Symbols of a pattern in click order (empty array for invalid input). */
export function patternSymbols(value) {
  const pattern = normalizePattern(value)
  if (!pattern) {
    return []
  }
  const result = []
  for (let index = 0; index < pattern.length; index++) {
    for (let symbol = 0; symbol < PATTERN_SYMBOLS.length; symbol++) {
      if (PATTERN_SYMBOLS[symbol].key === pattern.charAt(index)) {
        result.push(PATTERN_SYMBOLS[symbol])
        break
      }
    }
  }
  return result
}

export function patternToBytes(value) {
  const pattern = normalizePattern(value)
  if (!pattern) {
    return null
  }
  const bytes = []
  for (let index = 0; index < pattern.length; index++) {
    bytes.push(pattern.charCodeAt(index))
  }
  return bytes
}

/** PBKDF2-HMAC-SHA256, arbitrary key length (RFC 8018). */
export function pbkdf2Sha256(passwordBytes, saltBytes, iterations, keyLength) {
  if (!Array.isArray(passwordBytes) || passwordBytes.length === 0) {
    return null
  }
  if (!Array.isArray(saltBytes) || saltBytes.length === 0) {
    return null
  }
  if (!isValidIterations(iterations) || iterations !== Math.floor(iterations)) {
    return null
  }
  const length = typeof keyLength === "number" && keyLength > 0
    ? Math.floor(keyLength)
    : HASH_BYTES
  const blockCount = Math.ceil(length / HASH_BYTES)
  const output = []
  for (let block = 1; block <= blockCount; block++) {
    const blockSalt = saltBytes.concat([
      (block >>> 24) & 0xff,
      (block >>> 16) & 0xff,
      (block >>> 8) & 0xff,
      block & 0xff
    ])
    let u = hmac("SHA256", passwordBytes, blockSalt)
    const accumulated = u.slice(0)
    for (let round = 1; round < iterations; round++) {
      u = hmac("SHA256", passwordBytes, u)
      for (let index = 0; index < accumulated.length; index++) {
        accumulated[index] ^= u[index]
      }
    }
    for (let index = 0; index < accumulated.length; index++) {
      output.push(accumulated[index])
    }
  }
  return output.slice(0, length)
}

/** Derive the stored hash (lowercase hex) for a pattern, or "" on bad input. */
export function derivePatternHash(pattern, saltHex, iterations) {
  const patternBytes = patternToBytes(pattern)
  const saltBytes = hexToBytes(saltHex)
  if (!patternBytes || !saltBytes || saltBytes.length !== SALT_BYTES) {
    return ""
  }
  const derived = pbkdf2Sha256(patternBytes, saltBytes, iterations, HASH_BYTES)
  return derived ? bytesToHex(derived) : ""
}

/**
 * Build a pin record (with a fresh random salt unless saltHex is injected).
 * @returns {{ok: true, record: object} | {ok: false, error: string}}
 */
export function createPinRecord(pattern, options) {
  const settings = options || {}
  const canonical = normalizePattern(pattern)
  if (!canonical) {
    return { ok: false, error: "pattern_invalid" }
  }
  const iterations = settings.iterations === undefined
    ? DEFAULT_PBKDF2_ITERATIONS
    : Number(settings.iterations)
  if (!isValidIterations(iterations) || iterations !== Math.floor(iterations)) {
    return { ok: false, error: "iterations_out_of_range" }
  }
  const saltHex = typeof settings.saltHex === "string"
    ? settings.saltHex.toLowerCase()
    : randomBytesHex(SALT_BYTES, settings.randomFn)
  if (!isHex(saltHex, SALT_HEX_LENGTH)) {
    return { ok: false, error: "salt_invalid" }
  }
  const hash = derivePatternHash(canonical, saltHex, iterations)
  if (!hash) {
    return { ok: false, error: "hash_failed" }
  }
  const updatedAt = typeof settings.updatedAt === "number" && settings.updatedAt > 0
    ? Math.floor(settings.updatedAt)
    : Date.now()
  return {
    ok: true,
    record: {
      salt: saltHex,
      hash: hash,
      iterations: iterations,
      updatedAt: updatedAt
    }
  }
}

/**
 * Validate a pin record/payload. A payload from the phone also carries
 * {"algorithm":"PBKDF2-SHA256"}; that field is accepted but not stored.
 * @returns {{ok: true, record: object} | {ok: false, error: string}}
 */
export function normalizePinRecord(raw, options) {
  const settings = options || {}
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "pin_not_object" }
  }
  const requireAlgorithm = settings.requireAlgorithm === true
  if (raw.algorithm === undefined || raw.algorithm === null) {
    if (requireAlgorithm) {
      return { ok: false, error: "pin_algorithm_invalid" }
    }
  } else if (String(raw.algorithm).trim().toUpperCase() !== PBKDF2_ALGORITHM) {
    return { ok: false, error: "pin_algorithm_invalid" }
  }
  const saltHex = typeof raw.salt === "string" ? raw.salt.toLowerCase() : ""
  if (!isHex(saltHex, SALT_HEX_LENGTH)) {
    return { ok: false, error: "pin_salt_invalid" }
  }
  const hashHex = typeof raw.hash === "string" ? raw.hash.toLowerCase() : ""
  if (!isHex(hashHex, HASH_HEX_LENGTH)) {
    return { ok: false, error: "pin_hash_invalid" }
  }
  const iterations = Number(raw.iterations)
  if (!isValidIterations(iterations) || iterations !== Math.floor(iterations)) {
    return { ok: false, error: "pin_iterations_invalid" }
  }
  let updatedAt = 0
  if (typeof settings.timestamp === "number" && settings.timestamp > 0) {
    updatedAt = Math.floor(settings.timestamp)
  } else if (raw.updatedAt !== undefined && Number(raw.updatedAt) > 0) {
    updatedAt = Math.floor(Number(raw.updatedAt))
  } else {
    updatedAt = Date.now()
  }
  return {
    ok: true,
    record: {
      salt: saltHex,
      hash: hashHex,
      iterations: iterations,
      updatedAt: updatedAt
    }
  }
}

/** Verify a pattern against a stored record. */
export function verifyPattern(pattern, record) {
  const normalized = normalizePinRecord(record)
  if (!normalized.ok) {
    return { ok: false, error: normalized.error, matched: false }
  }
  if (!normalizePattern(pattern)) {
    return { ok: false, error: "pattern_invalid", matched: false }
  }
  const expected = derivePatternHash(pattern, normalized.record.salt, normalized.record.iterations)
  if (!expected) {
    return { ok: false, error: "hash_failed", matched: false }
  }
  return { ok: true, matched: constantTimeEqual(expected, normalized.record.hash) }
}

/** Fresh lock state (no failures). */
export function emptyLockState() {
  return { failures: 0, lockedUntil: 0, updatedAt: 0 }
}

/** Tolerant parse of a stored lock state. */
export function normalizeLockState(raw) {
  if (!raw || typeof raw !== "object") {
    return emptyLockState()
  }
  let failures = Number(raw.failures)
  if (!isFinite(failures) || failures < 0) {
    failures = 0
  }
  failures = Math.floor(failures)
  let lockedUntil = Number(raw.lockedUntil)
  if (!isFinite(lockedUntil) || lockedUntil < 0) {
    lockedUntil = 0
  }
  lockedUntil = Math.floor(lockedUntil)
  let updatedAt = Number(raw.updatedAt)
  if (!isFinite(updatedAt) || updatedAt < 0) {
    updatedAt = 0
  }
  return {
    failures: failures,
    lockedUntil: lockedUntil,
    updatedAt: Math.floor(updatedAt)
  }
}

/** Milliseconds left on the current lockout (0 when not locked). */
export function lockRemainingMs(lock, now) {
  const state = normalizeLockState(lock)
  const timestamp = typeof now === "number" ? now : Date.now()
  return state.lockedUntil > timestamp ? state.lockedUntil - timestamp : 0
}

export function isLocked(lock, now) {
  return lockRemainingMs(lock, now) > 0
}

/**
 * Record one wrong pattern. Failures 1-4 do not lock; the 5th locks 30 s,
 * every further failure adds another 30 s (6th -> 60 s, 7th -> 90 s, ...).
 */
export function nextLockAfterFailure(lock, now) {
  const state = normalizeLockState(lock)
  const timestamp = typeof now === "number" ? now : Date.now()
  const failures = state.failures + 1
  const lockMs = failures >= LOCK_AFTER_FAILURES
    ? (failures - LOCK_AFTER_FAILURES + 1) * LOCK_STEP_MS
    : 0
  return {
    failures: failures,
    lockedUntil: lockMs > 0 ? timestamp + lockMs : 0,
    lockMs: lockMs,
    locked: lockMs > 0,
    updatedAt: timestamp
  }
}

/** Reset after a successful unlock or after the pin is removed. */
export function resetLockState(now) {
  return {
    failures: 0,
    lockedUntil: 0,
    updatedAt: typeof now === "number" ? now : Date.now()
  }
}

export function formatLockCountdown(remainingMs) {
  const seconds = Math.max(0, Math.ceil(Number(remainingMs) / 1000))
  return seconds > 0 ? seconds + "s" : ""
}

/* ------------------------------------------------------------------------ */

function isValidIterations(value) {
  return typeof value === "number" && isFinite(value) &&
    value >= MIN_PBKDF2_ITERATIONS && value <= MAX_PBKDF2_ITERATIONS
}

function isHex(value, length) {
  return typeof value === "string" && value.length === length && /^[0-9a-f]+$/.test(value)
}

function hexToBytes(hex) {
  if (!isHex(hex, hex.length) || hex.length % 2 !== 0) {
    return null
  }
  const bytes = []
  for (let index = 0; index < hex.length; index += 2) {
    bytes.push(parseInt(hex.slice(index, index + 2), 16))
  }
  return bytes
}

function bytesToHex(bytes) {
  let result = ""
  for (let index = 0; index < bytes.length; index++) {
    const value = bytes[index] & 0xff
    result += (value < 16 ? "0" : "") + value.toString(16)
  }
  return result
}

function randomBytesHex(length, randomFn) {
  const random = typeof randomFn === "function" ? randomFn : Math.random
  let hex = ""
  for (let index = 0; index < length; index++) {
    let value = Math.floor(random() * 256)
    if (!isFinite(value) || value < 0 || value > 255) {
      value = 0
    }
    hex += (value < 16 ? "0" : "") + value.toString(16)
  }
  return hex
}

function constantTimeEqual(left, right) {
  const a = String(left)
  const b = String(right)
  if (a.length !== b.length) {
    return false
  }
  let diff = 0
  for (let index = 0; index < a.length; index++) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index)
  }
  return diff === 0
}