# WristKey 端到端验收报告 v3（手环 UI v3 + Bitwarden 导入）

- 任务：task-10（QA：UI v3 + Bitwarden 导入的夹具/终验）
- 执行：qa，2026-11-10 17:32 (Asia/Shanghai)
- 结论：**PASS** —— 手环 UI v3 与 Bitwarden 未加密 JSON 导入均已实现并通过验证；
  band-app 78/78、android-app JVM 78/78（11 个测试类）、Node e2e 155/155、Python 30/30、
  构建/包名/版本/签名检查 **46 PASS / 0 FAIL / 0 SKIP**；APK 与 .rpk 同证书、包名一致。
- 未覆盖：真机（小米手环 10 Pro）上的 UI v3 交互（3 码/页、A-Z 筛选页、手势）与
  Bitwarden 导入后的同步/显示，见第 7 节。

## 1. 手环 UI v3（rpk 1.0.4 / versionCode 5）

### 1.1 设计规格（docs/design/ui-v3-spec.md）

- 主界面无顶栏（不显示标题/分类/同步状态行），整屏给验证码；
- 每页 3 个账号（ACCOUNTS_PER_PAGE = 3），上下滑动翻页；
- 右侧 rail（56px）顶部 A-Z 圆钮：无筛选显示 A-Z，有筛选显示当前字母并高亮；下方页码；
- 首字母筛选页 pages/picker：标题“首字母筛选”，7 列网格 38 格（A-Z + 0-9 + 全部 + #），
  每格显示字母与该字母账号数；点击写入 wristkey_letter_filter 后 router.back()；
- 字母桶：优先 issuer 首字符，issuer 空用账号名；A-Z/0-9 对应桶，其它（中文/符号/空）→ #；
- 筛选在全部账号内进行（忽略分类），筛选后仍 3 个/页；菜单页移除分类入口。

### 1.2 实现与静态检查（e2e/check-build.mjs 新增 17 项 UI v3 检查，全部 PASS）

| 检查项 | 结果 |
| --- | --- |
| index.ux 存在且**无 header/status 顶栏标记** | PASS |
| 右侧 rail（rail + letter-button/openPicker） | PASS |
| index 打开 pages/picker 路由 | PASS |
| settings.js ACCOUNTS_PER_PAGE = 3 | PASS |
| index 使用 paginate(currentAccounts, page, ACCOUNTS_PER_PAGE) | PASS |
| 字母筛选函数 filterAccountsByLetter / normalizeLetterFilter | PASS |
| 字母桶/计数函数 letterBucket / buildLetterCounts | PASS |
| 筛选持久化 key wristkey_letter_filter | PASS |
| pages/picker/picker.ux 存在、标题“首字母筛选”、字母桶/全部/# 渲染 | PASS |
| manifest 注册 pages/picker | PASS |
| menu.ux 无分类入口（无 pages/category / “分类”） | PASS |
| band-app/tests 存在字母桶/筛选测试（settings.test.mjs、uxStructure.test.mjs） | PASS |
| band-app/tests 覆盖 letterBucket/buildLetterCounts | PASS |
| band-app/tests 覆盖 ACCOUNTS_PER_PAGE/paginate（每页 3 个、页码夹取） | PASS |

