#!/usr/bin/env node
// WristKey e2e — 夹具生成器（确定性：固定 salt/iv/时间戳，重复运行逐字节一致）。
//
//   node fixtures/generate.mjs          # 在 e2e/ 下执行：npm run fixtures
//
// 产物（e2e/fixtures/）：
//   plain-backup.json            明文 Stratum 备份（覆盖算法/digits/period/分类/排序/跳过项/边界/Steam）
//   expected-import.json         参考映射结果（协议 account + 跳过报告），供跨端对拍
//   strong.stratum               Strong 加密（Argon2id + AES-256-GCM），密码 test-password
//   legacy.stratum               Legacy 加密（PBKDF2-SHA1 + AES-256-CBC/PKCS7），密码 test-password
//   uri-list.txt                 otpauth:// 文本列表（含应跳过的 HOTP / 非法行）
//   protocol/valid-session.json  合法同步消息序列（begin → account×N → commit）
//   manifest.json                文件哈希、加密参数、覆盖矩阵（便于报告与复现）
//
// 所有 secret 均为公开测试值（RFC 6238 Appendix B 种子等），不得用于真实账号。

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { base32Encode } from '../lib/encoding.mjs';
import {
  ARGON2_PARAMS,
  FIXTURE_PASSWORD,
  FIXTURE_UPDATED_AT,
  LEGACY_HEADER,
  STRONG_HEADER,
  buildOtpAuthUri,
  encryptLegacy,
  encryptStrong,
  mapBackupToAccounts
} from '../lib/stratum.mjs';
import { mapBitwardenToAccounts } from '../lib/bitwarden.mjs';
import { RFC6238_SEEDS } from '../lib/totp.mjs';
import {
  PIN_ALGORITHM,
  PIN_ITERATIONS_DEFAULT,
  buildPinAck,
  buildPinClear,
  buildPinQuery,
  buildPinSet,
  buildPinState,
  buildSyncSession,
  derivePinHash
} from '../lib/protocol.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_SYNC_ID = 'sync-1760000000000-e2e';
const FIXTURE_SENT_AT = 1760000000000;

function b32(value, padded) {
  const encoded = base32Encode(Buffer.from(String(value), 'utf8'));
  return padded ? encoded : encoded.replace(/=+$/, '');
}

function categoryId(name) {
  return createHash('sha1').update(String(name), 'utf8').digest('hex').slice(0, 8);
}

/** 确定性字节流：sha256(label + ':' + counter) 串接。夹具专用，不是真实随机数。 */
function deterministicBytes(label, length) {
  const chunks = [];
  let total = 0;
  let counter = 0;
  while (total < length) {
    const chunk = createHash('sha256').update(label + ':' + counter, 'utf8').digest();
    chunks.push(chunk);
    total += chunk.length;
    counter += 1;
  }
  return Buffer.concat(chunks).subarray(0, length);
}

function makeSecret(label, length) {
  // 生成不重复的测试 secret；长度按 5 字节对齐，避免出现 '=' 填充（除专门的 padded 用例）。
  const raw = deterministicBytes('wristkey-test-secret:' + label, length);
  return base32Encode(raw).replace(/=+$/, '');
}

