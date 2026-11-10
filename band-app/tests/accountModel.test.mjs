import test from "node:test"
import assert from "node:assert/strict"

import {
  DEFAULT_CATEGORY,
  MAX_CATEGORY_LENGTH,
  MAX_ID_LENGTH,
  MAX_NAME_LENGTH,
  SNAPSHOT_VERSION,
  collectCategories,
  createSnapshot,
  emptySnapshot,
  filterAccountsByCategory,
  findAccountById,
  maskSecret,
  sortAccountsById,
  normalizeAccount,
  normalizeAccounts,
  parseSnapshotPayload
} from "../src/common/scripts/accountModel.js"

const NOW = 1760000000000

function validAccount(overrides) {
  return Object.assign(
    {
      id: "s_ab12cd34ef56",
      issuer: "GitHub",
      accountName: "me@example.com",
      category: "开发",
      secret: "JBSWY3DPEHPK3PXP",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      updatedAt: 1759999999000
    },
    overrides || {}
  )
}

test("normalizeAccount accepts a full valid account", () => {
  const result = normalizeAccount(validAccount(), { timestamp: NOW })
  assert.equal(result.ok, true)
  assert.deepEqual(result.account, validAccount())
})

test("normalizeAccount applies defaults for missing optional fields", () => {
  const result = normalizeAccount(
    {
      id: "no-optionals",
      issuer: "GitHub",
      accountName: "me@example.com",
      secret: "JBSWY3DPEHPK3PXP"
    },
    { timestamp: NOW }
  )
  assert.equal(result.ok, true)
  assert.equal(result.account.category, DEFAULT_CATEGORY)
  assert.equal(result.account.algorithm, "SHA1")
  assert.equal(result.account.digits, 6)
  assert.equal(result.account.period, 30)
  assert.equal(result.account.updatedAt, NOW)
})

test("normalizeAccount normalises lowercase algorithm and padded secret", () => {
  const result = normalizeAccount(
    validAccount({
      id: "x",
      algorithm: "sha512",
      secret: "jbsw y3dp ehpk 3pxp ==",
      category: "  开发  "
    }),
    { timestamp: NOW }
  )
  assert.equal(result.ok, true)
  assert.equal(result.account.algorithm, "SHA512")
  assert.equal(result.account.secret, "JBSWY3DPEHPK3PXP")
  assert.equal(result.account.category, "开发")
})

test("normalizeAccount rejects accounts with empty issuer and account name", () => {
  const noIssuer = normalizeAccount(
    { accountName: "", secret: "JBSWY3DPEHPK3PXP" },
    { timestamp: NOW, fallbackId: "0" }
  )
  assert.equal(noIssuer.ok, false)
  assert.equal(noIssuer.error, "empty_issuer_and_account")

  const blank = normalizeAccount(
    { issuer: "   ", accountName: "  ", secret: "JBSWY3DPEHPK3PXP" },
    { timestamp: NOW, fallbackId: "0" }
  )
  assert.equal(blank.ok, false)
  assert.equal(blank.error, "empty_issuer_and_account")

  const onlyIssuer = normalizeAccount(
    { issuer: "GitHub", secret: "JBSWY3DPEHPK3PXP" },
    { timestamp: NOW, fallbackId: "0" }
  )
  assert.equal(onlyIssuer.ok, true)
  assert.equal(onlyIssuer.account.accountName, "")
})

test("normalizeAccount rejects invalid period/digits boundaries", () => {
  for (const period of [0, 4, 301, 30.5, "abc", -30]) {
    const result = normalizeAccount(validAccount({ period: period }), { timestamp: NOW })
    assert.equal(result.ok, false, "period " + period)
    assert.equal(result.error, "period_out_of_range")
    assert.equal(result.field, "period")
  }
  for (const digits of [5, 0, 11, 8.5]) {
    const result = normalizeAccount(validAccount({ digits: digits }), { timestamp: NOW })
    assert.equal(result.ok, false, "digits " + digits)
    assert.equal(result.error, "digits_out_of_range")
  }
  for (const period of [5, 300]) {
    assert.equal(normalizeAccount(validAccount({ period: period }), { timestamp: NOW }).ok, true)
  }
  for (const digits of [6, 8, 10]) {
    assert.equal(normalizeAccount(validAccount({ digits: digits }), { timestamp: NOW }).ok, true)
  }
})

