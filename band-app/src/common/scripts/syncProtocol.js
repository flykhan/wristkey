/**
 * WristKey band app - sync protocol v3 state machine (pure functions).
 *
 * Implements the phone -> band half of docs/protocol.md (v3, and v2 for
 * compatibility with older Android builds):
 *   mfa_sync_begin   -> (re)starts staging
 *   mfa_sync_account -> validates + stages one account
 *   mfa_sync_commit  -> validates the full staging set, emits a snapshot + ack
 *   mfa_pin_set/query/clear -> returns a pinCommand for the storage layer,
 *                             which replies with mfa_pin_ack / mfa_pin_state
 *
 * The module has no Vela runtime dependency (no @system.*) and no storage/UI
 * side effects: callers persist the committed snapshot and deliver the ack.
 * This keeps the tricky validation logic testable in plain Node.js
 * (see tests/syncProtocol.test.mjs).
 *
 * A message that violates the protocol is ignored, counted in the state error
 * counters, and never aborts an otherwise valid sync. A failing commit always
 * discards staging so the previously stored snapshot stays untouched.
 */

import { normalizeAccount, parseSnapshotPayload, SNAPSHOT_VERSION } from "./accountModel.js"
import { normalizePinRecord } from "./pin.js"

export const PROTOCOL_VERSION = 3
export const SUPPORTED_PROTOCOL_VERSIONS = [2, 3]
export const MAX_SYNC_ACCOUNTS = 500
export const STAGING_TIMEOUT_MS = 120000
export const MAX_SYNC_ID_LENGTH = 128

export const MESSAGE_BEGIN = "mfa_sync_begin"
export const MESSAGE_ACCOUNT = "mfa_sync_account"
export const MESSAGE_COMMIT = "mfa_sync_commit"
export const MESSAGE_ACK = "mfa_sync_ack"
export const MESSAGE_REQUEST = "mfa_sync_request"

// v3 pin channel.
export const MESSAGE_PIN_SET = "mfa_pin_set"
export const MESSAGE_PIN_QUERY = "mfa_pin_query"
export const MESSAGE_PIN_CLEAR = "mfa_pin_clear"
export const MESSAGE_PIN_ACK = "mfa_pin_ack"
export const MESSAGE_PIN_STATE = "mfa_pin_state"

/** Fresh (idle) staging state. */
export function createSyncState() {
  return {
    syncId: null,
    accountCount: 0,
    startedAt: 0,
    slots: [],
    lastMessageAt: 0,
    invalidCount: 0,
    duplicateIndexCount: 0,
    duplicateIdCount: 0,
    lastError: null
  }
}

export function isStagingActive(state) {
  return !!state && typeof state.syncId === "string" && state.syncId.length > 0
}

/** Number of staged (valid, deduplicated by index) accounts. */
export function getReceivedCount(state) {
  if (!state || !Array.isArray(state.slots)) {
    return 0
  }
  let count = 0
  for (let index = 0; index < state.slots.length; index++) {
    if (state.slots[index]) {
      count += 1
    }
  }
  return count
}

/**
 * Extract the JSON payload from a system.interconnect message.
 * The Vela event is usually an object with a data field; tests pass strings.
 */
export function extractPayload(message) {
  if (typeof message === "string") {
    return message
  }
  if (!message || typeof message !== "object") {
    return null
  }
  if (typeof message.data === "string") {
    return message.data
  }
  if (message.data && typeof message.data === "object") {
    return message.data
  }
  // Any remaining object is treated as a parsed envelope; parseEnvelope()
  // reports missing_type / invalid_message as needed.
  return message
}

/**
 * Parse and validate the protocol envelope. Both v2 (legacy Android builds)
 * and v3 are accepted here; pin messages additionally require version 3 in
 * handleMessage(). Unknown versions/types are returned as errors so the caller
 * can ignore them (protocol: unknown type/version must be ignored).
 * @returns {{ok: true, message: object} | {ok: false, error: string, type?: string}}
 */
