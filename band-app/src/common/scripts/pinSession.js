/**
 * WristKey band app - in-memory unlock session.
 *
 * Only the timestamp of the last successful unlock is kept (never the
 * pattern). app.ux locks again when the app returns to the foreground after
 * more than LOCK_IDLE_TIMEOUT_MS; the timeout is intentionally short because
 * a lost/borrowed band must not expose codes indefinitely.
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
  if (lastUnlockedAt <= 0) {
    return true
  }
  return timestamp - lastUnlockedAt >= timeout
}
