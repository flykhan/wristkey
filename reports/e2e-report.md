# WristKey 端到端验收报告（终版 v2 — Steam Guard 修复）

- 任务：task-7（e2e/QA：Steam 夹具、跨实现对拍与终验）
- 执行：qa，2026-11-10 16:09 (Asia/Shanghai)
- 结论：**PASS** —— Steam Guard 已按新规范在两端实现并通过跨端验证；
  band-app 69/69、android-app JVM 72/72、Node e2e 145/145、Python 24/24、
  构建/包名/版本/签名检查 29 PASS / 0 FAIL / 0 SKIP；APK 与 .rpk 同证书、包名一致。
- 未覆盖：真机（小米手环 10 Pro）上的 Steam 显示/安装/同步，见第 7 节。

## 1. Steam Guard 修复（band 1.0.2 / APK 1.1）

### 1.1 问题与根因（真机发现）

真机上 Steam 账号被当成普通 TOTP 显示 **6 位数字**，而不是 Steam 的 5 位字母数字码。根因有三层：

1. **手环端**：旧版只实现 10 的幂取模 + 补零到 digits 位的 TOTP，没有 Steam 码生成逻辑。
2. **手机端导入**：旧版 Stratum 规范把 Type=4 列为“跳过项”，Steam 账号根本进不了快照；
   URI 列表里 otpauth://totp/Steam:...（issuer=Steam 且无额外标记）会被当普通 TOTP（digits=6/30s）。
3. **协议**：account 没有类型字段，手环端无法区分 TOTP 与 Steam，digits=5 反而被当作非法丢弃。

### 1.2 规范与协议变更（docs 已更新）

- docs/protocol.md：account 新增可选 otpType（"totp" 缺省 / "steam"，大小写不敏感）；
  Steam 固定 digits=5、period=30、algorithm=SHA1；明确 SteamOtp 算法：
  HMAC-SHA1 → RFC 4226 动态截断 → 5 次 ALPHABET[material % 26]（字母表
  23456789BCDFGHJKMNPQRTVWXY），不是 10 的幂取模；并补充“确定性约定”
  （id/顺序/空同步/重复 index/非法 begin/失败 ack 原因码/超时）。
- docs/stratum-format.md：Type=4（Steam）改为支持，映射为 otpType="steam" 并强制 5/30/SHA1；
  URI 列表三种 Steam 识别形式：issuer/label 前缀 Steam、非 Steam issuer 的裸 &steam、encoder=steam。

### 1.3 两端修复

| 端 | 修复 | 版本 |
| --- | --- | --- |
| band-app | 新增 generateSteam（5 位字母表、HMAC-SHA1、无补零/无 10 的幂）；协议校验支持 otpType，Steam 固定字段；UI 原样显示字母数字码 | **1.0.2** / versionCode 3 |
| android-app | 备份 Type=4 导入（忽略存储的 Digits/Period/Algorithm，固定 5/30/SHA1）；URI 三种 Steam 形式识别；快照发送 otpType；显示不做数字补零 | **1.1** / versionCode 2 |

### 1.4 QA 夹具与跨端验证

- **夹具**：plain-backup 增加 2 个 Steam 条目（issuer=Steam 与 issuer≠Steam 的 Valve），
  secret 与其他账号**完全独立**（避免 Stratum 主键重复被跳过）；uri-list 覆盖 3 种 Steam 形式
  （issuer=Steam 无标记 / 非 Steam issuer+&steam / encoder=steam）+ 5 条普通 TOTP + 2 条应跳过。
  当前统计：**23 条 = 13 导入 + 10 跳过**；URI **10 行 = 8 导入 + 2 跳过**。
- **Steam 码 6 组公开向量**（secret OJZ2BP7STWSLUD7I23Q5AYZELZB5OAFU）：
  T=59→3DP36、1111111109→GX57J、1111111111→TCJ4Y、1234567890→VYNVB、
  1640846388→2Y4TM、1735689600→DQ5KF。三套独立实现一致：
  e2e Node（node:crypto）、band-app generateSteam、Python（hmac/hashlib）。
- **协议**：invalid-cases 扩到 25 例，覆盖 otpType=steam 合法/非法（digits≠5、period≠30、
  algorithm≠SHA1、otpType 非法值）、大小写不敏感、duplicate_index 覆盖、非法 begin、
  失败 ack 原因码等；valid-session 含 13 条 account（2 条 Steam）且单条 < 1KB。
