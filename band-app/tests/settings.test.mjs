import test from "node:test"
import assert from "node:assert/strict"

import {
  ACCOUNTS_PER_PAGE,
  DARK_THEME,
  LIGHT_THEME,
  LETTER_BUCKET_KEYS,
  LETTER_FILTER_STORAGE_KEY,
  LETTER_KEYS,
  accountLetter,
  buildLetterCounts,
  cyclePage,
  describeSync,
  detailCodeFontSize,
  filterAccountsByLetter,
  formatClock,
  letterBucket,
  listCodeFontSize,
  normalizeLetterFilter,
  paginate,
  parseDarkMode,
  progressColor,
  themeFor
} from "../src/common/scripts/settings.js"

test("parseDarkMode accepts the stored forms", () => {
  assert.equal(parseDarkMode("true"), true)
  assert.equal(parseDarkMode("dark"), true)
  assert.equal(parseDarkMode("1"), true)
  assert.equal(parseDarkMode("false"), false)
  assert.equal(parseDarkMode(""), false)
  assert.equal(parseDarkMode(null), false)
  assert.equal(themeFor(true), DARK_THEME)
  assert.equal(themeFor(false), LIGHT_THEME)
})

test("paginate returns three accounts per page and clamps the page", () => {
  const items = Array.from({ length: 7 }, (_, index) => ({ id: String(index) }))
  assert.equal(ACCOUNTS_PER_PAGE, 3)

  const first = paginate(items, 0)
  assert.deepEqual(first.items.map(item => item.id), ["0", "1", "2"])
  assert.equal(first.pageCount, 3)
  assert.equal(first.total, 7)

  const second = paginate(items, 1)
  assert.deepEqual(second.items.map(item => item.id), ["3", "4", "5"])

  const third = paginate(items, 2)
  assert.deepEqual(third.items.map(item => item.id), ["6"])
  assert.equal(third.page, 2)

  assert.equal(paginate(items, 99).page, 2)
  assert.equal(paginate(items, -5).page, 0)

  const empty = paginate([], 0)
  assert.deepEqual(empty.items, [])
  assert.equal(empty.pageCount, 1)
  assert.equal(empty.total, 0)

  assert.equal(paginate(null, 0).total, 0)
})

test("list code font sizes are 42/40/34 (v3 spec)", () => {
  assert.equal(listCodeFontSize("3DP36"), 42) // Steam 5 chars
  assert.equal(listCodeFontSize("123 456"), 42) // 6 digits
  assert.equal(listCodeFontSize("1234 5678"), 40) // 8 digits
  assert.equal(listCodeFontSize("12345 67890"), 34) // 10 digits
  assert.equal(listCodeFontSize(""), 42)
  assert.equal(detailCodeFontSize("3DP36"), 70)
  assert.equal(detailCodeFontSize("123 456"), 70)
  assert.equal(detailCodeFontSize("123 45678"), 58)
  assert.equal(detailCodeFontSize("123 4567890"), 46)
})

test("letterBucket: A-Z / 0-9 else # (case-insensitive, trimmed)", () => {
  assert.equal(letterBucket("GitHub"), "G")
  assert.equal(letterBucket("  steam"), "S")
  assert.equal(letterBucket("7zip"), "7")
  assert.equal(letterBucket("0account"), "0")
  assert.equal(letterBucket("小米"), "#")
  assert.equal(letterBucket("--"), "#")
  assert.equal(letterBucket(""), "#")
  assert.equal(letterBucket("   "), "#")
  assert.equal(letterBucket(null), "#")
  assert.equal(letterBucket(undefined), "#")
  assert.equal(letterBucket(42), "#")
})

test("accountLetter prefers issuer, falls back to account name", () => {
  assert.equal(accountLetter({ issuer: "GitHub", accountName: "me" }), "G")
  assert.equal(accountLetter({ issuer: "  ", accountName: "alice" }), "A")
  assert.equal(accountLetter({ issuer: "", accountName: "小米" }), "#")
  assert.equal(accountLetter({ issuer: "", accountName: "" }), "#")
  assert.equal(accountLetter({}), "#")
  assert.equal(accountLetter(null), "#")
})

