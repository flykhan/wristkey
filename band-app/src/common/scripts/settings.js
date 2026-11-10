/**
 * WristKey band app - display settings and pure view helpers.
 *
 * Kept free of @system.* imports so tests can cover paging, letter filtering
 * and code font sizing.
 *
 * UI v3 (docs/design/ui-v3-spec.md):
 *   - 3 accounts per page, no top bar / status row
 *   - right rail A-Z button opens pages/picker; filter persists in storage
 *   - letter buckets: issuer first character, else account name; A-Z / 0-9,
 *     anything else (CJK, symbols, empty) -> "#"
 */

export const THEME_STORAGE_KEY = "wristkey_dark_mode"
export const CATEGORY_STORAGE_KEY = "wristkey_category"
export const LETTER_FILTER_STORAGE_KEY = "wristkey_letter_filter"
export const ACCOUNTS_PER_PAGE = 3
export const DEFAULT_DARK_MODE = true

/** A-Z + 0-9 (26 + 10 = 36 keys) in picker display order. */
export const LETTER_KEYS = []
for (let index = 0; index < 26; index++) {
  LETTER_KEYS.push(String.fromCharCode(65 + index))
}
for (let digit = 0; digit <= 9; digit++) {
  LETTER_KEYS.push(String(digit))
}
/** All selectable buckets, including the catch-all "#". */
export const LETTER_BUCKET_KEYS = LETTER_KEYS.concat(["#"])

export const LIGHT_THEME = {
  pageBackground: "#F3F0E9",
  cardBackground: "#FFFFFF",
  cardBorder: "#E7E2D8",
  itemBackground: "#F2F6F3",
  title: "#1E2A2E",
  body: "#45555C",
  secondary: "#8B9AA0",
  disabledText: "#B9C4BF",
  accent: "#0F8C6C",
  codeColor: "#0B6E55",
  accentSoft: "#E5F2EC",
  buttonBackground: "#E8F2EE",
  progressTrack: "#E3E8EA",
  progressSafe: "#0F8C6C",
  progressWarn: "#F57C00",
  progressDanger: "#D84315",
  divider: "#E3E8EA"
}

export const DARK_THEME = {
  pageBackground: "#000000",
  cardBackground: "#0B0F0E",
  cardBorder: "#1C2724",
  itemBackground: "#111715",
  title: "#EDF5F1",
  body: "#C5D2CD",
  secondary: "#81938E",
  disabledText: "#4C5A55",
  accent: "#6ED5B7",
  codeColor: "#7FE3C6",
  accentSoft: "#16221E",
  buttonBackground: "#1B2622",
  progressTrack: "#2A3633",
  progressSafe: "#6ED5B7",
  progressWarn: "#FFB74D",
  progressDanger: "#FF8A65",
  divider: "#22302C"
}

/**
 * Per-letter bucket of a string: first character, uppercased; A-Z / 0-9 kept,
 * everything else (CJK, symbols, empty) becomes "#".
 */
export function letterBucket(value) {
  const text = typeof value === "string" ? value.trim() : ""
  if (text.length === 0) {
    return "#"
  }
  const first = text.charAt(0).toUpperCase()
  if (first >= "A" && first <= "Z") {
    return first
  }
  if (first >= "0" && first <= "9") {
    return first
  }
  return "#"
}

/** Issuer's first character wins; empty issuer falls back to accountName. */
export function accountLetter(account) {
  if (!account) {
    return "#"
  }
  const issuer = typeof account.issuer === "string" ? account.issuer.trim() : ""
  if (issuer.length > 0) {
    return letterBucket(issuer)
  }
  const accountName =
    typeof account.accountName === "string" ? account.accountName.trim() : ""
  if (accountName.length > 0) {
    return letterBucket(accountName)
  }
  return "#"
}

/** Letter bucket -> account count, with every bucket present (0 when empty). */
export function buildLetterCounts(accounts) {
  const counts = {}
  for (let index = 0; index < LETTER_BUCKET_KEYS.length; index++) {
    counts[LETTER_BUCKET_KEYS[index]] = 0
  }
  const list = Array.isArray(accounts) ? accounts : []
  for (let index = 0; index < list.length; index++) {
    counts[accountLetter(list[index])] += 1
  }
  return counts
}

/** Normalise a stored filter: "" means all; otherwise one of A-Z/0-9/#. */
export function normalizeLetterFilter(value) {
  const text = typeof value === "string" ? value.trim().toUpperCase() : ""
  if (text.length === 0) {
    return ""
  }
  return LETTER_BUCKET_KEYS.indexOf(text) >= 0 ? text : ""
}