function buildBackup() {
  const categories = [
    { Id: categoryId('开发'), Name: '开发', Ranking: 0 },
    { Id: categoryId('个人'), Name: '个人', Ranking: 1 },
    { Id: categoryId('云服务'), Name: '云服务', Ranking: 2 },
    { Id: categoryId('社交'), Name: '社交', Ranking: 3 }
  ];
  const cat = {
    开发: categories[0].Id,
    个人: categories[1].Id,
    云服务: categories[2].Id,
    社交: categories[3].Id
  };

  const rfc = {
    SHA1: b32(RFC6238_SEEDS.SHA1),
    SHA256: b32(RFC6238_SEEDS.SHA256),
    SHA512: b32(RFC6238_SEEDS.SHA512)
  };

  const authenticator = (fields) => {
    return Object.assign(
      {
        Type: 2,
        Icon: null,
        Issuer: '',
        Username: null,
        Secret: '',
        Pin: null,
        Algorithm: 0,
        Digits: 6,
        Period: 30,
        Counter: 0,
        Ranking: 0,
        CopyCount: 0
      },
      fields
    );
  };

  const authenticators = [
    // ---- 可导入：RFC 6238 三个算法（8 位，30s）----
    authenticator({ Issuer: 'RFC6238', Username: 'sha1@test.invalid', Secret: rfc.SHA1, Algorithm: 0, Digits: 8, Period: 30, Ranking: 0 }),
    authenticator({ Issuer: 'RFC6238', Username: 'sha256@test.invalid', Secret: rfc.SHA256, Algorithm: 1, Digits: 8, Period: 30, Ranking: 1 }),
    authenticator({ Issuer: 'RFC6238', Username: 'sha512@test.invalid', Secret: rfc.SHA512, Algorithm: 2, Digits: 8, Period: 30, Ranking: 2 }),
    // ---- 可导入：多分类，取 AuthenticatorCategory.Ranking 最小者（社交）----
    authenticator({ Issuer: 'GitHub', Username: 'me@example.com', Secret: 'JBSWY3DPEHPK3PXP', Algorithm: 0, Digits: 6, Period: 30, Ranking: 3 }),
    // ---- 可导入：SHA256 / 6 位 / 60s，Username 为 null ----
    authenticator({ Issuer: 'AWS', Username: null, Secret: makeSecret('aws', 20), Algorithm: 1, Digits: 6, Period: 60, Ranking: 4 }),
    // ---- 可导入：SHA512 / 10 位 / 60s，Unicode issuer ----
    authenticator({ Issuer: '企业VPN', Username: 'admin', Secret: makeSecret('vpn', 60), Algorithm: 2, Digits: 10, Period: 60, Ranking: 5 }),
    // ---- 可导入：SHA1 / 6 位 / 15s，无分类 ----
    authenticator({ Issuer: 'Cloudflare', Username: 'user@example.com', Secret: 'MFRGGZDFMZTWQ2LK', Algorithm: 0, Digits: 6, Period: 15, Ranking: 6 }),
    // ---- 可导入：secret 带 '=' 填充（Stratum 允许），映射时归一化 ----
    authenticator({ Issuer: 'Padded', Username: 'padding@example.com', Secret: b32('padsecret', true), Algorithm: 0, Digits: 6, Period: 30, Ranking: 7 }),
    // ---- 可导入：Unicode issuer/username，SHA1 / 8 位 ----
    authenticator({ Issuer: '邮件', Username: '邮箱用户', Secret: makeSecret('email', 20), Algorithm: 0, Digits: 8, Period: 30, Ranking: 8 }),
    // ---- 可导入：issuer 为空、username 非空（允许）----
    authenticator({ Issuer: '', Username: 'no-issuer@example.com', Secret: makeSecret('no-issuer', 20), Algorithm: 0, Digits: 6, Period: 30, Ranking: 9 }),
    // ---- 可导入：username 为空、issuer 非空（允许）----
    authenticator({ Issuer: 'NoUsername', Username: null, Secret: makeSecret('no-username', 20), Algorithm: 0, Digits: 6, Period: 30, Ranking: 10 }),
    // ---- 应跳过：Type=1 HOTP ----
    authenticator({ Type: 1, Issuer: 'LegacyHOTP', Username: 'hotp-user', Secret: makeSecret('hotp', 20), Digits: 6, Period: 30, Counter: 7, Ranking: 11 }),
    // ---- 可导入：Type=4 Steam（issuer 为 Steam；SteamOtp 固定 5 位/30s/SHA1）----
    authenticator({ Type: 4, Issuer: 'Steam', Username: 'steamuser', Secret: makeSecret('steam', 20), Digits: 5, Period: 30, Ranking: 12 }),
    // ---- 可导入：Type=4 Steam 但 issuer≠Steam（如 Valve）----
    authenticator({ Type: 4, Issuer: 'Valve', Username: 'valveuser', Secret: makeSecret('valve-steam', 20), Digits: 5, Period: 30, Ranking: 13 }),
    // ---- 应跳过：Type=3 Mobile-OTP ----
    authenticator({ Type: 3, Issuer: 'MobileOTP', Username: 'mobile', Secret: makeSecret('mobile-otp', 20), Pin: '1234', Ranking: 13 }),
    // ---- 应跳过：非法 Base32 ----
    authenticator({ Issuer: 'BadBase32', Username: 'bad', Secret: 'INVALID1BASE32!!', Ranking: 14 }),
    // ---- 应跳过：空 secret ----
    authenticator({ Issuer: 'EmptySecret', Username: 'empty', Secret: '', Ranking: 15 }),
    // ---- 应跳过：period 越界（下/上）----
    authenticator({ Issuer: 'BadPeriodLow', Username: 'period', Secret: makeSecret('period-low', 20), Period: 4, Ranking: 16 }),
    authenticator({ Issuer: 'BadPeriodHigh', Username: 'period', Secret: makeSecret('period-high', 20), Period: 301, Ranking: 17 }),
    // ---- 应跳过：digits 越界（下/上）----
    authenticator({ Issuer: 'BadDigitsLow', Username: 'digits', Secret: makeSecret('digits-low', 20), Digits: 5, Ranking: 18 }),
    authenticator({ Issuer: 'BadDigitsHigh', Username: 'digits', Secret: makeSecret('digits-high', 20), Digits: 11, Ranking: 19 }),
    // ---- 应跳过：issuer 与 username 同时为空 ----
    authenticator({ Issuer: null, Username: null, Secret: makeSecret('no-label', 20), Ranking: 20 }),
    // ---- 应跳过：Algorithm 非法 ----
    authenticator({ Issuer: 'BadAlgorithm', Username: 'algo', Secret: makeSecret('bad-algorithm', 20), Algorithm: 7, Ranking: 21 })
  ];

  const links = [
    { CategoryId: cat.开发, AuthenticatorSecret: rfc.SHA1, Ranking: 0 },
    { CategoryId: cat.开发, AuthenticatorSecret: rfc.SHA256, Ranking: 1 },
    { CategoryId: cat.开发, AuthenticatorSecret: rfc.SHA512, Ranking: 2 },
    // GitHub 同时属于「社交」(Ranking 2) 与「云服务」(Ranking 7) → 取社交
    { CategoryId: cat.社交, AuthenticatorSecret: 'JBSWY3DPEHPK3PXP', Ranking: 2 },
    { CategoryId: cat.云服务, AuthenticatorSecret: 'JBSWY3DPEHPK3PXP', Ranking: 7 },
    { CategoryId: cat.云服务, AuthenticatorSecret: makeSecret('aws', 20), Ranking: 1 },
    { CategoryId: cat.云服务, AuthenticatorSecret: makeSecret('vpn', 60), Ranking: 0 },
    { CategoryId: cat.个人, AuthenticatorSecret: b32('padsecret', true), Ranking: 0 },
    { CategoryId: cat.个人, AuthenticatorSecret: makeSecret('email', 20), Ranking: 2 },
    { CategoryId: cat.个人, AuthenticatorSecret: makeSecret('no-username', 20), Ranking: 3 },
    { CategoryId: cat.社交, AuthenticatorSecret: makeSecret('steam', 20), Ranking: 3 },
    { CategoryId: cat.云服务, AuthenticatorSecret: makeSecret('valve-steam', 20), Ranking: 2 }
  ];

  return {
    Authenticators: authenticators,
    Categories: categories,
    AuthenticatorCategories: links,
    CustomIcons: []
  };
}