test("buildLetterCounts counts every bucket (0 when absent)", () => {
  const counts = buildLetterCounts([
    { issuer: "GitHub", accountName: "me" },
    { issuer: "gitlab", accountName: "me" },
    { issuer: "7zip", accountName: "" },
    { issuer: "", accountName: "alice" },
    { issuer: "小米", accountName: "me" },
    { issuer: "", accountName: "" }
  ])
  assert.equal(LETTER_KEYS.length, 36)
  assert.equal(LETTER_BUCKET_KEYS.length, 37)
  assert.equal(counts["G"], 2)
  assert.equal(counts["7"], 1)
  assert.equal(counts["A"], 1)
  assert.equal(counts["#"], 2)
  assert.equal(counts["B"], 0)
  assert.equal(Object.keys(counts).length, 37)
  assert.deepEqual(buildLetterCounts(null)["A"], 0)
})

test("filterAccountsByLetter filters across all accounts (ignores category)", () => {
  const accounts = [
    { id: "a", issuer: "GitHub", accountName: "me", category: "开发" },
    { id: "b", issuer: "Google", accountName: "me", category: "Web" },
    { id: "c", issuer: "gitlab", accountName: "me", category: "开发" },
    { id: "d", issuer: "", accountName: "7zip", category: "工具" },
    { id: "e", issuer: "小米", accountName: "me", category: "默认分类" }
  ]
  assert.deepEqual(filterAccountsByLetter(accounts, "").map(a => a.id), ["a", "b", "c", "d", "e"])
  assert.deepEqual(filterAccountsByLetter(accounts, "G").map(a => a.id), ["a", "b", "c"])
  assert.deepEqual(filterAccountsByLetter(accounts, "g").map(a => a.id), ["a", "b", "c"])
  assert.deepEqual(filterAccountsByLetter(accounts, "7").map(a => a.id), ["d"])
  assert.deepEqual(filterAccountsByLetter(accounts, "#").map(a => a.id), ["e"])
  assert.deepEqual(filterAccountsByLetter(accounts, "Z"), [])
  assert.deepEqual(filterAccountsByLetter(null, "A"), [])
  // The input array is not mutated.
  assert.equal(accounts.length, 5)
})

test("normalizeLetterFilter keeps only a valid bucket or empty", () => {
  assert.equal(LETTER_FILTER_STORAGE_KEY, "wristkey_letter_filter")
  assert.equal(normalizeLetterFilter("s"), "S")
  assert.equal(normalizeLetterFilter(" 7 "), "7")
  assert.equal(normalizeLetterFilter("#"), "#")
  assert.equal(normalizeLetterFilter(""), "")
  assert.equal(normalizeLetterFilter("   "), "")
  assert.equal(normalizeLetterFilter("all"), "")
  assert.equal(normalizeLetterFilter("AB"), "")
  assert.equal(normalizeLetterFilter(null), "")
  assert.equal(normalizeLetterFilter(undefined), "")
})

test("cyclePage wraps in both directions", () => {
  assert.equal(cyclePage(0, 3, 1), 1)
  assert.equal(cyclePage(2, 3, 1), 0)
  assert.equal(cyclePage(0, 3, -1), 2)
  assert.equal(cyclePage(0, 1, 1), 0)
})

test("formatClock shows today vs other days", () => {
  const now = new Date(2026, 10, 10, 15, 20, 0).getTime()
  assert.equal(formatClock(now, now), "今天 15:20")
  assert.equal(formatClock(new Date(2026, 10, 9, 8, 5, 0).getTime(), now), "11-09 08:05")
  assert.equal(formatClock(0, now), "")
  assert.equal(formatClock(undefined, now), "")
})

test("describeSync covers empty, offline and synced states", () => {
  const now = new Date(2026, 10, 10, 15, 20, 0).getTime()
  const empty = describeSync({ version: 2, updatedAt: 0, accounts: [] }, false, now)
  assert.equal(empty.empty, true)
  assert.equal(empty.text, "尚未同步")
  assert.equal(empty.detail, "手机未连接")

  const synced = describeSync(
    { version: 2, updatedAt: now, accounts: [{ id: "a" }, { id: "b" }] },
    true,
    now
  )
  assert.equal(synced.empty, false)
  assert.equal(synced.text, "2 个账号 · 今天 15:20")
  assert.equal(synced.detail, "手机已连接")
})

test("progressColor switches at 5s and 2s", () => {
  assert.equal(progressColor(30, DARK_THEME), DARK_THEME.progressSafe)
  assert.equal(progressColor(5, DARK_THEME), DARK_THEME.progressWarn)
  assert.equal(progressColor(2, DARK_THEME), DARK_THEME.progressDanger)
})
