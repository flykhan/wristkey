import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectFormat,
  decryptStrong,
  decryptLegacy,
  parseBackupJson,
  parseUriList,
  mapStratumBackup,
  buildSnapshot,
  normalizeSecret,
  deriveId
} from "../src/stratum.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, "..", "fixtures");
const PASSWORD = "test-password";

function fixture(name) {
  return fs.readFileSync(path.join(FIX, name));
}

test("detectFormat: 强/弱/明文/URI 列表", () => {
  assert.equal(detectFormat(fixture("strong.stratum")), "strong");
  assert.equal(detectFormat(fixture("legacy.stratum")), "legacy");
  assert.equal(detectFormat(fixture("plain-backup.json")), "plain");
  assert.equal(detectFormat(fixture("uri-list.txt")), "uri-list");
});

test("strong: 解密结果与明文一致", async () => {
  const text = await decryptStrong(fixture("strong.stratum"), PASSWORD);
  assert.deepEqual(JSON.parse(text), JSON.parse(fixture("plain-backup.json").toString("utf8")));
});

test("legacy: 解密结果与明文一致", () => {
  const text = decryptLegacy(fixture("legacy.stratum"), PASSWORD);
  assert.deepEqual(JSON.parse(text), JSON.parse(fixture("plain-backup.json").toString("utf8")));
});

test("strong: 错误密码拒绝", async () => {
  await assert.rejects(() => decryptStrong(fixture("strong.stratum"), "wrong-password"), /密码错误|BAD_PASSWORD/);
});

test("legacy: 错误密码拒绝", () => {
  assert.throws(() => decryptLegacy(fixture("legacy.stratum"), "wrong-password"));
});

test("映射: 3 个 TOTP 导入，5 个跳过", () => {
  const backup = parseBackupJson(fixture("plain-backup.json").toString("utf8"));
  const { accounts, skipped } = mapStratumBackup(backup);
  assert.equal(accounts.length, 3);
  assert.equal(skipped.length, 5);
  const github = accounts.find((a) => a.issuer === "GitHub");
  assert.ok(github);
  assert.equal(github.category, "社交"); // 多分类取 AuthenticatorCategory.Ranking 最小者
  assert.equal(github.algorithm, "SHA1");
  assert.equal(github.digits, 6);
  assert.equal(github.period, 30);
  assert.equal(github.id, deriveId(github.secret));
  const aws = accounts.find((a) => a.issuer === "AWS");
  assert.equal(aws.algorithm, "SHA512");
  assert.equal(aws.digits, 10);
  assert.equal(aws.period, 15);
});

test("映射: 跳过原因可读", () => {
  const backup = parseBackupJson(fixture("plain-backup.json").toString("utf8"));
  const { skipped } = mapStratumBackup(backup);
  const reasons = skipped.map((s) => s.reason).join(" | ");
  assert.match(reasons, /HOTP/);
  assert.match(reasons, /Steam/);
  assert.match(reasons, /Base32/);
  assert.match(reasons, /period/);
  assert.match(reasons, /issuer 与 accountName 均为空/);
});

test("URI 列表: HOTP 行被跳过", () => {
  const text = fixture("uri-list.txt").toString("utf8");
  const { accounts, skipped } = parseUriList(text);
  assert.equal(accounts.length, 3);
  assert.equal(skipped.length, 1);
  assert.equal(accounts[1].algorithm, "SHA256");
  assert.equal(accounts[2].digits, 10);
});

test("Normalize/Id 稳定性", () => {
  assert.equal(normalizeSecret(" jbsw y3dp - ehpk 3pxp = "), "JBSWY3DPEHPK3PXP");
  assert.equal(deriveId("JBSWY3DPEHPK3PXP"), deriveId("jbsw y3dp ehpk 3pxp=="));
  assert.match(deriveId("JBSWY3DPEHPK3PXP"), /^s_[0-9a-f]{12}$/);
});

test("buildSnapshot: 输出协议 v2 结构且不含内部字段", () => {
  const backup = parseBackupJson(fixture("plain-backup.json").toString("utf8"));
  const { accounts } = mapStratumBackup(backup);
  const snap = buildSnapshot(accounts, 1760000000000);
  assert.equal(snap.version, 2);
  assert.equal(snap.updatedAt, 1760000000000);
  assert.equal(snap.accounts.length, 3);
  for (const a of snap.accounts) {
    for (const k of ["id", "issuer", "accountName", "category", "secret", "algorithm", "digits", "period"]) {
      assert.ok(k in a, "缺少字段 " + k);
    }
    assert.ok(!("_ranking" in a));
  }
});
