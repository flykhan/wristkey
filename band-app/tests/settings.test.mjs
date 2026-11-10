import test from "node:test"
import assert from "node:assert/strict"

import {
  ACCOUNTS_PER_PAGE,
  DARK_THEME,
  LIGHT_THEME,
  cyclePage,
  describeSync,
  formatClock,
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
