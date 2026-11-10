#!/usr/bin/env node
import fs from "node:fs";
import {
  detectFormat,
  decryptStrong,
  decryptLegacy,
  parseBackupJson,
  parseUriList,
  mapStratumBackup,
  buildSnapshot,
  maskSecret
} from "./stratum.mjs";

const USAGE = [
  "用法: node src/cli.mjs <备份文件> [--password <密码>] [--out <文件>] [--report] [--pretty]",
  "",
  "支持: Strong(.stratum) / Legacy(.stratum) / 明文 JSON / otpauth:// 文本列表",
  "输出: 协议 v2 快照 JSON（可被手环端/手机端复用做夹具）",
  "示例: node src/cli.mjs backup.stratum --password test-password --pretty"
].join("\n");

function parseArgs(argv) {
  const args = { file: null, password: null, out: null, report: false, pretty: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--password") args.password = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--report") args.report = true;
    else if (a === "--pretty") args.pretty = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (!a.startsWith("--")) args.file = a;
    else throw new Error("未知参数: " + a);
  }
  return args;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message + "\n" + USAGE);
    process.exit(2);
  }
  if (args.help || !args.file) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 2);
  }

  const buf = fs.readFileSync(args.file);
  const format = detectFormat(buf);
  console.error("检测格式: " + format);

  let text;
  if (format === "strong") {
    if (!args.password) throw new Error("Strong 备份需要 --password");
    text = await decryptStrong(buf, args.password);
  } else if (format === "legacy") {
    if (!args.password) throw new Error("Legacy 备份需要 --password");
    text = decryptLegacy(buf, args.password);
  } else {
    text = buf.toString("utf8");
  }

  let accounts;
  let skipped;
  if (format === "uri-list" || (format === "text" && /^otpauth:/im.test(text))) {
    ({ accounts, skipped } = parseUriList(text));
  } else if (format === "plain" || format === "strong" || format === "legacy") {
    const backup = parseBackupJson(text);
    ({ accounts, skipped } = mapStratumBackup(backup));
  } else {
    throw new Error("无法识别备份格式（支持 Strong/Legacy/明文 JSON/URI 列表）");
  }

  const snapshot = buildSnapshot(accounts);
  const json = JSON.stringify(snapshot, null, args.pretty ? 2 : 0);
  if (args.out) {
    fs.writeFileSync(args.out, json + "\n");
    console.error("已写出: " + args.out);
  } else {
    process.stdout.write(json + "\n");
  }

  console.error("导入 " + accounts.length + " 个账号，跳过 " + skipped.length + " 个");
  for (const a of accounts) {
    console.error("  + [" + a.category + "] " + a.issuer + " / " + a.accountName + "  " + a.algorithm + " " + a.digits + "d " + a.period + "s  " + maskSecret(a.secret));
  }
  if (args.report && skipped.length) {
    console.error("跳过明细:");
    for (const s of skipped) {
      console.error("  - " + (s.issuer || "(无 issuer)") + " / " + (s.accountName || "(无账号)") + " : " + s.reason);
    }
  }
}

main().catch((e) => {
  console.error("错误: " + (e && e.message ? e.message : e));
  process.exit(1);
});