- **已知差异**：tools/fixtures 的旧 Python 夹具中 Steam 与 GitHub **共用 secret**，
  按 Stratum 主键规则触发 DUPLICATE_SECRET（已知仍 3 导入/5 跳过），不作为 Steam 正向用例；
  e2e 对 tools/src/stratum.mjs 的对拍对非 Steam 子集严格一致，Steam 支持情况自适应。
- **验证结果**：Steam 相关 20+ 断言全过（含 band-app generateSteam 6 向量对拍、
  2 个夹具 Steam 账号 ×2 时间点对拍、3 种 URI 识别、协议 Steam 用例）。

## 2. 环境

| 项 | 值 |
| --- | --- |
| OS | Linux x86_64 |
| Node | v22.22.2 |
| npm | 10.9.7 |
| Python | 3.14.8（e2e/.venv：argon2-cffi 25.1.0 + cryptography 50.0.2） |
| JDK | /home/lsl/.jdks/jdk-21.0.13+9 |
| Android SDK | ~/Android/Sdk（platforms android-34/36.1；build-tools 34.0.0/36.1.0/37.0.0） |
| 时间 | 2026-11-10 16:09 CST |
| 真机 | **无** |

## 3. 产物清单与校验值

| 产物 | 路径 | 大小 | SHA-256 | 关键属性 |
| --- | --- | --- | --- | --- |
| band .rpk | band-app/dist/dev.wristkey.app.release.1.0.2.rpk | 56,645 B | 51dd8b9519bf2bfffde613fb0a8a72d184ecc587691e2cd3a96f8602ab8e9f4b | package=dev.wristkey.app，name=腕证，versionName=1.0.2，versionCode=3，deviceTypeList=[watch] |
| android release APK | android-app/app/build/outputs/apk/release/app-release.apk | 26,263,473 B | 6fb73d769699ffc90af868f14f41c34a8e0d143c4a5d03552944e73067156550 | package=dev.wristkey.app，label=腕证，versionName=1.1，versionCode=2，minSdk 28，targetSdk 36 |
| 签名证书 PEM | signing/rpk-sign/certificate.pem | — | SHA-256 指纹 b7cfba158655bd329acc30a81cb6f5a62815b74df93db4c4931e608851da85c4 | CN=WristKey Dev, OU=WristKey, O=WristKey, C=CN |
| 测试夹具 | e2e/fixtures/（6 个文件） | 见附录 | 见附录 | 确定性生成，密码 test-password |

> 本次 --build 重新构建了 band rpk（band-dev 交付件为 56,639 B / sha256 61558db6…f28bc8；
> 重建后为 56,645 B / sha256 51dd8b95…e9f4b，内容与版本一致，仅构建时间戳/压缩差异）。
> APK 重建后与交付件 sha256 完全一致（6fb73d76…56550）。
> .rpk 内嵌证书 DER 命中 offset 53099（重建后偏移变化属正常）；APK 证书 = PEM = b7cfba…85c4。

## 4. 验收执行结果

### 4.1 band-app

~~~
npm --prefix band-app test          # tests 69 / pass 69 / fail 0
npm --prefix band-app run release   # 由 check-build --build 执行，退出码 0
# 产出 dev.wristkey.app.release.1.0.2.rpk（56,645 B）
~~~

### 4.2 android-app

~~~
cd android-app && ./gradlew testDebugUnitTest assembleRelease
# BUILD SUCCESSFUL；JVM 单测 72 passed / 0 failed / 10 个测试类
# release APK versionName=1.1 versionCode=2（26,263,473 B，重建后 hash 与交付件一致）
~~~

### 4.3 构建/包名/版本/签名检查（node e2e/check-build.mjs --build --with-tests）

~~~
构建检查: 29 PASS / 0 FAIL / 0 SKIP
~~~

29 项覆盖：band manifest/features/designWidth、npm test 69 用例、npm run release、
rpk package/name/versionName=1.0.2/versionCode=3、android gradle test+assembleRelease
（72 用例/10 类）、APK package/label/versionName=1.1/versionCode=2、
APK/PEM/RPK-DER 三方签名一致、scripts/check-signing.sh PASS、包名一致。

明细：reports/e2e-build-result.json。

### 4.4 签名一致性（bash scripts/check-signing.sh，默认参数）

