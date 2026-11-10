import test from "node:test"
import assert from "node:assert/strict"

import {
  MESSAGE_ACK,
  MESSAGE_REQUEST,
  PROTOCOL_VERSION,
  STAGING_TIMEOUT_MS,
  buildAck,
  buildSyncRequest,
  checkStagingTimeout,
  createSyncState,
  extractPayload,
  getReceivedCount,
  handleMessage,
  isStagingActive,
  parseEnvelope,
  serializeMessage
} from "../src/common/scripts/syncProtocol.js"

const T0 = 1760000000000
const SYNC_ID = "sync-1760000000000-7f3a"

function accountObject(id, overrides) {
  return Object.assign(
    {
      id: id,
      issuer: "GitHub",
      accountName: "me@example.com",
      category: "开发",
      secret: "JBSWY3DPEHPK3PXP",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      updatedAt: T0
    },
    overrides || {}
  )
}

function beginMessage(syncId, count, sentAt) {
  return {
    type: "mfa_sync_begin",
    version: PROTOCOL_VERSION,
    sentAt: sentAt || T0,
    syncId: syncId,
    accountCount: count
  }
}

function accountMessage(syncId, index, account, sentAt) {
  return {
    type: "mfa_sync_account",
    version: PROTOCOL_VERSION,
    sentAt: sentAt || T0,
    syncId: syncId,
    index: index,
    account: account
  }
}

function commitMessage(syncId, count, sentAt) {
  return {
    type: "mfa_sync_commit",
    version: PROTOCOL_VERSION,
    sentAt: sentAt || T0,
    syncId: syncId,
    accountCount: count
  }
}

function feed(state, message, now) {
  return handleMessage(state, message, now || T0)
}

test("happy path: begin -> account x3 (out of order) -> commit", () => {
  let state = createSyncState()
  let result = feed(state, beginMessage(SYNC_ID, 3))
  assert.equal(result.handled, true)
  assert.equal(result.ignored, false)
  assert.equal(isStagingActive(result.state), true)
  assert.equal(result.state.accountCount, 3)
  state = result.state

  // Out-of-order indices are accepted and stored by their index.
  for (const [index, id] of [[2, "c"], [0, "a"], [1, "b"]]) {
    result = feed(state, accountMessage(SYNC_ID, index, accountObject(id)), T0 + index)
    assert.equal(result.ignored, false)
    assert.equal(result.ack, null)
    state = result.state
  }
  assert.equal(getReceivedCount(state), 3)

  result = feed(state, commitMessage(SYNC_ID, 3), T0 + 10)
  assert.equal(result.ignored, false)
  assert.equal(result.committed !== null, true)
  assert.deepEqual(result.committed.accounts.map(a => a.id), ["a", "b", "c"])
  assert.equal(result.committed.version, 3)
  assert.equal(result.committed.updatedAt, T0 + 10)

  assert.equal(result.ack.type, MESSAGE_ACK)
  assert.equal(result.ack.version, 3)
  assert.equal(result.ack.syncId, SYNC_ID)
  assert.equal(result.ack.ok, true)
  assert.equal(result.ack.received, 3)
  assert.equal(result.ack.committed, 3)
  assert.equal(result.ack.error, null)
  assert.equal(result.ack.sentAt, T0 + 10)

  assert.equal(isStagingActive(result.state), false)
  assert.equal(getReceivedCount(result.state), 0)
})

test("duplicate index is tolerated and counted once", () => {
  let state = createSyncState()
  state = feed(state, beginMessage(SYNC_ID, 3)).state
  state = feed(state, accountMessage(SYNC_ID, 0, accountObject("a"))).state
  state = feed(state, accountMessage(SYNC_ID, 1, accountObject("b"))).state
  const duplicate = feed(state, accountMessage(SYNC_ID, 1, accountObject("b")))
  assert.equal(duplicate.ignored, false)
  assert.equal(duplicate.state.duplicateIndexCount, 1)
  assert.equal(duplicate.errors.includes("duplicate_index"), true)
  state = duplicate.state
  state = feed(state, accountMessage(SYNC_ID, 2, accountObject("c"))).state

  const result = feed(state, commitMessage(SYNC_ID, 3))
  assert.equal(result.ack.ok, true)
  assert.equal(result.committed.accounts.length, 3)
})

