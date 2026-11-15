import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// UI v5 (2.2.0): real-device feedback was that the A-Z button, menu button,
// lock close button and back button were too small, that usernames/passwords
// were nearly invisible and that every hint was too small. These tests pin the
// 480x336 layout sizes so a later refactor cannot silently shrink them again.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8")
}

function cssBlock(source, selector) {
  const start = source.indexOf(selector + " {")
  assert.ok(start >= 0, "缺少 CSS 块 " + selector)
  const end = source.indexOf("}", start)
  return source.slice(start, end + 1)
}

function methodBody(source, name) {
  const definition = new RegExp("\\n  " + name + "\\([^)]*\\) \\{")
  const match = definition.exec(source)
  assert.ok(match, "缺少方法 " + name)
  const bodyStart = match.index + match[0].length
  const end = source.indexOf("\n  },", bodyStart)
  return source.slice(bodyStart, end === -1 ? undefined : end)
}

test("band-app is 2.2.0 / versionCode 12 everywhere it is user visible", () => {
  const manifest = JSON.parse(read("src/manifest.json"))
  assert.equal(manifest.versionName, "2.2.0")
  assert.equal(manifest.versionCode, 12)
  assert.equal(manifest.package, "com.flykhan.wristkey")
  const pkg = JSON.parse(read("package.json"))
  assert.equal(pkg.version, "2.2.0")

  for (const page of ["index", "detail", "menu", "picker", "pin", "copyright"]) {
    const source = read("src/pages/" + page + "/" + page + ".ux")
    assert.doesNotMatch(source, /2\.1\.2/, page + " 仍留有 2.1.2")
  }
  assert.match(read("src/pages/copyright/copyright.ux"), /版本 2\.2\.0/)
  assert.match(read("src/pages/menu/menu.ux"), /版本 2\.2\.0 · Apache-2\.0/)
})

test("index cards have a fixed height so 1-2 filtered rows do not stretch", () => {
  const source = read("src/pages/index/index.ux")
  const item = cssBlock(source, ".otp-item")
  assert.match(item, /flex:\s*none/)
  assert.match(item, /height:\s*98px/)
  assert.match(cssBlock(source, ".otp-issuer"), /font-size:\s*24px/)
  assert.match(cssBlock(source, ".otp-account"), /font-size:\s*15px/)
  assert.match(cssBlock(source, ".otp-remaining"), /font-size:\s*16px/)
  assert.match(source, /function listCodeSize/)
  assert.match(source, /return 48/)
  assert.match(source, /return 46/)
})

test("index rail and empty state use the larger 2.2.0 sizes", () => {
  const source = read("src/pages/index/index.ux")
  const letter = cssBlock(source, ".letter-button")
  assert.match(letter, /width:\s*52px/)
  assert.match(letter, /height:\s*52px/)
  assert.match(cssBlock(source, ".letter-text"), /font-size:\s*20px/)
  assert.match(cssBlock(source, ".rail-count"), /font-size:\s*13px/)
  assert.match(cssBlock(source, ".page-indicator"), /font-size:\s*15px/)
  const menu = cssBlock(source, ".menu-button")
  assert.match(menu, /width:\s*64px/)
  assert.match(menu, /height:\s*44px/)
  assert.match(cssBlock(source, ".menu-button-text"), /font-size:\s*17px/)
  assert.match(cssBlock(source, ".empty-title"), /font-size:\s*24px/)
  assert.match(cssBlock(source, ".empty-copy"), /font-size:\s*16px/)
  const emptyButton = cssBlock(source, ".empty-button")
  assert.match(emptyButton, /height:\s*40px/)
  assert.match(cssBlock(source, ".empty-button-text"), /font-size:\s*16px/)
})

test("index inline lock has 44 px exit, dots and 128x100 keys", () => {
  const source = read("src/pages/index/index.ux")
  const close = cssBlock(source, ".lock-close")
  assert.match(close, /width:\s*44px/)
  assert.match(close, /height:\s*44px/)
  assert.match(cssBlock(source, ".lock-close-text"), /font-size:\s*26px/)
  assert.match(cssBlock(source, ".lock-title"), /font-size:\s*22px/)
  assert.match(cssBlock(source, ".lock-slot"), /width:\s*44px/)
  assert.match(cssBlock(source, ".lock-hint"), /font-size:\s*16px/)
  const key = cssBlock(source, ".lock-key")
  assert.match(key, /width:\s*128px/)
  assert.match(key, /height:\s*100px/)
  assert.match(cssBlock(source, ".lock-key-glyph"), /font-size:\s*42px/)
  assert.match(cssBlock(source, ".lock-key-label"), /font-size:\s*15px/)
})

