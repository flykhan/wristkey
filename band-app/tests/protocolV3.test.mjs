import test from "node:test"
import assert from "node:assert/strict"

import {
  MESSAGE_PIN_ACK,
  MESSAGE_PIN_CLEAR,
  MESSAGE_PIN_QUERY,
  MESSAGE_PIN_SET,
  MESSAGE_PIN_STATE,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  buildPinAck,
  buildPinState,
  createSyncState,
  handleMessage,
  parseEnvelope
} from "../src/common/scripts/syncProtocol.js"

const T0 = 1760000000000
const SYNC_ID = "sync-v3-test"
const SALT = "00112233445566778899aabbccddeeff"
const HASH = "ab".repeat(32)
const PIN_PAYLOAD = {
  algorithm: "PBKDF2-SHA256",
  salt: SALT,
  hash: HASH,
  iterations: 1200
}

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

function feed(state, message, now, options) {
  return handleMessage(state, message, now === undefined ? T0 : now, options)
}

test("protocol v3 still accepts v2 envelopes and commits a v3 snapshot", () => {
  assert.equal(PROTOCOL_VERSION, 3)
  assert.deepEqual(SUPPORTED_PROTOCOL_VERSIONS, [2, 3])
  for (const version of [2, 3]) {
    assert.equal(parseEnvelope({ type: "mfa_sync_begin", version: version }).ok, true)
  }
  assert.equal(parseEnvelope({ type: "mfa_sync_begin", version: 1 }).error, "unsupported_version")
  assert.equal(parseEnvelope({ type: "mfa_sync_begin", version: 4 }).error, "unsupported_version")

  let state = createSyncState()
  state = feed(state, { type: "mfa_sync_begin", version: 2, sentAt: T0, syncId: SYNC_ID, accountCount: 1 }).state
  state = feed(state, {
    type: "mfa_sync_account",
    version: 2,
    sentAt: T0,
    syncId: SYNC_ID,
    index: 0,
    account: accountObject("a")
  }).state
  const result = feed(state, {
    type: "mfa_sync_commit",
    version: 2,
    sentAt: T0 + 1,
    syncId: SYNC_ID,
    accountCount: 1
  })
  assert.equal(result.ack.ok, true)
  assert.equal(result.ack.version, 3)
  assert.equal(result.committed.version, 3)
  assert.equal(result.committed.accounts[0].password, "")
})

test("v3 account password presence: absent keeps, empty clears, value replaces", () => {
  const previousAccounts = [
    { id: "a", password: "old password" },
    { id: "b", password: "second" }
  ]

  let state = createSyncState()
  state = feed(state, { type: "mfa_sync_begin", version: 3, sentAt: T0, syncId: SYNC_ID, accountCount: 3 }).state
  state = feed(
    state,
    { type: "mfa_sync_account", version: 3, sentAt: T0, syncId: SYNC_ID, index: 0, account: accountObject("a") },
    T0,
    { previousAccounts }
  ).state
  state = feed(
    state,
    {
      type: "mfa_sync_account",
      version: 3,
      sentAt: T0,
      syncId: SYNC_ID,
      index: 1,
      account: accountObject("b", { password: "" })
    },
    T0,
    { previousAccounts }
  ).state
  state = feed(
    state,
    {
      type: "mfa_sync_account",
      version: 3,
      sentAt: T0,
      syncId: SYNC_ID,
      index: 2,
      account: accountObject("c", { password: "new pass" })
    },
    T0,
    { previousAccounts }
  ).state

  assert.equal(state.slots[0].password, "old password")
  assert.equal(state.slots[1].password, "")
  assert.equal(state.slots[2].password, "new pass")

  const result = feed(state, { type: "mfa_sync_commit", version: 3, sentAt: T0 + 2, syncId: SYNC_ID, accountCount: 3 })
  assert.equal(result.ack.ok, true)
  assert.deepEqual(result.committed.accounts.map(account => account.password), [
    "old password",
    "",
    "new pass"
  ])
})

test("v2 account messages never carry a password and keep the stored one", () => {
  const previousAccounts = [{ id: "a", password: "keep me" }]
  let state = feed(createSyncState(), {
    type: "mfa_sync_begin",
    version: 2,
    sentAt: T0,
    syncId: SYNC_ID,
    accountCount: 1
  }).state
  state = feed(
    state,
    {
      type: "mfa_sync_account",
      version: 2,
      sentAt: T0,
      syncId: SYNC_ID,
      index: 0,
      account: accountObject("a", { password: "should be ignored" })
    },
    T0,
    { previousAccounts }
  ).state
  assert.equal(state.slots[0].password, "keep me")
})