test("duplicate account id under a different index is rejected", () => {
  let state = createSyncState()
  state = feed(state, beginMessage(SYNC_ID, 2)).state
  state = feed(state, accountMessage(SYNC_ID, 0, accountObject("a"))).state
  const duplicate = feed(state, accountMessage(SYNC_ID, 1, accountObject("a")))
  assert.equal(duplicate.ignored, true)
  assert.equal(duplicate.error, "duplicate_account_id")
  assert.equal(duplicate.state.duplicateIdCount, 1)
  state = duplicate.state

  const result = feed(state, commitMessage(SYNC_ID, 2))
  assert.equal(result.committed, null)
  assert.equal(result.ack.ok, false)
  assert.equal(result.ack.error, "incomplete_sync")
  assert.equal(result.ack.received, 1)
})

test("commit with a mismatched accountCount fails and discards staging", () => {
  let state = createSyncState()
  state = feed(state, beginMessage(SYNC_ID, 2)).state
  state = feed(state, accountMessage(SYNC_ID, 0, accountObject("a"))).state
  state = feed(state, accountMessage(SYNC_ID, 1, accountObject("b"))).state

  const result = feed(state, commitMessage(SYNC_ID, 3))
  assert.equal(result.committed, null)
  assert.equal(result.ack.ok, false)
  assert.equal(result.ack.error, "account_count_mismatch")
  assert.equal(isStagingActive(result.state), false)
})

test("commit before all accounts arrived fails with incomplete_sync", () => {
  let state = createSyncState()
  state = feed(state, beginMessage(SYNC_ID, 3)).state
  state = feed(state, accountMessage(SYNC_ID, 0, accountObject("a"))).state
  const result = feed(state, commitMessage(SYNC_ID, 3))
  assert.equal(result.ack.ok, false)
  assert.equal(result.ack.error, "incomplete_sync")
  assert.equal(result.ack.received, 1)
  assert.equal(result.ack.committed, 0)
  assert.equal(result.state.syncId, null)
})

test("unknown syncId account messages are ignored without aborting staging", () => {
  let state = createSyncState()
  state = feed(state, beginMessage(SYNC_ID, 2)).state
  state = feed(state, accountMessage(SYNC_ID, 0, accountObject("a"))).state

  const result = feed(state, accountMessage("other-sync", 1, accountObject("b")))
  assert.equal(result.ignored, true)
  assert.equal(result.error, "sync_id_mismatch")
  assert.equal(result.state.invalidCount, 1)
  assert.equal(result.state.syncId, SYNC_ID)
  assert.equal(getReceivedCount(result.state), 1)

  state = result.state
  state = feed(state, accountMessage(SYNC_ID, 1, accountObject("b"))).state
  assert.equal(feed(state, commitMessage(SYNC_ID, 2)).ack.ok, true)
})

test("commit with an unknown syncId fails and discards staging", () => {
  let state = createSyncState()
  state = feed(state, beginMessage(SYNC_ID, 1)).state
  state = feed(state, accountMessage(SYNC_ID, 0, accountObject("a"))).state

  const result = feed(state, commitMessage("other-sync", 1))
  assert.equal(result.ack.ok, false)
  assert.equal(result.ack.error, "sync_id_mismatch")
  assert.equal(result.committed, null)
  assert.equal(isStagingActive(result.state), false)
})

test("commit without begin fails with no_active_begin", () => {
  const result = feed(createSyncState(), commitMessage(SYNC_ID, 0))
  assert.equal(result.ack.ok, false)
  assert.equal(result.ack.error, "no_active_begin")
  assert.equal(result.committed, null)
})

test("invalid accounts are counted and dropped; commit fails", () => {
  let state = createSyncState()
  state = feed(state, beginMessage(SYNC_ID, 2)).state
  state = feed(state, accountMessage(SYNC_ID, 0, accountObject("a"))).state
  const invalid = feed(
    state,
    accountMessage(SYNC_ID, 1, accountObject("b", { secret: "NOT-BASE32" }))
  )
  assert.equal(invalid.ignored, true)
  assert.equal(invalid.error, "account_invalid:secret_invalid_char")
  assert.equal(invalid.state.invalidCount, 1)
  state = invalid.state

  const result = feed(state, commitMessage(SYNC_ID, 2))
  assert.equal(result.ack.ok, false)
  assert.equal(result.ack.error, "incomplete_sync")
  assert.equal(result.committed, null)
})

test("zero-account sync commits an empty snapshot (clears the band)", () => {
  let state = createSyncState()
  state = feed(state, beginMessage(SYNC_ID, 0)).state
  const result = feed(state, commitMessage(SYNC_ID, 0))
  assert.equal(result.ack.ok, true)
  assert.equal(result.ack.received, 0)
  assert.equal(result.ack.committed, 0)
  assert.deepEqual(result.committed.accounts, [])
  assert.equal(result.committed.version, 3)
})

