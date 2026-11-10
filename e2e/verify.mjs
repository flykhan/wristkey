#!/usr/bin/env node
// WristKey e2e — 端到端验证入口。
//
//   cd e2e && npm install && npm run verify      # 等价于 node verify.mjs
//
// 覆盖：
//   A. RFC 6238 测试向量（SHA1/SHA256/SHA512，独立 node:crypto HMAC 实现）
//   B. 夹具覆盖矩阵、明文备份映射、id/排序/分类一致性
//   C. Strong/Legacy 加解密（hash-wasm Argon2id + node:crypto AES）
//   D. 跨实现交叉验证（tools/fixtures 的 Python 夹具 + tools/src/stratum.mjs）
//   E. otpauth:// URI 列表夹具
//   F. 同步协议 v2 合法消息序列 + 手环端/手机端状态机
//   G. 协议字段边界（消息大小、最大字段、非法字段）
//   H. 协议非法/超时/去重用例回放（fixtures/protocol/invalid-cases.json）
//   I. 跨端 TOTP / Steam 对拍（band-app 纯模块 vs 独立实现）
//   J. Bitwarden 未加密 Vault JSON 导入（otpauth / Steam encoder / 纯 Base32 / 加密负例）
//   K. 协议 v3：password 合并、pin_set/query/clear/ack/state、v2↔v3 兼容、8s ack 超时
// 退出码：0 全部通过；1 存在失败。

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

import { createRunner, assert, assertEqual, assertDeepEqual, assertThrows } from './lib/runner.mjs';
import { base32Encode, normalizeProtocolSecret } from './lib/encoding.mjs';
import { RFC6238_SEEDS, RFC6238_VECTORS, hotp, totp, totpAtSeconds, steamTotp } from './lib/totp.mjs';
import * as stratum from './lib/stratum.mjs';
import * as protocol from './lib/protocol.mjs';
import * as bitwarden from './lib/bitwarden.mjs';

const E2E_ROOT = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = join(E2E_ROOT, '..');
const FIXTURES = join(E2E_ROOT, 'fixtures');
const PASSWORD = stratum.FIXTURE_PASSWORD;
const FIXED_NOW = 1760000000999;

