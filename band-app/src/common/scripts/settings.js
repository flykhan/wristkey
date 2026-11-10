/**
 * WristKey band app - display settings and pure view helpers.
 *
 * Kept free of @system.* imports so tests can cover paging/formatting.
 * Storage access (reading/writing these keys) happens in the pages.
 */

export const THEME_STORAGE_KEY = "wristkey_dark_mode"
export const CATEGORY_STORAGE_KEY = "wristkey_category"
export const ACCOUNTS_PER_PAGE = 3
export const DEFAULT_DARK_MODE = true

export const LIGHT_THEME = {
  pageBackground: "#F3F0E9",
  cardBackground: "#FFFFFF",
  cardBorder: "#E7E2D8",
  title: "#1E2A2E",
  body: "#45555C",
  secondary: "#8B9AA0",
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
  title: "#EDF5F1",
  body: "#C5D2CD",
  secondary: "#81938E",
  accent: "#6ED5B7",
  codeColor: "#7FE3C6",
  accentSoft: "#13211C",
  buttonBackground: "#1B2622",
  progressTrack: "#2A3633",
  progressSafe: "#6ED5B7",
  progressWarn: "#FFB74D",
  progressDanger: "#FF8A65",
  divider: "#22302C"
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

/** Cycle the page index, wrapping at both ends (band: tap/swipe to loop). */
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
 * Human readable sync state for the index header.
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