/**
 * Filter accounts by letter bucket. Empty filter returns all accounts.
 * Categories are intentionally ignored (v3 filters across the whole list).
 */
export function filterAccountsByLetter(accounts, letter) {
  const list = Array.isArray(accounts) ? accounts : []
  const wanted = normalizeLetterFilter(letter)
  if (wanted === "") {
    return list.slice(0)
  }
  const result = []
  for (let index = 0; index < list.length; index++) {
    if (accountLetter(list[index]) === wanted) {
      result.push(list[index])
    }
  }
  return result
}

/* --------------------------------------------------------------------------
 * UI v4 letter picker: full-screen 4x4 grid, 3 pages, swipe up/down.
 * ------------------------------------------------------------------------ */

export const PICKER_COLUMNS = 4
export const PICKER_ROWS = 4
export const PICKER_PAGE_SIZE = PICKER_COLUMNS * PICKER_ROWS
export const PICKER_PAGE_COUNT = 3
export const PICKER_ALL_KEY = "ALL"
export const PASSWORD_REVEAL_MS = 10000

/**
 * 48 cells across 3 pages ("" is a decorative empty cell). Page 1 is A-P,
 * page 2 continues with Q-Z and 0-5, page 3 holds 6-9, "#" and 全部.
 */
export const PICKER_PAGE_KEYS = [
  ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P"],
  ["Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z", "0", "1", "2", "3", "4", "5"],
  ["6", "7", "8", "9", "#", PICKER_ALL_KEY, "", "", "", "", "", "", "", "", "", ""]
]

/**
 * Build the cells of one picker page.
 * @param {object[]} accounts all accounts (category is intentionally ignored)
 * @param {string} currentFilter "" or one of A-Z/0-9/#
 * @param {object} theme palette (LIGHT_THEME/DARK_THEME)
 * @param {number} pageIndex 0..PICKER_PAGE_COUNT-1 (clamped)
 * @returns {object[]} 16 cells
 */
export function buildPickerPage(accounts, currentFilter, theme, pageIndex) {
  const palette = theme || DARK_THEME
  const list = Array.isArray(accounts) ? accounts : []
  const counts = buildLetterCounts(list)
  const filter = normalizeLetterFilter(currentFilter)
  let page = typeof pageIndex === "number" ? Math.floor(pageIndex) : 0
  if (page < 0) {
    page = 0
  }
  if (page >= PICKER_PAGE_COUNT) {
    page = PICKER_PAGE_COUNT - 1
  }
  const keys = PICKER_PAGE_KEYS[page]
  const cells = []
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]
    if (key === "") {
      cells.push({
        key: "",
        label: "",
        count: 0,
        countText: "",
        hasAccounts: false,
        selected: false,
        placeholder: true,
        disabled: false,
        background: "transparent",
        textColor: palette.secondary,
        countColor: palette.secondary,
        borderColor: "transparent",
        borderWidth: 0
      })
      continue
    }
    const isAll = key === PICKER_ALL_KEY
    const count = isAll ? list.length : counts[key]
    const hasAccounts = count > 0
    const selected = isAll ? filter === "" : filter === key
    cells.push({
      key: key,
      label: isAll ? "全部" : key,
      count: count,
      countText: String(count),
      hasAccounts: hasAccounts,
      selected: selected,
      placeholder: false,
      disabled: false,
      background: hasAccounts || selected ? palette.accentSoft : "transparent",
      textColor: hasAccounts ? palette.title : palette.disabledText,
      countColor: hasAccounts ? palette.secondary : palette.disabledText,
      borderColor: selected ? palette.accent : "transparent",
      borderWidth: selected ? 2 : 0
    })
  }
  return cells
}

/** Build all three picker pages (used by tests and simple UIs). */
export function buildPickerPages(accounts, currentFilter, theme) {
  const pages = []
  for (let page = 0; page < PICKER_PAGE_COUNT; page++) {
    pages.push(buildPickerPage(accounts, currentFilter, theme, page))
  }
  return pages
}

/** Number of accounts visible under the current filter (rail hint). */
export function filteredAccountCount(accounts, letter) {
  return filterAccountsByLetter(accounts, letter).length
}

/**
 * Detail screen password row. Empty passwords show a placeholder; a stored
 * password is masked until the user taps it for PASSWORD_REVEAL_MS.
 * @returns {{text: string, empty: boolean, hidden: boolean}}
 */
