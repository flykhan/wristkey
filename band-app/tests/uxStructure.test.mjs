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

test("menu no longer exposes category selection", () => {
  const source = read("src/pages/menu/menu.ux")
  assert.doesNotMatch(source, /openCategory|分类/)
  assert.match(source, /请求手机同步/)
  assert.match(source, /toggleTheme/)
  assert.match(source, /exitApp/)
})

test("picker page is registered and renders the 7-column grid", () => {
  const manifest = JSON.parse(read("src/manifest.json"))
  assert.equal(manifest.versionName, "1.0.4")
  assert.equal(manifest.versionCode, 5)
  assert.ok(manifest.router.pages["pages/picker"], "manifest 缺少 pages/picker 路由")
  assert.equal(manifest.router.pages["pages/picker"].component, "picker")

  const source = read("src/pages/picker/picker.ux")
  assert.match(source, /按首字母筛选/)
  assert.match(source, /LETTER_FILTER_STORAGE_KEY/)
  assert.match(source, /router.back()/)
  // Six explicit row loops keep the A-Z / 0-9 / 全部 / # grid at 7 columns.
  for (let row = 0; row < 6; row++) {
    assert.match(source, new RegExp('for="\{\{ row' + row + ' \}\}"'), "缺少 row" + row)
  }
})
