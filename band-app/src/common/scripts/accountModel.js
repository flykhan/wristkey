/**
 * WristKey band app - account model.
 *
 * Pure validation/normalisation shared by the sync protocol, storage and UI.
 * No Vela runtime dependency, so it is covered by tests/accountModel.test.mjs.
 *
 * Validation rules follow docs/protocol.md v3 (including otpType="steam" and
 * the optional account password added in v3):
 *   id           non-empty string, <= 64 (falls back to the message index)
 *   issuer       string, <= 64; issuer and accountName must not both be empty
 *   accountName  string, <= 64
 *   category     string, default "默认分类", <= 32
 *   secret       Base32 A-Z2-7 (spaces/''='' padding allowed), normalised
 *   otpType      "totp" (default) or "steam" (case-insensitive)
 *   algorithm    SHA1 / SHA256 / SHA512 (case-insensitive), default SHA1;
 *                forced to SHA1 for Steam
 *   digits       6-10 integer, default 6; forced to 5 for Steam
 *                (digits=5 is only legal together with otpType="steam")
 *   period       5-300 integer seconds, default 30; forced to 30 for Steam
 *   password     optional v3 string, <= 128 UTF-16 code units, spaces and
 *                Unicode allowed, control characters U+0000-U+001F rejected;
 *                missing/null defaults to "" (no password on this account)
 *   updatedAt    optional Unix milliseconds
 *
 * Fields that are present but invalid make the whole account invalid (the
 * caller drops it and counts an error); fields that are missing get defaults.
 */

import {
  ALGORITHMS,
  DEFAULT_ALGORITHM,
  OTP_TYPE_STEAM,
  STEAM_DIGITS,
  STEAM_PERIOD,
  normalizeBase32,
  normalizeDigits,
  normalizeOtpType,
  normalizePeriod
} from "./totp.js"

export const DEFAULT_CATEGORY = "默认分类"
export const SNAPSHOT_VERSION = 3
export const MAX_ID_LENGTH = 64
export const MAX_NAME_LENGTH = 64
export const MAX_CATEGORY_LENGTH = 32
export const MAX_PASSWORD_LENGTH = 128
export const MAX_ACCOUNTS = 500

const ALGORITHM_SET = {}
for (let index = 0; index < ALGORITHMS.length; index++) {
  ALGORITHM_SET[ALGORITHMS[index]] = true
}

/**
 * Normalise one account.
 * @param {object} raw
 * @param {{timestamp?: number, fallbackId?: string|number}} [options]
 * @returns {{ok: true, account: object} | {ok: false, error: string, field?: string}}
 */
