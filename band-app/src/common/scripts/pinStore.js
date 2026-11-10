/**
 * WristKey band app - pin/lock persistence on top of @system.storage.
 *
 * Each record is written with one storage.set(), the atomic unit available on
 * Vela: a failed write leaves the previous value untouched. Corrupt or
 * out-of-range values are treated as "no pin" / "no lock" instead of crashing
 * the app (the user can always re-sync a new pin from the phone).
 */

import storage from "@system.storage"
import {
  PIN_LOCK_STORAGE_KEY,
  PIN_STORAGE_KEY,
  emptyLockState,
  normalizeLockState,
  normalizePinRecord
} from "./pin.js"

/** Load the enabled pin record, or null when disabled/corrupt. */
export function loadPin(callback) {
  const done = typeof callback === "function" ? callback : function () {}
  readValue(PIN_STORAGE_KEY, function (error, value) {
    if (error || !value) {
      done(null)
      return
    }
    let parsed = value
    if (typeof value === "string") {
      try {
        parsed = JSON.parse(value)
      } catch (parseError) {
        done(null)
        return
      }
    }
    const normalized = normalizePinRecord(parsed)
    done(normalized.ok ? normalized.record : null)
  })
}

/** Persist a pin record atomically. */
export function savePin(record, callback) {
  const done = typeof callback === "function" ? callback : function () {}
  const normalized = normalizePinRecord(record)
  if (!normalized.ok) {
    done({ ok: false, error: normalized.error })
    return
  }
  writeValue(PIN_STORAGE_KEY, JSON.stringify(normalized.record), done)
}

/** Delete the pin (also used when the phone sends mfa_pin_clear). */
export function deletePin(callback) {
  const done = typeof callback === "function" ? callback : function () {}
  try {
    storage.delete({
      key: PIN_STORAGE_KEY,
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

/** Load persisted lock counters (never fails; corrupt data becomes empty). */
export function loadLock(callback) {
  const done = typeof callback === "function" ? callback : function () {}
  readValue(PIN_LOCK_STORAGE_KEY, function (error, value) {
    if (error || !value) {
      done(emptyLockState())
      return
    }
    let parsed = value
    if (typeof value === "string") {
      try {
        parsed = JSON.parse(value)
      } catch (parseError) {
        done(emptyLockState())
        return
      }
    }
    done(normalizeLockState(parsed))
  })
}

/** Persist the lock counters (so a restart cannot bypass the lockout). */
export function saveLock(lock, callback) {
  const done = typeof callback === "function" ? callback : function () {}
  writeValue(PIN_LOCK_STORAGE_KEY, JSON.stringify(normalizeLockState(lock)), done)
}

function readValue(key, callback) {
  try {
    storage.get({
      key: key,
      default: "",
      success: function (data) {
        callback(null, data)
      },
      fail: function () {
        callback("storage_read_failed", "")
      }
    })
  } catch (error) {
    callback("storage_read_failed", "")
  }
}

function writeValue(key, value, done) {
  try {
    storage.set({
      key: key,
      value: value,
      success: function () {
        done({ ok: true })
      },
      fail: function () {
        done({ ok: false, error: "storage_write_failed" })
      }
    })
  } catch (error) {
    done({ ok: false, error: "storage_write_failed" })
  }
}
