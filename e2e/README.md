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
│   ├── bitwarden.mjs            Bitwarden 未加密 Vault JSON 参考解析/映射
│   └── runner.mjs               PASS/FAIL 运行器与断言
├── fixtures/
│   ├── generate.mjs             确定性夹具生成器（固定 salt/iv/时间戳）
│   ├── plain-backup.json        明文 Stratum 备份（13 导入 + 10 跳过，含 Steam）
│   ├── expected-import.json     参考映射结果（协议 account + 跳过报告）
│   ├── strong.stratum           Strong 加密夹具（密码 test-password）
│   ├── legacy.stratum           Legacy 加密夹具（密码 test-password）
│   ├── uri-list.txt             otpauth:// 列表（8 导入 + 2 跳过，含 3 种 Steam 形式）
│   ├── bitwarden-export.json    Bitwarden 未加密 Vault 夹具（10 item → 6 导入 + 4 跳过）
│   ├── bitwarden-encrypted-export.json  加密导出负例（识别并拒绝）
│   ├── bitwarden-expected-import.json   参考映射结果（供 Android 单测对拍）
│   ├── manifest.json            文件哈希、加密参数、覆盖矩阵
│   └── protocol/
│       ├── valid-session.json   合法同步消息序列（1 begin + 13 account + 1 commit）
│       └── invalid-cases.json   25 个非法/边界用例与期望
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
node check-build.mjs --build --with-tests   # 终验：重建 rpk/APK + 双端单测 + 全量检查
node check-build.mjs --build         # + band release / android assembleRelease
~~~

npm run verify 退出码 0 = 全部通过、1 = 有失败；结果同时写入 verify-result.json。

## 夹具覆盖矩阵

plain-backup.json 共 23 条 Authenticator：**13 条可导入 + 10 条应跳过**。

| 类别 | 覆盖 |
| --- | --- |
| 算法 | SHA1 / SHA256 / SHA512（Algorithm 0/1/2） |
| digits | 5（Steam）/ 6 / 8 / 10 |
| period | 15 / 30 / 60（协议边界 5–300） |
| otpType | totp / steam（Type=4，含 issuer≠Steam 的 Steam 账号） |
| 分类 | 4 个分类 + 默认分类；多分类取 AuthenticatorCategory.Ranking 最小者 |
| 排序 | Ranking 与分类内 Ranking 混合；无分类排最后 |
| 边界 | secret 带 = 填充、Unicode issuer/username、issuer 空、username 空 |
| 跳过 | Type=1 HOTP、Type=3 Mobile-OTP、非法 Base32、空 secret、period=4/301、digits=5/11（TOTP）、issuer+username 全空、Algorithm=7 |

跳过的条目在 expected-import.json 的 skipped 数组中逐条给出
{stratumIndex, issuer, username, code, reason}（**不含 secret**）。
code 取值：UNSUPPORTED_OTP_TYPE（HOTP/Mobile-OTP）、INVALID_BASE32、EMPTY_SECRET、
PERIOD_OUT_OF_RANGE、DIGITS_OUT_OF_RANGE、EMPTY_ISSUER_AND_USERNAME、INVALID_ALGORITHM。

### Steam Guard（otpType=steam）

- Stratum `Type=4` 映射为 `otpType="steam"`，固定 `digits=5`、`period=30`、`algorithm=SHA1`
  （忽略备份里的 Digits/Period/Algorithm）；
- 码为 5 位字母数字（字母表 23456789BCDFGHJKMNPQRTVWXY），不是 10 的幂取模；
- 公开向量（secret OJZ2BP7STWSLUD7I23Q5AYZELZB5OAFU）：T=59→3DP36、1111111109→GX57J、
  1111111111→TCJ4Y、1234567890→VYNVB、1640846388→2Y4TM、1735689600→DQ5KF；
- URI 三种识别形式：issuer/label 前缀 Steam、非 Steam issuer 的裸 `&steam` 标记、`encoder=steam`；
- 夹具含 2 个备份 Steam 账号（issuer=Steam / issuer=Valve）与 3 个 URI 形式，secret 均独立。

> tools/fixtures 的旧 Python 夹具中 Steam 与 GitHub **共用 secret**，按 Stratum 主键规则会
> 被 DUPLICATE_SECRET 跳过（已知 3 导入/5 跳过），Steam 正向用例以 e2e/fixtures 为准。