export function normalizeAccount(raw, options) {
  const settings = options || {}
  const now = typeof settings.timestamp === "number" ? settings.timestamp : Date.now()
  if (!isPlainObject(raw)) {
    return fail("account_not_object")
  }

  const issuer = toText(raw.issuer)
  const accountName = toText(raw.accountName)
  if (issuer.length === 0 && accountName.length === 0) {
    return fail("empty_issuer_and_account")
  }
  if (issuer.length > MAX_NAME_LENGTH) {
    return fail("issuer_too_long", "issuer")
  }
  if (accountName.length > MAX_NAME_LENGTH) {
    return fail("account_name_too_long", "accountName")
  }

  let id = ""
  const rawId = raw.id
  if (rawId !== undefined && rawId !== null && String(rawId).trim().length > 0) {
    id = String(rawId).trim()
    if (id.length > MAX_ID_LENGTH) {
      return fail("id_too_long", "id")
    }
  } else if (settings.fallbackId !== undefined && settings.fallbackId !== null &&
             String(settings.fallbackId).length > 0) {
    id = String(settings.fallbackId)
  } else {
    return fail("id_missing", "id")
  }

  const secret = normalizeBase32(raw.secret)
  if (!secret.ok) {
    return fail(secret.error, "secret")
  }

  const otpType = normalizeOtpType(raw.otpType)
  if (otpType === null) {
    return fail("otp_type_invalid", "otpType")
  }
  const isSteam = otpType === OTP_TYPE_STEAM

  let algorithm = DEFAULT_ALGORITHM
  if (raw.algorithm !== undefined && raw.algorithm !== null &&
      String(raw.algorithm).trim().length > 0) {
    const candidate = String(raw.algorithm).trim().toUpperCase()
    if (!ALGORITHM_SET[candidate]) {
      return fail("algorithm_invalid", "algorithm")
    }
    algorithm = candidate
  }

  let digits
  let period
  if (isSteam) {
    // Steam Guard is fixed to 5 alphanumeric characters / 30 s / SHA1. An
    // explicitly conflicting field means sender and band disagree, so the
    // account is dropped instead of being displayed with a wrong code.
    if (algorithm !== "SHA1") {
      return fail("steam_algorithm_invalid", "algorithm")
    }
    if (hasValue(raw.digits)) {
      const parsedDigits = Number(raw.digits)
      if (!isFinite(parsedDigits) || parsedDigits !== STEAM_DIGITS) {
        return fail("steam_digits_invalid", "digits")
      }
    }
    if (hasValue(raw.period)) {
      const parsedPeriod = Number(raw.period)
      if (!isFinite(parsedPeriod) || parsedPeriod !== STEAM_PERIOD) {
        return fail("steam_period_invalid", "period")
      }
    }
    digits = STEAM_DIGITS
    period = STEAM_PERIOD
  } else {
    digits = normalizeDigits(raw.digits)
    if (digits === null) {
      return fail("digits_out_of_range", "digits")
    }
    period = normalizePeriod(raw.period)
    if (period === null) {
      return fail("period_out_of_range", "period")
    }
  }

  let category = DEFAULT_CATEGORY
  if (raw.category !== undefined && raw.category !== null) {
    const candidate = String(raw.category).trim()
    if (candidate.length > 0) {
      if (candidate.length > MAX_CATEGORY_LENGTH) {
        return fail("category_too_long", "category")
      }
      category = candidate
    }
  }

  const passwordResult = normalizePassword(raw.password)
  if (!passwordResult.ok) {
    return fail(passwordResult.error, "password")
  }

  let updatedAt = now
  if (raw.updatedAt !== undefined && raw.updatedAt !== null) {
    const parsed = Number(raw.updatedAt)
    if (isFinite(parsed) && parsed > 0) {
      updatedAt = Math.floor(parsed)
    }
  }

  return {
    ok: true,
    account: {
      id: id,
      issuer: issuer,
      accountName: accountName,
      category: category,
      secret: secret.value,
      otpType: otpType,
      algorithm: algorithm,
      digits: digits,
      period: period,
      password: passwordResult.value,
      updatedAt: updatedAt
    }
  }
}

/**
 * Normalise an optional account password. Missing/null means "no password"
 * (v2 snapshots and plain TOTP accounts). The value is never trimmed: spaces
 * are legal password characters.
 * @returns {{ok: true, value: string} | {ok: false, error: string}}
 */
export function normalizePassword(value) {
  if (value === undefined || value === null) {
    return { ok: true, value: "" }
  }
  if (typeof value !== "string") {
    return { ok: false, error: "password_invalid" }
  }
  if (value.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, error: "password_too_long" }
  }
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) < 0x20) {
      return { ok: false, error: "password_control_character" }
    }
  }
  return { ok: true, value: value }
}

/**
 * Normalise a list of accounts, keeping valid entries and reporting dropped
 * ones. Duplicate ids keep the first occurrence.
 * @returns {{accounts: object[], errors: {index: number, error: string, field?: string}[]}}
 */
export function normalizeAccounts(list, options) {
  const settings = options || {}
  const timestamp = typeof settings.timestamp === "number" ? settings.timestamp : Date.now()
  const accounts = []
  const errors = []
  const seenIds = {}

  if (!Array.isArray(list)) {
    return { accounts: accounts, errors: [{ index: -1, error: "accounts_not_array" }] }
  }

  for (let index = 0; index < list.length; index++) {
    const result = normalizeAccount(list[index], {
      timestamp: timestamp,
      fallbackId: "idx-" + index
    })
    if (!result.ok) {
      errors.push({ index: index, error: result.error, field: result.field })
      continue
    }
    if (seenIds[result.account.id]) {
      errors.push({ index: index, error: "duplicate_id", field: "id" })
      continue
    }
    seenIds[result.account.id] = true
    accounts.push(result.account)
  }

  return { accounts: accounts, errors: errors }
}