export function passwordDisplay(password, revealed) {
  const value = typeof password === "string" ? password : ""
  if (value.length === 0) {
    return { text: "未导入密码", empty: true, hidden: false }
  }
  if (revealed === true) {
    return { text: value, empty: false, hidden: false }
  }
  return { text: "••••••••", empty: false, hidden: true }
}

/**
 * List row code font size (px): 6 digits / 5-char Steam -> 42,
 * 8 digits -> 40, 10 digits -> 34.
 */
export function listCodeFontSize(groupedCode) {
  return codeFontSizeFor(groupedCode, 42, 40, 34)
}

/** Detail screen code size (single large code, no neighbour cards). */
export function detailCodeFontSize(groupedCode) {
  return codeFontSizeFor(groupedCode, 70, 58, 46)
}

function codeFontSizeFor(groupedCode, short, medium, long) {
  const length = String(groupedCode || "").replace(/\s/g, "").length
  if (length <= 6) {
    return short
  }
  if (length <= 8) {
    return medium
  }
  return long
}

/** Interpret a stored dark-mode flag ("true"/"dark"/"1" mean dark). */
export function parseDarkMode(value) {
  return value === "true" || value === "dark" || value === "1"
}

export function themeFor(isDark) {
  return isDark ? DARK_THEME : LIGHT_THEME
}

/** Countdown colour: green -> orange (<=5s) -> red (<=2s). */
export function progressColor(remaining, theme) {
  const palette = theme || DARK_THEME
  if (remaining <= 2) {
    return palette.progressDanger
  }
  if (remaining <= 5) {
    return palette.progressWarn
  }
  return palette.progressSafe
}

/**
 * Page a list.
 * @returns {{items: any[], page: number, pageCount: number, total: number}}
 */
export function paginate(items, page, pageSize) {
  const list = Array.isArray(items) ? items : []
  const size = typeof pageSize === "number" && pageSize > 0 ? pageSize : ACCOUNTS_PER_PAGE
  const pageCount = Math.max(1, Math.ceil(list.length / size))
  let current = typeof page === "number" ? Math.floor(page) : 0
  if (current < 0) {
    current = 0
  }
  if (current >= pageCount) {
    current = pageCount - 1
  }
  const start = current * size
  return {
    items: list.slice(start, start + size),
    page: current,
    pageCount: pageCount,
    total: list.length
  }
}

/** Cycle the page index, wrapping at both ends (band: swipe to loop). */
export function cyclePage(page, pageCount, direction) {
  const count = typeof pageCount === "number" && pageCount > 0 ? pageCount : 1
  const current = typeof page === "number" ? page : 0
  const step = direction < 0 ? -1 : 1
  let next = (current + step) % count
  if (next < 0) {
    next += count
  }
  return next
}

/** "今天 15:20" / "11-10 15:20" / "" when timestamp is missing. */
export function formatClock(timestamp, now) {
  if (typeof timestamp !== "number" || timestamp <= 0) {
    return ""
  }
  const date = new Date(timestamp)
  const reference = new Date(typeof now === "number" ? now : Date.now())
  const time = pad2(date.getHours()) + ":" + pad2(date.getMinutes())
  const sameDay =
    date.getFullYear() === reference.getFullYear() &&
    date.getMonth() === reference.getMonth() &&
    date.getDate() === reference.getDate()
  if (sameDay) {
    return "今天 " + time
  }
  return pad2(date.getMonth() + 1) + "-" + pad2(date.getDate()) + " " + time
}

/**
 * Human readable sync state (used by the menu page / diagnostics).
 * @returns {{text: string, detail: string, empty: boolean}}
 */
export function describeSync(snapshot, connected, now) {
  const accounts = snapshot && Array.isArray(snapshot.accounts) ? snapshot.accounts : []
  const updatedAt = snapshot && typeof snapshot.updatedAt === "number" ? snapshot.updatedAt : 0
  const detail = connected ? "手机已连接" : "离线可用"
  if (accounts.length === 0 && updatedAt === 0) {
    return { text: "尚未同步", detail: connected ? "手机已连接" : "手机未连接", empty: true }
  }
  const parts = []
  parts.push(accounts.length + " 个账号")
  const clock = formatClock(updatedAt, now)
  if (clock) {
    parts.push(clock)
  }
  return { text: parts.join(" · "), detail: detail, empty: false }
}

function pad2(value) {
  return value < 10 ? "0" + value : String(value)
}