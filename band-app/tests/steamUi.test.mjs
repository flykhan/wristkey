import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { buildTokenState } from "../src/common/scripts/totp.js"
import { normalizeAccount } from "../src/common/scripts/accountModel.js"

// Steam Guard UI integration (docs/protocol.md "Steam Guard").
// The band must render the 5 character alphanumeric code as-is and label the
// account type in the detail page; codes must never be zero padded or
// digit-grouped like numeric TOTP.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8")
}

const STEAM_SECRET = "OJZ2BP7STWSLUD7I23Q5AYZELZB5OAFU"

test("index page shows the token groupedCode (Steam stays ungrouped)", () => {
  const source = read("src/pages/index/index.ux")
  assert.match(source, /\{\{\s*\$item\.groupedCode\s*\}\}/)
  assert.doesNotMatch(source, /padLeft|% 10/, "band pages must not pad numeric codes")
})

test("detail page labels Steam Guard and its algorithm", () => {
  const source = read("src/pages/detail/detail.ux")
  assert.match(source, /Steam Guard/)
  assert.match(source, /SHA1 · 5 位字母数字/)
  assert.match(source, /otpType === "steam"/)
})

test("manifest is 1.0.2 / versionCode 3 and keeps the required features", () => {
  const manifest = JSON.parse(read("src/manifest.json"))
  assert.equal(manifest.package, "dev.wristkey.app")
  assert.equal(manifest.versionName, "1.0.2")
  assert.equal(manifest.versionCode, 3)
  const features = (manifest.features || []).map(item => item.name)
  for (const required of ["system.router", "system.storage", "system.interconnect"]) {
    assert.ok(features.includes(required))
  }
})

test("Steam account flows from normalizeAccount to a 5-character token", () => {
  const result = normalizeAccount(
    {
      id: "s_steam",
      issuer: "Steam",
      accountName: "me",
      category: "游戏",
      secret: STEAM_SECRET,
      otpType: "steam"
    },
    { timestamp: 1760000000000 }
  )
  assert.equal(result.ok, true)
  assert.equal(result.account.digits, 5)
  assert.equal(result.account.period, 30)
  assert.equal(result.account.algorithm, "SHA1")

  const token = buildTokenState(result.account, 59000)
  assert.equal(token.valid, true)
  assert.equal(token.otpType, "steam")
  assert.equal(token.code, "3DP36")
  assert.equal(token.groupedCode, "3DP36")
  assert.equal(token.code.length, 5)
  assert.doesNotMatch(token.code, /[0-9]{6}/)
})

test("numeric TOTP rendering is unchanged for regular accounts", () => {
  const result = normalizeAccount(
    {
      id: "s_totp",
      issuer: "GitHub",
      accountName: "me",
      secret: "JBSWY3DPEHPK3PXP",
      digits: 6,
      period: 30
    },
    { timestamp: 1760000000000 }
  )
  assert.equal(result.ok, true)
  const token = buildTokenState(result.account, 59000)
  assert.equal(token.otpType, "totp")
  assert.equal(token.code.length, 6)
  assert.match(token.groupedCode, /^[0-9]{3} [0-9]{3}$/)
})