> 3 个 RFC6238 账号的 secret 就是 RFC 6238 Appendix B 的公开种子（Base32 编码），
> 因此可以直接用 RFC 表验证手环端/手机端 TOTP 实现。

## Bitwarden 未加密 Vault 夹具（docs/bitwarden-format.md）

- bitwarden-export.json：10 个 item → **6 导入 + 4 跳过**（确定性、密码字段为 fake-* 占位）；
  - 导入：otpauth TOTP（SHA1/6/30）、SHA256/8/60、Steam（encoder=steam → otpType=steam/5/30）、
    纯 Base32 secret（SHA1/6/30）、name 空 → issuer 兜底为 Bitwarden、username 空 → 取 otpauth label；
    文件夹/folderId 一律忽略（分类=默认分类）；
  - 跳过：无 login.totp（NO_TOTP）、非登录 type=2（NOT_LOGIN_TYPE）、非法 totp（INVALID_TOTP）、
    HOTP URI（TYPE_NOT_TOTP）；跳过报告只含 name/原因（不含 secret）。
- bitwarden-encrypted-export.json：encrypted=true 负例，参考实现识别为 encrypted 并拒绝，
  提示“Bitwarden 加密导出暂不支持，请导出未加密 JSON”。
- bitwarden-expected-import.json：参考映射结果；Android 单测若复制同一夹具，e2e verify 会自动
  读 android-app/app/src/test/resources/... 的夹具对拍（相同内容时要求映射完全一致）。
- 独立实现：e2e/lib/bitwarden.mjs（Node）+ python/verify_fixtures.py 4c 节（Python）双实现互证。

## 加密夹具参数（严格对齐 docs/stratum-format.md）

| 形态 | 布局 | 密钥派生 | 加密 |
| --- | --- | --- | --- |
| Strong | AUTHENTICATORPRO(16) + salt(16) + iv(12) + 密文 + tag(16) | Argon2id，p=4，m=65536 KiB，t=3，输出 32B | AES-256-GCM，无 AAD |
| Legacy | AuthenticatorPro(16) + salt(20) + iv(16) + 密文 | PBKDF2-HMAC-SHA1，64000 次，输出 32B | AES-256-CBC + PKCS#7 |

密码均为 test-password；salt/iv 由固定标签的 SHA-256 派生（确定性，便于 git diff 与复现），
具体十六进制值记录在 fixtures/manifest.json。明文载荷与 plain-backup.json **逐字节相同**。

## 协议夹具

- protocol/valid-session.json：mfa_sync_begin → mfa_sync_account × 13 → mfa_sync_commit，
  syncId=sync-1760000000000-e2e，account 载荷含 otpType，单条消息最大约 490B（< 1KB 限制）。
- protocol/invalid-cases.json：25 个手环端接收状态机用例，逐条声明期望（依据 docs/protocol.md
  的校验规则与“确定性约定”）：版本 1/未知 type 忽略、非法 JSON、v1 快照忽略、非法 begin 保留 staging、
  空标签/非法字段/超长 id/字符串 digits 丢弃、commit 条数/syncId 不匹配（account_count_mismatch /
  sync_id_mismatch）、无 staging（no_active_begin）、同 index 重复覆盖（duplicate_index 不失败）、
  同 id 不同 index 丢弃后到者（incomplete_sync）、缺省 id/字段兜底、Steam 账号固定字段、
  Steam 非法字段丢弃、新 begin 丢弃旧 staging、空同步清空、120s staging 超时。
  每个用例给出 expect.results（逐条状态）、finalSnapshot（不变/账号数）、lastAck 等断言。

## verify.mjs 覆盖（A–J）

