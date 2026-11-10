/**
 * WristKey band app - snapshot persistence on top of @system.storage.
 *
 * Storage model (docs/architecture.md):
 *   key: mfa_snapshot_v2
 *   value: {"version":2,"updatedAt":<ms>,"accounts":[...]}
 *
 * The whole snapshot is written with a single storage.set() call, which is the
 * atomic unit available on Vela: either the old snapshot or the new one is
 * present. A failed write leaves the previous value untouched and is reported
 * to the caller so the UI can keep showing the last known good snapshot.
 *
 * Legacy compatibility: if the v2 key is missing, the BandOTP v1 key
 * ("mfa_config_snapshot", {"configs":[...]}) is read and, when it contains
 * valid accounts, migrated into the v2 key (best effort). v1 snapshots are
 * never used by the v2 sync protocol itself.
 */

import storage from "@system.storage"
import {
  createSnapshot,
  emptySnapshot,
  parseSnapshotPayload
} from "./accountModel.js"

export const STORAGE_KEY = "mfa_snapshot_v2"
export const LEGACY_STORAGE_KEY = "mfa_config_snapshot"

/**
 * Load the stored snapshot.
 * @param {(snapshot: object) => void} callback always called exactly once
 */
export function loadSnapshot(callback) {
  const done = typeof callback === "function" ? callback : function () {}
  readValue(STORAGE_KEY, function (error, value) {
    const parsed = error ? null : parseSnapshotPayload(value)
    if (parsed && (parsed.accounts.length > 0 || parsed.updatedAt > 0)) {
      done(parsed)
      return
    }
    // Missing/empty v2 snapshot: try the legacy BandOTP key once.
    readValue(LEGACY_STORAGE_KEY, function (legacyError, legacyValue) {
      const legacy = legacyError ? null : parseSnapshotPayload(legacyValue)
      if (legacy && legacy.accounts.length > 0) {
        migrateLegacy(legacy)
        done(legacy)
        return
      }
      done(emptySnapshot())
    })
  })
}

/**
 * Persist a snapshot atomically (single-key write).
 * @param {object} snapshot {"version":2,"updatedAt":<ms>,"accounts":[...]}
 * @param {(result: {ok: boolean, error?: string}) => void} [callback]
 */
export function saveSnapshot(snapshot, callback) {
  const done = typeof callback === "function" ? callback : function () {}
  let payload
  try {
    const records = snapshot && Array.isArray(snapshot.accounts) ? snapshot.accounts : []
    const updatedAt = snapshot && typeof snapshot.updatedAt === "number"
      ? snapshot.updatedAt
      : Date.now()
    payload = JSON.stringify(createSnapshot(records, updatedAt))
  } catch (error) {
    done({ ok: false, error: "snapshot_serialize_failed" })
    return
  }

  try {
    storage.set({
      key: STORAGE_KEY,
      value: payload,
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

/** Convenience: load just the account list. */
export function loadAccounts(callback) {
  loadSnapshot(function (snapshot) {
    if (typeof callback === "function") {
      callback(snapshot.accounts)
    }
  })
}

/** Convenience: save a list of accounts with a fresh updatedAt. */
export function saveAccounts(accounts, updatedAt, callback) {
  saveSnapshot(
    {
      version: 2,
      updatedAt: typeof updatedAt === "number" ? updatedAt : Date.now(),
      accounts: Array.isArray(accounts) ? accounts : []
    },
    callback
  )
}

/**
 * Persist the snapshot produced by a successful mfa_sync_commit.
 * @param {object} committed snapshot from syncProtocol.handleMessage()
 * @param {(result: {ok: boolean, error?: string}) => void} [callback]
 */
export function applyCommittedSnapshot(committed, callback) {
  if (!committed || !Array.isArray(committed.accounts)) {
    if (typeof callback === "function") {
      callback({ ok: false, error: "invalid_snapshot" })
    }
    return
  }
  saveSnapshot(committed, callback)
}

function migrateLegacy(legacySnapshot) {
  saveSnapshot(
    {
      version: 2,
      updatedAt: legacySnapshot.updatedAt || Date.now(),
      accounts: legacySnapshot.accounts
    },
    function (result) {
      if (result.ok) {
        try {
          storage.delete({ key: LEGACY_STORAGE_KEY })
        } catch (error) {
          // Best effort only; keeping the old key is harmless.
        }
      }
    }
  )
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