test("a new begin discards a previous staging session", () => {
  let state = createSyncState()
  state = feed(state, beginMessage(SYNC_ID, 2)).state
  state = feed(state, accountMessage(SYNC_ID, 0, accountObject("a"))).state

  const nextId = "sync-2"
  state = feed(state, beginMessage(nextId, 1)).state
  assert.equal(state.syncId, nextId)
  assert.equal(getReceivedCount(state), 0)

  // Old sync's commit must not commit the new staging.
  const stale = feed(state, commitMessage(SYNC_ID, 2))
  assert.equal(stale.ack.ok, false)
  assert.equal(stale.ack.error, "sync_id_mismatch")
})

test("staging times out after STAGING_TIMEOUT_MS", () => {
  let state = createSyncState()
  state = feed(state, beginMessage(SYNC_ID, 1), T0).state
  const result = feed(state, accountMessage(SYNC_ID, 0, accountObject("a")), T0 + STAGING_TIMEOUT_MS + 1)
  assert.equal(result.errors.includes("staging_timeout"), true)
  assert.equal(result.error, "no_active_begin")
  assert.equal(result.state.syncId, null)

  const expired = checkStagingTimeout(state, T0 + STAGING_TIMEOUT_MS + 1)
  assert.equal(expired.expired, true)
})

test("malformed, unknown-version and unknown-type messages are ignored", () => {
  let state = createSyncState()
  let result = feed(state, "{not json")
  assert.equal(result.handled, false)
  assert.equal(result.errors.includes("invalid_json"), true)

  result = feed(state, { type: "mfa_sync_begin", version: 1, syncId: "x", accountCount: 1 })
  assert.equal(result.handled, false)
  assert.equal(result.errors.includes("unsupported_version"), true)

  result = feed(state, { type: "mfa_sync_unknown", version: 2 })
  assert.equal(result.handled, false)
  assert.equal(result.errors[0].startsWith("unknown_type:"), true)

  result = feed(state, { version: 2 })
  assert.equal(result.handled, false)
  assert.equal(result.errors.includes("missing_type"), true)

  // Invalid begin does not touch an existing staging session.
  state = feed(state, beginMessage(SYNC_ID, 1)).state
  result = feed(state, { type: "mfa_sync_begin", version: 2, syncId: "", accountCount: 1 })
  assert.equal(result.ignored, true)
  assert.equal(result.state.syncId, SYNC_ID)
})

test("index and accountCount validation boundaries", () => {
  let state = createSyncState()
  state = feed(state, beginMessage(SYNC_ID, 2)).state
  for (const index of [-1, 2, 99, 1.5, null]) {
    const result = feed(state, accountMessage(SYNC_ID, index, accountObject("a")))
    assert.equal(result.error, "index_out_of_range", "index " + index)
  }
  // accountCount must be an integer within 0..500.
  for (const count of [-1, 501, 1.5, "x", null]) {
    const result = feed(createSyncState(), beginMessage("s", count))
    assert.equal(result.ignored, true, "count " + count)
  }
})

test("envelope payload extraction supports strings and interconnect events", () => {
  const json = JSON.stringify(beginMessage(SYNC_ID, 1))
  assert.equal(extractPayload(json), json)
  assert.equal(extractPayload({ data: json }), json)
  const objectPayload = beginMessage(SYNC_ID, 1)
  assert.deepEqual(extractPayload({ data: objectPayload }), objectPayload)
  assert.deepEqual(extractPayload(objectPayload), objectPayload)
  assert.equal(extractPayload(null), null)
  assert.equal(extractPayload(42), null)

  assert.equal(parseEnvelope(json).ok, true)
  assert.equal(parseEnvelope({ data: json }).ok, true)
  assert.equal(parseEnvelope("   ").ok, false)
  assert.equal(parseEnvelope([]).ok, false)
})

