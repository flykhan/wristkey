import test from "node:test"
import assert from "node:assert/strict"

import {
  DARK_THEME,
  PASSWORD_REVEAL_MS,
  PICKER_ALL_KEY,
  PICKER_COLUMNS,
  PICKER_PAGE_COUNT,
  PICKER_PAGE_KEYS,
  PICKER_PAGE_SIZE,
  PICKER_ROWS,
  buildPickerPage,
  buildPickerPages,
  filteredAccountCount,
  passwordDisplay
} from "../src/common/scripts/settings.js"

const ACCOUNTS = [
  { id: "1", issuer: "Amazon", accountName: "me" },
  { id: "2", issuer: "GitHub", accountName: "dev" },
  { id: "3", issuer: "", accountName: "@user" },
  { id: "4", issuer: "Steam", accountName: "gamer" }
]

test("picker grid is 4x4 across 3 pages and covers every bucket", () => {
  assert.equal(PICKER_COLUMNS, 4)
  assert.equal(PICKER_ROWS, 4)
  assert.equal(PICKER_PAGE_SIZE, 16)
  assert.equal(PICKER_PAGE_COUNT, 3)
  assert.equal(PICKER_PAGE_KEYS.length, 3)
  for (const keys of PICKER_PAGE_KEYS) {
    assert.equal(keys.length, 16)
  }

  const pages = buildPickerPages(ACCOUNTS, "", DARK_THEME)
  assert.equal(pages.length, 3)
  for (const page of pages) {
    assert.equal(page.length, 16)
  }
  assert.equal(pages[0][0].key, "A")
  assert.equal(pages[0][15].key, "P")
  assert.equal(pages[1][0].key, "Q")
  assert.equal(pages[1][15].key, "5")
  assert.equal(pages[2][0].key, "6")
  assert.equal(pages[2][4].key, "#")
  assert.equal(pages[2][5].key, PICKER_ALL_KEY)
  assert.equal(pages[2][5].label, "全部")
  assert.equal(pages[2][6].placeholder, true)
  assert.equal(pages[2][6].key, "")
})

test("picker pages show counts per bucket and the total on 全部", () => {
  const page0 = buildPickerPage(ACCOUNTS, "", DARK_THEME, 0)
  const a = page0.find(cell => cell.key === "A")
  const g = page0.find(cell => cell.key === "G")
  assert.equal(a.count, 1)
  assert.equal(a.hasAccounts, true)
  assert.equal(a.countText, "1")
  assert.equal(g.count, 1)
  assert.equal(page0.find(cell => cell.key === "B").count, 0)
  assert.equal(page0.find(cell => cell.key === "B").hasAccounts, false)
  assert.equal(page0.find(cell => cell.key === "B").textColor, DARK_THEME.disabledText)

  const page2 = buildPickerPage(ACCOUNTS, "", DARK_THEME, 2)
  const all = page2.find(cell => cell.key === PICKER_ALL_KEY)
  assert.equal(all.count, ACCOUNTS.length)
  assert.equal(all.hasAccounts, true)
  const hash = page2.find(cell => cell.key === "#")
  assert.equal(hash.count, 1)
})

test("current filter is highlighted; 全部 is selected only when unfiltered", () => {
  const filtered = buildPickerPage(ACCOUNTS, "a", DARK_THEME, 0)
  const a = filtered.find(cell => cell.key === "A")
  assert.equal(a.selected, true)
  assert.equal(a.borderWidth, 2)
  assert.equal(a.borderColor, DARK_THEME.accent)

  const allPage = buildPickerPage(ACCOUNTS, "a", DARK_THEME, 2)
  assert.equal(allPage.find(cell => cell.key === PICKER_ALL_KEY).selected, false)

  const unfiltered = buildPickerPage(ACCOUNTS, "", DARK_THEME, 2)
  assert.equal(unfiltered.find(cell => cell.key === PICKER_ALL_KEY).selected, true)
  assert.equal(unfiltered.find(cell => cell.key === PICKER_ALL_KEY).borderWidth, 2)
})

test("filteredAccountCount ignores categories and count stays total for 全部", () => {
  assert.equal(filteredAccountCount(ACCOUNTS, ""), 4)
  assert.equal(filteredAccountCount(ACCOUNTS, "A"), 1)
  assert.equal(filteredAccountCount(ACCOUNTS, "#"), 1)
  assert.equal(filteredAccountCount(ACCOUNTS, "Z"), 0)
})

test("password display masks by default and reveals for 10 seconds only", () => {
  assert.equal(PASSWORD_REVEAL_MS, 10000)
  assert.deepEqual(passwordDisplay("", false), { text: "未导入密码", empty: true, hidden: false })
  assert.deepEqual(passwordDisplay(null, true), { text: "未导入密码", empty: true, hidden: false })
  assert.deepEqual(passwordDisplay("vault pass", false), {
    text: "••••••••",
    empty: false,
    hidden: true
  })
  assert.deepEqual(passwordDisplay("vault pass", true), {
    text: "vault pass",
    empty: false,
    hidden: false
  })
})