export function parseEnvelope(raw) {
  const payload = extractPayload(raw)
  if (payload === null) {
    return { ok: false, error: "empty_message" }
  }

  let message = payload
  if (typeof payload === "string") {
    if (payload.trim().length === 0) {
      return { ok: false, error: "empty_message" }
    }
    try {
      message = JSON.parse(payload)
    } catch (error) {
      return { ok: false, error: "invalid_json" }
    }
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return { ok: false, error: "invalid_message" }
  }
  if (typeof message.type !== "string" || message.type.length === 0) {
    return { ok: false, error: "missing_type" }
  }
  if (SUPPORTED_PROTOCOL_VERSIONS.indexOf(message.version) < 0) {
    return { ok: false, error: "unsupported_version", type: message.type }
  }
  return { ok: true, message: message }
}

/**
 * Discard staging when it has been idle for too long.
 * @returns {{state: object, expired: boolean}}
 */
export function checkStagingTimeout(state, now, timeoutMs) {
  const current = state || createSyncState()
  const timestamp = typeof now === "number" ? now : Date.now()
  const limit = typeof timeoutMs === "number" ? timeoutMs : STAGING_TIMEOUT_MS
  if (isStagingActive(current) && timestamp - current.startedAt > limit) {
    return { state: createSyncState(), expired: true }
  }
  return { state: current, expired: false }
}

/**
 * Feed one raw interconnect message into the state machine.
 *
 * @param {object} state state returned by a previous call (createSyncState() first)
 * @param {string|object} raw JSON string, parsed envelope or event with data field
 * @param {number} [now] Unix milliseconds (injectable for tests)
 * @param {{previousAccounts?: object[]}} [options] previousAccounts supplies the
 *   stored snapshot so v3 account messages without a password keep the stored
 *   password (absence = keep, "" = clear).
 * @returns {{
 *   state: object,
 *   handled: boolean,
 *   ignored: boolean,
 *   ack: object|null,
 *   committed: object|null,
 *   errors: string[],
 *   pinCommand?: {type: "set"|"query"|"clear", record?: object, requestId?: string}|null
 * }}
 *   ack: the object to send back to the phone (null when not applicable)
 *   committed: a v3 snapshot to persist atomically (null when not committed)
 *   pinCommand: storage/UI work for mfa_pin_* messages; the caller applies it
 *   and then sends mfa_pin_ack / mfa_pin_state (pure layer never touches disk)
 */
export function handleMessage(state, raw, now, options) {
  const timestamp = typeof now === "number" ? now : Date.now()
  const settings = options || {}
  const current = state || createSyncState()
  const errors = []

  const timeoutCheck = checkStagingTimeout(current, timestamp)
  let working = timeoutCheck.state
  if (timeoutCheck.expired) {
    errors.push("staging_timeout")
  }

  const parsed = parseEnvelope(raw)
  if (!parsed.ok) {
    return ignoredResult(working, errors.concat([parsed.error]), parsed.type)
  }

  const message = parsed.message

  // Pin messages only exist in v3; a v2 envelope carrying one is ignored so an
  // old phone build can never influence the lock.
  if (isPinMessageType(message.type)) {
    if (message.version !== PROTOCOL_VERSION) {
      return ignoredResult(working, errors.concat(["pin_requires_v3"]), message.type)
    }
    return handlePinMessage(working, message, timestamp)
  }

  if (message.type === MESSAGE_BEGIN) {
    return handleBegin(working, message, timestamp, errors)
  }
  if (message.type === MESSAGE_ACCOUNT) {
    return handleAccount(working, message, timestamp, errors, settings)
  }
  if (message.type === MESSAGE_COMMIT) {
    return handleCommit(working, message, timestamp, errors)
  }
  return ignoredResult(working, errors.concat(["unknown_type:" + message.type]))
}

/**
 * Build a mfa_sync_ack envelope.
 * @param {{syncId?: string, ok?: boolean, received?: number, committed?: number,
 *          error?: string|null, sentAt?: number}} options
 */
export function buildAck(options) {
  const settings = options || {}
  return {
    type: MESSAGE_ACK,
    version: PROTOCOL_VERSION,
    sentAt: typeof settings.sentAt === "number" ? settings.sentAt : Date.now(),
    syncId: typeof settings.syncId === "string" ? settings.syncId : "",
    ok: settings.ok === true,
    received: toCount(settings.received),
    committed: toCount(settings.committed),
    error: settings.error ? String(settings.error) : null
  }
}

