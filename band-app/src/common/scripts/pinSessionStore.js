/**
 * WristKey band app - persisted unlock session.
 *
 * Vela compiles each page into its own bundle, so a plain module-level
 * variable is NOT shared between pages (unlocking on /pages/lock would still
 * look locked on /pages/index). The unlock timestamp therefore lives in
 * @system.storage so every page reads the same value.
 *
 * Only the timestamp is stored, never the pattern. Cold start clears it;
 * returning from the background after LOCK_IDLE_TIMEOUT_MS locks again.
 */

import storage from "@system.storage"
import { LOCK_IDLE_TIMEOUT_MS, isUnlockedFresh } from "./pinSession"

export const UNLOCK_STORAGE_KEY = "wristkey_unlock_v1"

/** Record a successful unlock before navigating away. */
export function markUnlocked(now, callback) {
  const done = typeof callback === "function" ? callback : function () {}
  const timestamp = typeof now === "number" ? now : Date.now()
  try {
    storage.set({
      key: UNLOCK_STORAGE_KEY,
      value: String(timestamp),
      success: function () {
        done({ ok: true, at: timestamp })
      },
      fail: function () {
        done({ ok: false, error: "storage_write_failed" })
      }
    })
  } catch (error) {
    done({ ok: false, error: "storage_write_failed" })
  }
  return timestamp
}

/** Forget the session (cold start / app destroyed). */
export function clearSession(callback) {
  const done = typeof callback === "function" ? callback : function () {}
  try {
    storage.delete({
      key: UNLOCK_STORAGE_KEY,
      success: function () {
        done({ ok: true })
      },
      fail: function () {
        done({ ok: false, error: "storage_delete_failed" })
      }
    })
  } catch (error) {
    done({ ok: false, error: "storage_delete_failed" })
  }
}

/** Load the persisted unlock timestamp, or 0 when missing/corrupt. */
export function loadUnlockedAt(callback) {
  const done = typeof callback === "function" ? callback : function () {}
  try {
    storage.get({
      key: UNLOCK_STORAGE_KEY,
      default: "",
      success: function (value) {
        const timestamp = Number(value)
        done(Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0)
      },
      fail: function () {
        done(0)
      }
    })
  } catch (error) {
    done(0)
  }
}

/** True when a pin is enabled and the persisted session is missing/stale. */
export function shouldRelock(now, callback) {
  const done = typeof callback === "function" ? callback : function () {}
  const timestamp = typeof now === "number" ? now : Date.now()
  loadUnlockedAt(function (lastUnlockedAt) {
    done(!isUnlockedFresh(lastUnlockedAt, timestamp, LOCK_IDLE_TIMEOUT_MS))
  })
}