test("normalizeAccount rejects invalid secrets", () => {
  for (const secret of ["", "   ", "JBSWY3DP1", "JBSWY3DP-", "JBSWY3DP0", null, 42]) {
    const result = normalizeAccount(validAccount({ secret: secret }), { timestamp: NOW })
    assert.equal(result.ok, false, "secret " + JSON.stringify(secret))
    assert.equal(result.field, "secret")
  }
})

test("normalizeAccount rejects unsupported algorithms and over-long text", () => {
  for (const algorithm of ["md5", "SHA-1", "none"]) {
    const result = normalizeAccount(validAccount({ algorithm: algorithm }), { timestamp: NOW })
    assert.equal(result.ok, false)
    assert.equal(result.error, "algorithm_invalid")
  }
  const longIssuer = normalizeAccount(
    validAccount({ issuer: "x".repeat(MAX_NAME_LENGTH + 1) }),
    { timestamp: NOW }
  )
  assert.equal(longIssuer.ok, false)
  assert.equal(longIssuer.error, "issuer_too_long")

  const longName = normalizeAccount(
    validAccount({ accountName: "x".repeat(MAX_NAME_LENGTH + 1) }),
    { timestamp: NOW }
  )
  assert.equal(longName.ok, false)

  const longId = normalizeAccount(
    validAccount({ id: "x".repeat(MAX_ID_LENGTH + 1) }),
    { timestamp: NOW }
  )
  assert.equal(longId.ok, false)
  assert.equal(longId.error, "id_too_long")

  const longCategory = normalizeAccount(
    validAccount({ category: "x".repeat(MAX_CATEGORY_LENGTH + 1) }),
    { timestamp: NOW }
  )
  assert.equal(longCategory.ok, false)
  assert.equal(longCategory.error, "category_too_long")
})

test("normalizeAccount falls back to the provided index id", () => {
  const withId = normalizeAccount(validAccount({ id: "custom" }), {
    timestamp: NOW,
    fallbackId: "7"
  })
  assert.equal(withId.account.id, "custom")

  const noId = normalizeAccount(validAccount({ id: undefined }), {
    timestamp: NOW,
    fallbackId: "7"
  })
  assert.equal(noId.ok, true)
  assert.equal(noId.account.id, "7")

  const blankId = normalizeAccount(validAccount({ id: "  " }), {
    timestamp: NOW,
    fallbackId: 3
  })
  assert.equal(blankId.ok, true)
  assert.equal(blankId.account.id, "3")

  const missingFallback = normalizeAccount(validAccount({ id: null }), { timestamp: NOW })
  assert.equal(missingFallback.ok, false)
  assert.equal(missingFallback.error, "id_missing")
})

test("normalizeAccounts reports invalid entries and deduplicates ids", () => {
  const accounts = [
    validAccount({ id: "a" }),
    validAccount({ id: "a" }),
    { id: "b", issuer: "", accountName: "", secret: "JBSWY3DPEHPK3PXP" },
    validAccount({ id: "c", secret: "not-base32-1" })
  ]
  const result = normalizeAccounts(accounts, { timestamp: NOW })
  assert.equal(result.accounts.length, 1)
  assert.equal(result.accounts[0].id, "a")
  assert.equal(result.errors.length, 3)
  assert.equal(result.errors[0].error, "duplicate_id")
  assert.equal(result.errors[1].error, "empty_issuer_and_account")
  assert.equal(result.errors[2].error, "secret_invalid_char")

  assert.deepEqual(normalizeAccounts(null).errors, [
    { index: -1, error: "accounts_not_array" }
  ])
})

