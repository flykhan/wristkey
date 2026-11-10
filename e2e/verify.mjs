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
// 退出码：0 全部通过；1 存在失败。

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

import { createRunner, assert, assertEqual, assertDeepEqual, assertThrows } from './lib/runner.mjs';
import { base32Encode, normalizeProtocolSecret } from './lib/encoding.mjs';
import { RFC6238_SEEDS, RFC6238_VECTORS, hotp, totp, totpAtSeconds } from './lib/totp.mjs';
import * as stratum from './lib/stratum.mjs';
import * as protocol from './lib/protocol.mjs';

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
    period: account.period
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
  r.test('映射统计 = 11 导入 / 11 跳过（共 22）', function () {
    assertEqual(mapped.stats.total, 22);
    assertEqual(mapped.stats.imported, 11);
    assertEqual(mapped.stats.skipped, 11);
    assertDeepEqual(mapped.stats, expected.stats);
  });
  r.test('映射结果与 expected-import.json 完全一致', function () {
    assertDeepEqual(mapped.accounts, expected.accounts);
    assertDeepEqual(mapped.skipped, expected.skipped);
  });
  r.test('覆盖矩阵：算法 / digits / period / 分类 / 跳过类型', function () {
    assertDeepEqual(manifest.coverage.algorithms, ['SHA1', 'SHA256', 'SHA512']);
    assertDeepEqual(manifest.coverage.digits, [6, 8, 10]);
    assertDeepEqual(manifest.coverage.periods, [15, 30, 60]);
    for (const category of ['开发', '个人', '云服务', '社交', '默认分类']) {
      assert(manifest.coverage.categories.indexOf(category) >= 0, '缺少分类 ' + category);
    }
    for (const code of [
      'TYPE_NOT_TOTP',
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
    assertEqual(typeCounts.TYPE_NOT_TOTP, 3, 'HOTP/Steam/Mobile-OTP 各 1 条');
  });
  r.test('每个导入账号 id = s_ + sha1(归一化 secret)[0:12]（独立复算）', function () {
    for (const account of expected.accounts) {
      const canonical = normalizeProtocolSecret(account.secret);
      const hex = createHash('sha1').update(canonical, 'utf8').digest('hex').slice(0, 12);
      assertEqual(account.id, 's_' + hex, 'account ' + account.issuer + ' id');
    }
    return expected.accounts.length + ' 个';
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
    // 云服务（Ranking=2）：企业VPN（binding 0）在 AWS（binding 1）之前
    assertDeepEqual(
      accounts.slice(6, 8).map(function (account) { return account.issuer; }),
      ['企业VPN', 'AWS']
    );
    // 社交（Ranking=3）：多分类的 GitHub 取 binding ranking 最小的社交
    assertEqual(accounts[8].issuer, 'GitHub');
    assertEqual(accounts[8].category, '社交', 'GitHub 多分类取 AuthenticatorCategory.Ranking 最小者');
    // 无分类 → 默认分类，最后，按 Authenticator.Ranking
    assertDeepEqual(
      accounts.slice(9).map(function (account) { return account.issuer; }),
      ['Cloudflare', '']
    );
    for (const account of accounts.slice(9)) {
      assertEqual(account.category, '默认分类');
    }
    return '11 条顺序符合规则';
  });
  r.test('明文备份条目结构符合 Stratum 规范', function () {
    assertEqual(plain.Authenticators.length, 22, 'Authenticators 条目数');
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
    return '22 条 Authenticator / ' + plain.AuthenticatorCategories.length + ' 条分类绑定';
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
    r.test('Python 夹具映射：3 导入 / 5 跳过，分类正确', function () {
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
      const codes = toolsMapped.skipped.map(function (item) { return item.code; }).sort();
      assertDeepEqual(codes, ['EMPTY_ISSUER_AND_USERNAME', 'INVALID_BASE32', 'PERIOD_OUT_OF_RANGE', 'TYPE_NOT_TOTP', 'TYPE_NOT_TOTP']);
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
      r.test('tools/src/stratum.mjs 与 e2e 对 Python 夹具映射一致（按 id）', function () {
        const theirs = toolsModule.mapStratumBackup(toolsPlain);
        assertDeepEqual(sortedAccountSet(theirs.accounts), sortedAccountSet(toolsMapped.accounts));
        assertEqual(theirs.skipped.length, toolsMapped.skipped.length);
      });
      r.test('tools/src/stratum.mjs 与 e2e 对 e2e 夹具映射一致（按 id）', function () {
        const theirs = toolsModule.mapStratumBackup(plain);
        assertDeepEqual(sortedAccountSet(theirs.accounts), sortedAccountSet(mapped.accounts));
        assertEqual(theirs.skipped.length, mapped.skipped.length);
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
  r.test('URI 列表：5 导入 / 2 跳过（HOTP + 非法 secret）', function () {
    assertEqual(parsedUris.stats.total, 7);
    assertEqual(parsedUris.stats.imported, 5);
    assertEqual(parsedUris.stats.skipped, 2);
    const codes = parsedUris.skipped.map(function (item) { return item.code; }).sort();
    assertDeepEqual(codes, ['INVALID_BASE32', 'TYPE_NOT_TOTP']);
  });
  r.test('URI 导入字段与明文映射一致（issuer/accountName/secret/algorithm/digits/period）', function () {
    const byId = accountSetById(expected.accounts);
    for (const account of parsedUris.accounts) {
      const plainAccount = byId.get(account.id);
      assert(plainAccount, 'URI 账号 ' + account.id + ' 应在明文映射中');
      assertDeepEqual(stripAccountForUriCompare(account), stripAccountForUriCompare(plainAccount));
      assertEqual(account.category, '默认分类', 'URI 列表无分类 → 默认分类');
    }
    return parsedUris.accounts.length + ' 个';
  });

  // ---------------------------------------------------- F. 合法协议会话
  r.section('F. 同步协议 v2 合法消息序列与状态机');
  const sessionFixture = readJson(join(FIXTURES, 'protocol', 'valid-session.json'));
  const sessionMessages = sessionFixture.messages;
  const expectedAccounts = expected.accounts;
  const accountMessages = sessionMessages.filter(function (message) {
    return message.type === protocol.MESSAGE_TYPES.ACCOUNT;
  });
  r.test('消息序列结构：1 begin + 11 account + 1 commit', function () {
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
      syncId: sessionFixture.syncId
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
    assertEqual(request.version, 2);
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
  r.test('未知 type/version 不破坏进行中的 staging', function () {
    const receiver = new protocol.BandSyncReceiver({ now: function () { return FIXED_NOW; } });
    const session = protocol.buildSyncSession([makeValidAccount()], { sentAt: FIXED_NOW, syncId: 's-keep' });
    assertEqual(receiver.receive(session.messages[0]).status, 'accepted');
    assertEqual(receiver.receive({ type: 'future_type', version: 2, sentAt: FIXED_NOW }).status, 'ignored');
    assertEqual(receiver.receive({ type: 'mfa_sync_account', version: 3, sentAt: FIXED_NOW }).status, 'ignored');
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
    r.test('band-app TOTP 模块导出 generateTotp/hotp 且可加载', function () {
      assertEqual(typeof bandTotp.generateTotp, 'function', '缺少 generateTotp');
      assertEqual(typeof bandTotp.hotp, 'function', '缺少 hotp');
      return bandTotpPath.replace(WORKSPACE + '/', '');
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
    r.test('band-app TOTP 对夹具全部账号逐一对拍（2 个时间点）', function () {
      const times = [stratum.FIXTURE_UPDATED_AT, stratum.FIXTURE_UPDATED_AT + 59000];
      let comparisons = 0;
      for (const account of expected.accounts) {
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
    r.test('band-app normalizeBase32 与 e2e 归一化一致（空格/=/小写）', function () {
      const normalized = bandTotp.normalizeBase32(' jbsw y3dp ehpk 3pxp= ');
      assert(normalized && normalized.ok, 'normalizeBase32 应成功');
      assertEqual(normalized.value, normalizeProtocolSecret(' jbsw y3dp ehpk 3pxp= '));
      assertEqual(normalized.value, 'JBSWY3DPEHPK3PXP');
    });
  } else {
    process.stdout.write('  NOTE band-app TOTP 模块不可用（不存在或加载失败），跳过跨端 TOTP 对拍\n');
  }

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
