# WristKey e2e — 测试夹具与验证框架

本目录只包含**测试/验证**用途的代码与夹具，不进入手环 .rpk 或手机 APK 发布产物。
覆盖两件事：

1. **夹具**：明文 Stratum 备份、Strong/Legacy 加密备份、otpauth:// URI 列表、
   同步协议 v2 消息序列与非法/边界用例；
2. **验证**：Node 端 verify.mjs（RFC 向量、解密、映射、协议状态机、跨实现对拍）、
   Python 端独立解密验证、构建产物（.rpk / APK）与签名一致性检查。

> 所有 secret 均为**公开测试值**（RFC 6238 Appendix B 种子、GitHub 官方示例 secret 等）。
> 禁止把真实 TOTP secret 写入本目录或任何测试文件。

## 目录

~~~
e2e/
├── package.json                 私有 ESM 包（devDependency: hash-wasm）
├── verify.mjs                   主验证入口（退出码 0/1）
├── check-build.mjs              构建产物 + 签名一致性检查
├── lib/
│   ├── encoding.mjs             Base32 编解码/归一化
│   ├── totp.mjs                 独立 TOTP/HOTP 实现（node:crypto）+ RFC 向量表
│   ├── stratum.mjs              Stratum 格式参考实现（嗅探/加解密/映射/URI）
│   ├── protocol.mjs             协议 v2 参考实现（手环接收状态机 + 手机端状态机）
│   └── runner.mjs               PASS/FAIL 运行器与断言
├── fixtures/
│   ├── generate.mjs             确定性夹具生成器（固定 salt/iv/时间戳）
│   ├── plain-backup.json        明文 Stratum 备份（11 导入 + 11 跳过）
│   ├── expected-import.json     参考映射结果（协议 account + 跳过报告）
│   ├── strong.stratum           Strong 加密夹具（密码 test-password）
│   ├── legacy.stratum           Legacy 加密夹具（密码 test-password）
│   ├── uri-list.txt             otpauth:// 列表（5 导入 + 2 跳过）
│   ├── manifest.json            文件哈希、加密参数、覆盖矩阵
│   └── protocol/
│       ├── valid-session.json   合法同步消息序列（1 begin + 11 account + 1 commit）
│       └── invalid-cases.json   19 个非法/边界用例与期望
├── python/
│   ├── verify_fixtures.py       Python 独立解密 + RFC 向量验证
│   └── requirements.txt
└── verify-result.json           最近一次 verify 的结果（自动生成）
~~~

## 快速开始

~~~bash
cd e2e
npm install

# 1) 重新生成夹具（确定性，重复运行逐字节一致）
npm run fixtures

# 2) Node 端验证（RFC 向量 / 解密 / 映射 / 协议 / 跨实现）
npm run verify

# 3) Python 独立验证（第三方语言实现；建议 venv）
python3 -m venv .venv
.venv/bin/pip install -r python/requirements.txt
.venv/bin/python python/verify_fixtures.py

# 4) 构建产物与签名一致性（等 band-app/android-app 构建后）
node check-build.mjs                 # 静态检查
node check-build.mjs --with-tests    # + band npm test / android gradle test
node check-build.mjs --build         # + band release / android assembleDebug
~~~

npm run verify 退出码 0 = 全部通过、1 = 有失败；结果同时写入 verify-result.json。

## 夹具覆盖矩阵

plain-backup.json 共 22 条 Authenticator：**11 条可导入 + 11 条应跳过**。

| 类别 | 覆盖 |
| --- | --- |
| 算法 | SHA1 / SHA256 / SHA512（Algorithm 0/1/2） |
| digits | 6 / 8 / 10 |
| period | 15 / 30 / 60（协议边界 5–300） |
| 分类 | 4 个分类 + 默认分类；多分类取 AuthenticatorCategory.Ranking 最小者 |
| 排序 | Ranking 与分类内 Ranking 混合；无分类排最后 |
| 边界 | secret 带 = 填充、Unicode issuer/username、issuer 空、username 空 |
| 跳过 | Type=1 HOTP、Type=4 Steam、Type=3 Mobile-OTP、非法 Base32、空 secret、period=4/301、digits=5/11、issuer+username 全空、Algorithm=7 |

跳过的条目在 expected-import.json 的 skipped 数组中逐条给出
{stratumIndex, issuer, username, code, reason}（**不含 secret**）。
code 取值：TYPE_NOT_TOTP、INVALID_BASE32、EMPTY_SECRET、PERIOD_OUT_OF_RANGE、
DIGITS_OUT_OF_RANGE、EMPTY_ISSUER_AND_USERNAME、INVALID_ALGORITHM。

> 3 个 RFC6238 账号的 secret 就是 RFC 6238 Appendix B 的公开种子（Base32 编码），
> 因此可以直接用 RFC 表验证手环端/手机端 TOTP 实现。

## 加密夹具参数（严格对齐 docs/stratum-format.md）

| 形态 | 布局 | 密钥派生 | 加密 |
| --- | --- | --- | --- |
| Strong | AUTHENTICATORPRO(16) + salt(16) + iv(12) + 密文 + tag(16) | Argon2id，p=4，m=65536 KiB，t=3，输出 32B | AES-256-GCM，无 AAD |
| Legacy | AuthenticatorPro(16) + salt(20) + iv(16) + 密文 | PBKDF2-HMAC-SHA1，64000 次，输出 32B | AES-256-CBC + PKCS#7 |