test("createSnapshot stores version, updatedAt and normalized accounts", () => {
  const snapshot = createSnapshot(
    [
      {
        issuer: "GitHub",
        accountName: "me@example.com",
        secret: "jbswy3dpehpk3pxp",
        algorithm: "sha256"
      }
    ],
    NOW
  )
  assert.equal(snapshot.version, SNAPSHOT_VERSION)
  assert.equal(snapshot.updatedAt, NOW)
  assert.equal(snapshot.accounts.length, 1)
  assert.equal(snapshot.accounts[0].id, "idx-0")
  assert.equal(snapshot.accounts[0].secret, "JBSWY3DPEHPK3PXP")
  assert.equal(snapshot.accounts[0].algorithm, "SHA256")

  const empty = createSnapshot([], NOW)
  assert.deepEqual(empty, { version: 2, updatedAt: NOW, accounts: [] })
})

test("parseSnapshotPayload accepts v2 JSON and legacy v1 configs", () => {
  const v2 = parseSnapshotPayload(
    JSON.stringify({ version: 2, updatedAt: NOW, accounts: [validAccount()] })
  )
  assert.equal(v2.version, 2)
  assert.equal(v2.updatedAt, NOW)
  assert.equal(v2.accounts.length, 1)
  assert.equal(v2.errors.length, 0)

  // BandOTP v1 snapshot shape ({configs:[...]}) is mapped to v2 accounts.
  const v1 = parseSnapshotPayload({
    version: 1,
    updatedAt: 1759999999000,
    configs: [validAccount({ id: "legacy" })]
  })
  assert.equal(v1.version, 2)
  assert.equal(v1.accounts.length, 1)
  assert.equal(v1.accounts[0].id, "legacy")
  assert.equal(v1.sourceVersion, 1)

  assert.equal(parseSnapshotPayload("not json"), null)
  assert.equal(parseSnapshotPayload(""), null)
  assert.equal(parseSnapshotPayload(null), null)
  assert.equal(parseSnapshotPayload({ version: 2 }), null)
  assert.equal(parseSnapshotPayload([]), null)
  assert.deepEqual(emptySnapshot(), { version: 2, updatedAt: 0, accounts: [] })
})

test("category helpers keep first-appearance order and counts", () => {
  const accounts = [
    validAccount({ id: "1", category: "开发" }),
    validAccount({ id: "2", category: "Web" }),
    validAccount({ id: "3", category: "开发" }),
    validAccount({ id: "4", category: undefined })
  ]
  assert.deepEqual(collectCategories(accounts), [
    { name: "开发", count: 2 },
    { name: "Web", count: 1 },
    { name: DEFAULT_CATEGORY, count: 1 }
  ])
  assert.equal(filterAccountsByCategory(accounts, "开发").length, 2)
  assert.equal(filterAccountsByCategory(accounts, DEFAULT_CATEGORY).length, 1)
  assert.equal(filterAccountsByCategory(accounts, "missing").length, 0)
  assert.equal(findAccountById(accounts, "2").issuer, "GitHub")
  assert.equal(findAccountById(accounts, "nope"), null)
})

test("sortAccountsById orders deterministically without mutating input", () => {
  const accounts = [
    { id: "s_c" },
    { id: "s_a" },
    { id: "s_b" }
  ]
  const sorted = sortAccountsById(accounts)
  assert.deepEqual(sorted.map(account => account.id), ["s_a", "s_b", "s_c"])
  assert.deepEqual(accounts.map(account => account.id), ["s_c", "s_a", "s_b"])
  assert.deepEqual(sortAccountsById(null), [])
})

test("maskSecret never exposes the full secret", () => {
  const secret = "JBSWY3DPEHPK3PXP"
  const masked = maskSecret(secret)
  assert.notEqual(masked, secret)
  assert.equal(masked, "JBSW…3PXP")
  assert.equal(maskSecret(""), "——")
  assert.equal(maskSecret("SHORT"), "********")
  assert.equal(maskSecret(null), "——")
})