test("buildAck and buildSyncRequest shapes", () => {
  const ack = buildAck({
    syncId: SYNC_ID,
    ok: true,
    received: 3,
    committed: 3,
    error: null,
    sentAt: T0
  })
  assert.deepEqual(ack, {
    type: MESSAGE_ACK,
    version: 3,
    sentAt: T0,
    syncId: SYNC_ID,
    ok: true,
    received: 3,
    committed: 3,
    error: null
  })

  const failure = buildAck({ syncId: SYNC_ID, ok: false, received: 1, committed: 0, error: "incomplete_sync" })
  assert.equal(failure.ok, false)
  assert.equal(failure.error, "incomplete_sync")
  assert.equal(failure.committed, 0)

  const request = buildSyncRequest({ sentAt: T0, requestId: "req-1-2" })
  assert.deepEqual(request, {
    type: MESSAGE_REQUEST,
    version: 3,
    sentAt: T0,
    requestId: "req-1-2"
  })

  const generated = buildSyncRequest({ sentAt: T0 })
  assert.match(generated.requestId, /^req-1760000000000-[0-9a-f]+$/)

  const serialised = serializeMessage(request)
  assert.equal(typeof serialised, "string")
  assert.deepEqual(JSON.parse(serialised), request)
})

/* --------------------------------------------------------------------------
 * Steam Guard through the v2 sync state machine
 * ------------------------------------------------------------------------ */

const STEAM_SECRET = "OJZ2BP7STWSLUD7I23Q5AYZELZB5OAFU"

function steamAccountObject(id) {
  return accountObject(id, {
    issuer: "Steam",
    accountName: "me",
    secret: STEAM_SECRET,
    otpType: "steam",
    algorithm: "SHA1",
    digits: 5,
    period: 30
  })
}

test("a Steam account is accepted and committed with otpType=steam", () => {
  let state = createSyncState()
  state = feed(state, beginMessage(SYNC_ID, 1)).state
  const staged = feed(state, accountMessage(SYNC_ID, 0, steamAccountObject("s_steam")), T0 + 1)
  assert.equal(staged.ignored, false)
  assert.equal(staged.errors.length, 0)
  assert.equal(staged.state.slots[0].otpType, "steam")
  assert.equal(staged.state.slots[0].digits, 5)

  const result = feed(staged.state, commitMessage(SYNC_ID, 1), T0 + 2)
  assert.equal(result.ack.ok, true)
  assert.equal(result.committed.accounts.length, 1)
  assert.equal(result.committed.accounts[0].otpType, "steam")
  assert.equal(result.committed.accounts[0].digits, 5)
  assert.equal(result.committed.accounts[0].period, 30)
  assert.equal(result.committed.accounts[0].algorithm, "SHA1")
})

test("Steam/TOTP mixed sync commits both account kinds", () => {
  let state = createSyncState()
  state = feed(state, beginMessage(SYNC_ID, 2)).state
  state = feed(state, accountMessage(SYNC_ID, 0, steamAccountObject("s_steam")), T0 + 1).state
  state = feed(state, accountMessage(SYNC_ID, 1, accountObject("s_totp")), T0 + 2).state
  const result = feed(state, commitMessage(SYNC_ID, 2), T0 + 3)
  assert.equal(result.ack.ok, true)
  assert.deepEqual(
    result.committed.accounts.map(account => account.otpType),
    ["steam", "totp"]
  )
})

test("invalid Steam field combinations are dropped and fail the commit", () => {
  let state = createSyncState()
  state = feed(state, beginMessage(SYNC_ID, 2)).state
  state = feed(state, accountMessage(SYNC_ID, 0, steamAccountObject("s_steam")), T0 + 1).state

  for (const [overrides, error] of [
    [{ digits: 6 }, "account_invalid:steam_digits_invalid"],
    [{ period: 60 }, "account_invalid:steam_period_invalid"],
    [{ algorithm: "SHA256" }, "account_invalid:steam_algorithm_invalid"],
    [{ otpType: "hotp" }, "account_invalid:otp_type_invalid"]
  ]) {
    const invalid = feed(
      state,
      accountMessage(SYNC_ID, 1, Object.assign(steamAccountObject("s_bad"), overrides)),
      T0 + 2
    )
    assert.equal(invalid.ignored, true)
    assert.ok(invalid.errors.includes(error), "expected " + error + " got " + invalid.errors)
  }

  // The valid Steam account is staged, but the second one never is.
  const result = feed(state, commitMessage(SYNC_ID, 2), T0 + 3)
  assert.equal(result.ack.ok, false)
  assert.equal(result.ack.error, "incomplete_sync")
})

test("plain TOTP still rejects digits=5", () => {
  let state = createSyncState()
  state = feed(state, beginMessage(SYNC_ID, 1)).state
  const invalid = feed(
    state,
    accountMessage(SYNC_ID, 0, accountObject("s_bad", { digits: 5 })),
    T0 + 1
  )
  assert.equal(invalid.ignored, true)
  assert.ok(invalid.errors.includes("account_invalid:digits_out_of_range"))
})