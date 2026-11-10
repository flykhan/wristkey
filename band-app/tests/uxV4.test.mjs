import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8")
}

test("manifest is 2.1.1 / versionCode 10 and keeps lock and pin routes for later", () => {
  const manifest = JSON.parse(read("src/manifest.json"))
  assert.equal(manifest.versionName, "2.1.1")
  assert.equal(manifest.versionCode, 10)
  assert.equal(manifest.package, "com.flykhan.wristkey")
  assert.equal(manifest.router.entry, "pages/index")
  for (const page of ["index", "lock", "pin", "detail", "picker", "menu", "copyright"]) {
    assert.ok(manifest.router.pages["pages/" + page], "缺少 pages/" + page)
  }
  assert.equal(manifest.router.pages["pages/lock"].component, "lock")
  assert.equal(manifest.router.pages["pages/pin"].component, "pin")
  const features = (manifest.features || []).map(item => item.name)
  for (const required of ["system.router", "system.storage", "system.interconnect"]) {
    assert.ok(features.includes(required))
  }
})

test("app.ux no longer gates startup on the pattern lock (2.1.1)", () => {
  const source = read("src/app.ux")
  assert.match(source, /<script>/)
  assert.match(source, /export\s+default/)
  assert.doesNotMatch(source, /pinSessionStore|shouldRelock|loadPin|router\.push/)
  assert.doesNotMatch(source, /pages\/lock|pages\/pin/)
})

test("lock page renders T/S/C pattern and handles failures with persisted lock", () => {
  const source = read("src/pages/lock/lock.ux")
  assert.match(source, /腕证已锁定/)
  assert.match(source, /PATTERN_SYMBOLS/)
  assert.match(source, /verifyPattern/)
  assert.match(source, /nextLockAfterFailure/)
  assert.match(source, /saveLock/)
  assert.match(source, /loadLock/)
  assert.match(source, /pinSessionStore/)
  assert.match(source, /markUnlocked\(Date\.now\(\),/)
  assert.match(source, /markUnlocked[\s\S]*router\.back\(\)/)
  assert.match(source, /lockRemainingMs|isLocked/)
  assert.match(source, /shakeOffset/)
  assert.doesNotMatch(source, /router\.replace\(/)
  assert.match(source, /this\.\$app\.exit\(\)/)
  assert.match(source, /onlongpress="clearInput"/)
})

test("pin setup page supports verify / change / disable", () => {
  const source = read("src/pages/pin/pin.ux")
  assert.match(source, /verifyPattern/)
  assert.match(source, /createPinRecord/)
  assert.match(source, /savePin/)
  assert.match(source, /deletePin/)
  assert.match(source, /sendPinState/)
  assert.match(source, /buildPinState/)
  assert.match(source, /修改图案/)
  assert.match(source, /关闭入口密码/)
  assert.match(source, /mode === "manage"/)
})

test("index v4 rail exposes filter count, menu button and pin commands", () => {
  const source = read("src/pages/index/index.ux")
  assert.match(source, /class="rail"/)
  assert.match(source, /class="letter-button"/)
  assert.match(source, /class="rail-count"/)
  assert.match(source, /共 \{\{ filteredCount \}\} 个/)
  assert.match(source, /class="menu-button"/)
  assert.match(source, /onclick="openMenu"/)
  assert.doesNotMatch(source, /ensureUnlocked|shouldRelock/)
  assert.match(source, /applyPinCommand/)
  assert.match(source, /sendPinAck/)
  assert.match(source, /sendPinState/)
  assert.match(source, /previousAccounts/)
  assert.match(source, /event\.direction === "up"/)
  assert.match(source, /event\.direction === "down"/)
  assert.match(source, /event\.direction === "right"/)
  assert.match(source, /event\.direction === "left"/)
})

test("detail shows username and a 10s masked password row", () => {
  const source = read("src/pages/detail/detail.ux")
  assert.match(source, /用户名/)
  assert.match(source, /密码/)
  assert.match(source, /passwordDisplay/)
  assert.match(source, /PASSWORD_REVEAL_MS/)
  assert.match(source, /togglePassword/)
  assert.match(source, /hidePassword/)
  assert.match(source, /onHide\(\)/)
})

test("copyright page reports 2.1.1 with protocol v3", () => {
  const source = read("src/pages/copyright/copyright.ux")
  assert.match(source, /版本 2\.1\.1/)
  assert.match(source, /协议 v3/)
  assert.match(source, /PBKDF2/)
})