~~~
APK: android-app/app/build/outputs/apk/release/app-release.apk
RPK: band-app/dist/dev.wristkey.app.release.1.0.2.rpk
RPK package: dev.wristkey.app | name: 腕证
APK 证书 SHA-256: b7cfba158655bd329acc30a81cb6f5a62815b74df93db4c4931e608851da85c4
APK 证书 DN: CN=WristKey Dev, OU=WristKey, O=WristKey, C=CN
签名 PEM SHA-256: b7cfba158655bd329acc30a81cb6f5a62815b74df93db4c4931e608851da85c4
RPK 内嵌证书 DER: 是 (offset 53099)
PASS: 包名 dev.wristkey.app，APK 与 RPK 使用同一证书
~~~

### 4.5 e2e Node 验证（cd e2e && npm run verify）

~~~
WristKey e2e verify: 145 passed, 0 failed, 145 total
~~~

| 节 | 断言数 | 内容 |
| --- | --- | --- |
| A. RFC 6238 / RFC 4226 / Steam 向量 | 28 | 3 算法×6 时间点 + HOTP 10 向量 + **Steam 6 向量** + 码长/字符集 |
| B. 夹具覆盖矩阵与明文映射 | 13 | 哈希可复现、13/10 映射、id 独立复算、Steam 固定字段、排序、跳过报告 |
| C. Strong/Legacy 加解密 | 8 | 解密 == 明文；错误密码/头部/截断；再加密逐字节一致 |
| D. 跨实现交叉验证 | 9 | Python 夹具解密/再加密、映射、URI、与 tools/src/stratum.mjs 双向（Steam 自适应） |
| E. URI 列表 | 4 | 8 导入/2 跳过；**3 种 Steam 形式**；普通 TOTP/Steam 字段与明文映射一致 |
| F. 协议 v2 合法会话与双端状态机 | 9 | 15 条消息（含 2 Steam）、信封/大小/索引/同步号、回放提交、ack、request |
| G. 协议字段边界 | 24 | 最大字段消息 < 1KB（含 Steam）、非法字段/非法 Steam 丢弃、未知字段忽略 |
| H. 非法/边界用例回放 | 25 | 含 Steam、duplicate_index、非法 begin、失败 ack 原因码、120s 超时 |
| I. 跨端 TOTP/Steam 对拍 | 25 | RFC 向量、HOTP、375 组矩阵、夹具 TOTP 账号、**Steam 6 向量 + 账号对拍** |

### 4.6 e2e Python 独立验证（含 Steam）

~~~
cd e2e && .venv/bin/python python/verify_fixtures.py
Python verify: 24 passed, 0 failed, 24 total
~~~

含：e2e 加密夹具 Python 独立解密、Stratum 官方 decrypt_backup.py 解密我方 Strong/Legacy 夹具、
RFC 6238 夹具账号复算、**Steam Guard 6 组向量 + 2 个 Type=4 夹具条目检查**、加密参数常量校验。

## 5. 跨实现交叉验证证据（双向、非自证）

| # | 方向 | 结果 |
| --- | --- | --- |
| 1 | e2e 密文 → Python 独立解密 | PASS |
| 2 | e2e 密文 → Stratum 官方工具解密 | PASS |
| 3 | tools/fixtures（Python 生成）→ e2e Node 解密 | PASS |
| 4 | e2e 密文 → tools/src/stratum.mjs 解密 | PASS |
| 5 | 固定 salt/iv 再加密 → 与 Python 产物逐字节一致 | PASS |
| 6 | 映射对拍（e2e vs tools）非 Steam 严格一致；Steam 自适应（tools 旧夹具共用 secret 已知 3/5） | PASS |
| 7 | TOTP 跨端（band-app vs 独立实现） | PASS（RFC 向量、375 矩阵、夹具账号） |
| 8 | **Steam 跨端**（band-app generateSteam vs e2e Node vs Python） | PASS（6 组向量 + 夹具 Steam 账号） |

## 6. 夹具覆盖矩阵

e2e/fixtures/plain-backup.json：23 条 = **13 导入 + 10 跳过**；uri-list.txt：10 行 = 8 导入 + 2 跳过。