test("index keeps the interconnect channel open while the lock screen is up", () => {
  const source = read("src/pages/index/index.ux")
  const showLock = methodBody(source, "showLock")
  assert.match(showLock, /this\.setupChannel\(\)/)
  assert.match(showLock, /this\.locked = true/)
  assert.match(showLock, /this\.mainVisible = false/)

  const setup = methodBody(source, "setupChannel")
  assert.match(setup, /if \(this\.channelReady\)/)
  assert.match(setup, /const connection = connect\(/)
  assert.match(setup, /this\.channelReady = connection !== null/)
  assert.doesNotMatch(setup, /this\.channelReady = true/)

  // A pin command arriving while locked still persists and refreshes the lock.
  const command = methodBody(source, "applyPinCommand")
  assert.match(command, /savePin\(command\.record/)
  assert.match(command, /this\.showLock\(\)/)
  assert.match(source, /sendPinAck/)
  assert.match(source, /sendPinState/)
})

test("detail shows readable credentials and a 58-60 px code", () => {
  const source = read("src/pages/detail/detail.ux")
  assert.match(cssBlock(source, ".issuer"), /font-size:\s*24px/)
  const back = cssBlock(source, ".back-button")
  assert.match(back, /width:\s*72px/)
  assert.match(back, /height:\s*40px/)
  assert.match(cssBlock(source, ".back-text"), /font-size:\s*17px/)
  assert.match(cssBlock(source, ".credential-label"), /font-size:\s*15px/)
  assert.match(cssBlock(source, ".credential-value"), /font-size:\s*18px/)
  assert.match(cssBlock(source, ".countdown"), /font-size:\s*16px/)
  assert.match(cssBlock(source, ".label"), /font-size:\s*14px/)
  assert.match(cssBlock(source, ".value"), /font-size:\s*14px/)
  assert.match(source, /function detailCodeSize/)
  assert.match(source, /return length <= 6 \? 60 : 58/)
  assert.doesNotMatch(source, /detailCodeFontSize/)
  assert.match(source, /用户名/)
  assert.match(source, /密码/)
})

test("menu rows are 56 px with 22 px titles", () => {
  const source = read("src/pages/menu/menu.ux")
  const option = cssBlock(source, ".option")
  assert.match(option, /height:\s*56px/)
  assert.match(option, /flex:\s*none/)
  assert.match(cssBlock(source, ".title"), /font-size:\s*22px/)
  assert.match(cssBlock(source, ".subtitle"), /font-size:\s*14px/)
  assert.match(cssBlock(source, ".option-title"), /font-size:\s*19px/)
  assert.match(cssBlock(source, ".option-value"), /font-size:\s*14px/)
  assert.match(cssBlock(source, ".hint"), /font-size:\s*14px/)
})

test("picker 4x4 cells use 24 px letters, 44 px close and visible dots", () => {
  const source = read("src/pages/picker/picker.ux")
  assert.match(cssBlock(source, ".title"), /font-size:\s*20px/)
  const close = cssBlock(source, ".close")
  assert.match(close, /width:\s*44px/)
  assert.match(close, /height:\s*44px/)
  assert.match(cssBlock(source, ".cell-letter"), /font-size:\s*24px/)
  assert.match(cssBlock(source, ".cell-count"), /font-size:\s*13px/)
  assert.match(cssBlock(source, ".dot"), /width:\s*8px/)
  for (let row = 0; row < 4; row++) {
    assert.match(source, new RegExp('for="\\{\\{ row' + row + ' \\}\\}"'))
  }
})

test("pin waits a frame for 正在校验… before deriving and uses big keys", () => {
  const source = read("src/pages/pin/pin.ux")
  assert.match(source, /this\.hintText = "正在校验…"/)
  assert.match(source, /processPattern\(pattern\)/)
  const complete = methodBody(source, "handleComplete")
  assert.match(complete, /setTimeout\(/)
  assert.match(complete, /this\.processPattern\(pattern\)/)
  const key = cssBlock(source, ".key")
  assert.match(key, /width:\s*128px/)
  assert.match(key, /height:\s*100px/)
  assert.match(cssBlock(source, ".key-glyph"), /font-size:\s*42px/)
  assert.match(cssBlock(source, ".key-label"), /font-size:\s*15px/)
  assert.match(cssBlock(source, ".slot"), /width:\s*44px/)
  assert.match(cssBlock(source, ".hint"), /font-size:\s*16px/)
  assert.match(cssBlock(source, ".title"), /font-size:\s*22px/)
})

test("copyright page keeps valid markup after the 2.2.0 edit", () => {
  const source = read("src/pages/copyright/copyright.ux")
  assert.doesNotMatch(source, /<\/text><\/text>/)
  assert.match(source, /Steam Guard 按 Steam 字母表独立实现<\/text>/)
  assert.match(source, /入口图案锁 PBKDF2-HMAC-SHA256/)
})