/**
 * Build a mfa_sync_request envelope asking the phone for a full snapshot.
 * @param {{sentAt?: number, requestId?: string}} [options]
 */
export function buildSyncRequest(options) {
  const settings = options || {}
  const sentAt = typeof settings.sentAt === "number" ? settings.sentAt : Date.now()
  return {
    type: MESSAGE_REQUEST,
    version: PROTOCOL_VERSION,
    sentAt: sentAt,
    requestId: settings.requestId
      ? String(settings.requestId)
      : "req-" + sentAt + "-" + randomSuffix()
  }
}

/**
 * Build a mfa_pin_ack envelope (v3 only).
 * @param {{ok?: boolean, enabled?: boolean, error?: string|null, sentAt?: number}} options
 */
export function buildPinAck(options) {
  const settings = options || {}
  return {
    type: MESSAGE_PIN_ACK,
    version: PROTOCOL_VERSION,
    sentAt: typeof settings.sentAt === "number" ? settings.sentAt : Date.now(),
    ok: settings.ok === true,
    enabled: settings.enabled === true,
    error: settings.error ? String(settings.error) : null
  }
}

/**
 * Build a mfa_pin_state envelope (v3 only). Broadcasts (no requestId) omit the
 * field entirely; query replies echo the requestId.
 * @param {object|null} record stored pin record or null when disabled
 * @param {{sentAt?: number, requestId?: string}} [options]
 */
export function buildPinState(record, options) {
  const settings = options || {}
  const enabled = !!record
  const state = {
    type: MESSAGE_PIN_STATE,
    version: PROTOCOL_VERSION,
    sentAt: typeof settings.sentAt === "number" ? settings.sentAt : Date.now(),
    enabled: enabled,
    updatedAt: enabled && typeof record.updatedAt === "number" ? record.updatedAt : 0
  }
  if (settings.requestId !== undefined && settings.requestId !== null) {
    const requestId = String(settings.requestId).trim()
    if (requestId.length > 0) {
      state.requestId = requestId
    }
  }
  return state
}

/** Serialise an outgoing message (single JSON object, protocol requirement). */
export function serializeMessage(message) {
  return JSON.stringify(message)
}

/**
 * Optional v1 compatibility: the BandOTP phone app sent a single
 * "mfa_config_snapshot" message. v1 is not part of v3 sync, but accepting it
 * lets an older phone app push a snapshot to this band. Returns a v3 snapshot
 * (to persist) or null when the message is not a v1 snapshot.
 */
export function parseLegacySnapshot(raw) {
  const payload = extractPayload(raw)
  if (payload === null) {
    return null
  }
  let message = payload
  if (typeof payload === "string") {
    try {
      message = JSON.parse(payload)
    } catch (error) {
      return null
    }
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return null
  }
  if (message.type !== "mfa_config_snapshot") {
    return null
  }
  return parseSnapshotPayload(message)
}

/* --------------------------------------------------------------------------
 * Internal handlers
 * ------------------------------------------------------------------------ */

function isPinMessageType(type) {
  return type === MESSAGE_PIN_SET || type === MESSAGE_PIN_QUERY || type === MESSAGE_PIN_CLEAR
}

function handlePinMessage(state, message, now) {
  if (message.type === MESSAGE_PIN_SET) {
    const normalized = normalizePinRecord(message.pin, {
      timestamp: now,
      requireAlgorithm: true
    })
    if (!normalized.ok) {
      return {
        state: state,
        handled: true,
        ignored: false,
        ack: buildPinAck({ ok: false, error: "invalid_pin_payload", sentAt: now }),
        committed: null,
        errors: ["invalid_pin_payload"],
        pinCommand: null
      }
    }
    return {
      state: state,
      handled: true,
      ignored: false,
      ack: null,
      committed: null,
      errors: [],
      pinCommand: { type: "set", record: normalized.record }
    }
  }

  if (message.type === MESSAGE_PIN_QUERY) {
    const requestId = typeof message.requestId === "string" ? message.requestId.trim() : ""
    return {
      state: state,
      handled: true,
      ignored: false,
      ack: null,
      committed: null,
      errors: [],
      pinCommand: { type: "query", requestId: requestId }
    }
  }

  return {
    state: state,
    handled: true,
    ignored: false,
    ack: null,
    committed: null,
    errors: [],
    pinCommand: { type: "clear" }
  }
}