function buildBitwardenExport() {
  return {
    encrypted: false,
    folders: [
      { id: 'f-dev', name: '开发' },
      { id: 'f-social', name: '社交' }
    ],
    items: [
      // ---- 可导入：otpauth TOTP ----
      {
        id: 'bw-github', folderId: 'f-dev', type: 1, name: 'GitHub', notes: null, favorite: false,
        login: {
          uris: [{ match: null, uri: 'https://github.com' }],
          username: 'me@example.com',
          password: 'fake-password-github',
          totp: 'otpauth://totp/GitHub:me@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub'
        }
      },
      // ---- 可导入：SHA256 / 8 位 / 60s ----
      {
        id: 'bw-aws', folderId: null, type: 1, name: 'AWS', notes: null,
        login: {
          username: 'root',
          password: 'fake-password-aws',
          totp: 'otpauth://totp/AWS:root?secret=' + makeSecret('bw-aws', 32) + '&issuer=AWS&algorithm=SHA256&digits=8&period=60'
        }
      },
      // ---- 可导入：Steam（encoder=steam）----
      {
        id: 'bw-steam', folderId: 'f-social', type: 1, name: 'Steam', notes: null,
        login: {
          username: 'steamuser',
          password: 'fake-password-steam',
          totp: 'otpauth://totp/Steam:steamuser?secret=OJZ2BP7STWSLUD7I23Q5AYZELZB5OAFU&issuer=Steam&encoder=steam'
        }
      },
      // ---- 可导入：纯 Base32 secret（SHA1/6/30）----
      {
        id: 'bw-raw', folderId: null, type: 1, name: 'RawBase32', notes: null,
        login: { username: 'raw@test.invalid', password: 'fake-password-raw', totp: 'MFRGGZDFMZTWQ2LK' }
      },
      // ---- 可导入：name 为空 → issuer=Bitwarden；username 为空 → 取 otpauth label ----
      {
        id: 'bw-noname', folderId: null, type: 1, name: '   ', notes: null,
        login: {
          username: '   ',
          password: 'fake-password-noname',
          totp: 'otpauth://totp/NoName:noname@test.invalid?secret=' + makeSecret('bw-noname', 20) + '&issuer=NoName'
        }
      },
      // ---- 可导入：Unicode name + username 为空取 label ----
      {
        id: 'bw-email', folderId: 'f-dev', type: 1, name: '邮件', notes: null,
        login: {
          username: '',
          password: 'fake-password-email',
          totp: 'otpauth://totp/邮件:邮箱用户?secret=' + makeSecret('bw-email', 20) + '&issuer=邮件&digits=8'
        }
      },
      // ---- 跳过：普通密码条目（无 totp）----
      {
        id: 'bw-nototp', folderId: null, type: 1, name: 'PlainLogin', notes: null,
        login: { username: 'plain', password: 'fake-password-plain', totp: null }
      },
      // ---- 跳过：非登录条目（type=2），即使带 totp 也不导入 ----
      {
        id: 'bw-note', folderId: null, type: 2, name: 'SecureNote', notes: 'fake note', secureNote: { type: 0 },
        login: { username: '', password: null, totp: 'otpauth://totp/Note:note?secret=MFRGGZDFMZTWQ2LK&issuer=Note' }
      },
      // ---- 跳过：既不是 otpauth URI 也不是合法 Base32 ----
      {
        id: 'bw-badtotp', folderId: null, type: 1, name: 'BadTotp',
        login: { username: 'bad', password: 'fake-password-bad', totp: 'not-a-totp-or-base32!!' }
      },
      // ---- 跳过：HOTP otpauth（不支持）----
      {
        id: 'bw-baduri', folderId: null, type: 1, name: 'BadUri',
        login: { username: 'bad', password: 'fake-password-bad', totp: 'otpauth://hotp/LegacyHOTP:hotp?secret=MFRGGZDFMZTWQ2LK&counter=0' }
      }
    ]
  };
}

function buildBitwardenEncryptedExport() {
  // 加密导出负例：仅用于验证“识别并拒绝”，不含任何可解密内容。
  return {
    encrypted: true,
    passwordProtected: true,
    salt: 'wristkey-fixture-salt-base64==',
    kdfType: 0,
    kdfIterations: 600000,
    encKeyValidation_DO_NOT_EDIT: 'wristkey-fixture-enc-key-validation',
    data: '2.wristkey-fixture-encrypted-vault-data'
  };
}

