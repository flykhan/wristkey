/**
 * WristKey band app - unlock-session helpers.
 *
 * The timeout logic lives here; the timestamp itself is persisted by
 * pinSessionStore.js because Vela bundles every page separately and in-memory
 * module state is not shared between /pages/lock and /pages/index.
 *
 * Only a timestamp is kept (never the pattern). The timeout is intentionally
 * short because a lost/borrowed band must not expose codes indefinitely.
 */

export const LOCK_IDLE_TIMEOUT_MS = 120000

let lastUnlockedAt = 0

/** Record a successful unlock (or a just-saved new pattern). */
export function markUnlocked(now) {
  lastUnlockedAt = typeof now === "number" ? now : Date.now()
}

/** Forget the session (cold start / app destroyed). */
export function resetSession() {
  lastUnlockedAt = 0
}

export function getLastUnlockedAt() {
  return lastUnlockedAt
}

/** True when a pin is enabled and the session is missing/older than 2 min. */
export function shouldRelock(now, timeoutMs) {
  const timestamp = typeof now === "number" ? now : Date.now()
  const timeout = typeof timeoutMs === "number" ? timeoutMs : LOCK_IDLE_TIMEOUT_MS
  return !isUnlockedFresh(lastUnlockedAt, timestamp, timeout)
}

/** Pure freshness check shared with the persisted store. */
export function isUnlockedFresh(lastUnlockedAt, now, timeoutMs) {
  const timestamp = typeof now === "number" ? now : Date.now()
  const timeout = typeof timeoutMs === "number" ? timeoutMs : LOCK_IDLE_TIMEOUT_MS
  if (!(lastUnlockedAt > 0)) {
    return false
  }
  return timestamp - lastUnlockedAt < timeout
}