| 节 | 内容 |
| --- | --- |
| A | RFC 6238 三种算法 × 6 个时间点 + RFC 4226 HOTP 10 向量 + digits 长度 + **Steam Guard 6 组向量** |
| B | 文件哈希可复现、覆盖矩阵、映射结果与 expected-import.json 一致、id 独立复算、分类 Id、排序规则、跳过报告不含 secret |
| C | Strong/Legacy 解密 == 明文、错误密码/错误头部/截断拒绝、同 salt/iv 再加密逐字节一致 |
| D | **跨实现**：Python 夹具（tools/fixtures）解密、固定 salt/iv 再加密逐字节一致、映射 3/5（旧夹具 Steam 共用 secret 已知跳过）、URI 列表、与 tools/src/stratum.mjs 双向对拍（Steam 支持自适应） |
| E | URI 列表 8 导入 / 2 跳过；普通 TOTP 字段与明文映射一致；**3 种 Steam 形式均识别为 otpType=steam** |
| F | 合法会话：信封/大小/索引/同步号、手环端回放提交、ack、手机端状态机、request |
| G | 字段边界：最大字段消息 < 1KB（含 Steam）、13 类非法 account + 4 类非法 Steam account 丢弃、未知字段忽略、小写算法/otpType 容忍 |
| H | 回放 invalid-cases.json 的 25 个用例（含 Steam / duplicate_index / 非法 begin / 失败 ack 原因码） |
| I | **跨端 TOTP/Steam**：band-app 纯模块 vs 独立实现（RFC 向量、HOTP、3×5×5×5 矩阵、夹具 TOTP 账号、**Steam 6 向量 + Steam 账号跨端对拍**） |
| J | **Bitwarden 未加密 Vault**：内容嗅探（vault/encrypted/非 Bitwarden）、otpauth TOTP / Steam encoder / 纯 Base32 三类、name/username 兜底、文件夹忽略、加密导出拒绝、映射账号经协议同步、Android 单测夹具对拍（若已复制） |

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
- 版本号：rpk 1.0.4 / versionCode 5（UI v3），APK 1.2 / versionCode 3（Bitwarden 导入）；
- APK 签名证书 SHA-256 == signing/rpk-sign/certificate.pem；
- .rpk 字节流内嵌同一证书 DER（aiot-toolkit 签名块）；
- 三者指纹一致，并可选择调用团队统一的 scripts/check-signing.sh；
- **band UI v3 静态检查**（docs/design/ui-v3-spec.md）：
  index.ux 无 header/status 顶栏、右侧 rail A-Z 按钮、打开 pages/picker；
  settings.js 的 ACCOUNTS_PER_PAGE == 3、字母筛选函数与 wristkey_letter_filter 持久化 key；
  pages/picker/picker.ux 存在（标题“首字母筛选”、字母桶/全部/#）且 manifest 注册路由；
  band-app/tests 覆盖字母桶/筛选与分页（ACCOUNTS_PER_PAGE/paginate）；
- 结果写入 ../reports/e2e-build-result.json，退出码 0 = 无 FAIL（SKIP 可接受）。

## 协议/格式的确定性约定（与 docs/protocol.md 对齐）

旧版文档未明确、现已写入 docs/protocol.md 的规则，e2e 参考实现严格照此执行：

1. **account.id**：s_ + sha1(归一化 secret) 前 12 位；归一化 = 大写、去空白、去 -、去 =；
2. **快照顺序**：协议不保证顺序，跨端对拍用 id 集合 + 字段值，不比较数组下标；
3. **空同步**：begin/commit accountCount=0 合法，写入空快照（清空账号）；
4. **重复 index**：同轮重复 index 后到覆盖先到（duplicate_index，不算失败）；
   同 account.id 出现在不同 index → 丢弃后到者；
5. **非法 begin**：syncId 空/超长或 accountCount 非 0–500 整数 → 忽略并**保留**当前 staging；
6. **失败 ack 原因码**：no_active_begin / sync_id_mismatch / account_count_mismatch / incomplete_sync；
7. **staging 超时**：120s 无新消息自动丢弃，不计入错误；
8. **otpType**：可选 totp（缺省）/steam（大小写不敏感）；Steam 固定 digits=5/period=30/SHA1，
   码为 5 位字母数字（docs/protocol.md Steam Guard 一节）；
9. **URI 列表**：无分类 → 默认分类；Steam 三种识别形式见夹具覆盖矩阵。

## 安全与许可

- e2e 代码为本项目独立实现；research/ 下参考项目只读，官方解密工具仅用于离线校验；
- 夹具 secret 均为公开测试值，禁止替换为真实凭证；bitwarden-export.json 中的密码字段
  全部为 fake-* 占位值，仅供格式验证；
- plain-backup.json / bitwarden-export.json 是测试备份，不要导入真实账号环境。