// ---------------------------------------------------------------- 协议 v3 夹具

const V3_SYNC_ID = 'sync-1760000000000-v3';
const V3_SENT_AT = FIXTURE_SENT_AT;
const V3_PASSWORD_FIELD_COUNT = 3;

const PIN_PATTERN = 'TSCCT';
const PIN_SALT = deterministicBytes('wristkey-e2e-pin-salt', 16).toString('hex');
const PIN_ITERATIONS = PIN_ITERATIONS_DEFAULT;
const PIN_HASH = derivePinHash(PIN_PATTERN, PIN_SALT, PIN_ITERATIONS);
const PIN_NOW = FIXTURE_SENT_AT + 3000;

/** 给前 3 个映射账号加 password：空格、Unicode、显式空串（清空语义）。 */
function buildV3Accounts(mappedAccounts) {
  const passwords = ['correct horse battery staple', 'p@ssw0rd-测试-Ω', ''];
  return mappedAccounts.map(function (account, index) {
    const copy = Object.assign({}, account);
    if (index < passwords.length) {
      copy.password = passwords[index];
    }
    return copy;
  });
}

function buildPasswordMergeScenarios(mappedAccounts) {
  const first = mappedAccounts[0];
  const second = mappedAccounts[1];
  const third = mappedAccounts[2];
  const withPassword = function (account, password) {
    return Object.assign({}, account, { password });
  };

  const scenarios = [
    {
      name: 'v3-password-default-preserved',
      description: 'v3 账号缺省 password → 保留手环旧密码',
      version: 3,
      initialAccounts: [withPassword(first, 'old-pass-1')],
      incomingAccounts: [Object.assign({}, first)],
      expectedPasswords: ['old-pass-1']
    },
    {
      name: 'v3-password-empty-clears',
      description: 'v3 账号显式 password:"" → 清空旧密码',
      version: 3,
      initialAccounts: [withPassword(first, 'old-pass-1')],
      incomingAccounts: [withPassword(first, '')],
      expectedPasswords: [null]
    },
    {
      name: 'v3-password-new-value-overwrites',
      description: 'v3 账号非空 password → 覆盖旧密码',
      version: 3,
      initialAccounts: [withPassword(first, 'old-pass-1')],
      incomingAccounts: [withPassword(first, 'new-pass-2')],
      expectedPasswords: ['new-pass-2']
    },
    {
      name: 'v3-snapshot-mixed-merge',
      description: '同轮混合：缺省保留 / 空串清空 / 新账号无密码',
      version: 3,
      initialAccounts: [withPassword(first, 'old-pass-1'), withPassword(second, 'old-pass-2')],
      incomingAccounts: [Object.assign({}, first), withPassword(second, ''), Object.assign({}, third)],
      expectedPasswords: ['old-pass-1', null, null]
    }
  ];

  return scenarios.map(function (scenario, index) {
    const syncId = 'sync-1760000000000-merge-' + index;
    const session = buildSyncSession(scenario.incomingAccounts, {
      sentAt: FIXTURE_SENT_AT + 100 + index * 10,
      syncId,
      version: scenario.version
    });
    return {
      name: scenario.name,
      description: scenario.description,
      initialSnapshot: {
        version: 3,
        storageKey: 'mfa_snapshot_v3',
        updatedAt: FIXTURE_UPDATED_AT,
        accounts: scenario.initialAccounts
      },
      syncId,
      messages: session.messages,
      expected: {
        accountIds: scenario.incomingAccounts.map(function (account) { return account.id; }),
        passwords: scenario.expectedPasswords
      }
    };
  });
}

function buildV2CompatFixture(mappedAccounts) {
  const first = mappedAccounts[0];
  const second = mappedAccounts[1];
  const third = mappedAccounts[2];
  const initialAccounts = [
    Object.assign({}, first, { password: 'v2-old-1' }),
    Object.assign({}, second, { password: 'v2-old-2' })
  ];
  // 旧手机（v1.2/v2 协议）全量同步：不带 password 字段
  const incomingAccounts = [Object.assign({}, first), Object.assign({}, second), Object.assign({}, third)];
  const session = buildSyncSession(incomingAccounts, {
    sentAt: FIXTURE_SENT_AT + 500,
    syncId: 'sync-1760000000000-v2-compat',
    version: 2
  });
  return {
    description: 'v2 手机 → v3 手环：消息 version=2、无 password 字段；手环账号照常同步，旧密码按“缺省=保留”处理',
    initialSnapshot: {
      version: 3,
      storageKey: 'mfa_snapshot_v3',
      updatedAt: FIXTURE_UPDATED_AT,
      accounts: initialAccounts
    },
    syncId: session.syncId,
    messages: session.messages,
    expected: {
      snapshotVersion: 2,
      storageKey: 'mfa_snapshot_v3',
      accountCount: 3,
      passwords: ['v2-old-1', 'v2-old-2', null],
      ack: { type: 'mfa_sync_ack', version: 3, ok: true, received: 3, committed: 3, error: null },
      note: 'v2 无 password 字段，等价于缺省 → 保留旧密码；新账号无密码'
    }
  };
}