| 维度 | 覆盖 |
| --- | --- |
| 算法 | SHA1 / SHA256 / SHA512 |
| digits | 5（Steam）/ 6 / 8 / 10 |
| period | 15 / 30 / 60 |
| otpType | totp / steam（issuer=Steam 与 issuer=Valve 两种 Steam） |
| 分类 | 开发 / 个人 / 云服务 / 社交 / 默认分类；多分类取 Binding Ranking 最小者 |
| 边界 | secret 带 = 填充、Unicode issuer/username、issuer 空、username 空 |
| 跳过 | HOTP(Type=1)、Mobile-OTP(Type=3)、非法 Base32、空 secret、period 4/301、digits 5/11（TOTP）、issuer+username 全空、Algorithm=7 |

加密夹具：Strong = AUTHENTICATORPRO + salt16 + iv12 + AES-256-GCM(Argon2id p4 m65536 t3 out32) + tag16；
Legacy = AuthenticatorPro + salt20 + iv16 + AES-256-CBC/PKCS7(PBKDF2-SHA1 64000 dk32)；密码 test-password。

## 7. 未验证项与残余风险

1. **真机未验证（中）**：无小米手环 10 Pro 真机，本次 Steam 修复的显示效果、rpk 安装、
   interconnect 包名+签名握手、xms 投递/重连、480×336 UI 均未实机复验；
   真机发现的原问题已由两端实现 + 夹具/单测/跨端对拍覆盖，但最终仍需一次真机回归
   （Steam 账号应显示 5 位字母数字码，且 30s 刷新）。
2. **tools 旧夹具 Steam 共用 secret（低）**：tools/fixtures 的 Steam 条目与 GitHub 共用 secret，
   会按 DUPLICATE_SECRET 跳过（已知 3/5）；Steam 正向用例以 e2e/fixtures 为准。
3. **ack 为 best effort（低）**：xms SDK 是否提供消息接收回调未在真机确认。
4. **band-app 导入 totp.js 的 Node 警告（低）**：band-app/package.json 未声明 type=module，
   e2e verify 导入时出现 MODULE_TYPELESS_PACKAGE_JSON 警告，不影响正确性。
5. **夹具 secret 均为公开测试值**：禁止替换为真实凭证。

## 8. 复现命令

~~~bash
# A. 夹具与 Node/Python 验证
cd e2e && npm install
npm run fixtures
npm run verify
python3 -m venv .venv && .venv/bin/pip install -r python/requirements.txt
.venv/bin/python python/verify_fixtures.py

# B. 两端构建 + 单测 + 版本/包名/签名全量验收
cd ..
npm --prefix band-app test
npm --prefix band-app run release
cd android-app && ./gradlew testDebugUnitTest assembleRelease && cd ..
node e2e/check-build.mjs --build --with-tests

# C. 签名一致性（默认参数，需 java 在 PATH）
JAVA_HOME=$(ls -d ~/.jdks/jdk-* | sort -V | tail -1)
PATH="$JAVA_HOME/bin:$PATH" bash scripts/check-signing.sh
~~~

## 9. 附录

### 9.1 夹具文件哈希（fixtures/manifest.json）

| 文件 | 字节 | SHA-256 |
| --- | --- | --- |
| plain-backup.json | 9117 | 08fec2213cb649aab13ffb030ef29aca4a1c1f1573a7b790ba7b1929012c5da0 |
| expected-import.json | 6314 | c6e85738422cc374e24bf4fea17c8bed5c37337d6e7e5a0c36516b9aa7ff9b5a |
| strong.stratum | 9177 | 0f2e4ede24e65e98f5353299373e54429eb8875688873bf1ad73931039a03b47 |
| legacy.stratum | 9172 | e09d27f3aba2aade51e028ce8afe2f0d9ec426bbdb89b4a6bdecaa33e9ec96f6 |
| uri-list.txt | 1060 | 84579b76426b442bea8a324187a95787f386ad6800eb177d14861df51e09b886 |
| protocol/valid-session.json | 7179 | 6a2cf11f3ad9528b294cb4d9b81d558aa70bca806e640aec515a346707422ec1 |

### 9.2 本次验收日志

完整命令输出：/tmp/final-acceptance-steam.log（band/android 单测、check-build 29 项、
e2e verify 145 项、Python 24 项、check-signing）。关键退出码均为 0。

### 9.3 相关文档

- e2e/README.md：夹具/框架用法、Steam 规则、覆盖矩阵、确定性约定；
- e2e/verify-result.json：Node 145 项逐条结果；
- reports/e2e-build-result.json：构建检查 29 项逐条结果。