/** Password of a previously stored account with the same id, or "". */
function previousPassword(accounts, id) {
  if (!Array.isArray(accounts)) {
    return ""
  }
  for (let index = 0; index < accounts.length; index++) {
    const account = accounts[index]
    if (account && account.id === id && typeof account.password === "string") {
      return account.password
    }
  }
  return ""
}

function handleBegin(state, message, now, errors) {
  const syncId = typeof message.syncId === "string" ? message.syncId.trim() : ""
  const count = toInteger(message.accountCount)
  const found = errors.slice()

  if (syncId.length === 0 || syncId.length > MAX_SYNC_ID_LENGTH) {
    found.push("invalid_sync_id")
  }
  if (count === null || count < 0 || count > MAX_SYNC_ACCOUNTS) {
    found.push("invalid_account_count")
  }
  if (found.length > errors.length) {
    return {
      state: state,
      handled: true,
      ignored: true,
      ack: null,
      committed: null,
      errors: found
    }
  }

  const next = createSyncState()
  next.syncId = syncId
  next.accountCount = count
  next.startedAt = now
  next.lastMessageAt = now
  next.slots = new Array(count)
  for (let index = 0; index < count; index++) {
    next.slots[index] = null
  }
  return {
    state: next,
    handled: true,
    ignored: false,
    ack: null,
    committed: null,
    errors: found
  }
}

function handleAccount(state, message, now, errors, options) {
  if (!isStagingActive(state)) {
    return ignoredStateResult(state, errors.concat(["no_active_begin"]), "no_active_begin")
  }
  if (message.syncId !== state.syncId) {
    const next = withError(state, "sync_id_mismatch")
    return ignoredStateResult(next, errors.concat(["sync_id_mismatch"]), "sync_id_mismatch")
  }

  const index = toInteger(message.index)
  if (index === null || index < 0 || index >= state.accountCount) {
    const next = withError(state, "index_out_of_range")
    return ignoredStateResult(next, errors.concat(["index_out_of_range"]), "index_out_of_range")
  }

  const normalized = normalizeAccount(message.account, {
    timestamp: now,
    fallbackId: String(index)
  })
  if (!normalized.ok) {
    const error = "account_invalid:" + normalized.error
    const next = withError(state, error)
    return ignoredStateResult(next, errors.concat([error]), error)
  }
  const account = normalized.account
  const settings = options || {}
  const rawAccount = message.account && typeof message.account === "object" ? message.account : null
  const supportsPassword = message.version === PROTOCOL_VERSION
  const hasPassword = supportsPassword && rawAccount !== null &&
    Object.prototype.hasOwnProperty.call(rawAccount, "password")

  if (hasPassword) {
    if (typeof rawAccount.password !== "string") {
      const passwordError = "account_invalid:password_invalid"
      const invalid = withError(state, passwordError)
      return ignoredStateResult(invalid, errors.concat([passwordError]), passwordError)
    }
  } else {
    // v3 absence means "keep the stored password"; v2 never carries one, so an
    // old phone build cannot wipe passwords on re-sync.
    account.password = previousPassword(settings.previousAccounts, account.id)
  }

  // The same account id staged under a different index is a protocol violation.
  for (let slot = 0; slot < state.slots.length; slot++) {
    const existing = state.slots[slot]
    if (existing && slot !== index && existing.id === account.id) {
      const next = withError(state, "duplicate_account_id")
      next.duplicateIdCount += 1
      return ignoredStateResult(
        next,
        errors.concat(["duplicate_account_id"]),
        "duplicate_account_id"
      )
    }
  }

  const next = cloneState(state)
  if (next.slots[index]) {
    next.duplicateIndexCount += 1
    errors.push("duplicate_index")
  }
  next.slots[index] = account
  next.lastMessageAt = now
  return {
    state: next,
    handled: true,
    ignored: false,
    ack: null,
    committed: null,
    errors: errors
  }
}