test("invalid v3 passwords are rejected with a specific error", () => {
  const cases = [
    [{ password: 42 }, "account_invalid:password_invalid"],
    [{ password: "x".repeat(129) }, "account_invalid:password_too_long"],
    [{ password: "line\nbreak" }, "account_invalid:password_control_character"]
  ]
  for (const [overrides, error] of cases) {
    const state = feed(createSyncState(), {
      type: "mfa_sync_begin",
      version: 3,
      sentAt: T0,
      syncId: SYNC_ID,
      accountCount: 1
    }).state
    const result = feed(state, {
      type: "mfa_sync_account",
      version: 3,
      sentAt: T0,
      syncId: SYNC_ID,
      index: 0,
      account: accountObject("a", overrides)
    })
    assert.equal(result.ignored, true, JSON.stringify(overrides))
    assert.ok(result.errors.includes(error), "expected " + error + " got " + result.errors)
  }
})

test("mfa_pin_set yields a pinCommand; the caller persists and acks", () => {
  const result = feed(createSyncState(), {
    type: MESSAGE_PIN_SET,
    version: 3,
    sentAt: T0,
    pin: PIN_PAYLOAD
  })
  assert.equal(result.handled, true)
  assert.equal(result.ack, null)
  assert.equal(result.pinCommand.type, "set")
  assert.equal(result.pinCommand.record.salt, SALT)
  assert.equal(result.pinCommand.record.hash, HASH)
  assert.equal(result.pinCommand.record.iterations, 1200)
  assert.equal(result.pinCommand.record.updatedAt, T0)
  assert.equal(result.pinCommand.record.algorithm, undefined)
})

test("malformed pin payload and v2 pin messages are refused", () => {
  const invalid = feed(createSyncState(), {
    type: MESSAGE_PIN_SET,
    version: 3,
    sentAt: T0,
    pin: { algorithm: "PBKDF2-SHA256", salt: "00", hash: "a".repeat(64), iterations: 1200 }
  })
  assert.equal(invalid.pinCommand, null)
  assert.equal(invalid.ack.ok, false)
  assert.equal(invalid.ack.error, "invalid_pin_payload")
  assert.equal(invalid.ack.version, 3)

  const oldPhone = feed(createSyncState(), {
    type: MESSAGE_PIN_QUERY,
    version: 2,
    sentAt: T0,
    requestId: "req-1"
  })
  assert.equal(oldPhone.ignored, true)
  assert.ok(!oldPhone.pinCommand)
  assert.ok(oldPhone.errors.includes("pin_requires_v3"))
})

test("mfa_pin_query and mfa_pin_clear return pinCommands", () => {
  const query = feed(createSyncState(), {
    type: MESSAGE_PIN_QUERY,
    version: 3,
    sentAt: T0,
    requestId: "  req-42  "
  })
  assert.deepEqual(query.pinCommand, { type: "query", requestId: "req-42" })

  const clear = feed(createSyncState(), {
    type: MESSAGE_PIN_CLEAR,
    version: 3,
    sentAt: T0
  })
  assert.deepEqual(clear.pinCommand, { type: "clear" })
})

test("buildPinAck and buildPinState shapes", () => {
  assert.deepEqual(buildPinAck({ ok: true, enabled: true, sentAt: T0 }), {
    type: MESSAGE_PIN_ACK,
    version: 3,
    sentAt: T0,
    ok: true,
    enabled: true,
    error: null
  })
  const failed = buildPinAck({ ok: false, error: "invalid_pin_payload", sentAt: T0 })
  assert.equal(failed.ok, false)
  assert.equal(failed.enabled, false)
  assert.equal(failed.error, "invalid_pin_payload")

  assert.deepEqual(buildPinState({ updatedAt: 123 }, { sentAt: T0 }), {
    type: MESSAGE_PIN_STATE,
    version: 3,
    sentAt: T0,
    enabled: true,
    updatedAt: 123
  })
  assert.deepEqual(buildPinState(null, { sentAt: T0, requestId: "req-9" }), {
    type: MESSAGE_PIN_STATE,
    version: 3,
    sentAt: T0,
    enabled: false,
    updatedAt: 0,
    requestId: "req-9"
  })
  assert.equal("requestId" in buildPinState(null, { sentAt: T0 }), false)
})