function buildPinMessages() {
  const setMessage = buildPinSet(
    { algorithm: PIN_ALGORITHM, salt: PIN_SALT, hash: PIN_HASH, iterations: PIN_ITERATIONS },
    { sentAt: PIN_NOW }
  );
  const queryMessage = buildPinQuery('pin-' + PIN_NOW, { sentAt: PIN_NOW + 1 });
  const clearMessage = buildPinClear({ sentAt: PIN_NOW + 2 });
  return { setMessage, queryMessage, clearMessage };
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

async function main() {
  const backup = buildBackup();
  const plainText = JSON.stringify(backup, null, 2) + '\n';
  const plainBuffer = Buffer.from(plainText, 'utf8');

  // 1) 明文备份 + 参考映射
  writeFileSync(join(HERE, 'plain-backup.json'), plainBuffer);
  const mapped = mapBackupToAccounts(backup, { updatedAt: FIXTURE_UPDATED_AT });
  if (mapped.stats.total !== 23 || mapped.stats.imported !== 13 || mapped.stats.skipped !== 10) {
    throw new Error('夹具条目数不符合预期：' + JSON.stringify(mapped.stats));
  }
  const expected = {
    source: 'plain-backup.json',
    note: '参考映射结果（e2e/lib/stratum.mjs mapBackupToAccounts）。排序规则见 e2e/README.md；文档未强制排序，跨端对拍请按 account.id 集合比较。',
    stats: mapped.stats,
    accounts: mapped.accounts,
    skipped: mapped.skipped
  };
  writeJson(join(HERE, 'expected-import.json'), expected);

  // 2) Strong / Legacy 加密夹具（固定 salt/iv，确定性）
  const strongSalt = deterministicBytes('wristkey-e2e-strong-salt', 16);
  const strongIv = deterministicBytes('wristkey-e2e-strong-iv', 12);
  const legacySalt = deterministicBytes('wristkey-e2e-legacy-salt', 20);
  const legacyIv = deterministicBytes('wristkey-e2e-legacy-iv', 16);
  const strong = await encryptStrong(plainText, FIXTURE_PASSWORD, strongSalt, strongIv);
  const legacy = encryptLegacy(plainText, FIXTURE_PASSWORD, legacySalt, legacyIv);
  writeFileSync(join(HERE, 'strong.stratum'), strong);
  writeFileSync(join(HERE, 'legacy.stratum'), legacy);

  // 3) URI 列表（含 2 条应跳过：HOTP、非法 secret）
  const byUsername = new Map();
  for (const account of mapped.accounts) {
    byUsername.set(account.issuer + '|' + account.accountName, account);
  }
  const uriAccounts = [
    byUsername.get('GitHub|me@example.com'),
    byUsername.get('企业VPN|admin'),
    byUsername.get('Cloudflare|user@example.com'),
    byUsername.get('RFC6238|sha1@test.invalid'),
    byUsername.get('RFC6238|sha256@test.invalid')
  ];
  for (const account of uriAccounts) {
    if (!account) {
      throw new Error('URI 列表取到了不存在的 account');
    }
  }
  const uriLines = uriAccounts.map(function (account) {
    return buildOtpAuthUri(account);
  });
  const steamSecret = makeSecret('steam', 20);
  const valveSteamSecret = makeSecret('valve-steam', 20);
  const aegisSteamSecret = makeSecret('aegis-steam', 20);
  // Steam 形式 1：issuer=Steam，无额外标记
  uriLines.push('otpauth://totp/Steam:steamuser?secret=' + steamSecret + '&issuer=Steam');
  // Steam 形式 2：非 Steam issuer + 裸 &steam 标记（Stratum 对 issuer≠Steam 的导出约定）
  uriLines.push('otpauth://totp/Valve:valveuser?secret=' + valveSteamSecret + '&issuer=Valve&steam');
  // Steam 形式 3：encoder=steam（Aegis 等实现约定），issuer 前缀不是 Steam
  uriLines.push('otpauth://totp/AegisSteamRepo:aegisuser?secret=' + aegisSteamSecret + '&issuer=AegisSteamRepo&encoder=steam');
  uriLines.push('otpauth://hotp/LegacyHOTP:hotp-user?secret=' + b32('hotp-uri-skip') + '&counter=7');
  uriLines.push('otpauth://totp/BadUri:bad?secret=NOT-BASE32!');
  writeFileSync(join(HERE, 'uri-list.txt'), uriLines.join('\n') + '\n', 'utf8');

  // 4) 协议 v2 合法会话（保留给旧手环/旧手机兼容回归）
  const session = buildSyncSession(mapped.accounts, {
    sentAt: FIXTURE_SENT_AT,
    syncId: FIXTURE_SYNC_ID,
    version: 2
  });
  writeJson(join(HERE, 'protocol', 'valid-session.json'), {
    description: '协议 v2 合法同步消息序列：begin → account×N → commit；account 来自 expected-import.json；无 password 字段',
    version: 2,
    syncId: session.syncId,
    messages: session.messages
  });

  // 4b) 协议 v3 夹具
  const v3Dir = join(HERE, 'protocol-v3');
  mkdirSync(v3Dir, { recursive: true });
  const v3Accounts = buildV3Accounts(mapped.accounts);
  const sessionV3 = buildSyncSession(v3Accounts, { sentAt: V3_SENT_AT, syncId: V3_SYNC_ID });
  writeJson(join(v3Dir, 'valid-session.json'), {
    description: '协议 v3 全量同步：13 账号；前 3 个账号分别携带空格密码 / Unicode 密码 / 显式空串（清空语义）',
    version: 3,
    syncId: sessionV3.syncId,
    messages: sessionV3.messages,
    expected: {
      accountCount: v3Accounts.length,
      passwordAccountCount: V3_PASSWORD_FIELD_COUNT,
      accounts: v3Accounts
    }
  });

  const mergeScenarios = buildPasswordMergeScenarios(mapped.accounts);
  writeJson(join(v3Dir, 'password-merge.json'), {
    description: 'v3 password 合并矩阵：缺省=保留旧值；""=清空；新值=覆盖；同一轮可混合',
    baseClock: FIXTURE_SENT_AT + 100,
    scenarios: mergeScenarios
  });

  const v2Compat = buildV2CompatFixture(mapped.accounts);
  writeJson(join(v3Dir, 'v2-compat-session.json'), v2Compat);

  const pinMessages = buildPinMessages();
  writeJson(join(v3Dir, 'pin-set.json'), {
    description: '合法 mfa_pin_set：PBKDF2-SHA256、salt 32 hex、hash 64 hex、iterations 10；手环 ack 成功并广播 enabled=true',
    pattern: PIN_PATTERN,
    pin: {
      algorithm: PIN_ALGORITHM,
      salt: PIN_SALT,
      hash: PIN_HASH,
      iterations: PIN_ITERATIONS
    },
    message: pinMessages.setMessage,
    expected: {
      ack: buildPinAck({ ok: true, enabled: true, error: null, now: PIN_NOW }),
      state: buildPinState({ enabled: true, updatedAt: PIN_NOW, now: PIN_NOW }),
      stored: {
        algorithm: PIN_ALGORITHM,
        salt: PIN_SALT,
        hash: PIN_HASH,
        iterations: PIN_ITERATIONS,
        updatedAt: PIN_NOW
      }
    }
  });

  const pinAckCases = [
    { name: 'success', valid: true, message: buildPinAck({ ok: true, enabled: true, error: null, now: PIN_NOW }) },
    { name: 'failure-invalid-pin-payload', valid: true, message: buildPinAck({ ok: false, enabled: false, error: 'invalid_pin_payload', now: PIN_NOW }) },
    { name: 'failure-invalid-version', valid: true, message: buildPinAck({ ok: false, enabled: false, error: 'invalid_version', now: PIN_NOW }) },
    { name: 'failure-storage-error', valid: true, message: buildPinAck({ ok: false, enabled: true, error: 'storage_error', now: PIN_NOW }) },
    { name: 'invalid-success-with-error', valid: false, message: buildPinAck({ ok: true, enabled: true, error: 'storage_error', now: PIN_NOW }) },
    { name: 'invalid-failure-without-error', valid: false, message: buildPinAck({ ok: false, enabled: false, error: null, now: PIN_NOW }) },
    { name: 'invalid-version-2', valid: false, message: {
      type: 'mfa_pin_ack', version: 2, sentAt: PIN_NOW, ok: true, enabled: true, error: null
    } },
    { name: 'invalid-enabled-type', valid: false, message: {
      type: 'mfa_pin_ack', version: 3, sentAt: PIN_NOW, ok: true, enabled: 'true', error: null
    } },
    { name: 'invalid-error-code', valid: false, message: buildPinAck({ ok: false, enabled: false, error: 'invalid_pin', now: PIN_NOW }) },
    { name: 'invalid-missing-sentAt', valid: false, message: {
      type: 'mfa_pin_ack', version: 3, ok: true, enabled: true, error: null
    } }
  ];
  writeJson(join(v3Dir, 'pin-ack.json'), {
    description: 'mfa_pin_ack 合法/非法矩阵：成功不得带 error；失败必须在原因码白名单内；仅 v3',
    cases: pinAckCases
  });

  writeJson(join(v3Dir, 'pin-query-state.json'), {
    description: 'mfa_pin_query → mfa_pin_state(enabled=true, updatedAt=设置时刻, requestId 回填)；另含手环主动广播样例（无 requestId）',
    setupMessage: pinMessages.setMessage,
    queryMessage: pinMessages.queryMessage,
    expected: {
      stateReply: buildPinState({ enabled: true, updatedAt: PIN_NOW, requestId: pinMessages.queryMessage.requestId, now: PIN_NOW + 1 }),
      broadcast: buildPinState({ enabled: true, updatedAt: PIN_NOW, now: PIN_NOW + 2 })
    }
  });

  writeJson(join(v3Dir, 'pin-clear.json'), {
    description: 'mfa_pin_clear：删除图案、失败计数归零；ack ok=true/enabled=false；广播 enabled=false',
    message: pinMessages.clearMessage,
    expected: {
      ack: buildPinAck({ ok: true, enabled: false, error: null, now: PIN_NOW + 2 }),
      state: buildPinState({ enabled: false, updatedAt: PIN_NOW + 2, now: PIN_NOW + 2 })
    }
  });

  const validPinPayload = {
    algorithm: PIN_ALGORITHM,
    salt: PIN_SALT,
    hash: PIN_HASH,
    iterations: PIN_ITERATIONS
  };
  const rawPinSet = function (pin, version) {
    return {
      type: 'mfa_pin_set',
      version: version == null ? 3 : version,
      sentAt: PIN_NOW,
      pin
    };
  };
  const invalidPinCases = [
    { name: 'missing-pin', expected: { status: 'rejected', error: 'invalid_pin_payload' }, message: {
      type: 'mfa_pin_set', version: 3, sentAt: PIN_NOW
    } },
    { name: 'pin-not-object', expected: { status: 'rejected', error: 'invalid_pin_payload' }, message: {
      type: 'mfa_pin_set', version: 3, sentAt: PIN_NOW, pin: PIN_HASH
    } },
    { name: 'pin-null', expected: { status: 'rejected', error: 'invalid_pin_payload' }, message: {
      type: 'mfa_pin_set', version: 3, sentAt: PIN_NOW, pin: null
    } },
    { name: 'algorithm-unsupported', expected: { status: 'rejected', error: 'invalid_pin_payload' }, message: rawPinSet(
      Object.assign({}, validPinPayload, { algorithm: 'PBKDF2-SHA1' })) },
    { name: 'salt-31-hex', expected: { status: 'rejected', error: 'invalid_pin_payload' }, message: rawPinSet(
      Object.assign({}, validPinPayload, { salt: PIN_SALT.slice(1) })) },
    { name: 'salt-uppercase', expected: { status: 'rejected', error: 'invalid_pin_payload' }, message: rawPinSet(
      Object.assign({}, validPinPayload, { salt: PIN_SALT.toUpperCase() })) },
    { name: 'hash-63-hex', expected: { status: 'rejected', error: 'invalid_pin_payload' }, message: rawPinSet(
      Object.assign({}, validPinPayload, { hash: PIN_HASH.slice(1) })) },
    { name: 'hash-uppercase', expected: { status: 'rejected', error: 'invalid_pin_payload' }, message: rawPinSet(
      Object.assign({}, validPinPayload, { hash: PIN_HASH.toUpperCase() })) },
    { name: 'hash-non-hex', expected: { status: 'rejected', error: 'invalid_pin_payload' }, message: rawPinSet(
      Object.assign({}, validPinPayload, { hash: 'g'.repeat(64) })) },
    { name: 'iterations-0', expected: { status: 'rejected', error: 'invalid_pin_payload' }, message: rawPinSet(
      Object.assign({}, validPinPayload, { iterations: 0 })) },
    { name: 'iterations-20001', expected: { status: 'rejected', error: 'invalid_pin_payload' }, message: rawPinSet(
      Object.assign({}, validPinPayload, { iterations: 20001 })) },
    { name: 'iterations-fraction', expected: { status: 'rejected', error: 'invalid_pin_payload' }, message: rawPinSet(
      Object.assign({}, validPinPayload, { iterations: 10.5 })) },
    { name: 'version-2-set', expected: { status: 'rejected', error: 'invalid_version' }, message: rawPinSet(validPinPayload, 2) },
    { name: 'version-2-query', expected: { status: 'rejected', error: 'invalid_version' }, message: {
      type: 'mfa_pin_query', version: 2, sentAt: PIN_NOW, requestId: 'legacy-query'
    } },
    { name: 'version-2-clear', expected: { status: 'rejected', error: 'invalid_version' }, message: {
      type: 'mfa_pin_clear', version: 2, sentAt: PIN_NOW
    } },
    { name: 'missing-sentAt', expected: { status: 'ignored' }, message: {
      type: 'mfa_pin_set', version: 3, pin: validPinPayload
    } },
    { name: 'pin-query-missing-requestId', expected: { status: 'ignored' }, message: {
      type: 'mfa_pin_query', version: 3, sentAt: PIN_NOW
    } }
  ];
  writeJson(join(v3Dir, 'invalid-pin.json'), {
    description: '非法 pin 载荷/版本矩阵：除 envelope 非法（status=ignored）外，pin_set 失败统一 ack invalid_pin_payload，旧图案不变；pin 消息仅 v3',
    cases: invalidPinCases
  });

  // 5) Bitwarden 未加密 Vault 夹具（含加密导出负例）
  const bitwardenExport = buildBitwardenExport();
  writeJson(join(HERE, 'bitwarden-export.json'), bitwardenExport);
  writeJson(join(HERE, 'bitwarden-encrypted-export.json'), buildBitwardenEncryptedExport());
  const bitwardenMapped = mapBitwardenToAccounts(bitwardenExport, { updatedAt: FIXTURE_UPDATED_AT });
  if (bitwardenMapped.stats.total !== 10 || bitwardenMapped.stats.imported !== 6 || bitwardenMapped.stats.skipped !== 4) {
    throw new Error('Bitwarden 夹具条目数不符合预期：' + JSON.stringify(bitwardenMapped.stats));
  }
  writeJson(join(HERE, 'bitwarden-expected-import.json'), {
    source: 'bitwarden-export.json',
    note: '参考映射结果（e2e/lib/bitwarden.mjs mapBitwardenToAccounts，依据 docs/bitwarden-format.md）',
    stats: bitwardenMapped.stats,
    accounts: bitwardenMapped.accounts,
    skipped: bitwardenMapped.skipped
  });

  // 6) manifest
  const files = [
    'plain-backup.json',
    'expected-import.json',
    'strong.stratum',
    'legacy.stratum',
    'uri-list.txt',
    'protocol/valid-session.json',
    'protocol-v3/valid-session.json',
    'protocol-v3/password-merge.json',
    'protocol-v3/v2-compat-session.json',
    'protocol-v3/pin-set.json',
    'protocol-v3/pin-ack.json',
    'protocol-v3/pin-query-state.json',
    'protocol-v3/pin-clear.json',
    'protocol-v3/invalid-pin.json',
    'bitwarden-export.json',
    'bitwarden-encrypted-export.json',
    'bitwarden-expected-import.json'
  ];
  const manifestFiles = files.map(function (name) {
    const buffer = readFileSync(join(HERE, name));
    return { name, bytes: buffer.length, sha256: sha256(buffer) };
  });
  const coverage = {
    algorithms: Array.from(new Set(mapped.accounts.map(function (account) { return account.algorithm; }))).sort(),
    digits: Array.from(new Set(mapped.accounts.map(function (account) { return account.digits; }))).sort(function (a, b) { return a - b; }),
    periods: Array.from(new Set(mapped.accounts.map(function (account) { return account.period; }))).sort(function (a, b) { return a - b; }),
    categories: Array.from(new Set(mapped.accounts.map(function (account) { return account.category; }))),
    otpTypes: Array.from(new Set(mapped.accounts.map(function (account) { return account.otpType; }))).sort(),
    skippedCodes: mapped.skipped.map(function (item) { return item.code; })
  };
  coverage.protocolV3 = {
    validSession: {
      version: 3,
      accountCount: v3Accounts.length,
      passwordAccountCount: V3_PASSWORD_FIELD_COUNT,
      syncId: sessionV3.syncId
    },
    passwordMergeScenarios: mergeScenarios.length,
    v2Compat: {
      accountCount: v2Compat.expected.accountCount,
      snapshotVersion: v2Compat.expected.snapshotVersion
    },
    pin: {
      pattern: PIN_PATTERN,
      algorithm: PIN_ALGORITHM,
      iterations: PIN_ITERATIONS,
      saltHex: PIN_SALT,
      storageKey: 'wristkey_pin_v1',
      setMessageBytes: Buffer.byteLength(JSON.stringify(pinMessages.setMessage), 'utf8'),
      invalidCases: invalidPinCases.length,
      ackCases: pinAckCases.length
    }
  };
  writeJson(join(HERE, 'manifest.json'), {
    generator: 'e2e/fixtures/generate.mjs',
    formatSpec: 'docs/stratum-format.md + docs/bitwarden-format.md + research/stratum/doc/BACKUP_FORMAT.md',
    deterministic: true,
    password: FIXTURE_PASSWORD,
    updatedAt: FIXTURE_UPDATED_AT,
    encryption: {
      strong: {
        header: STRONG_HEADER.toString('ascii'),
        layout: 'header16 + salt16 + iv12 + ciphertext + tag16',
        keyDerivation: { algorithm: 'Argon2id', parallelism: ARGON2_PARAMS.parallelism, memorySizeKiB: ARGON2_PARAMS.memorySize, iterations: ARGON2_PARAMS.iterations, outputBytes: ARGON2_PARAMS.hashLength },
        cipher: 'AES-256-GCM (no AAD, tag 16)',
        saltHex: strongSalt.toString('hex'),
        ivHex: strongIv.toString('hex')
      },
      legacy: {
        header: LEGACY_HEADER.toString('ascii'),
        layout: 'header16 + salt20 + iv16 + ciphertext',
        keyDerivation: { algorithm: 'PBKDF2-HMAC-SHA1', iterations: 64000, outputBytes: 32 },
        cipher: 'AES-256-CBC + PKCS#7',
        saltHex: legacySalt.toString('hex'),
        ivHex: legacyIv.toString('hex')
      }
    },
    expected: mapped.stats,
    bitwarden: {
      source: 'bitwarden-export.json',
      encryptedNegative: 'bitwarden-encrypted-export.json',
      expected: bitwardenMapped.stats,
      skippedCodes: bitwardenMapped.skipped.map(function (item) { return item.code; })
    },
    coverage,
    files: manifestFiles
  });

  console.log('夹具已生成：' + HERE);
  console.log('  明文 ' + plainBuffer.length + ' bytes，映射 ' + mapped.stats.imported + ' 导入 / ' + mapped.stats.skipped + ' 跳过');
  console.log('  strong ' + strong.length + ' bytes，legacy ' + legacy.length + ' bytes，uri ' + uriLines.length + ' 行');
  console.log('  协议 v2 消息 ' + session.messages.length + ' 条（syncId=' + session.syncId + '）');
  console.log('  协议 v3 消息 ' + sessionV3.messages.length + ' 条（syncId=' + sessionV3.syncId + '），密码合并场景 ' + mergeScenarios.length + ' 个');
  console.log('  pin 夹具：set/query/clear + ' + pinAckCases.length + ' 个 ack case + ' + invalidPinCases.length + ' 个非法 payload case');
  console.log('  Bitwarden 条目 ' + bitwardenMapped.stats.total + ' 条，映射 ' + bitwardenMapped.stats.imported + ' 导入 / ' + bitwardenMapped.stats.skipped + ' 跳过（含加密导出负例）');
}

main().catch(function (error) {
  console.error('生成失败:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