密码均为 test-password；salt/iv 由固定标签的 SHA-256 派生（确定性，便于 git diff 与复现），
具体十六进制值记录在 fixtures/manifest.json。明文载荷与 plain-backup.json **逐字节相同**。

## 协议夹具

- protocol/valid-session.json：mfa_sync_begin → mfa_sync_account × 11 → mfa_sync_commit，
  syncId=sync-1760000000000-e2e，单条消息最大约 400B（< 1KB 限制）。
- protocol/invalid-cases.json：19 个手环端接收状态机用例，逐条声明期望：
  版本 1/未知 type 忽略、非法 JSON、v1 快照忽略、空标签/非法字段/超长 id/字符串 digits 丢弃、
  commit 条数/syncId 不匹配、无 staging、重复 id 去重、缺省 id 兜底、缺省字段归一化、
  新 begin 丢弃旧 staging、空同步清空、120s staging 超时。
  每个用例给出 expect.results（逐条状态）、finalSnapshot（不变/账号数）、lastAck 等断言。

## verify.mjs 覆盖（A–I）

| 节 | 内容 |
| --- | --- |
| A | RFC 6238 三种算法 × 6 个时间点 + RFC 4226 HOTP 10 向量 + digits 长度 |
| B | 文件哈希可复现、覆盖矩阵、映射结果与 expected-import.json 一致、id 独立复算、分类 Id、排序规则、跳过报告不含 secret |
| C | Strong/Legacy 解密 == 明文、错误密码/错误头部/截断拒绝、同 salt/iv 再加密逐字节一致 |
| D | **跨实现**：Python 夹具（tools/fixtures）解密、固定 salt/iv 再加密逐字节一致、映射 3/5 与分类、URI 列表、与 tools/src/stratum.mjs 双向对拍 |
| E | URI 列表 5 导入 / 2 跳过，字段与明文映射一致（无分类 → 默认分类） |
| F | 合法会话：信封/大小/索引/同步号、手环端回放提交、ack、手机端状态机、request |
| G | 字段边界：最大字段消息 < 1KB、13 类非法 account 丢弃、未知字段忽略、小写算法容忍 |
| H | 回放 invalid-cases.json 的 19 个用例 |
| I | **跨端 TOTP**：band-app 纯模块 vs 独立实现（RFC 向量、HOTP、3×5×5×5 矩阵、夹具全部账号） |

## 交叉验证证据（双向、非自证）

1. **e2e 加密夹具 → Python 独立解密**：python/verify_fixtures.py 用 argon2-cffi + cryptography
   按文档实现解密，结果与明文语义一致；
2. **e2e 加密夹具 → Stratum 官方工具**：research/stratum/extra/decrypt_backup.py（GPL-3.0，
   仅离线校验、不参与发布）可解密 strong.stratum / legacy.stratum；
3. **tools/fixtures（Python 生成）→ e2e Node 解密**：双向一致；
4. **e2e 加密逻辑 → tools/src/stratum.mjs 解密**：e2e 生成的密文可被另一套 Node 实现还原；
5. **固定 salt/iv 再加密**：用 tools 夹具的固定 salt/iv 重新加密其明文，与 Python 产物**逐字节一致**，
   证明参数/填充/序列化完全对齐；
6. **映射对拍**：e2e 与 tools/src/stratum.mjs 对同一备份按 id 集合完全一致。

## 构建产物检查（check-build.mjs）

判定项：

- band-app/dist/*.rpk 存在，manifest.package == dev.wristkey.app、name == 腕证、
  deviceTypeList 含 watch、features 含 system.router/system.storage/system.interconnect；
- Android APK 存在，包名 dev.wristkey.app、应用名 腕证；
- APK 签名证书 SHA-256 == signing/rpk-sign/certificate.pem；
- .rpk 字节流内嵌同一证书 DER（aiot-toolkit 签名块）；
- 三者指纹一致，并可选择调用团队统一的 scripts/check-signing.sh；
- 结果写入 ../reports/e2e-build-result.json，退出码 0 = 无 FAIL（SKIP 可接受）。

## 协议/格式的参考选择（文档未明确规定处）

以下选择不影响互通时，跨端实现应保持一致；已同步给 Lead：

1. **account.id 计算**：s_ + sha1(归一化 secret) 前 12 位十六进制；
   归一化 = 大写、去空白、去 -、去 =（与 tools/src/stratum.mjs 一致）。
   文档未说明 = 填充如何处理，建议在 docs/stratum-format.md 中明确。
2. **快照排序**：文档仅说“按排序输出”。参考实现规则：分类间按 Category.Ranking，
   分类内按 AuthenticatorCategories.Ranking，无分类归入「默认分类」并排最后，
   同键按 Authenticator.Ranking、secret 决定。跨端对拍建议**按 id 集合**而不是数组顺序。
3. **非法 begin**：文档只规定“收到 begin 即清空 staging”。参考实现：缺 syncId/accountCount
   的非法 begin 忽略，**保留**旧 staging。
4. **account 单个字段非法**：丢弃整条 account 并计入错误（依据“非法消息直接丢弃，不中断同步”）。
5. **URI 列表**：不含分类信息，映射后一律 默认分类。
6. **algorithm 大小写**：手环端参考实现对 sha1 等小写容忍并归一化为大写。

## 安全与许可

- e2e 代码为本项目独立实现；research/ 下参考项目只读，官方解密工具仅用于离线校验；
- 夹具 secret 均为公开测试值，禁止替换为真实凭证；
- plain-backup.json 是测试备份，不要导入真实账号环境。
