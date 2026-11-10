import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Regression guard for the real-device crash on 2026-11-10:
// app.ux must wrap its JavaScript in a <script> block, otherwise the Vela
// runtime loads a null default export and fails with
// "TypeError: cannot set property 'style' of null" / "appData is undefined".
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8")
}

function pageFiles() {
  const pagesDir = path.join(ROOT, "src", "pages")
  const files = []
  for (const name of fs.readdirSync(pagesDir)) {
    const file = path.join(pagesDir, name, name + ".ux")
    if (fs.existsSync(file)) {
      files.push("src/pages/" + name + "/" + name + ".ux")
    }
  }
  return files
}

test("app.ux wraps its JavaScript in a <script> block", () => {
  const source = read("src/app.ux")
  assert.ok(source.includes("<script>"), "app.ux 缺少 <script> 开始标签")
  assert.ok(source.includes("</script>"), "app.ux 缺少 </script> 结束标签")
  assert.match(source, /export\s+default/, "app.ux 缺少 export default 生命周期对象")
})

test("each page .ux has template, script and style blocks", () => {
  const pages = pageFiles()
  assert.ok(pages.length >= 3, "页面数量异常: " + pages.length)
  for (const file of pages) {
    const source = read(file)
    assert.match(source, /<template>/, file + " 缺少 <template>")
    assert.match(source, /<script>/, file + " 缺少 <script>")
    assert.match(source, /<style>/, file + " 缺少 <style>")
  }
})

test("manifest declares quick app runtime requirements", () => {
  const manifest = JSON.parse(read("src/manifest.json"))
  assert.equal(manifest.package, "dev.wristkey.app")
  assert.equal(manifest.name, "腕证")
  assert.ok(Array.isArray(manifest.deviceTypeList) && manifest.deviceTypeList.includes("watch"))
  assert.ok(Number(manifest.minPlatformVersion) >= 1000)
  assert.equal(manifest.config.designWidth, "device-width")
  const features = (manifest.features || []).map((item) => item.name)
  for (const required of ["system.router", "system.storage", "system.interconnect"]) {
    assert.ok(features.includes(required), "manifest.features 缺少 " + required)
  }
  assert.ok(Number(manifest.versionCode) >= 2, "修复版应提升 versionCode 便于覆盖安装")
})

// UI v3 (docs/design/ui-v3-spec.md): one screen = 3 accounts + letter rail,
// no top bar / status row; the right rail button opens pages/picker.
test("index is the v3 layout: no top bar, 3 rows, right letter rail", () => {
  const source = read("src/pages/index/index.ux")
  assert.doesNotMatch(source, /class="header"/, "v3 index 不应有顶栏")
  assert.doesNotMatch(source, /status-row|syncText|categoryLabel/, "v3 index 不应有状态行/分类")
  assert.match(source, /class="rail"/)
  assert.match(source, /class="letter-button"/)
  assert.match(source, /onclick="openPicker"/)
  assert.match(source, /for="{{ pageAccounts }}"/)
  assert.match(source, /class="page-indicator"/)
  assert.match(source, /onclick="nextPage"/)
  assert.match(source, /onswipe="handleSwipe"/)
  // Swipes: up/down paging, right menu, left exit.
  assert.match(source, /event.direction === "up"/)
  assert.match(source, /event.direction === "down"/)
  assert.match(source, /event.direction === "right"/)
  assert.match(source, /event.direction === "left"/)
  assert.ok(source.includes("this.$app.exit"), "左滑应退出应用")
})

// Regression guard for the 2026-11-10 "pattern accepted but no next screen":
// index used to replace itself with the lock page from BOTH onInit and onShow,
// and the lock page replaced the stack with index. Vela ends up with an empty
// page stack, so the app exits. Entry -> lock must be a push, unlock a back.
test("entry page pushes the lock and the lock page goes back", () => {
  const index = read("src/pages/index/index.ux")
  assert.match(index, /router\.push\(\{ uri: "\/pages\/lock" \}\)/)
  assert.doesNotMatch(index, /router\.replace\(\{ uri: "\/pages\/lock" \}\)/)
  const onInitBlock = index.slice(index.indexOf("onInit()"), index.indexOf("onShow()"))
  assert.doesNotMatch(onInitBlock, /ensureUnlocked|pages\/lock/, "onInit 不应再次触发锁屏")

  const lock = read("src/pages/lock/lock.ux")
  assert.match(lock, /markUnlocked\([\s\S]*router\.back\(\)/)
  assert.doesNotMatch(lock, /router\.replace\(\{ uri: "\/pages\/index" \}\)/)

  for (const file of ["src/app.ux", ...pageFiles()]) {
    assert.doesNotMatch(read(file), /router\.replace\(/, file + " 不应使用 router.replace")
  }
})

test("menu exposes pin, sync, about and exit only", () => {
  const source = read("src/pages/menu/menu.ux")
  assert.doesNotMatch(source, /openCategory|分类|toggleTheme|显示模式/)
  assert.match(source, /入口密码/)
  assert.match(source, /立即同步/)
  assert.match(source, /关于/)
  assert.match(source, /openPin/)
  assert.match(source, /exitApp/)
})

test("picker page is registered and renders the 3-page 4x4 grid", () => {
  const manifest = JSON.parse(read("src/manifest.json"))
  assert.equal(manifest.versionName, "2.0.2")
  assert.equal(manifest.versionCode, 8)
  assert.ok(manifest.router.pages["pages/picker"], "manifest 缺少 pages/picker 路由")
  assert.equal(manifest.router.pages["pages/picker"].component, "picker")

  const source = read("src/pages/picker/picker.ux")
  assert.match(source, /按首字母筛选/)
  assert.match(source, /LETTER_FILTER_STORAGE_KEY/)
  assert.match(source, /router.back()/)
  // Four explicit row loops keep each 4x4 page tall enough to fill the screen.
  for (let row = 0; row < 4; row++) {
    assert.match(source, new RegExp('for="\{\{ row' + row + ' \}\}"'), "缺少 row" + row)
  }
  assert.match(source, /PICKER_PAGE_COUNT/)
  assert.match(source, /nextPage/)
  assert.doesNotMatch(source, /7 列/)
})