/** Build a v3 storage payload from accounts (never called with untrusted strings). */
export function createSnapshot(accounts, updatedAt) {
  const timestamp = typeof updatedAt === "number" ? updatedAt : Date.now()
  const normalized = normalizeAccounts(Array.isArray(accounts) ? accounts : [], {
    timestamp: timestamp
  })
  return {
    version: SNAPSHOT_VERSION,
    updatedAt: timestamp,
    accounts: normalized.accounts
  }
}

/**
 * Parse a stored/built snapshot payload. Tolerant: accepts v2/v3 payloads
 * ({"accounts": [...]}) and legacy v1 shapes ({"configs": [...]}) produced by
 * BandOTP, returning a v3 snapshot or null when the payload is not a snapshot.
 * Accounts without a password (v1/v2 data) load with password "" instead of
 * being rejected, which is required for the v2 -> v3 migration.
 */
export function parseSnapshotPayload(raw) {
  let payload = raw
  if (typeof raw === "string") {
    try {
      payload = JSON.parse(raw)
    } catch (error) {
      return null
    }
  }
  if (!isPlainObject(payload)) {
    return null
  }

  let list = null
  if (Array.isArray(payload.accounts)) {
    list = payload.accounts
  } else if (Array.isArray(payload.configs)) {
    list = payload.configs
  }
  if (list === null) {
    return null
  }

  let updatedAt = 0
  const parsedUpdatedAt = Number(payload.updatedAt)
  if (isFinite(parsedUpdatedAt) && parsedUpdatedAt > 0) {
    updatedAt = Math.floor(parsedUpdatedAt)
  }

  const result = normalizeAccounts(list)
  return {
    version: SNAPSHOT_VERSION,
    updatedAt: updatedAt,
    accounts: result.accounts,
    errors: result.errors,
    sourceVersion: isFinite(Number(payload.version)) ? Number(payload.version) : 1
  }
}

/** Empty v3 snapshot. */
export function emptySnapshot() {
  return { version: SNAPSHOT_VERSION, updatedAt: 0, accounts: [] }
}

/** Categories in first-appearance order with account counts. */
export function collectCategories(accounts) {
  const categories = []
  const indexByName = {}
  const list = Array.isArray(accounts) ? accounts : []
  for (let index = 0; index < list.length; index++) {
    const account = list[index] || {}
    const name = account.category || DEFAULT_CATEGORY
    if (indexByName[name] === undefined) {
      indexByName[name] = categories.length
      categories.push({ name: name, count: 0 })
    }
    categories[indexByName[name]].count += 1
  }
  return categories
}

/** Accounts belonging to one category ("默认分类" when category is missing). */
export function filterAccountsByCategory(accounts, category) {
  const list = Array.isArray(accounts) ? accounts : []
  const wanted = category || DEFAULT_CATEGORY
  const result = []
  for (let index = 0; index < list.length; index++) {
    const account = list[index] || {}
    if ((account.category || DEFAULT_CATEGORY) === wanted) {
      result.push(account)
    }
  }
  return result
}

/**
 * Sort accounts by id for display.
 * The protocol does not guarantee snapshot order (cross-end checks compare id
 * sets), so the band UI sorts deterministically: category grouping is applied
 * first, then accounts by id within a category.
 */
export function sortAccountsById(accounts) {
  const list = Array.isArray(accounts) ? accounts.slice(0) : []
  list.sort(function (left, right) {
    const a = left && left.id !== undefined ? String(left.id) : ""
    const b = right && right.id !== undefined ? String(right.id) : ""
    if (a < b) {
      return -1
    }
    if (a > b) {
      return 1
    }
    return 0
  })
  return list
}

/** Find an account by id, returns null when not present. */
export function findAccountById(accounts, id) {
  const list = Array.isArray(accounts) ? accounts : []
  for (let index = 0; index < list.length; index++) {
    if (list[index] && list[index].id === id) {
      return list[index]
    }
  }
  return null
}

/** Mask a secret for display. The full secret never reaches the UI layer. */
export function maskSecret(secret) {
  const value = typeof secret === "string" ? secret : ""
  if (value.length === 0) {
    return "——"
  }
  if (value.length <= 8) {
    return "********"
  }
  return value.slice(0, 4) + "…" + value.slice(value.length - 4)
}

function fail(error, field) {
  const result = { ok: false, error: error }
  if (field) {
    result.field = field
  }
  return result
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim().length > 0
}

function toText(value) {
  if (value === undefined || value === null) {
    return ""
  }
  return String(value).trim()
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}