function handleCommit(state, message, now, errors) {
  const syncId = typeof message.syncId === "string" ? message.syncId : ""
  const count = toInteger(message.accountCount)
  const received = getReceivedCount(state)

  if (!isStagingActive(state)) {
    return failureCommit(
      state,
      buildAck({ syncId: syncId, ok: false, received: received, committed: 0, error: "no_active_begin", sentAt: now }),
      errors.concat(["no_active_begin"]),
      received,
      now
    )
  }

  if (syncId !== state.syncId) {
    return failureCommit(
      createSyncState(),
      buildAck({ syncId: syncId, ok: false, received: received, committed: 0, error: "sync_id_mismatch", sentAt: now }),
      errors.concat(["sync_id_mismatch"]),
      received,
      now
    )
  }

  if (count === null || count !== state.accountCount) {
    return failureCommit(
      createSyncState(),
      buildAck({ syncId: syncId, ok: false, received: received, committed: 0, error: "account_count_mismatch", sentAt: now }),
      errors.concat(["account_count_mismatch"]),
      received,
      now
    )
  }

  const accounts = []
  let complete = true
  for (let index = 0; index < state.slots.length; index++) {
    if (state.slots[index]) {
      accounts.push(state.slots[index])
    } else {
      complete = false
    }
  }

  if (!complete || accounts.length !== state.accountCount) {
    return failureCommit(
      createSyncState(),
      buildAck({ syncId: syncId, ok: false, received: accounts.length, committed: 0, error: "incomplete_sync", sentAt: now }),
      errors.concat(["incomplete_sync"]),
      accounts.length,
      now
    )
  }

  const snapshot = {
    version: SNAPSHOT_VERSION,
    updatedAt: now,
    accounts: accounts
  }
  return {
    state: createSyncState(),
    handled: true,
    ignored: false,
    ack: buildAck({
      syncId: syncId,
      ok: true,
      received: accounts.length,
      committed: accounts.length,
      error: null,
      sentAt: now
    }),
    committed: snapshot,
    errors: errors
  }
}

function failureCommit(state, ack, errors, received, now) {
  const next = state && isStagingActive(state) ? createSyncState() : (state || createSyncState())
  if (isStagingActive(state)) {
    next.invalidCount = state.invalidCount + 1
    next.lastError = ack.error
  }
  next.lastMessageAt = now
  return {
    state: next,
    handled: true,
    ignored: false,
    ack: ack,
    committed: null,
    errors: errors
  }
}

function ignoredResult(state, errors, type) {
  const result = {
    state: state,
    handled: false,
    ignored: true,
    ack: null,
    committed: null,
    errors: errors
  }
  if (type) {
    result.type = type
  }
  return result
}

function ignoredStateResult(state, errors, error) {
  return {
    state: state,
    handled: true,
    ignored: true,
    ack: null,
    committed: null,
    errors: errors,
    error: error
  }
}

function cloneState(state) {
  return {
    syncId: state.syncId,
    accountCount: state.accountCount,
    startedAt: state.startedAt,
    slots: state.slots.slice(0),
    lastMessageAt: state.lastMessageAt,
    invalidCount: state.invalidCount,
    duplicateIndexCount: state.duplicateIndexCount,
    duplicateIdCount: state.duplicateIdCount,
    lastError: state.lastError
  }
}

function withError(state, error) {
  const next = cloneState(state)
  next.invalidCount += 1
  next.lastError = error
  return next
}

function toInteger(value) {
  if (value === undefined || value === null || value === "") {
    return null
  }
  const parsed = Number(value)
  if (!isFinite(parsed) || Math.floor(parsed) !== parsed) {
    return null
  }
  return parsed
}

function toCount(value) {
  const parsed = toInteger(value)
  if (parsed === null || parsed < 0) {
    return 0
  }
  return parsed
}

function randomSuffix() {
  return Math.floor(Math.random() * 0xffff).toString(16)
}