- band-app 单测 **78/78 通过**，新增 settings.test.mjs 覆盖：
  paginate 3/页与页码夹取、listCodeFontSize 42/40/34、letterBucket(A-Z/0-9/#/大小写/CJK/NULL)、
  accountLetter（issuer 优先、回退账号名）、buildLetterCounts（全部 37 桶计数）、
  filterAccountsByLetter（跨分类）、normalizeLetterFilter。
- 版本：rpk **1.0.4 / versionCode 5**（check-build 校验通过）。

## 2. Bitwarden 未加密 JSON 导入（APK 1.2 / versionCode 3）

### 2.1 规范（docs/bitwarden-format.md）

- 识别：未加密 Vault（顶层 items，元素含 login，encrypted 为 false/缺失）；
  加密导出（encrypted=true）拒绝并提示“Bitwarden 加密导出暂不支持，请导出未加密 JSON”（不按密码错误处理）；
  其它 Bitwarden 导出（无 login）不识别；与 Stratum（Authenticators）、Aegis（entries）按内容区分。
- 映射：item.name → issuer（trim，空 → Bitwarden）；login.username → accountName
  （空 → otpauth label 账号）；login.totp → otpauth URI 或纯 Base32（SHA1/6/30）；
  文件夹/folderId 忽略（默认分类）；type≠1、无/非法 totp、重复 secret → 跳过并报告。
- Steam：otpauth 中 encoder=steam 或 issuer/label 前缀 Steam → otpType=steam（5 位字母数字码）。

### 2.2 QA 夹具与对拍

- **e2e 夹具** bitwarden-export.json：10 个 item → **6 导入 + 4 跳过**（确定性；密码字段全为 fake-*）：
  - 导入：otpauth TOTP（SHA1/6/30）、SHA256/8/60、Steam(encoder=steam)→steam/5/30、
    纯 Base32（SHA1/6/30）、name 空→issuer=Bitwarden、username 空→otpauth label；
  - 跳过：NO_TOTP / NOT_LOGIN_TYPE(type=2 带 totp) / INVALID_TOTP / TYPE_NOT_TOTP(HOTP)；
- **加密负例** bitwarden-encrypted-export.json：识别为 encrypted 并拒绝，错误文案与 Android 常量一致；
- **双实现独立解析**：e2e/lib/bitwarden.mjs（Node）与 python/verify_fixtures.py 4c 节（Python）均得到 6/4，
  Steam 字段 5/30/SHA1、name/username 兜底、文件夹忽略全部一致；
- **与 Android 单测夹具对拍**：e2e 独立解析 android-app/app/src/test/resources/fixtures/bitwarden-export.json：
  **10 item → 5 导入 / 5 跳过**；GitHub 字段、Steam（issuer=Steam，URI issuer=Other+encoder=steam，
  accountName=alice，otpType=steam/5/30/SHA1，**T=59 → 3DP36**）、RawBase32、LabelOnly（SHA256/8/60，
  accountName=labelacct）均与 BitwardenImporterTest 断言一致；跳过原因为
  NO_TOTP / INVALID_TOTP / TYPE_NOT_TOTP / NOT_LOGIN_TYPE / DUPLICATE_SECRET；
- **Android 单测**：78/78 通过（11 个测试类），含 BitwardenImporterTest（5 导入/5 跳过、字段映射、
  Steam 5 位码 3DP36、加密导出显式文案且非 StratumPasswordException、按 secret 合并覆盖）；
- **已知小差异（不影响 TOTP/同步）**：raw Base32 + item.name/username 全空 时，
  docs/bitwarden-format.md 语义为 accountName 回退 issuer（参考实现得到 “Bitwarden”），
  而 Android 1.2 单测断言 accountName 为空串。已在 e2e verify 中记录 NOTE；
  仅影响列表显示名，建议后续统一（改实现或改文档）。

## 3. 环境

| 项 | 值 |
| --- | --- |
| OS | Linux x86_64 |
| Node | v22.22.2 |
| npm | 10.9.7 |
| Python | 3.14.8（e2e/.venv：argon2-cffi 25.1.0 + cryptography 50.0.2） |
| JDK | /home/lsl/.jdks/jdk-21.0.13+9 |
| Android SDK | ~/Android/Sdk（build-tools 34.0.0/36.1.0/37.0.0） |
| 时间 | 2026-11-10 17:32 CST |
| 真机 | **无** |

## 4. 产物清单与校验值

| 产物 | 路径 | 大小 | SHA-256 | 关键属性 |
| --- | --- | --- | --- | --- |
| band .rpk | band-app/dist/dev.wristkey.app.release.1.0.4.rpk | 68,766 B | 243dcaeabaf9325b85dec56beb6e51d0b8a43751bd960008d035983bdee1ac94 | package=dev.wristkey.app，name=腕证，versionName=1.0.4，versionCode=5，deviceTypeList=[watch] |
| android release APK | android-app/app/build/outputs/apk/release/app-release.apk | 26,263,469 B | a7c07962cd908454bc1592aa8b2b56ba707c103eae10e9a3c0d108ed21ca6e59 | package=dev.wristkey.app，label=腕证，versionName=1.2，versionCode=3，minSdk 28，targetSdk 36 |
| 签名证书 PEM | signing/rpk-sign/certificate.pem | — | SHA-256 指纹 b7cfba158655bd329acc30a81cb6f5a62815b74df93db4c4931e608851da85c4 | CN=WristKey Dev, OU=WristKey, O=WristKey, C=CN |
| 测试夹具 | e2e/fixtures/（9 个文件） | 见附录 | 见附录 | 确定性生成，密码 test-password |

> 本次 --build 重新构建了 band rpk（band-dev 交付件 68,764 B / sha256 f1225f2b…ff8a74；
> 重建后 68,766 B / sha256 243dcaea…1ac94，内容与版本一致，仅构建时间戳/压缩差异）。
> APK 重建后与交付件 sha256 完全一致（a7c07962…6e59）。
> .rpk 内嵌证书 DER 命中 offset 65055；APK 证书 = PEM = b7cfba…85c4。

## 5. 验收执行结果

### 5.1 构建/包名/版本/签名/UI 静态检查

~~~
node e2e/check-build.mjs --build --with-tests   # 重建 rpk+APK、双端单测、全量检查
构建检查: 46 PASS / 0 FAIL / 0 SKIP（--build 额外校验 release 构建步骤）
~~~

包含：band npm test 78 用例、npm run release、rpk 1.0.4/5、UI v3 静态检查（17 项）、
android gradle testDebugUnitTest assembleRelease（78 用例/11 类）、APK 1.2/3、
APK/PEM/RPK-DER 三方签名一致、scripts/check-signing.sh PASS、包名一致。
明细：reports/e2e-build-result.json。

### 5.2 e2e Node 验证

~~~
cd e2e && npm run verify
WristKey e2e verify: 155 passed, 0 failed, 155 total
~~~

| 节 | 断言数 | 本轮变化 |
| --- | --- | --- |
| A. RFC 6238 / RFC 4226 / Steam 向量 | 28 | — |
| B. 夹具覆盖矩阵与明文映射 | 13 | — |
| C. Strong/Legacy 加解密 | 8 | — |
| D. 跨实现交叉验证 | 9 | — |
| E. URI 列表 | 4 | — |
| F. 协议 v2 合法会话与双端状态机 | 9 | — |
| G. 协议字段边界 | 24 | — |
| H. 非法/边界用例回放 | 25 | — |
| I. 跨端 TOTP/Steam 对拍 | 25 | — |
| **J. Bitwarden 未加密 Vault 导入** | **10** | **新增**：嗅探/映射/6 导入 4 跳过/Steam/兜底/加密负例/协议同步/Android 夹具 5 导入 5 跳过 + 3DP36 + 单测断言交叉核对 |

### 5.3 e2e Python 独立验证

~~~
cd e2e && .venv/bin/python python/verify_fixtures.py
Python verify: 30 passed, 0 failed, 30 total
~~~

新增 4c 节（6 项）：Bitwarden 内容嗅探、独立解析 6 导入/4 跳过、Steam 5/30/SHA1、
name/username 兜底、加密导出拒绝、期望统计 6/4/10。

### 5.4 签名一致性（bash scripts/check-signing.sh，默认参数）

~~~
APK 证书 SHA-256: b7cfba158655bd329acc30a81cb6f5a62815b74df93db4c4931e608851da85c4
签名 PEM SHA-256: b7cfba158655bd329acc30a81cb6f5a62815b74df93db4c4931e608851da85c4
RPK 内嵌证书 DER: 是 (offset 65055)
PASS: 包名 dev.wristkey.app，APK 与 RPK 使用同一证书
~~~

注：dist 中同时存在 dev.wristkey.app.debug.1.0.4.rpk（band-dev 调试包）；
check-build 与 check-signing.sh 均优先选择 *.release.*.rpk。

## 6. 夹具与检查新增（本轮）

- e2e/fixtures/bitwarden-export.json（10 item → 6 导入 + 4 跳过，确定性，fake-* 密码占位）；
- e2e/fixtures/bitwarden-encrypted-export.json（加密导出负例）；
- e2e/fixtures/bitwarden-expected-import.json（参考映射，供 Android 单测对拍）；
- e2e/lib/bitwarden.mjs（Node 独立解析/映射）；
- python/verify_fixtures.py 4c 节（Python 独立解析）；
- e2e/verify.mjs J 节（10 项，含 Android 夹具对拍）；
- e2e/check-build.mjs UI v3 静态检查（17 项：无顶栏/3 个每页/rail/picker/字母桶/测试覆盖）；
- e2e/check-build.mjs 版本期望更新为 rpk 1.0.4/5、APK 1.2/3。

## 7. 未验证项与残余风险

1. **真机未验证（中）**：本轮新增的 UI v3（每页 3 个、无顶栏、右滑菜单、A-Z 筛选页交互与
   字母计数显示）与 Bitwarden 导入后的同步/手环显示均未在小米手环 10 Pro 实机复验；
   需真机确认：3 码/页排版、picker 网格可点、筛选持久化、Steam 5 位码、Bitwarden 导入账号同步。
2. **Bitwarden accountName 兜底差异（低）**：raw Base32 + name/username 全空时文档语义回退 issuer，
   Android 1.2 返回空串；仅显示名差异，建议后续统一。
3. **ack 为 best effort（低）**：xms SDK 消息接收回调未在真机确认。
4. **band-app 导入 totp.js 的 Node 警告（低）**：band-app/package.json 未声明 type=module，
   e2e verify 导入时出现 MODULE_TYPELESS_PACKAGE_JSON 警告，不影响正确性。
5. **夹具 secret 均为公开测试值**；Bitwarden 夹具密码字段全为 fake-* 占位。

## 8. 复现命令

~~~bash
# A. 夹具与 Node/Python 验证
cd e2e && npm install
npm run fixtures
npm run verify
python3 -m venv .venv && .venv/bin/pip install -r python/requirements.txt
.venv/bin/python python/verify_fixtures.py

# B. 两端构建 + 单测 + UI 静态检查 + 版本/包名/签名全量验收
cd ..
npm --prefix band-app test
npm --prefix band-app run release
cd android-app && ./gradlew testDebugUnitTest assembleRelease && cd ..
node e2e/check-build.mjs --build --with-tests

# C. 签名一致性（默认参数优先选 release rpk，需 java 在 PATH）
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
| bitwarden-export.json | 3386 | 9fb083c28636361d5adf9eb01ba4a38590c45b92e568fbc9072df460650659dd |
| bitwarden-encrypted-export.json | 266 | 9fc2c8da5355a55f382878308ac748ca8ee8b0ad6fad54406835c220aeaa29f2 |
| bitwarden-expected-import.json | 2871 | b091607b0f270b6e1e7d245bf535b2e8308c12a5e5d93dca54cf77a186cda802 |

### 9.2 本次验收日志

完整命令输出：/tmp/final-acceptance-v3b.log（最终权威跑；band/android 单测、check-build 46 项、
e2e verify 155 项、Python 30 项、check-signing）；较早一轮 /tmp/final-acceptance-v3.log。
关键退出码均为 0。

### 9.3 相关文档

- e2e/README.md：夹具/框架用法、Bitwarden/Steam 规则、UI v3 静态检查、覆盖矩阵；
- docs/bitwarden-format.md、docs/design/ui-v3-spec.md；
- e2e/verify-result.json（155 项）、reports/e2e-build-result.json（46 项）。