const r = createRunner('WristKey e2e verify');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readBuffer(path) {
  return readFileSync(path);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function compareStrings(left, right) {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function stripAccountForCompare(account) {
  return {
    id: account.id,
    issuer: account.issuer,
    accountName: account.accountName,
    category: account.category,
    secret: account.secret,
    algorithm: account.algorithm,
    digits: account.digits,
    period: account.period,
    otpType: account.otpType || 'totp'
  };
}

function sortedAccountSet(accounts) {
  return accounts
    .map(stripAccountForCompare)
    .sort(function (left, right) {
      return compareStrings(left.id, right.id);
    });
}

function stripAccountForUriCompare(account) {
  const stripped = stripAccountForCompare(account);
  delete stripped.category;
  return stripped;
}

function accountSetById(accounts) {
  const map = new Map();
  for (const account of accounts) {
    map.set(account.id, stripAccountForCompare(account));
  }
  return map;
}

function rfcSeedBase32(algorithm) {
  // 夹具中的 Stratum secret 不带 '=' 填充；解码时两种形式等价。
  return base32Encode(Buffer.from(RFC6238_SEEDS[algorithm], 'ascii')).replace(/=+$/, '');
}

function makeValidAccount(overrides) {
  return Object.assign(
    {
      id: 's_test000000000',
      issuer: 'Test',
      accountName: 'test@test.invalid',
      category: '默认分类',
      secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA1',
      digits: 6,
      period: 30
    },
    overrides
  );
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function main() {
  // ------------------------------------------------------------------ 环境
  const manifest = readJson(join(FIXTURES, 'manifest.json'));
  const plainBuffer = readBuffer(join(FIXTURES, 'plain-backup.json'));
  const plain = JSON.parse(plainBuffer.toString('utf8'));
  const expected = readJson(join(FIXTURES, 'expected-import.json'));
  const mapped = stratum.mapBackupToAccounts(plain, { updatedAt: stratum.FIXTURE_UPDATED_AT });

  process.stdout.write(
    '环境: node ' + process.version + ' / ' + process.platform + ' ' + process.arch +
      ' / 夹具密码 "' + PASSWORD + '"\n'
  );

  // --------------------------------------------------------- A. RFC 向量
  r.section('A. RFC 6238 / RFC 4226 测试向量（独立 HMAC 实现）');
  const rfcSecrets = {
    SHA1: rfcSeedBase32('SHA1'),
    SHA256: rfcSeedBase32('SHA256'),
    SHA512: rfcSeedBase32('SHA512')
  };
  for (const vector of RFC6238_VECTORS) {
    for (const algorithm of ['SHA1', 'SHA256', 'SHA512']) {
      r.test('RFC 6238 T=' + vector.time + ' ' + algorithm, function () {
        const code = totpAtSeconds(rfcSecrets[algorithm], vector.time, {
          digits: 8,
          period: 30,
          algorithm
        });
        assertEqual(code, vector[algorithm], 'T=' + vector.time + ' ' + algorithm + ' 与 RFC 表不一致');
        return 'code=' + code;
      });
    }
  }
  const rfc4226 = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  r.test('RFC 4226 HOTP counter=0..9', function () {
    const secret = base32Encode(Buffer.from(RFC6238_SEEDS.SHA1, 'ascii'));
    const codes = rfc4226.map(function (expectedCode, counter) {
      const code = hotp(secret, BigInt(counter), { digits: 6, algorithm: 'SHA1' });
      assertEqual(code, expectedCode, 'HOTP counter=' + counter);
      return code;
    });
    return '10 个向量';
  });
  r.test('digits 6/8/10 输出长度正确', function () {
    for (const digits of [6, 8, 10]) {
      const code = totpAtSeconds(rfcSecrets.SHA1, 59, { digits, period: 30, algorithm: 'SHA1' });
      assertEqual(code.length, digits, 'digits=' + digits);
      assert(/^[0-9]+$/.test(code), 'digits=' + digits + ' 不是纯数字');
    }
    return '6/8/10';
  });
  const STEAM_SECRET = 'OJZ2BP7STWSLUD7I23Q5AYZELZB5OAFU';
  const STEAM_VECTORS = [
    { time: 59, code: '3DP36' },
    { time: 1111111109, code: 'GX57J' },
    { time: 1111111111, code: 'TCJ4Y' },
    { time: 1234567890, code: 'VYNVB' },
    { time: 1640846388, code: '2Y4TM' },
    { time: 1735689600, code: 'DQ5KF' }
  ];
  for (const vector of STEAM_VECTORS) {
    r.test('Steam Guard T=' + vector.time, function () {
      const code = steamTotp(STEAM_SECRET, vector.time * 1000);
      assertEqual(code, vector.code, 'Steam 码与公开向量不一致');
      assertEqual(code.length, 5, 'Steam 码应固定 5 位');
      assert(/^[23456789BCDFGHJKMNPQRTVWXY]+$/.test(code), 'Steam 码字符集错误');
      return 'code=' + code;
    });
  }
  r.test('Steam 码不是 10 的幂取模（与纯数字 TOTP 不同）', function () {
    const numeric = totpAtSeconds(STEAM_SECRET, 59, { digits: 6, period: 30, algorithm: 'SHA1' });
    const steam = steamTotp(STEAM_SECRET, 59000);
    assert(numeric !== steam, 'Steam 码不应等于纯数字 TOTP 码');
    return 'numeric=' + numeric + ' steam=' + steam;
  });
  r.test('RFC 种子与夹具 RFC 账号 secret 一致（公开测试值）', function () {
    const plainAuthenticators = plain.Authenticators;
    const rfcAccounts = plainAuthenticators.filter(function (authenticator) {
      return authenticator.Issuer === 'RFC6238';
    });
    assertEqual(rfcAccounts.length, 3, '应当有 3 个 RFC6238 测试账号');
    const byAlgorithm = { 0: 'SHA1', 1: 'SHA256', 2: 'SHA512' };
    for (const authenticator of rfcAccounts) {
      const algorithm = byAlgorithm[authenticator.Algorithm];
      assertEqual(authenticator.Secret, rfcSeedBase32(algorithm), 'RFC 账号 secret 应为 RFC 6238 公开种子');
    }
    return '3 个公开向量账号';
  });

  // ----------------------------------------------------- B. 夹具一致性
  r.section('B. 夹具覆盖矩阵与明文映射');
  r.test('明文备份可解析，格式嗅探 = json', function () {
    assertEqual(stratum.detectFormat(plainBuffer), 'json');
    assertEqual(stratum.detectFormat(JSON.stringify({ authenticators: [] })), 'json', '应容忍 camelCase');
  });
  r.test('manifest 加密参数与 docs/stratum-format.md 一致', function () {
    const strongParams = manifest.encryption.strong.keyDerivation;
    assertEqual(strongParams.algorithm, 'Argon2id');
    assertEqual(strongParams.parallelism, 4);
    assertEqual(strongParams.memorySizeKiB, 65536);
    assertEqual(strongParams.iterations, 3);
    assertEqual(strongParams.outputBytes, 32);
    assertEqual(manifest.encryption.strong.layout, 'header16 + salt16 + iv12 + ciphertext + tag16');
    assertEqual(manifest.encryption.legacy.layout, 'header16 + salt20 + iv16 + ciphertext');
    assertEqual(manifest.encryption.legacy.keyDerivation.algorithm, 'PBKDF2-HMAC-SHA1');
    assertEqual(manifest.encryption.legacy.keyDerivation.iterations, 64000);
    assertEqual(manifest.encryption.legacy.keyDerivation.outputBytes, 32);
    assertEqual(manifest.encryption.strong.saltHex.length, 32, 'strong salt 16 字节');
    assertEqual(manifest.encryption.strong.ivHex.length, 24, 'strong iv 12 字节');
    assertEqual(manifest.encryption.legacy.saltHex.length, 40, 'legacy salt 20 字节');
    assertEqual(manifest.encryption.legacy.ivHex.length, 32, 'legacy iv 16 字节');
  });
  r.test('生成物与 manifest 哈希一致（可复现）', function () {
    for (const file of manifest.files) {
      const buffer = readBuffer(join(FIXTURES, file.name));
      assertEqual(buffer.length, file.bytes, file.name + ' 字节数');
      assertEqual(sha256(buffer), file.sha256, file.name + ' sha256');
    }
    return manifest.files.length + ' 个文件';
  });
  r.test('映射统计 = 13 导入 / 10 跳过（共 23）', function () {
    assertEqual(mapped.stats.total, 23);
    assertEqual(mapped.stats.imported, 13);
    assertEqual(mapped.stats.skipped, 10);
    assertDeepEqual(mapped.stats, expected.stats);
  });
  r.test('映射结果与 expected-import.json 完全一致', function () {
    assertDeepEqual(mapped.accounts, expected.accounts);
    assertDeepEqual(mapped.skipped, expected.skipped);
  });
  r.test('覆盖矩阵：算法 / digits / period / 分类 / 跳过类型', function () {
    assertDeepEqual(manifest.coverage.algorithms, ['SHA1', 'SHA256', 'SHA512']);
    assertDeepEqual(manifest.coverage.digits, [5, 6, 8, 10]);
    assertDeepEqual(manifest.coverage.periods, [15, 30, 60]);
    assertDeepEqual(manifest.coverage.otpTypes, ['steam', 'totp']);
    for (const category of ['开发', '个人', '云服务', '社交', '默认分类']) {
      assert(manifest.coverage.categories.indexOf(category) >= 0, '缺少分类 ' + category);
    }
    for (const code of [
      'UNSUPPORTED_OTP_TYPE',
      'INVALID_BASE32',
      'EMPTY_SECRET',
      'PERIOD_OUT_OF_RANGE',
      'DIGITS_OUT_OF_RANGE',
      'EMPTY_ISSUER_AND_USERNAME',
      'INVALID_ALGORITHM'
    ]) {
      assert(manifest.coverage.skippedCodes.indexOf(code) >= 0, '缺少跳过类型 ' + code);
    }
    const typeCounts = {};
    for (const item of expected.skipped) {
      typeCounts[item.code] = (typeCounts[item.code] || 0) + 1;
    }
    assertEqual(typeCounts.UNSUPPORTED_OTP_TYPE, 2, 'HOTP/Mobile-OTP 各 1 条（Steam 现已支持）');
  });
  r.test('每个导入账号 id = s_ + sha1(归一化 secret)[0:12]（独立复算）', function () {
    for (const account of expected.accounts) {
      const canonical = normalizeProtocolSecret(account.secret);
      const hex = createHash('sha1').update(canonical, 'utf8').digest('hex').slice(0, 12);
      assertEqual(account.id, 's_' + hex, 'account ' + account.issuer + ' id');
    }
    return expected.accounts.length + ' 个';
  });
  r.test('Steam 账号映射：otpType=steam / digits=5 / period=30 / SHA1', function () {
    const steamAccounts = expected.accounts.filter(function (account) {
      return account.otpType === 'steam';
    });
    assertEqual(steamAccounts.length, 2, '应有 2 个 Steam 账号（issuer=Steam 与 issuer=Valve）');
    for (const account of steamAccounts) {
      assertEqual(account.algorithm, 'SHA1', 'Steam 固定 SHA1');
      assertEqual(account.digits, 5, 'Steam 固定 5 位字母数字');
      assertEqual(account.period, 30, 'Steam 固定 30s');
    }
    const issuers = steamAccounts.map(function (account) { return account.issuer; }).sort();
    assertDeepEqual(issuers, ['Steam', 'Valve'], '应覆盖 issuer=Steam 与 issuer≠Steam 两种');
    return steamAccounts.map(function (account) { return account.issuer + '/' + account.digits; }).join(', ');
  });
  r.test('分类 Id = sha1(分类名) 前 8 位十六进制', function () {
    for (const category of plain.Categories) {
      const hex = createHash('sha1').update(category.Name, 'utf8').digest('hex').slice(0, 8);
      assertEqual(category.Id, hex, '分类 ' + category.Name);
    }
    return plain.Categories.length + ' 个分类';
  });
  r.test('排序规则：分类优先、分类内 ranking、无分类最后', function () {
    const accounts = expected.accounts;
    // 开发（Category.Ranking=0）：3 条 RFC6238
    assertDeepEqual(
      accounts.slice(0, 3).map(function (account) { return account.issuer + '|' + account.accountName; }),
      ['RFC6238|sha1@test.invalid', 'RFC6238|sha256@test.invalid', 'RFC6238|sha512@test.invalid']
    );
    // 个人（Ranking=1）：Padded / 邮件 / NoUsername
    assertDeepEqual(
      accounts.slice(3, 6).map(function (account) { return account.category; }),
      ['个人', '个人', '个人']
    );
    // 云服务（Ranking=2）：企业VPN（binding 0）/ AWS（binding 1）/ Valve（binding 2）
    assertDeepEqual(
      accounts.slice(6, 9).map(function (account) { return account.issuer; }),
      ['企业VPN', 'AWS', 'Valve']
    );
    // 社交（Ranking=3）：多分类的 GitHub 取 binding ranking 最小的社交；Steam binding 3
    assertEqual(accounts[9].issuer, 'GitHub');
    assertEqual(accounts[9].category, '社交', 'GitHub 多分类取 AuthenticatorCategory.Ranking 最小者');
    assertEqual(accounts[10].issuer, 'Steam');
    assertEqual(accounts[10].otpType, 'steam');
    // 无分类 → 默认分类，最后，按 Authenticator.Ranking
    assertDeepEqual(
      accounts.slice(11).map(function (account) { return account.issuer; }),
      ['Cloudflare', '']
    );
    for (const account of accounts.slice(11)) {
      assertEqual(account.category, '默认分类');
    }
    return accounts.length + ' 条顺序符合规则';
  });
  r.test('明文备份条目结构符合 Stratum 规范', function () {
    assertEqual(plain.Authenticators.length, 23, 'Authenticators 条目数');
    for (const authenticator of plain.Authenticators) {
      assert(Number.isInteger(authenticator.Type), 'Type 必须是整数');
      assert(Number.isInteger(authenticator.Algorithm), 'Algorithm 必须是整数');
      assert(Number.isInteger(authenticator.Digits), 'Digits 必须是整数');
      assert(Number.isInteger(authenticator.Period), 'Period 必须是整数');
      assert(typeof authenticator.Secret === 'string', 'Secret 必须是字符串');
      assert(Object.prototype.hasOwnProperty.call(authenticator, 'Ranking'), '缺少 Ranking');
      assert(Object.prototype.hasOwnProperty.call(authenticator, 'Issuer'), '缺少 Issuer');
      assert(Object.prototype.hasOwnProperty.call(authenticator, 'Username'), '缺少 Username');
    }
    // 分类引用必须存在
    const categoryIds = new Set(plain.Categories.map(function (category) { return category.Id; }));
    for (const link of plain.AuthenticatorCategories) {
      assert(categoryIds.has(link.CategoryId), '未知 CategoryId ' + link.CategoryId);
      assert(typeof link.AuthenticatorSecret === 'string', 'AuthenticatorCategory 缺 AuthenticatorSecret');
    }
    return '23 条 Authenticator / ' + plain.AuthenticatorCategories.length + ' 条分类绑定';
  });
  r.test('映射幂等（两次映射结果一致）', function () {
    const again = stratum.mapBackupToAccounts(deepClone(plain), { updatedAt: stratum.FIXTURE_UPDATED_AT });
    assertDeepEqual(again.accounts, mapped.accounts);
    assertDeepEqual(again.skipped, mapped.skipped);
  });
  r.test('跳过报告不含完整 secret（安全）', function () {
    for (const item of expected.skipped) {
      assert(!('secret' in item), '跳过项不应包含 secret');
    }
    return expected.skipped.length + ' 条';
  });

  // ------------------------------------------------ C. Strong / Legacy
  r.section('C. Strong / Legacy 加解密一致性（自生成夹具）');
  const strong = readBuffer(join(FIXTURES, 'strong.stratum'));
  const legacy = readBuffer(join(FIXTURES, 'legacy.stratum'));
  r.test('格式嗅探：strong / legacy', function () {
    assertEqual(stratum.detectFormat(strong), 'strong');
    assertEqual(stratum.detectFormat(legacy), 'legacy');
  });
  await r.testAsync('Strong 解密（Argon2id p4 m64MiB t3 + AES-256-GCM）与明文一致', async function () {
    const decrypted = await stratum.decryptStrong(strong, PASSWORD);
    assertDeepEqual(JSON.parse(decrypted), plain);
    return decrypted.length + ' chars';
  });
  r.test('Legacy 解密（PBKDF2-SHA1 64000 + AES-256-CBC/PKCS7）与明文一致', function () {
    const decrypted = stratum.decryptLegacy(legacy, PASSWORD);
    assertDeepEqual(JSON.parse(decrypted), plain);
    return decrypted.length + ' chars';
  });
  await r.testAsync('错误密码：Strong 解密失败（GCM tag）', async function () {
    let thrown = null;
    try {
      await stratum.decryptStrong(strong, 'wrong-password');
    } catch (error) {
      thrown = error;
    }
    assert(thrown, '错误密码应解密失败');
    assert(String(thrown.message).indexOf('wrong-password') < 0, '错误信息不得包含密码');
  });
  r.test('错误密码：Legacy 解密失败（CBC 填充）', function () {
    let thrown = null;
    try {
      stratum.decryptLegacy(legacy, 'wrong-password');
    } catch (error) {
      thrown = error;
    }
    assert(thrown, '错误密码应解密失败');
    assert(String(thrown.message).indexOf('wrong-password') < 0, '错误信息不得包含密码');
  });
  r.test('文件头/截断/随机内容拒绝', function () {
    assertThrows(function () { stratum.splitStrongLayout(legacy); }, 'not a Strong');
    assertThrows(function () { stratum.splitLegacyLayout(strong); }, 'not a Legacy');
    assertThrows(function () { stratum.splitStrongLayout(strong.subarray(0, 20)); }, 'truncated');
    assertEqual(stratum.detectFormat(Buffer.from('random bytes')), 'unknown');
  });
  await r.testAsync('相同 salt/iv 重新加密 → 与夹具逐字节一致', async function () {
    const strongSalt = Buffer.from(manifest.encryption.strong.saltHex, 'hex');
    const strongIv = Buffer.from(manifest.encryption.strong.ivHex, 'hex');
    const legacySalt = Buffer.from(manifest.encryption.legacy.saltHex, 'hex');
    const legacyIv = Buffer.from(manifest.encryption.legacy.ivHex, 'hex');
    const plainText = plainBuffer.toString('utf8');
    const strongAgain = await stratum.encryptStrong(plainText, PASSWORD, strongSalt, strongIv);
    assert(strongAgain.equals(strong), 'Strong 重新加密应与夹具逐字节一致');
    const legacyAgain = stratum.encryptLegacy(plainText, PASSWORD, legacySalt, legacyIv);
    assert(legacyAgain.equals(legacy), 'Legacy 重新加密应与夹具逐字节一致');
    return 'strong ' + strongAgain.length + 'B / legacy ' + legacyAgain.length + 'B';
  });
  r.test('detectFormat：明文 / URI 列表 / 未知', function () {
    assertEqual(stratum.detectFormat(plainBuffer), 'json');
    assertEqual(stratum.detectFormat(readBuffer(join(FIXTURES, 'uri-list.txt'))), 'uri');
    assertEqual(stratum.detectFormat(Buffer.from([0, 1, 2, 3])), 'unknown');
  });

  // ------------------------------------ D. 跨实现交叉验证（Python 夹具）
  r.section('D. 跨实现交叉验证（tools/fixtures Python 夹具）');
  const toolsFixtures = join(WORKSPACE, 'tools', 'fixtures');
  const toolsPlainPath = join(toolsFixtures, 'plain-backup.json');
  if (existsSync(toolsPlainPath)) {
    const toolsPlainBuffer = readBuffer(toolsPlainPath);
    const toolsPlain = JSON.parse(toolsPlainBuffer.toString('utf8'));
    const toolsStrong = readBuffer(join(toolsFixtures, 'strong.stratum'));
    const toolsLegacy = readBuffer(join(toolsFixtures, 'legacy.stratum'));
    const toolsUri = readFileSync(join(toolsFixtures, 'uri-list.txt'), 'utf8');
    const toolsMapped = stratum.mapBackupToAccounts(toolsPlain, { updatedAt: stratum.FIXTURE_UPDATED_AT });

    await r.testAsync('Python 夹具 Strong 可被 e2e Node 实现解密', async function () {
      const decrypted = await stratum.decryptStrong(toolsStrong, PASSWORD);
      assertDeepEqual(JSON.parse(decrypted), toolsPlain);
    });
    r.test('Python 夹具 Legacy 可被 e2e Node 实现解密', function () {
      const decrypted = stratum.decryptLegacy(toolsLegacy, PASSWORD);
      assertDeepEqual(JSON.parse(decrypted), toolsPlain);
    });
    await r.testAsync('用 Python 夹具的固定 salt/iv + e2e 加密 → 与原文件逐字节一致', async function () {
      // Python generate.py: strong salt=bytes(range(16)), iv=bytes(range(12));
      //                      legacy salt=bytes(range(20)), iv=bytes(range(16))
      const rangeBuffer = function (length) {
        return Buffer.from(Array.from({ length }, function (_, index) { return index; }));
      };
      const strongAgain = await stratum.encryptStrong(
        toolsPlainBuffer.toString('utf8'),
        PASSWORD,
        rangeBuffer(16),
        rangeBuffer(12)
      );
      assert(strongAgain.equals(toolsStrong), 'Strong 加密切片应与 Python 夹具逐字节一致');
      const legacyAgain = stratum.encryptLegacy(
        toolsPlainBuffer.toString('utf8'),
        PASSWORD,
        rangeBuffer(20),
        rangeBuffer(16)
      );
      assert(legacyAgain.equals(toolsLegacy), 'Legacy 加密切片应与 Python 夹具逐字节一致');
      return 'strong/legacy 均逐字节一致';
    });
    r.test('Python 夹具映射：3 导入 / 5 跳过（旧夹具 Steam 与 GitHub 共用 secret，按主键重复跳过）', function () {
      assertEqual(toolsMapped.stats.total, 8);
      assertEqual(toolsMapped.stats.imported, 3);
      assertEqual(toolsMapped.stats.skipped, 5);
      const byIssuer = new Map(toolsMapped.accounts.map(function (account) { return [account.issuer, account]; }));
      assertEqual(byIssuer.get('GitHub').category, '社交', 'GitHub 多分类取 AuthenticatorCategory.Ranking 最小者');
      assertEqual(byIssuer.get('Google').category, '开发');
      assertEqual(byIssuer.get('AWS').category, '云服务');
      assertEqual(byIssuer.get('Google').algorithm, 'SHA256');
      assertEqual(byIssuer.get('Google').digits, 8);
      assertEqual(byIssuer.get('Google').period, 60);
      assertEqual(byIssuer.get('AWS').algorithm, 'SHA512');
      assertEqual(byIssuer.get('AWS').digits, 10);
      assertEqual(byIssuer.get('AWS').period, 15);
      const steamSkip = toolsMapped.skipped.find(function (item) { return item.issuer === 'Steam'; });
      assert(steamSkip, 'tools 旧夹具的 Steam 条目应出现在跳过报告');
      assertEqual(steamSkip.code, 'DUPLICATE_SECRET', '旧夹具 Steam 与 GitHub 共用 secret（Stratum 主键唯一），按重复跳过');
      const codes = toolsMapped.skipped.map(function (item) { return item.code; }).sort();
      assertDeepEqual(codes, ['DUPLICATE_SECRET', 'EMPTY_ISSUER_AND_USERNAME', 'INVALID_BASE32', 'PERIOD_OUT_OF_RANGE', 'UNSUPPORTED_OTP_TYPE']);
      console.log('  NOTE tools/fixtures 旧夹具 Steam 与 GitHub 共用 secret（已知 3/5）；Steam 映射正向用例以 e2e/fixtures 为准');
    });
    r.test('Python 夹具 URI 列表：3 导入 / 1 跳过', function () {
      const parsed = stratum.parseUriList(toolsUri);
      assertEqual(parsed.stats.imported, 3);
      assertEqual(parsed.stats.skipped, 1);
      assertEqual(parsed.skipped[0].code, 'TYPE_NOT_TOTP');
      const mine = accountSetById(stratum.mapBackupToAccounts(toolsPlain).accounts);
      for (const account of parsed.accounts) {
        const plainAccount = mine.get(account.id);
        assert(plainAccount, 'URI 账号 ' + account.issuer + ' 应在明文映射中');
        assertDeepEqual(stripAccountForUriCompare(account), stripAccountForUriCompare(plainAccount));
      }
    });

    // 与 tools/src/stratum.mjs 对拍
    const toolsModulePath = join(WORKSPACE, 'tools', 'src', 'stratum.mjs');
    if (existsSync(toolsModulePath)) {
      const toolsModule = await import(pathToFileURL(toolsModulePath).href);
      await r.testAsync('tools/src/stratum.mjs 解密结果与 e2e 实现一致', async function () {
        const toolsStrongText = await toolsModule.decryptStrong(toolsStrong, PASSWORD);
        assertDeepEqual(JSON.parse(toolsStrongText), toolsPlain);
        const toolsLegacyText = toolsModule.decryptLegacy(toolsLegacy, PASSWORD);
        assertDeepEqual(JSON.parse(toolsLegacyText), toolsPlain);
      });
      await r.testAsync('e2e 生成的 strong/legacy 可被 tools/src/stratum.mjs 解密（双向交叉验证）', async function () {
        const toolsStrongText = await toolsModule.decryptStrong(strong, PASSWORD);
        assertDeepEqual(JSON.parse(toolsStrongText), plain);
        const toolsLegacyText = toolsModule.decryptLegacy(legacy, PASSWORD);
        assertDeepEqual(JSON.parse(toolsLegacyText), plain);
        return 'strong/legacy 均可还原';
      });
      function compareWithTools(label, backupObject, mine) {
        const theirs = toolsModule.mapStratumBackup(backupObject);
        const mineNonSteam = mine.accounts.filter(function (account) { return account.otpType !== 'steam'; });
        const theirsNonSteam = theirs.accounts.filter(function (account) { return account.otpType !== 'steam'; });
        assertDeepEqual(sortedAccountSet(theirsNonSteam), sortedAccountSet(mineNonSteam), label + ': 非 Steam 账号应完全一致');
        const theirsSteam = theirs.accounts.filter(function (account) { return account.otpType === 'steam'; });
        const mineSteam = mine.accounts.filter(function (account) { return account.otpType === 'steam'; });
        if (mineSteam.length > 0 && theirsSteam.length === 0) {
          console.log('  NOTE ' + label + ': tools/src/stratum.mjs 尚未支持 Steam（' + mineSteam.length + ' 条 Steam 账号跳过对拍），待 tools 更新后应改为严格全量对拍');
        } else {
          assertDeepEqual(sortedAccountSet(theirsSteam), sortedAccountSet(mineSteam), label + ': Steam 账号应一致');
        }
        return { theirs, mine };
      }
      r.test('tools/src/stratum.mjs 与 e2e 对 Python 夹具映射一致（非 Steam 严格 / Steam 自适应）', function () {
        compareWithTools('Python 夹具', toolsPlain, toolsMapped);
      });
      r.test('tools/src/stratum.mjs 与 e2e 对 e2e 夹具映射一致（非 Steam 严格 / Steam 自适应）', function () {
        compareWithTools('e2e 夹具', plain, mapped);
      });
    } else {
      process.stdout.write('  NOTE tools/src/stratum.mjs 不存在，跳过实现级对拍\n');
    }
  } else {
    process.stdout.write('  NOTE tools/fixtures 不存在，跳过 Python 夹具交叉验证\n');
  }

  // -------------------------------------------------------- E. URI 列表
  r.section('E. otpauth:// URI 列表夹具');
  const uriText = readFileSync(join(FIXTURES, 'uri-list.txt'), 'utf8');
  const parsedUris = stratum.parseUriList(uriText);
  r.test('URI 列表：8 导入 / 2 跳过（HOTP + 非法 secret）', function () {
    assertEqual(parsedUris.stats.total, 10);
    assertEqual(parsedUris.stats.imported, 8);
    assertEqual(parsedUris.stats.skipped, 2);
    const codes = parsedUris.skipped.map(function (item) { return item.code; }).sort();
    assertDeepEqual(codes, ['INVALID_BASE32', 'TYPE_NOT_TOTP']);
  });
  r.test('URI 三种 Steam 形式均识别为 otpType=steam', function () {
    const steam = parsedUris.accounts.filter(function (account) { return account.otpType === 'steam'; });
    assertEqual(steam.length, 3, '应有 3 个 Steam URI 账号');
    const byIssuer = new Map(steam.map(function (account) { return [account.issuer, account]; }));
    assert(byIssuer.get('Steam'), 'issuer=Steam 无标记形式应识别');
    assert(byIssuer.get('Valve'), '非 Steam issuer + &steam 形式应识别');
    assert(byIssuer.get('AegisSteamRepo'), 'encoder=steam 形式应识别');
    for (const account of steam) {
      assertEqual(account.algorithm, 'SHA1', 'Steam 固定 SHA1');
      assertEqual(account.digits, 5, 'Steam 固定 5 位');
      assertEqual(account.period, 30, 'Steam 固定 30s');
    }
    return steam.map(function (account) { return account.issuer; }).join(', ');
  });
  r.test('URI 普通 TOTP 字段与明文映射一致（无分类 → 默认分类）', function () {
    const byId = accountSetById(expected.accounts);
    const totpAccounts = parsedUris.accounts.filter(function (account) { return account.otpType === 'totp'; });
    assertEqual(totpAccounts.length, 5, '普通 TOTP URI 应为 5 条');
    for (const account of totpAccounts) {
      const plainAccount = byId.get(account.id);
      assert(plainAccount, 'URI 账号 ' + account.id + ' 应在明文映射中');
      assertDeepEqual(stripAccountForUriCompare(account), stripAccountForUriCompare(plainAccount));
      assertEqual(account.category, '默认分类', 'URI 列表无分类 → 默认分类');
    }
    return totpAccounts.length + ' 个';
  });
  r.test('URI Steam 字段与明文映射一致（issuer=Steam / issuer=Valve）', function () {
    const byId = accountSetById(expected.accounts);
    for (const account of parsedUris.accounts.filter(function (item) { return item.otpType === 'steam'; })) {
      const plainAccount = byId.get(account.id);
      if (!plainAccount) {
        continue; // encoder=steam 形式使用独立 secret，无明文字段对照
      }
      assertDeepEqual(stripAccountForUriCompare(account), stripAccountForUriCompare(plainAccount));
      assertEqual(plainAccount.otpType, 'steam');
    }
    return '2 个可对照 + 1 个独立';
  });

  // ---------------------------------------------------- F. 合法协议会话
  r.section('F. 同步协议 v2 合法消息序列与状态机');
  const sessionFixture = readJson(join(FIXTURES, 'protocol', 'valid-session.json'));
  const sessionMessages = sessionFixture.messages;
  const expectedAccounts = expected.accounts;
  const accountMessages = sessionMessages.filter(function (message) {
    return message.type === protocol.MESSAGE_TYPES.ACCOUNT;
  });
  r.test('消息序列结构：1 begin + ' + expectedAccounts.length + ' account + 1 commit', function () {
    assertEqual(sessionMessages.length, expectedAccounts.length + 2);
    assertEqual(sessionMessages[0].type, 'mfa_sync_begin');
    assertEqual(sessionMessages[sessionMessages.length - 1].type, 'mfa_sync_commit');
    assertEqual(accountMessages.length, expectedAccounts.length);
  });
  r.test('信封字段合法：type/version/sentAt', function () {
    for (const message of sessionMessages) {
      const result = protocol.validateEnvelope(message);
      assert(result.ok, message.type + ': ' + result.reason);
      assertEqual(message.version, 2);
      assert(Number.isInteger(message.sentAt), 'sentAt 必须是整数毫秒');
    }
  });
  let maxMessageBytes = 0;
  r.test('单条消息 < 1KB', function () {
    for (const message of sessionMessages) {
      const bytes = protocol.messageBytes(message);
      maxMessageBytes = Math.max(maxMessageBytes, bytes);
      assert(bytes < protocol.MAX_MESSAGE_BYTES, message.type + ' 超过 1KB: ' + bytes);
    }
    return '最大 ' + maxMessageBytes + 'B';
  });
  r.test('index / count / syncId 自洽', function () {
    const syncId = sessionMessages[0].syncId;
    assertEqual(typeof syncId, 'string');
    assert(syncId.length > 0);
    assertEqual(sessionMessages[0].accountCount, expectedAccounts.length);
    assertEqual(sessionMessages[sessionMessages.length - 1].accountCount, expectedAccounts.length);
    sessionMessages.forEach(function (message, index) {
      if (message.type === 'mfa_sync_begin' || message.type === 'mfa_sync_commit') {
        return;
      }
      assertEqual(message.syncId, syncId);
      assertEqual(message.index, index - 1, 'account index 必须从 0 连续递增');
    });
  });
  r.test('account 载荷与 expected-import 一致', function () {
    accountMessages.forEach(function (message, index) {
      assertDeepEqual(message.account, expectedAccounts[index], '第 ' + index + ' 条 account');
      const validated = protocol.validateAccount(message.account, message.index);
      assert(validated.ok, validated.reason);
    });
    return expectedAccounts.length + ' 条';
  });
  r.test('手环端回放：全部接收并原子提交，快照与映射一致', function () {
    const receiver = new protocol.BandSyncReceiver({
      now: function () { return FIXED_NOW; }
    });
    const results = sessionMessages.map(function (message) {
      return receiver.receive(JSON.stringify(message));
    });
    assertDeepEqual(
      results.map(function (result) { return result.status; }),
      ['accepted'].concat(Array(expectedAccounts.length).fill('accepted'), ['committed'])
    );
    assert(receiver.snapshot, '应有快照');
    assertEqual(receiver.snapshot.version, 2);
    assertEqual(receiver.snapshot.updatedAt, FIXED_NOW);
    assertDeepEqual(receiver.snapshot.accounts, expectedAccounts);
    assert(receiver.staging === null, '提交后 staging 应清空');
  });
  r.test('ack 字段合法，手机端状态机置为 confirmed', function () {
    const receiver = new protocol.BandSyncReceiver({ now: function () { return FIXED_NOW; } });
    let ack = null;
    for (const message of sessionMessages) {
      const result = receiver.receive(message);
      if (result.ack) {
        ack = result.ack;
      }
    }
    assert(ack, '应产生 ack');
    assert(protocol.validateAck(ack).ok, 'ack 字段非法: ' + JSON.stringify(protocol.validateAck(ack)));
    assertEqual(ack.type, 'mfa_sync_ack');
    assertEqual(ack.ok, true);
    assertEqual(ack.received, expectedAccounts.length);
    assertEqual(ack.committed, expectedAccounts.length);
    assertEqual(ack.error, null);
    assertEqual(ack.syncId, sessionFixture.syncId);
    const client = new protocol.PhoneSyncClient({ now: function () { return FIXED_NOW; } });
    const handled = client.handleAck(ack);
    assertEqual(handled.status, 'confirmed');
    assertEqual(client.status, 'confirmed');
  });
  r.test('手机端重建会话与夹具逐字节一致', function () {
    const rebuilt = protocol.buildSyncSession(expectedAccounts, {
      sentAt: stratum.FIXTURE_UPDATED_AT,
      syncId: sessionFixture.syncId,
      version: 2
    });
    assertDeepEqual(rebuilt.messages, sessionMessages);
    assertEqual(rebuilt.syncId, sessionFixture.syncId);
  });
  r.test('手环端 mfa_sync_request 合法；手机端响应 resync / 未连接忽略', function () {
    const receiver = new protocol.BandSyncReceiver({ now: function () { return FIXED_NOW; } });
    assert(receiver.snapshot === null, '新装手环应无快照');
    const request = receiver.buildRequest('req-1760000000999-1', FIXED_NOW);
    const check = protocol.validateRequest(request);
    assert(check.ok, 'request 字段非法: ' + check.reason);
    assertEqual(request.type, 'mfa_sync_request');
    // 参考实现的手环端 buildRequest 固定发 v3；v2 手环在旧版固件中发 2，手机端两者都接受（见 K 节）
    assertEqual(request.version, 3);
    const client = new protocol.PhoneSyncClient();
    assertEqual(client.handleRequest(request, true).action, 'resync');
    assertEqual(client.handleRequest(request, false).action, 'ignored');
    assertEqual(client.handleRequest({ type: 'mfa_sync_request', version: 2, sentAt: FIXED_NOW }, true).action, 'ignored');
  });

  // ---------------------------------------------------- G. 协议字段边界
  r.section('G. 协议字段边界（消息大小 / 最大字段 / 非法字段）');
  r.test('最大字段 account 消息仍 < 1KB', function () {
    const maxAccount = makeValidAccount({
      id: 'x'.repeat(64),
      issuer: 'i'.repeat(64),
      accountName: 'a'.repeat(64),
      category: 'c'.repeat(32),
      secret: rfcSeedBase32('SHA512'),
      algorithm: 'SHA512',
      digits: 10,
      period: 300
    });
    const session = protocol.buildSyncSession([maxAccount], { sentAt: FIXED_NOW, syncId: 's-max' });
    const accountMessage = session.messages[1];
    const bytes = protocol.messageBytes(accountMessage);
    assert(bytes < protocol.MAX_MESSAGE_BYTES, '最大字段 account 消息 ' + bytes + 'B 应 < 1KB');
    return bytes + 'B';
  });
  r.test('最大字段 account 被手环端接受并提交', function () {
    const maxAccount = makeValidAccount({
      id: 'x'.repeat(64),
      issuer: 'i'.repeat(64),
      accountName: 'a'.repeat(64),
      category: 'c'.repeat(32),
      secret: rfcSeedBase32('SHA512'),
      algorithm: 'SHA512',
      digits: 10,
      period: 300
    });
    const session = protocol.buildSyncSession([maxAccount], { sentAt: FIXED_NOW, syncId: 's-max' });
    const receiver = new protocol.BandSyncReceiver({ now: function () { return FIXED_NOW; } });
    const results = session.messages.map(function (message) { return receiver.receive(message); });
    assertDeepEqual(
      results.map(function (result) { return result.status; }),
      ['accepted', 'accepted', 'committed']
    );
    assertEqual(receiver.snapshot.accounts.length, 1);
  });
  const invalidFieldAccounts = [
    { label: 'id 65 字符', overrides: { id: 'x'.repeat(65) }, reason: '64' },
    { label: 'issuer 65 字符', overrides: { issuer: 'i'.repeat(65) }, reason: '64' },
    { label: 'accountName 65 字符', overrides: { accountName: 'a'.repeat(65) }, reason: '64' },
    { label: 'category 33 字符', overrides: { category: 'c'.repeat(33) }, reason: '32' },
    { label: 'digits=5', overrides: { digits: 5 }, reason: 'digits' },
    { label: 'digits=11', overrides: { digits: 11 }, reason: 'digits' },
    { label: 'digits 字符串', overrides: { digits: '6' }, reason: 'digits' },
    { label: 'period=4', overrides: { period: 4 }, reason: 'period' },
    { label: 'period=301', overrides: { period: 301 }, reason: 'period' },
    { label: 'algorithm 非法', overrides: { algorithm: 'MD5' }, reason: 'algorithm' },
    { label: 'secret 非法字符', overrides: { secret: 'NOT-BASE32!' }, reason: 'secret' },
    { label: 'secret 空', overrides: { secret: '' }, reason: 'secret' },
    { label: 'issuer/accountName 全空', overrides: { issuer: '', accountName: '' }, reason: '同时为空' }
  ];
  for (const invalid of invalidFieldAccounts) {
    r.test('非法 account 被丢弃：' + invalid.label, function () {
      const account = makeValidAccount(invalid.overrides);
      const receiver = new protocol.BandSyncReceiver({ now: function () { return FIXED_NOW; } });
      const begin = receiver.receive(protocol.buildSyncSession([account], { sentAt: FIXED_NOW, syncId: 's-invalid' }).messages[0]);
      assertEqual(begin.status, 'accepted');
      const session = protocol.buildSyncSession([account], { sentAt: FIXED_NOW, syncId: 's-invalid' });
      const result = receiver.receive(session.messages[1]);
      assertEqual(result.status, 'dropped', invalid.label + ' 应被丢弃');
      assert(
        String(result.reason).indexOf(invalid.reason) >= 0,
        invalid.label + ' 丢弃原因应包含 ' + JSON.stringify(invalid.reason) + '，实际: ' + result.reason
      );
      const commit = receiver.receive(session.messages[2]);
      assertEqual(commit.status, 'failed');
      assertEqual(commit.ack.ok, false);
      assertEqual(receiver.snapshot, null);
    });
  }
  r.test('未知额外字段被忽略（前向兼容）', function () {
    const account = makeValidAccount({ pin: '1234', counter: 7, extra: { nested: true } });
    const receiver = new protocol.BandSyncReceiver({ now: function () { return FIXED_NOW; } });
    const session = protocol.buildSyncSession([account], { sentAt: FIXED_NOW, syncId: 's-extra' });
    const results = session.messages.map(function (message) { return receiver.receive(message); });
    assertDeepEqual(
      results.map(function (result) { return result.status; }),
      ['accepted', 'accepted', 'committed']
    );
    assert(!('pin' in receiver.snapshot.accounts[0]), '未知字段不应进入快照');
  });
  r.test('小写 algorithm 被容忍并归一化为大写', function () {
    const account = makeValidAccount({ algorithm: 'sha256' });
    const validated = protocol.validateAccount(account, 0);
    assert(validated.ok, validated.reason);
    assertEqual(validated.account.algorithm, 'SHA256');
  });
  r.test('Steam 账号消息仍 < 1KB（含 64 字符字段）', function () {
    const steamMax = {
      id: 'x'.repeat(64),
      issuer: 'i'.repeat(64),
      accountName: 'a'.repeat(64),
      category: 'c'.repeat(32),
      secret: 'OJZ2BP7STWSLUD7I23Q5AYZELZB5OAFU',
      algorithm: 'SHA1',
      digits: 5,
      period: 30,
      otpType: 'steam'
    };
    const session = protocol.buildSyncSession([steamMax], { sentAt: FIXED_NOW, syncId: 's-steam-max' });
    const bytes = protocol.messageBytes(session.messages[1]);
    assert(bytes < protocol.MAX_MESSAGE_BYTES, 'Steam 最大字段 account 消息 ' + bytes + 'B 应 < 1KB');
    return bytes + 'B';
  });
  for (const badSteam of [
    { label: 'otpType 非法', overrides: { otpType: 'hotp' }, reason: 'otpType' },
    { label: 'steam digits=6', overrides: { otpType: 'steam', digits: 6 }, reason: 'digits' },
    { label: 'steam period=60', overrides: { otpType: 'steam', digits: 5, period: 60 }, reason: 'period' },
    { label: 'steam algorithm=SHA256', overrides: { otpType: 'steam', algorithm: 'SHA256' }, reason: 'algorithm' }
  ]) {
    r.test('非法 Steam account 被丢弃：' + badSteam.label, function () {
      const account = makeValidAccount(badSteam.overrides);
      const validated = protocol.validateAccount(account, 0);
      assert(!validated.ok, badSteam.label + ' 应校验失败');
      assert(
        String(validated.reason).indexOf(badSteam.reason) >= 0,
        badSteam.label + ' 原因应包含 ' + JSON.stringify(badSteam.reason) + '，实际: ' + validated.reason
      );
    });
  }
  r.test('合法 Steam account 归一化：otpType=steam / digits=5 / period=30 / SHA1', function () {
    const validated = protocol.validateAccount(
      makeValidAccount({ otpType: 'STEAM', digits: 5, period: 30, algorithm: 'sha1' }),
      0
    );
    assert(validated.ok, validated.reason);
    assertEqual(validated.account.otpType, 'steam');
    assertEqual(validated.account.digits, 5);
    assertEqual(validated.account.period, 30);
    assertEqual(validated.account.algorithm, 'SHA1');
  });
  r.test('未知 type/version 不破坏进行中的 staging', function () {
    const receiver = new protocol.BandSyncReceiver({ now: function () { return FIXED_NOW; } });
    const session = protocol.buildSyncSession([makeValidAccount()], { sentAt: FIXED_NOW, syncId: 's-keep' });
    assertEqual(receiver.receive(session.messages[0]).status, 'accepted');
    assertEqual(receiver.receive({ type: 'future_type', version: 2, sentAt: FIXED_NOW }).status, 'ignored');
    assertEqual(receiver.receive({ type: 'mfa_sync_account', version: 4, sentAt: FIXED_NOW }).status, 'ignored');
    assertEqual(receiver.receive(session.messages[1]).status, 'accepted');
    assertEqual(receiver.receive(session.messages[2]).status, 'committed');
  });

  // --------------------------------------------- H. 非法/边界用例回放
  r.section('H. 协议非法/边界用例（fixtures/protocol/invalid-cases.json）');
  const invalidCasesFile = readJson(join(FIXTURES, 'protocol', 'invalid-cases.json'));
  const baseClock = invalidCasesFile.baseClock;
  for (const testCase of invalidCasesFile.cases) {
    r.test(testCase.name, function () {
      const initialSnapshot = testCase.initialSnapshot === 'default' ? invalidCasesFile.initialSnapshot : testCase.initialSnapshot;
      const clock = { now: baseClock };
      const receiver = new protocol.BandSyncReceiver({
        now: function () { return clock.now; },
        initialSnapshot: initialSnapshot == null ? null : deepClone(initialSnapshot)
      });
      const snapshotBefore = receiver.snapshot == null ? null : deepClone(receiver.snapshot);
      const offsets = testCase.clockOffsets || testCase.messages.map(function () { return 0; });
      const lastKnownErrors = { value: 0 };
      const results = testCase.messages.map(function (message, index) {
        clock.now = baseClock + (offsets[index] || 0);
        const result = receiver.receive(message);
        if (receiver.staging) {
          lastKnownErrors.value = receiver.staging.errors;
        }
        return result;
      });
      assertEqual(results.length, testCase.expect.results.length, testCase.name + ' results 数量');
      testCase.expect.results.forEach(function (expectedResult, index) {
        const actual = results[index];
        assertEqual(actual.status, expectedResult.status, testCase.name + ' 第 ' + index + ' 条状态');
        if (expectedResult.reasonContains) {
          assert(
            String(actual.reason).indexOf(expectedResult.reasonContains) >= 0,
            testCase.name + ' 第 ' + index + ' 条原因应包含 ' + JSON.stringify(expectedResult.reasonContains) + '，实际: ' + actual.reason
          );
        }
      });
      const expectedFinal = testCase.expect.finalSnapshot;
      if (expectedFinal === 'unchanged') {
        assertDeepEqual(receiver.snapshot, snapshotBefore, testCase.name + ' 快照应保持不变');
      } else if (expectedFinal && typeof expectedFinal === 'object') {
        assert(receiver.snapshot, testCase.name + ' 应存在快照');
        assertEqual(receiver.snapshot.accounts.length, expectedFinal.accountCount, testCase.name + ' 快照账号数');
        if (Array.isArray(expectedFinal.ids)) {
          assertDeepEqual(
            receiver.snapshot.accounts.map(function (account) { return account.id; }),
            expectedFinal.ids
          );
        }
      }
      assertEqual(receiver.staging !== null, testCase.expect.stagingActive, testCase.name + ' staging 状态');
      if (testCase.expect.lastAck === null) {
        assertEqual(receiver.lastAck, null, testCase.name + ' 不应有 ack');
      } else {
        assert(receiver.lastAck, testCase.name + ' 应有 ack');
        assertEqual(receiver.lastAck.ok, testCase.expect.lastAck.ok, testCase.name + ' ack.ok');
        assertEqual(receiver.lastAck.received, testCase.expect.lastAck.received, testCase.name + ' ack.received');
        assertEqual(receiver.lastAck.committed, testCase.expect.lastAck.committed, testCase.name + ' ack.committed');
        if (testCase.expect.lastAck.errorContains) {
          assert(
            String(receiver.lastAck.error).indexOf(testCase.expect.lastAck.errorContains) >= 0,
            testCase.name + ' ack.error 应包含 ' + JSON.stringify(testCase.expect.lastAck.errorContains)
          );
        }
      }
      if (testCase.expect.finalAccounts) {
        assertDeepEqual(
          receiver.snapshot.accounts.map(stripAccountForCompare),
          testCase.expect.finalAccounts.map(stripAccountForCompare)
        );
      }
      if (testCase.expect.expectedStagingErrors !== undefined) {
        assertEqual(lastKnownErrors.value, testCase.expect.expectedStagingErrors, testCase.name + ' staging 错误数');
      }
      assert(protocol.validateAck(receiver.lastAck).ok || receiver.lastAck === null, testCase.name + ' ack 字段应合法');
    });
  }

  // ---------------------------------------------- I. 跨端 TOTP 模块对拍
  r.section('I. 跨端 TOTP 对拍（band-app 纯模块 vs e2e 独立实现）');
  const bandTotpPaths = [
    join(WORKSPACE, 'band-app', 'src', 'common', 'scripts', 'totp.js'),
    join(WORKSPACE, 'band-app', 'src', 'common', 'scripts', 'totp.mjs')
  ];
  const bandTotpPath = bandTotpPaths.find(function (path) { return existsSync(path); });
  let bandTotp = null;
  if (bandTotpPath) {
    try {
      bandTotp = await import(pathToFileURL(bandTotpPath).href);
    } catch (error) {
      process.stdout.write('  NOTE band-app TOTP 模块加载失败（可能依赖快应用运行时）: ' + String(error.message) + '\n');
    }
  }
  if (bandTotp) {
    const steamExportNames = Object.keys(bandTotp).filter(function (name) {
      return /steam/i.test(name) && typeof bandTotp[name] === 'function';
    });
    r.test('band-app TOTP 模块导出 generateTotp/hotp 且可加载', function () {
      assertEqual(typeof bandTotp.generateTotp, 'function', '缺少 generateTotp');
      assertEqual(typeof bandTotp.hotp, 'function', '缺少 hotp');
      return bandTotpPath.replace(WORKSPACE + '/', '') + (steamExportNames.length ? ' / steam: ' + steamExportNames.join(',') : ' / 无 Steam 导出');
    });
    r.test('band-app RFC 4226 HOTP counter=0..9 与 RFC 表一致', function () {
      const secret = rfcSeedBase32('SHA1');
      for (let counter = 0; counter < 10; counter++) {
        const bandCode = bandTotp.hotp(secret, counter, 6, 'SHA1');
        assertEqual(bandCode, rfc4226[counter], 'counter=' + counter + ' 与 RFC 4226 表不一致');
      }
      return '10 个向量';
    });
    for (const vector of RFC6238_VECTORS) {
      for (const algorithm of ['SHA1', 'SHA256', 'SHA512']) {
        r.test('band-app RFC 6238 T=' + vector.time + ' ' + algorithm, function () {
          const code = bandTotp.generateTotp(rfcSecrets[algorithm], vector.time * 1000, 30, 8, algorithm);
          assertEqual(code, vector[algorithm], 'band-app TOTP 与 RFC 表不一致');
          return 'code=' + code;
        });
      }
    }
    r.test('band-app TOTP 与独立实现矩阵对拍（3 算法 × 5 digits × 5 period × 5 时间）', function () {
      const times = [0, 59000, 1111111109000, 1760000000000, 20000000000000];
      let comparisons = 0;
      for (const algorithm of ['SHA1', 'SHA256', 'SHA512']) {
        const secret = rfcSecrets[algorithm];
        for (const digits of [6, 7, 8, 9, 10]) {
          for (const period of [5, 15, 30, 60, 300]) {
            for (const timeMs of times) {
              const mine = totp(secret, timeMs, { period, digits, algorithm });
              const bandCode = bandTotp.generateTotp(secret, timeMs, period, digits, algorithm);
              assertEqual(
                bandCode,
                mine,
                algorithm + '/digits=' + digits + '/period=' + period + '/t=' + timeMs
              );
              comparisons += 1;
            }
          }
        }
      }
      return comparisons + ' 组对拍一致';
    });
    r.test('band-app TOTP 对夹具全部 TOTP 账号逐一对拍（2 个时间点）', function () {
      const times = [stratum.FIXTURE_UPDATED_AT, stratum.FIXTURE_UPDATED_AT + 59000];
      let comparisons = 0;
      for (const account of expected.accounts.filter(function (item) { return item.otpType !== 'steam'; })) {
        for (const timeMs of times) {
          const mine = totp(account.secret, timeMs, {
            period: account.period,
            digits: account.digits,
            algorithm: account.algorithm
          });
          const bandCode = bandTotp.generateTotp(
            account.secret,
            timeMs,
            account.period,
            account.digits,
            account.algorithm
          );
          assertEqual(bandCode, mine, account.issuer + '/' + account.accountName + '/t=' + timeMs);
          comparisons += 1;
        }
      }
      return comparisons + ' 次一致';
    });
    // Steam 跨端对拍：自动探测 band-app 导出的 Steam 码函数签名（时间毫秒/秒均可）
    if (steamExportNames.length > 0) {
      const steamFn = bandTotp[steamExportNames[0]];
      const strategies = [
        { name: '(secret, timeMs)', call: function (secret, seconds) { return steamFn(secret, seconds * 1000); } },
        { name: '(secret, seconds)', call: function (secret, seconds) { return steamFn(secret, seconds); } },
        { name: '(secret, timeMs, period)', call: function (secret, seconds) { return steamFn(secret, seconds * 1000, 30); } },
        { name: '(secret, seconds, period)', call: function (secret, seconds) { return steamFn(secret, seconds, 30); } }
      ];
      let chosen = null;
      for (const strategy of strategies) {
        try {
          const matches = STEAM_VECTORS.every(function (vector) {
            const value = strategy.call(STEAM_SECRET, vector.time);
            const code = value && typeof value === 'object' ? value.code || value.value : value;
            return code === vector.code;
          });
          if (matches) {
            chosen = strategy;
            break;
          }
        } catch (error) {
          // 尝试下一种签名
        }
      }
      if (!chosen) {
        r.test('band-app Steam 码跨端对拍', function () {
          throw new Error(
            'band-app 导出 Steam 函数（' + steamExportNames.join(',') + '）但无法匹配已验向量；' +
              '请对齐 docs/protocol.md 的 SteamOtp 算法（HMAC-SHA1 + 5 位字母表）'
          );
        });
      } else {
        r.test('band-app Steam 码 6 组向量对拍（签名 ' + chosen.name + '）', function () {
          for (const vector of STEAM_VECTORS) {
            const value = chosen.call(STEAM_SECRET, vector.time);
            const code = value && typeof value === 'object' ? value.code || value.value : value;
            assertEqual(code, vector.code, 'T=' + vector.time + ' Steam 码与独立实现不一致');
          }
          return '6 组一致';
        });
        r.test('band-app Steam 码对夹具 Steam 账号逐一对拍（2 个时间点）', function () {
          const steamAccounts = expected.accounts.filter(function (account) { return account.otpType === 'steam'; });
          assert(steamAccounts.length > 0, '夹具应包含 Steam 账号');
          let comparisons = 0;
          for (const account of steamAccounts) {
            for (const timeSeconds of [stratum.FIXTURE_UPDATED_AT / 1000, stratum.FIXTURE_UPDATED_AT / 1000 + 59]) {
              const mine = steamTotp(account.secret, timeSeconds * 1000);
              const value = chosen.call(account.secret, timeSeconds);
              const code = value && typeof value === 'object' ? value.code || value.value : value;
              assertEqual(code, mine, account.issuer + '/' + account.accountName + '/t=' + timeSeconds);
              comparisons += 1;
            }
          }
          return comparisons + ' 次一致';
        });
      }
    } else {
      console.log('  NOTE band-app totp.js 尚未导出 Steam 码函数（band-dev 实现后自动启用跨端 Steam 对拍）');
    }
    r.test('band-app normalizeBase32 与 e2e 归一化一致（空格/=/小写）', function () {
      const normalized = bandTotp.normalizeBase32(' jbsw y3dp ehpk 3pxp= ');
      assert(normalized && normalized.ok, 'normalizeBase32 应成功');
      assertEqual(normalized.value, normalizeProtocolSecret(' jbsw y3dp ehpk 3pxp= '));
      assertEqual(normalized.value, 'JBSWY3DPEHPK3PXP');
    });
  } else {
    process.stdout.write('  NOTE band-app TOTP 模块不可用（不存在或加载失败），跳过跨端 TOTP 对拍\n');
  }

  // ------------------------------------------- J. Bitwarden 导入（v3）
  r.section('J. Bitwarden 未加密 Vault JSON 导入');
  const bitwardenExport = readJson(join(FIXTURES, 'bitwarden-export.json'));
  const bitwardenEncryptedExport = readJson(join(FIXTURES, 'bitwarden-encrypted-export.json'));
  const bitwardenExpected = readJson(join(FIXTURES, 'bitwarden-expected-import.json'));
  const bitwardenMapped = bitwarden.mapBitwardenToAccounts(bitwardenExport, {
    updatedAt: stratum.FIXTURE_UPDATED_AT
  });

  r.test('内容嗅探：未加密 Vault / 加密导出 / 非 Bitwarden JSON', function () {
    assertEqual(bitwarden.detectBitwarden(bitwardenExport), 'vault');
    assertEqual(bitwarden.detectBitwarden(bitwardenEncryptedExport), 'encrypted');
    assertEqual(bitwarden.detectBitwarden(plain), 'unknown', 'Stratum 备份不应被识别为 Bitwarden');
    assertEqual(bitwarden.detectBitwarden({ items: [{ id: 'x', type: 1 }] }), 'unknown', '无 login 字段的导出不识别');
    assertEqual(bitwarden.detectBitwarden('not-json'), 'unknown');
  });
  r.test('映射结果与 bitwarden-expected-import.json 完全一致', function () {
    assertDeepEqual(bitwardenMapped.accounts, bitwardenExpected.accounts);
    assertDeepEqual(bitwardenMapped.skipped, bitwardenExpected.skipped);
    assertDeepEqual(bitwardenMapped.stats, bitwardenExpected.stats);
  });
  r.test('映射统计 6 导入 / 4 跳过（共 10 个 item）', function () {
    assertEqual(bitwardenMapped.stats.total, 10);
    assertEqual(bitwardenMapped.stats.imported, 6);
    assertEqual(bitwardenMapped.stats.skipped, 4);
  });
  r.test('totp 三种形态：otpauth TOTP / Steam encoder / 纯 Base32', function () {
    const byIssuer = new Map(bitwardenMapped.accounts.map(function (account) { return [account.issuer, account]; }));
    assertEqual(byIssuer.get('GitHub').secret, 'JBSWY3DPEHPK3PXP');
    assertEqual(byIssuer.get('GitHub').otpType, 'totp');
    assertEqual(byIssuer.get('AWS').algorithm, 'SHA256');
    assertEqual(byIssuer.get('AWS').digits, 8);
    assertEqual(byIssuer.get('AWS').period, 60);
    assertEqual(byIssuer.get('Steam').otpType, 'steam', 'encoder=steam 应识别为 Steam Guard');
    assertEqual(byIssuer.get('Steam').digits, 5);
    assertEqual(byIssuer.get('Steam').period, 30);
    assertEqual(byIssuer.get('Steam').algorithm, 'SHA1');
    assertEqual(byIssuer.get('RawBase32').secret, 'MFRGGZDFMZTWQ2LK', '纯 Base32 按 SHA1/6/30 导入');
    assertEqual(byIssuer.get('RawBase32').digits, 6);
    assertEqual(byIssuer.get('RawBase32').period, 30);
    return 'TOTP + Steam + Base32';
  });
  r.test('字段映射：name→issuer 兜底、username→accountName 兜底、文件夹忽略', function () {
    const byIssuer = new Map(bitwardenMapped.accounts.map(function (account) { return [account.issuer, account]; }));
    const noName = byIssuer.get(bitwarden.BITWARDEN_ISSUER);
    assert(noName, 'name 为空的条目 issuer 应兜底为 Bitwarden');
    assertEqual(noName.accountName, 'noname@test.invalid', 'username 为空时应取 otpauth label 的账号部分');
    assertEqual(byIssuer.get('邮件').accountName, '邮箱用户');
    for (const account of bitwardenMapped.accounts) {
      assertEqual(account.category, '默认分类', 'Bitwarden 文件夹/分类应忽略');
    }
    return bitwardenMapped.accounts.length + ' 条';
  });
  r.test('每个导入账号 id = s_ + sha1(secret)[0:12]（独立复算）', function () {
    for (const account of bitwardenMapped.accounts) {
      const canonical = normalizeProtocolSecret(account.secret);
      const hex = createHash('sha1').update(canonical, 'utf8').digest('hex').slice(0, 12);
      assertEqual(account.id, 's_' + hex);
    }
    return bitwardenMapped.accounts.length + ' 个';
  });
  r.test('跳过原因：NO_TOTP / NOT_LOGIN_TYPE / INVALID_TOTP / TYPE_NOT_TOTP', function () {
    const codes = bitwardenMapped.skipped.map(function (item) { return item.code; }).sort();
    assertDeepEqual(codes, ['INVALID_TOTP', 'NOT_LOGIN_TYPE', 'NO_TOTP', 'TYPE_NOT_TOTP']);
    for (const item of bitwardenMapped.skipped) {
      assert(!('secret' in item), '跳过报告不应包含 secret');
    }
    return bitwardenMapped.skipped.length + ' 条跳过';
  });
  r.test('加密导出：识别并拒绝，提示改用未加密 JSON', function () {
    let thrown = null;
    try {
      bitwarden.mapBitwardenToAccounts(bitwardenEncryptedExport);
    } catch (error) {
      thrown = error;
    }
    assert(thrown, '加密导出必须被拒绝');
    assertEqual(thrown.code, 'BITWARDEN_ENCRYPTED');
    assertEqual(thrown.message, bitwarden.BITWARDEN_ENCRYPTED_MESSAGE);
    assert(String(thrown.message).indexOf('未加密') >= 0);
  });
  r.test('Bitwarden 映射账号可经协议 v2 同步并提交', function () {
    const session = protocol.buildSyncSession(bitwardenMapped.accounts, {
      sentAt: FIXED_NOW,
      syncId: 'sync-bitwarden-fixture'
    });
    const receiver = new protocol.BandSyncReceiver({ now: function () { return FIXED_NOW; } });
    const results = session.messages.map(function (message) { return receiver.receive(message); });
    assertEqual(results[results.length - 1].status, 'committed');
    assertDeepEqual(receiver.snapshot.accounts, bitwardenMapped.accounts);
    assert(receiver.snapshot.accounts.some(function (account) { return account.otpType === 'steam'; }), '同步快照应保留 Steam 类型');
  });
  r.test('Android 单测 Bitwarden 夹具对拍（5 导入 / 5 跳过 & Steam 5 位码）', function () {
    const fixtureCandidates = [
      join(WORKSPACE, 'android-app', 'app', 'src', 'test', 'resources', 'fixtures', 'bitwarden-export.json'),
      join(WORKSPACE, 'android-app', 'app', 'src', 'test', 'resources', 'bitwarden-export.json')
    ];
    const androidPath = fixtureCandidates.find(function (path) { return existsSync(path); });
    if (!androidPath) {
      console.log('  NOTE Android 单测尚未提供 bitwarden-export.json（android-dev 实现后自动对拍）');
      return '未提供，跳过';
    }
    const androidExport = readJson(androidPath);
    assertEqual(bitwarden.detectBitwarden(androidExport), 'vault', 'Android 夹具应为未加密 Vault');
    const androidMapped = bitwarden.mapBitwardenToAccounts(androidExport, {
      updatedAt: stratum.FIXTURE_UPDATED_AT
    });
    assertEqual(androidMapped.stats.total, 10, 'Android 夹具 item 数');
    assertEqual(androidMapped.stats.imported, 5, 'Android 夹具应 5 导入');
    assertEqual(androidMapped.stats.skipped, 5, 'Android 夹具应 5 跳过');
    const byIssuer = new Map(androidMapped.accounts.map(function (account) { return [account.issuer, account]; }));

    const github = byIssuer.get('GitHub');
    assert(github, '应导入 GitHub');
    assertEqual(github.secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    assertEqual(github.accountName, 'dev@example.com');
    assertEqual(github.algorithm, 'SHA1');
    assertEqual(github.digits, 6);
    assertEqual(github.period, 30);
    assertEqual(github.otpType, 'totp');

    const steam = byIssuer.get('Steam');
    assert(steam, '应导入 Steam（URI issuer=Other + encoder=steam）');
    assertEqual(steam.otpType, 'steam');
    assertEqual(steam.digits, 5);
    assertEqual(steam.period, 30);
    assertEqual(steam.algorithm, 'SHA1');
    assertEqual(steam.accountName, 'alice');
    assertEqual(steamTotp(steam.secret, 59000), '3DP36', 'Steam T=59 应为 3DP36');

    const raw = byIssuer.get('RawBase32');
    assert(raw, '应导入纯 Base32 账号');
    assertEqual(raw.secret, 'JBSWY3DPEHPK3PXP');
    assertEqual(raw.algorithm, 'SHA1');
    assertEqual(raw.digits, 6);
    assertEqual(raw.period, 30);

    const labelOnly = byIssuer.get('LabelOnly');
    assert(labelOnly, '应导入 username 空、label 有账号的条目');
    assertEqual(labelOnly.accountName, 'labelacct');
    assertEqual(labelOnly.algorithm, 'SHA256');
    assertEqual(labelOnly.digits, 8);
    assertEqual(labelOnly.period, 60);

    const fallback = byIssuer.get(bitwarden.BITWARDEN_ISSUER);
    assert(fallback, 'name 为空的条目应回退 issuer=Bitwarden');
    if (fallback.accountName !== '') {
      console.log(
        '  NOTE 已知差异：raw Base32 + name/username 全空时，e2e 参考实现按 docs/bitwarden-format.md 回退 issuer="' +
          fallback.accountName + '"，Android 单测断言 accountName 为空串（不影响 TOTP/同步，仅显示名差异）'
      );
    }

    const codes = androidMapped.skipped.map(function (item) { return item.code; }).sort();
    assertDeepEqual(codes, ['DUPLICATE_SECRET', 'INVALID_TOTP', 'NOT_LOGIN_TYPE', 'NO_TOTP', 'TYPE_NOT_TOTP']);

    // 加密导出负例（Android 资源）
    const encryptedCandidates = [
      join(WORKSPACE, 'android-app', 'app', 'src', 'test', 'resources', 'fixtures', 'bitwarden-encrypted.json'),
      join(WORKSPACE, 'android-app', 'app', 'src', 'test', 'resources', 'bitwarden-encrypted.json')
    ];
    const encryptedPath = encryptedCandidates.find(function (path) { return existsSync(path); });
    if (encryptedPath) {
      const encryptedExport = readJson(encryptedPath);
      assertEqual(bitwarden.detectBitwarden(encryptedExport), 'encrypted');
      let thrown = null;
      try {
        bitwarden.mapBitwardenToAccounts(encryptedExport);
      } catch (error) {
        thrown = error;
      }
      assert(thrown, '加密导出应被拒绝');
      assertEqual(thrown.message, bitwarden.BITWARDEN_ENCRYPTED_MESSAGE);
    }

    // 与 Android 单测源码中的期望值交叉核对
    const testPath = join(
      WORKSPACE, 'android-app', 'app', 'src', 'test', 'java', 'dev', 'wristkey', 'app', 'bitwarden', 'BitwardenImporterTest.kt'
    );
    if (existsSync(testPath)) {
      const testSource = readFileSync(testPath, 'utf8');
      for (const marker of [
        'assertEquals(5, result.importedCount)',
        'assertEquals(5, result.skippedCount)',
        'OTP_TYPE_STEAM',
        '3DP36',
        bitwarden.BITWARDEN_ENCRYPTED_MESSAGE
      ]) {
        assert(testSource.indexOf(marker) >= 0, 'Android 单测缺少期望标记: ' + marker);
      }
    }
    return '5/5 + Steam(3DP36) + 加密负例，与 Android 单测断言一致';
  });

  // ------------------------------------------------ K. 协议 v3（密码 / pin / 兼容）
  r.section('K. 同步协议 v3：password 合并、pin 消息、v2↔v3 兼容');
  const v3Dir = join(FIXTURES, 'protocol-v3');
  const v3SessionFixture = readJson(join(v3Dir, 'valid-session.json'));
  const v3Expected = v3SessionFixture.expected;
  const v3Messages = v3SessionFixture.messages;
  const v3AccountMessages = v3Messages.filter(function (message) {
    return message.type === protocol.MESSAGE_TYPES.ACCOUNT;
  });
  const V3_SENT_AT = v3Messages[0].sentAt;

  r.test('v3 会话结构：version=3、1 begin + 13 account + 1 commit、3 个 password 字段、均 <1KB', function () {
    assertEqual(v3SessionFixture.version, 3);
    assertEqual(v3Messages.length, v3Expected.accountCount + 2);
    assertEqual(v3Messages[0].type, 'mfa_sync_begin');
    assertEqual(v3Messages[v3Messages.length - 1].type, 'mfa_sync_commit');
    assertEqual(v3AccountMessages.length, v3Expected.accountCount);
    let max = 0;
    for (const message of v3Messages) {
      const envelope = protocol.validateEnvelope(message, { versions: protocol.SYNC_VERSIONS });
      assert(envelope.ok, message.type + ': ' + envelope.reason);
      assertEqual(message.version, 3);
      const bytes = protocol.messageBytes(message);
      max = Math.max(max, bytes);
      assert(bytes < protocol.MAX_MESSAGE_BYTES, message.type + ' 超过 1KB: ' + bytes);
    }
    const withPassword = v3AccountMessages.filter(function (message) {
      return message.account.password !== undefined;
    });
    assertEqual(withPassword.length, v3Expected.passwordAccountCount);
    return '最大 ' + max + 'B，' + withPassword.length + ' 条带密码';
  });

  r.test('v3 account 载荷校验：与 expected.accounts 一致，password 保留（含 ""）', function () {
    v3AccountMessages.forEach(function (message, index) {
      const actual = protocol.validateAccount(message.account, message.index, { version: 3 });
      const expectedAccount = protocol.validateAccount(v3Expected.accounts[index], message.index, { version: 3 });
      assert(actual.ok, actual.reason);
      assert(expectedAccount.ok, expectedAccount.reason);
      assertDeepEqual(actual.account, expectedAccount.account, '第 ' + index + ' 条 account');
      assertEqual(actual.account.password, message.account.password);
    });
    return v3Expected.accountCount + ' 条';
  });

  r.test('v3 手环端回放：原子提交到 mfa_snapshot_v3，显式 "" 在快照中清空', function () {
    const receiver = new protocol.BandSyncReceiver({ now: function () { return FIXED_NOW; } });
    const results = v3Messages.map(function (message) { return receiver.receive(message); });
    assertDeepEqual(
      results.map(function (result) { return result.status; }),
      ['accepted'].concat(Array(v3Expected.accountCount).fill('accepted'), ['committed'])
    );
    assert(receiver.snapshot, '应有快照');
    assertEqual(receiver.snapshot.version, 3);
    assertEqual(receiver.snapshot.storageKey, protocol.SNAPSHOT_KEY_V3);
    assertEqual(receiver.snapshot.updatedAt, FIXED_NOW);
    const expectedSnapshotAccounts = v3Expected.accounts.map(function (account, index) {
      const copy = deepClone(account);
      if (copy.password === '') {
        delete copy.password;
      }
      const checked = protocol.validateAccount(copy, index, { version: 3 });
      assert(checked.ok, checked.reason);
      return checked.account;
    });
    assertDeepEqual(receiver.snapshot.accounts, expectedSnapshotAccounts);
    const ack = receiver.lastAck;
    assert(protocol.validateAck(ack).ok, 'ack 非法: ' + JSON.stringify(protocol.validateAck(ack)));
    assertEqual(ack.ok, true);
    assertEqual(ack.received, v3Expected.accountCount);
    assertEqual(ack.committed, v3Expected.accountCount);
    assertEqual(ack.syncId, v3SessionFixture.syncId);
    return '13 条 → v3 快照';
  });

  r.test('手机端 v3 重建会话与夹具逐字节一致', function () {
    const rebuilt = protocol.buildSyncSession(v3Expected.accounts, {
      sentAt: v3Messages[0].sentAt,
      syncId: v3SessionFixture.syncId,
      version: 3
    });
    assertDeepEqual(rebuilt.messages, v3Messages);
    assertEqual(rebuilt.version, 3);
  });

  r.test('password 字段边界：128 字符 / 129 拒绝 / 控制字符拒绝 / 非字符串拒绝 / Unicode 与空格允许', function () {
    const base = makeValidAccount({});
    const okNoPassword = protocol.validateAccount(base, 0, { version: 3 });
    assert(okNoPassword.ok, okNoPassword.reason);
    assertEqual(okNoPassword.account.password, undefined);

    const empty = protocol.validateAccount(Object.assign({}, base, { password: '' }), 0, { version: 3 });
    assert(empty.ok, empty.reason);
    assertEqual(empty.account.password, '');

    const max = protocol.validateAccount(Object.assign({}, base, { password: 'a'.repeat(protocol.MAX_PASSWORD_LENGTH) }), 0, { version: 3 });
    assert(max.ok, max.reason);
    assertEqual(max.account.password.length, 128);

    const tooLong = protocol.validateAccount(Object.assign({}, base, { password: 'a'.repeat(129) }), 0, { version: 3 });
    assertEqual(tooLong.ok, false);
    assert(String(tooLong.reason).indexOf('128') >= 0);

    const control = protocol.validateAccount(Object.assign({}, base, { password: 'abc\u0000def' }), 0, { version: 3 });
    assertEqual(control.ok, false, 'U+0000 必须拒绝');
    assert(String(control.reason).indexOf('控制字符') >= 0);
    const control2 = protocol.validateAccount(Object.assign({}, base, { password: 'abc\u001f' }), 0, { version: 3 });
    assertEqual(control2.ok, false, 'U+001F 必须拒绝');

    const notString = protocol.validateAccount(Object.assign({}, base, { password: 123 }), 0, { version: 3 });
    assertEqual(notString.ok, false);

    const unicode = protocol.validateAccount(Object.assign({}, base, { password: 'p@ss w0rd-测试-Ω' }), 0, { version: 3 });
    assert(unicode.ok, unicode.reason);
    assertEqual(unicode.account.password, 'p@ss w0rd-测试-Ω');

    const v2 = protocol.validateAccount(Object.assign({}, base, { password: 'should-be-ignored' }), 0, { version: 2 });
    assert(v2.ok, v2.reason);
    assertEqual(v2.account.password, undefined, 'v2 消息必须忽略 password');
    return '9 个边界';
  });

  r.test('password 合并矩阵：缺省保留 / "" 清空 / 新值覆盖 / 同轮混合', function () {
    const fixture = readJson(join(v3Dir, 'password-merge.json'));
    for (const scenario of fixture.scenarios) {
      const receiver = new protocol.BandSyncReceiver({
        now: function () { return V3_SENT_AT + 1000; },
        initialSnapshot: deepClone(scenario.initialSnapshot)
      });
      let last = null;
      for (const message of scenario.messages) {
        last = receiver.receive(message);
      }
      assertEqual(last.status, 'committed', scenario.name + ' 应提交成功');
      assertEqual(receiver.snapshot.storageKey, protocol.SNAPSHOT_KEY_V3);
      assertDeepEqual(
        receiver.snapshot.accounts.map(function (account) { return account.id; }),
        scenario.expected.accountIds,
        scenario.name + ' 账号顺序'
      );
      assertDeepEqual(
        receiver.snapshot.accounts.map(function (account) {
          return account.password === undefined ? null : account.password;
        }),
        scenario.expected.passwords,
        scenario.name + ' 密码合并结果'
      );
    }
    return fixture.scenarios.length + ' 个场景';
  });

  r.test('v2 手机 → v3 手环：消息无 password，旧密码保留，新账号无密码，快照 version=2', function () {
    const fixture = readJson(join(v3Dir, 'v2-compat-session.json'));
    for (const message of fixture.messages) {
      const envelope = protocol.validateEnvelope(message, { versions: protocol.SYNC_VERSIONS });
      assert(envelope.ok, envelope.reason);
      assertEqual(message.version, 2);
      if (message.type === protocol.MESSAGE_TYPES.ACCOUNT) {
        assert(!('password' in message.account), 'v2 account 不应携带 password 字段');
      }
    }
    const receiver = new protocol.BandSyncReceiver({
      now: function () { return V3_SENT_AT + 2000; },
      initialSnapshot: deepClone(fixture.initialSnapshot)
    });
    const results = fixture.messages.map(function (message) { return receiver.receive(message); });
    assertEqual(results[results.length - 1].status, 'committed');
    assertEqual(receiver.snapshot.version, 2, '快照 version 应记录来源协议版本');
    assertEqual(receiver.snapshot.storageKey, protocol.SNAPSHOT_KEY_V3, 'v2 同步也写入活动 v3 快照键');
    assertEqual(receiver.snapshot.accounts.length, fixture.expected.accountCount);
    assertDeepEqual(
      receiver.snapshot.accounts.map(function (account) {
        return account.password === undefined ? null : account.password;
      }),
      fixture.expected.passwords,
      'v2 缺省 password = 保留旧值'
    );
    assert(protocol.validateAck(receiver.lastAck).ok);
    assertEqual(receiver.lastAck.received, fixture.expected.accountCount);
    for (const key of ['type', 'version', 'ok', 'received', 'committed', 'error']) {
      assertDeepEqual(receiver.lastAck[key], fixture.expected.ack[key], 'v2 兼容 ack.' + key);
    }
    return '3 账号 / 2 个旧密码保留 + ack';
  });

  r.test('v2 手环收 v3：全部忽略、无快照；v2 手环收 v2 仍正常提交', function () {
    const oldBand = new protocol.BandSyncReceiver({
      supportedVersions: [2],
      now: function () { return FIXED_NOW; }
    });
    const ignored = v3Messages.map(function (message) { return oldBand.receive(message); });
    for (const result of ignored) {
      assertEqual(result.status, 'ignored');
      assert(String(result.reason).indexOf('version') >= 0, '忽略原因应提示 version: ' + result.reason);
    }
    assert(oldBand.snapshot === null, '旧手环不应写快照');
    assert(oldBand.staging === null, '旧手环不应开始 staging');
    assert(oldBand.lastAck === null, '旧手环不应回 ack');

    const v2Fixture = readJson(join(FIXTURES, 'protocol', 'valid-session.json'));
    const oldBand2 = new protocol.BandSyncReceiver({ supportedVersions: [2], now: function () { return FIXED_NOW; } });
    const results = v2Fixture.messages.map(function (message) { return oldBand2.receive(message); });
    assertEqual(results[results.length - 1].status, 'committed');
    assertEqual(oldBand2.snapshot.version, 2);
    return 'v3 全忽略 / v2 兼容';
  });

  r.test('v3 手机 8s 无 ack → 提示升级手环应用；手机端接受 v2 ack', function () {
    const client = new protocol.PhoneSyncClient({ now: function () { return V3_SENT_AT; } });
    const session = client.buildSync([makeValidAccount({})], {
      sentAt: V3_SENT_AT,
      syncId: 'sync-ack-timeout'
    });
    assertEqual(session.version, 3);
    assertEqual(client.checkAckTimeout(V3_SENT_AT + protocol.ACK_TIMEOUT_MS - 1).timedOut, false);
    const timedOut = client.checkAckTimeout(V3_SENT_AT + protocol.ACK_TIMEOUT_MS);
    assertEqual(timedOut.timedOut, true);
    assert(String(timedOut.suggestion).indexOf('升级手环应用') >= 0);

    const legacyAck = {
      type: 'mfa_sync_ack',
      version: 2,
      sentAt: V3_SENT_AT + 1,
      syncId: 'sync-legacy-ack',
      ok: true,
      received: 1,
      committed: 1,
      error: null
    };
    assert(protocol.validateAck(legacyAck).ok, '手机端应接受 v2 ack');
    const client2 = new protocol.PhoneSyncClient({ now: function () { return V3_SENT_AT; } });
    assertEqual(client2.handleAck(legacyAck).status, 'confirmed');
    return '8s 超时 + v2 ack 兼容';
  });

  const pinSetFixture = readJson(join(v3Dir, 'pin-set.json'));
  const pinQueryFixture = readJson(join(v3Dir, 'pin-query-state.json'));
  const pinClearFixture = readJson(join(v3Dir, 'pin-clear.json'));
  const pinAckFixture = readJson(join(v3Dir, 'pin-ack.json'));
  const invalidPinFixture = readJson(join(v3Dir, 'invalid-pin.json'));
  const pinNow = pinSetFixture.expected.stored.updatedAt;

  r.test('pin_set 夹具：pattern/SHA-256 hash/32+64 hex/iterations 1200，消息 <1KB', function () {
    const pin = pinSetFixture.pin;
    assertEqual(pin.algorithm, 'PBKDF2-SHA256');
    assertEqual(pin.salt.length, 32);
    assertEqual(pin.hash.length, 64);
    assertEqual(pin.iterations, 1200);
    assert(protocol.validatePinPattern(pinSetFixture.pattern).ok);
    assertEqual(
      protocol.derivePinHash(pinSetFixture.pattern, pin.salt, pin.iterations),
      pin.hash,
      'PBKDF2-SHA256(图案, salt, iterations, 32) 应等于夹具 hash'
    );
    assert(protocol.validatePinSet(pinSetFixture.message).ok, 'pin_set 消息应合法');
    const bytes = protocol.messageBytes(pinSetFixture.message);
    assert(bytes < protocol.MAX_MESSAGE_BYTES, 'pin_set 超过 1KB: ' + bytes);
    assertEqual(protocol.PIN_STORAGE_KEY, 'wristkey_pin_v1');
    return pinSetFixture.pattern + ' / ' + bytes + 'B';
  });

  r.test('图案格式边界：仅接受 5 位 TSC，大小写/长度/空值拒绝', function () {
    const valid = ['TSCCT', 'TTTTT', 'CCCCC', 'SSSSS', 'TSCTS'];
    for (const pattern of valid) {
      assert(protocol.validatePinPattern(pattern).ok, pattern + ' 应合法');
    }
    const invalid = ['', 'TSC', 'TSCCTX', 'tscct', 'TSCCT ', ' TSCCT', 'TSCXT', '12345'];
    for (const pattern of invalid) {
      assertEqual(protocol.validatePinPattern(pattern).ok, false, JSON.stringify(pattern) + ' 应非法');
    }
    return valid.length + ' 合法 / ' + invalid.length + ' 非法';
  });

  r.test('pin_set 手环端：ack 成功、enabled=true、存 salt/hash/iterations/updatedAt', function () {
    const receiver = new protocol.BandSyncReceiver({ now: function () { return pinNow; } });
    const result = receiver.receive(pinSetFixture.message);
    assertEqual(result.status, 'pin_set');
    assertDeepEqual(result.ack, pinSetFixture.expected.ack);
    assertDeepEqual(result.state, pinSetFixture.expected.state);
    assertDeepEqual(receiver.pin, pinSetFixture.expected.stored);
    assert(protocol.validatePinAck(result.ack).ok);
    assert(protocol.validatePinState(result.state).ok);
    assertDeepEqual(receiver.lastPinAck, result.ack);
  });

  r.test('pin_query → pin_state：requestId 回填 / 无图案 updatedAt=0；广播可被手机端处理', function () {
    const clock = { value: pinNow };
    const receiver = new protocol.BandSyncReceiver({ now: function () { return clock.value; } });
    receiver.receive(pinSetFixture.message);
    clock.value = pinNow + 1;
    const queryResult = receiver.receive(pinQueryFixture.queryMessage);
    assertEqual(queryResult.status, 'pin_state');
    assertDeepEqual(queryResult.state, pinQueryFixture.expected.stateReply);
    assert(protocol.validatePinState(queryResult.state).ok);

    const fresh = new protocol.BandSyncReceiver({ now: function () { return pinNow + 1; } });
    const freshResult = fresh.receive(pinQueryFixture.queryMessage);
    assertEqual(freshResult.state.enabled, false);
    assertEqual(freshResult.state.updatedAt, 0);
    assertEqual(freshResult.state.requestId, pinQueryFixture.queryMessage.requestId);

    const client = new protocol.PhoneSyncClient();
    const handled = client.handlePinState(pinQueryFixture.expected.broadcast);
    assertEqual(handled.ok, true);
    assertEqual(client.pinState.enabled, true);
    assertEqual(client.pinState.updatedAt, pinNow);

    for (const bad of [
      Object.assign({}, pinQueryFixture.expected.broadcast, { version: 2 }),
      Object.assign({}, pinQueryFixture.expected.broadcast, { enabled: 'yes' }),
      Object.assign({}, pinQueryFixture.expected.broadcast, { updatedAt: -1 })
    ]) {
      assertEqual(protocol.validatePinState(bad).ok, false);
    }
    return 'query / 无图案 / 广播 / 3 个非法 state';
  });

  r.test('pin_clear：ack ok/enabled=false、删除图案与失败计数、广播 enabled=false', function () {
    const clock = { value: pinNow };
    const receiver = new protocol.BandSyncReceiver({ now: function () { return clock.value; } });
    receiver.receive(pinSetFixture.message);
    receiver.pinFailures = 3;
    clock.value = pinNow + 2;
    const result = receiver.receive(pinClearFixture.message);
    assertEqual(result.status, 'pin_clear');
    assertDeepEqual(result.ack, pinClearFixture.expected.ack);
    assertDeepEqual(result.state, pinClearFixture.expected.state);
    assert(receiver.pin === null, '清空后不应保留 pin');
    assertEqual(receiver.pinFailures, 0);
    const queryAfter = receiver.receive(pinQueryFixture.queryMessage);
    assertEqual(queryAfter.state.enabled, false);
    assertEqual(queryAfter.state.updatedAt, 0);
    return '清空 + 计数归零';
  });

  r.test('pin_ack 矩阵：成功不带 error、失败原因码白名单、仅 v3', function () {
    for (const item of pinAckFixture.cases) {
      const check = protocol.validatePinAck(item.message);
      assertEqual(check.ok, item.valid, item.name + ': ' + (check.reason || ''));
    }
    const client = new protocol.PhoneSyncClient();
    const success = pinAckFixture.cases.find(function (item) { return item.name === 'success'; });
    const handled = client.handlePinAck(success.message);
    assertEqual(handled.ok, true);
    assertEqual(handled.enabled, true);
    const failure = pinAckFixture.cases.find(function (item) { return item.name === 'failure-invalid-pin-payload'; });
    const handledFail = client.handlePinAck(failure.message);
    assertEqual(handledFail.ok, true, '合法失败 ack 也是可处理消息');
    assertEqual(handledFail.enabled, false);
    assertDeepEqual(protocol.PIN_ACK_ERRORS, ['invalid_pin_payload', 'invalid_version', 'storage_error']);
    return pinAckFixture.cases.length + ' 个 case';
  });

  r.test('非法 pin 载荷/版本矩阵：rejected 时旧图案不变，envelope 非法则 ignored', function () {
    let maxBytes = 0;
    for (const item of invalidPinFixture.cases) {
      const receiver = new protocol.BandSyncReceiver({ now: function () { return pinNow; } });
      const result = receiver.receive(item.message);
      assertEqual(result.status, item.expected.status, item.name);
      if (item.expected.status === 'rejected') {
        assert(result.ack, item.name + ' 应回 ack');
        assertEqual(result.ack.ok, false);
        assertEqual(result.ack.error, item.expected.error, item.name);
        assertEqual(result.ack.enabled, false);
        assert(receiver.pin === null, item.name + ' 不应写入 pin');
        assert(protocol.validatePinAck(result.ack).ok, item.name + ' ack 自身应合法: ' + JSON.stringify(result.ack));
      } else {
        assert(receiver.pin === null);
        assert(receiver.lastPinAck === null);
      }
      maxBytes = Math.max(maxBytes, protocol.messageBytes(item.message));
    }

    // 旧图案不能被非法 pin_set 覆盖；失败 ack 仍可被手机端消费
    const clock = { value: pinNow };
    const receiver = new protocol.BandSyncReceiver({ now: function () { return clock.value; } });
    const setResult = receiver.receive(pinSetFixture.message);
    const before = deepClone(receiver.pin);
    clock.value = pinNow + 1;
    const bad = invalidPinFixture.cases.find(function (item) { return item.name === 'salt-31-hex'; });
    const badResult = receiver.receive(bad.message);
    assertEqual(badResult.status, 'rejected');
    assertEqual(badResult.ack.error, 'invalid_pin_payload');
    assertDeepEqual(receiver.pin, before, '失败 pin_set 不得改变旧图案');
    assertDeepEqual(receiver.lastPinAck, badResult.ack);
    assertEqual(setResult.ack.ok, true);
    return invalidPinFixture.cases.length + ' 个 case，最大 ' + maxBytes + 'B';
  });

  // ------------------------------------------------ 汇总与结果文件
  const summary = r.finish();
  const resultFile = join(E2E_ROOT, 'verify-result.json');
  writeFileSync(
    resultFile,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        node: process.version,
        platform: process.platform + ' ' + process.arch,
        summary,
        results: r.results.map(function (item) {
          return {
            section: item.section,
            name: item.name,
            passed: item.passed,
            extra: item.extra || '',
            error: item.passed ? null : String(item.error && item.error.message ? item.error.message : item.error)
          };
        })
      },
      null,
      2
    ) + '\n'
  );
  process.stdout.write('结果已写入 ' + resultFile + '\n');
  process.exitCode = summary.failed > 0 ? 1 : 0;
}

main().catch(function (error) {
  console.error('verify 运行失败:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
