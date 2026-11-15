# WristKey 端到端验收报告 v8（v2.2.0：真机反馈的同步/解锁/UI 修复）

- 任务：task-17（v2.2.0 全量验收）；此前 task-14（v2.0 全量验收）及 v2.0.1/v2.0.2/v2.1.0/v2.1.1/v2.1.2 回归见历史段落。
- 执行：qa，2026-11-15 23:30 (Asia/Shanghai)。
- 结论：**PASS**。band-app **116/116**、android-app JVM **112/112（16 个测试类）**、Node e2e **171/171**、
  Python **40/40**；构建/包名/版本/权限/UI/签名检查 **121 PASS / 0 FAIL / 0 SKIP**（含双端单测两项）。
  APK 与 .rpk 同证书、同包名 com.flykhan.wristkey。
- 本轮未发现 band-app / android-app 的构建或测试缺陷。check-build 首轮的 3 个 FAIL 均为 e2e 静态断言
  仍停留在 2.1.2 文案/常量，已按 2.2.0 源码更新（详见 6.2），非产品缺陷。
- **未覆盖**：小米手环 10 Pro 真机上的 xms/interconnect 实际链路、锁屏建链、手机拉起手环、
  真机渲染与功耗；真机日志证据来自用户侧反馈，见第 8 节。

## 0. v2.2.0 修复摘要

2.2.0 针对真机反馈的 4 类问题做修复，并保持协议 v3 不变：

1. **解锁/设图案卡顿（高）**：Vela 无 JIT，手环 PBKDF2 纯 JS 实现 10 轮在 VVD 实测约 2.1 s，
   真机更慢，表现为“输完图案没反应”。两端默认迭代与协议下限统一从 10 降到 **1**
   （VVD 1 轮约 0.2 s，协议仍允许 1–20000）。3^5=243 种图案本身熵很低，
   主要防护改为连续 5 次失败锁 30 s 递增，而非昂贵的 KDF。
2. **手机设图案/同步 8 秒无确认（高）**：真机日志显示手环快应用未运行时，手机发送返回
   `quickapp_proxy_server_send ... failed: -6`，手机 8 s 后报“未收到手环确认”。2.2.0 让
   **锁屏期间也建立 interconnect 通道**：index 的 showLock 调用 setupChannel()，
   channelReady 由 connect() 返回值决定（不再先置 true）；手机设图案前先 launchWearApp，
   每 2.5 s 重试（最多 3 次），同步单条发送失败重试 2 次（间隔 400 ms）。
3. **Bitwarden 无验证码条目缺失（中）**：login.totp 为空的登录条目 2.2.0 起仍导入，
   作为“无验证码”本地账号（hasOtp=false，id 前缀 n_），可查看名称/用户名/密码；
   因协议要求 secret 为合法 Base32，这类账号**不同步到手环**，同步前由 syncableAccounts
   过滤并在导入摘要单独计数。补 secret 后转为普通 s_ 账号即可同步。
4. **手环 UI 拉伸/字小（中）**：账号卡片固定 98px 高，筛选后仅 1–2 条也不再纵向拉伸；
   issuer/账号/倒计时、验证码、A-Z、菜单、锁屏键、详情返回、用户名/密码等字号与按钮整体放大。

对应版本：手环 **2.2.0 / versionCode 12**，手机 **2.2.0 / versionCode 8**。
（历史版本：2.1.2/11 与 2.1.2/7 见旧报告段落。）

## 1. v2.2.0 交付范围

### 1.1 手环端（rpk 2.2.0 / versionCode 12）

依据 docs/design/ui-v4-analysis.md、docs/design/ui-v3-spec.md（UI v5 为 2.2.0 真机反馈后的尺寸/链路修订）：

- **启动与锁屏（入口内联）**：index 内 `locked`/`mainVisible` 二选一渲染，不改路由页面栈；
  onInit 建状态并 loadGate，onShow 调 evaluateGate；锁屏状态直接 return，只有校验成功才解锁。
- **锁屏期间建链（2.2.0）**：showLock 设 locked=true、mainVisible=false 后调用 setupChannel()；
  setupChannel 内 `const connection = connect(...)`，`this.channelReady = connection !== null`；
  连接成功才允许后续同步/图案确认消息，避免手环未运行手机消息返回 -6。
- **图案与派生**：5 位 /^[TSC]{5}$/，PBKDF2-HMAC-SHA256、16 B salt、**1 次迭代**、32 B 输出；
  只存派生值与失败计数（wristkey_pin_v1 / wristkey_pin_lock_v1），不存图案明文。
- **主界面**：无顶栏，3 条/页；右侧 64px rail（A-Z 圆钮、账号数、页码、菜单）；
  .otp-item `flex:none; height:98px`，筛选 1–2 条不拉伸；卡片 issuer 24px、账号 15px、
  倒计时 16px，验证码按位数 48/46px；A-Z 按钮 52×52、菜单按钮 64×44。
- **锁屏/详情/菜单尺寸**：锁屏键 128×100、关闭键 44×44；详情返回 72×40、用户名/密码 18px、
  验证码按位数 60/58px；菜单行高 56px、标题 22px；picker 关闭 44×44、字母 24px。
- **协议 v3 手环侧**：PROTOCOL_VERSION=3、SUPPORTED_PROTOCOL_VERSIONS=[2,3]；account.password；
  mfa_pin_set/query/clear/ack/state；活动存储键 mfa_snapshot_v3，保留 mfa_snapshot_v2 回滚。
- **测试**：band-app/tests 新增 uxV5.test.mjs，覆盖固定高度、锁屏建链、尺寸/字号常量与源码结构。

### 1.2 手机端（APK 2.2.0 / versionCode 8）

依据 docs/design/android-v2-spec.md、docs/bitwarden-format.md：

- 3 个底部 Tab（账号 / 同步 / 设置）、深色 token、账号卡 issuer+accountName+验证码+秒数+进度条；
- FAB 导入：Stratum / Bitwarden / otpauth / 手动 四入口；账号详情 ModalBottomSheet；
- 入口图案：PatternPin.ITERATIONS=1（MIN=1、MAX=20000），16 B SecureRandom salt；
  MainActivity 调 newSaltHex/derive 并 setPin/clearPin/queryPin；
  固定向量 14d3407409dca32a6cebfb70c29871fd8b381466e8b290bc22625dc1fe8795a5 由单测锁定；
- 同步：SyncProtocol.PIN_ITERATIONS=1；WearableSyncController LAUNCH_DELAY_MS=1_300、
  PIN_RETRY_INTERVAL_MS=2_500、MAX_PIN_ATTEMPTS=3、SEND_RETRY_COUNT=2、SEND_RETRY_DELAY_MS=400；
  设图案先拉起手环并重试确认；发送前用 syncableAccounts 过滤 hasOtp=false；
- Bitwarden 无 totp：BitwardenImporter 导入为空 secret 本地账号（Secret.noOtpAccountId → n_ 前缀），
  不再计入 skipped；BitwardenImporterTest 断言 6 导入/4 跳过、noOtp.id 以 n_ 开头、secret 为空；
- UI：详情编辑页返回按钮 44dp、详情值 16sp；
- 权限最小化：release APK 唯一权限 com.flykhan.wristkey.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION，
  **无 INTERNET**（离线应用）。

### 1.3 e2e / 报告更新

- e2e/check-build.mjs 期望版本改为 2.2.0/12 与 2.2.0/8，rpk 文件名
  com.flykhan.wristkey.release.2.2.0.rpk；新增 band UI v5 与 Android v5 静态检查；
- e2e/lib/bitwarden.mjs 与夹具对齐“无 totp 也导入、本地可见、不同步”的 2.2.0 语义；
- e2e/verify.mjs、e2e/fixtures/generate.mjs、e2e/python/verify_fixtures.py 同步更新；
- reports/e2e-report.md（本文件）更新为 v8；e2e/README.md 同步 2.2.0 参数与计数。

## 2. 同步协议 v3（docs/protocol.md）

### 2.1 版本兼容矩阵

| 发送方 | 接收方 | 行为 |
| --- | --- | --- |
| 手机 v3（2.0+） | 手环 v3（2.0+） | 完整同步，含 password 与 pin 消息 |
| 手机 v3（2.0+） | 手环 v1.0.x（v2） | 手环忽略 begin；手机 8 s 无 ack 提示“手环应用版本过低” |
| 手机 v2（1.x） | 手环 v3（2.0+） | 手环按 v2 解析，同步账号但不带 password；快照 version=2，写活动键 mfa_snapshot_v3 |
| 手环 v3（2.0+） | 手机 v2（1.x） | 手机忽略 pin/ack v3，不影响账号数据 |

- 手环接受 version ∈ {2,3}；account.password 仅 v3；手机接受 {2,3}，pin 消息仅 version==3；
- 未知 type/version 忽略；单条消息 < 1 KiB。

### 2.2 password 与合并语义

- string ≤128，允许空格/Unicode，禁止 U+0000–U+001F；空串等同缺省；
- 同 account.id 再次同步：**缺省=保留旧值、显式空串=清空、非空=覆盖**，同轮可混合；
- 手机 2.0+ 全量同步：每条 account 都带 password，有密码发实际值、无密码发空串。

### 2.3 入口图案消息（pin）

| 消息 | 方向 | 语义 |
| --- | --- | --- |
| mfa_pin_set | 手机 → 手环 | pin{algorithm:"PBKDF2-SHA256", salt 32 hex, hash 64 hex, iterations 1–20000}；成功写 wristkey_pin_v1 并广播 mfa_pin_state |
| mfa_pin_query | 手机 → 手环 | 查询状态；手环回 mfa_pin_state（回填同一 requestId） |
| mfa_pin_clear | 手机 → 手环 | 删除图案与失败计数；ack {ok:true, enabled:false} |
| mfa_pin_ack | 手环 → 手机 | 成功 {ok:true, enabled} 不得带 error；失败 error ∈ invalid_pin_payload / invalid_version / storage_error |
| mfa_pin_state | 手环 → 手机 | enabled、updatedAt、requestId（广播时省略） |

- 非法 pin 载荷 → invalid_pin_payload，旧图案不变；pin 消息 version≠3 → invalid_version；
- 2.2.0 两端默认 **iterations=1**（协议仍允许 1–20000），salt 16 B，输出 32 B。

### 2.4 确定性约定

- account.id = s_ + sha1(归一化 secret) 前 12 位；归一化 = 大写、去空白/-/=；
- 无 TOTP 的本地账号用 n_ + sha1(名称/用户名/序号) 前 12 位，不同步到手环；
- 快照顺序不保证，跨端对拍按 id 集合与字段值；
- 空同步合法（清空账号）；重复 index 后到覆盖（duplicate_index 不算失败）；同 id 不同 index 丢弃后到者；
- 失败 ack 原因码：no_active_begin / sync_id_mismatch / account_count_mismatch / incomplete_sync；
- staging 120 s 无新消息自动丢弃，不计错误；手机 8 s 未收到 ack 视为超时。

## 3. 环境

| 项 | 值 |
| --- | --- |
| OS | Linux x86_64 |
| Node | v22.22.2 |
| npm | 10.9.7 |
| Python | 3.14.8（e2e/.venv：argon2-cffi 25.1.0 + cryptography 50.0.2） |
| JDK | /home/lsl/.jdks/jdk-21.0.13+9 |
| Android SDK | ~/Android/Sdk（build-tools 34.0.0/36.1.0/37.0.0） |
| 时间 | 2026-11-15 23:30 CST |
| 真机 | **无**（仅用户侧日志/反馈与 VVD 既有验证） |

## 4. 产物清单与校验值

| 产物 | 路径 | 大小 | SHA-256 | 关键属性 |
| --- | --- | --- | --- | --- |
| band .rpk | band-app/dist/com.flykhan.wristkey.release.2.2.0.rpk | 109,172 B | f0ff609c5e076619b012b6e69ae1d9ef2b9f97488dbbc57542aaec0f26218584 | package=com.flykhan.wristkey，name=腕证，versionName=2.2.0，versionCode=12，deviceTypeList=[watch] |
| android release APK | android-app/app/build/outputs/apk/release/app-release.apk | 26,509,053 B | 87314829d034f033c9ae29bbeb7f74c130caa00e7328819c635b609456989cc9 | package=com.flykhan.wristkey，label=腕证，versionName=2.2.0，versionCode=8，minSdk 28，targetSdk 36 |
| 签名证书 PEM | signing/rpk-sign/certificate.pem | — | SHA-256 指纹 b7cfba158655bd329acc30a81cb6f5a62815b74df93db4c4931e608851da85c4 | CN=WristKey Dev, OU=WristKey, O=WristKey, C=CN |
| 测试夹具 | e2e/fixtures/（含 protocol-v3/） | 见 10.1 | 见 10.1 | 确定性生成，密码 test-password |

> .rpk 内嵌证书 DER 命中 offset **105146**；APK 证书 SHA-256 == PEM == b7cfba…85c4。
> APK 与 .rpk 包名均为 com.flykhan.wristkey，应用名均为腕证。
> 历史产物：2.1.2 rpk 109,130 B / b52686a4… / DER offset 105104，APK 26,492,669 B / 0f169b25…；
> 2.0.0 rpk 113,923 B；2.0.1 114,700 B；2.0.2 114,640 B；2.1.0 114,661 B；2.1.1 106,788 B。

## 5. 验收执行结果

### 5.1 构建/包名/版本/权限/UI/签名静态检查

~~~
JAVA_HOME=/home/lsl/.jdks/jdk-21.0.13+9
PATH="$JAVA_HOME/bin:$PATH" node e2e/check-build.mjs --with-tests
构建检查: 121 PASS / 0 FAIL / 0 SKIP
~~~

121 项 = 119 项静态检查 + band npm test + android gradle testDebugUnitTest（两项测试命令也计为 PASS）。

覆盖：

- band：manifest.package/name、deviceTypeList、features（router/storage/interconnect）、designWidth；
- band npm test（116 用例）、rpk 文件名/versionName 2.2.0/versionCode 12；
- **手环 UI v3 回归 17 项**（无顶栏、rail、3 条/页、picker/字母桶/筛选持久化、测试覆盖）；
- **手环 UI v4 回归 21 项**（2.1.2 入口内联门禁、无 pages/lock 跳转与 router.replace、pages/pin、
  5 位 TSC、三色、PBKDF2 1 次、失败锁定、rail 64px、详情/菜单、协议 v3 password/pin、单测覆盖）；
- **手环 UI v5 新增 26 项**（2.2.0）：manifest/package.json 版本、版权/菜单文案、卡片固定 98px、
  卡片字号（24/15/16）、验证码 48/46、A-Z 52×52、菜单 64×44、锁屏键 128×100、
  锁屏关闭 44×44、详情返回 72×40、用户名/密码 18px、详情验证码 60/58、菜单 56/22、
  picker 44/24、设置图案键 128×100、showLock 调用 setupChannel、channelReady 由 connect() 决定、
  channelReady 不预置 true、pin.js 默认/下限 1、uxV5 单测覆盖；
- android：gradle testDebugUnitTest（112 用例/16 类）、APK 包名/应用名/2.2.0/8、
  **无 INTERNET**、权限仅 DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION；
- **Android UI v4 回归 13 项**：PatternPin 5 位/TSC/1 次/16 B、随机 salt、设置页、set/clear/query pin、
  3 Tab、FAB + ModalBottomSheet、密码 10 s 遮罩、详情/入口图案卡、深色 token、协议 v3、单测覆盖；
- **Android UI v5 新增 13 项**（2.2.0）：PatternPin 1/1 + 固定向量、SyncProtocol PIN_ITERATIONS=1、
  PinProtocolTest 迭代 1、Bitwarden 无 totp 导入、AccountModels.hasOtp、syncableAccounts 过滤、
  BitwardenImporterTest 6+4 与 n_ id、拉起/图案/同步重试常量、发送前过滤无码账号、
  44dp 返回按钮、16sp 详情值、2.2.0 回归单测存在；
- 签名：PEM / APK 证书 / RPK 内嵌 DER 三方一致，scripts/check-signing.sh PASS，APK 与 RPK 包名一致。

明细：reports/e2e-build-result.json（121 项）。

### 5.2 e2e Node 验证

~~~
cd e2e && npm run verify
WristKey e2e verify: 171 passed, 0 failed, 171 total
~~~

| 节 | 断言数 | 说明 |
| --- | --- | --- |
| A. RFC 6238 / RFC 4226 / Steam 向量 | 28 | SHA1/SHA256/SHA512、6 个时间点；HOTP 10 向量 |
| B. 夹具覆盖矩阵与明文映射 | 13 | manifest 哈希可复现、23 条 13 导入/10 跳过、id 独立复算、分类/排序、跳过报告无 secret |
| C. Strong / Legacy 加解密 | 8 | 解密 == 明文；错误密码/头/截断拒绝；同 salt/iv 再加密逐字节一致 |
| D. 跨实现交叉验证 | 9 | tools/fixtures Python 夹具解密/再加密、映射、URI、与 tools/src/stratum.mjs 双向对拍 |
| E. otpauth:// URI 列表 | 4 | 8 导入 / 2 跳过，3 种 Steam 形式 |
| F. 协议 v2 合法会话与状态机 | 9 | 信封/大小/索引、手环回放提交、ack、手机状态机、request |
| G. 协议字段边界 | 24 | 最大字段消息 < 1KB、非法 account/Steam 丢弃、未知字段忽略、大小写容忍 |
| H. 协议非法/边界用例 | 25 | protocol/invalid-cases.json 全量回放 |
| I. 跨端 TOTP/Steam 对拍 | 25 | band-app 纯模块 vs 独立实现（RFC/HOTP/矩阵/夹具/Steam） |
| J. Bitwarden 未加密 Vault | 10 | 嗅探/映射/**7 导入 3 跳过**/Steam/无 totp 本地账号/兜底/加密负例/Android 夹具对拍 |
| K. 协议 v3（password + pin + 兼容） | 16 | v3 会话与大小、password 边界、4 个合并场景、v2→v3、旧手环忽略 v3、pin 全套、非法 pin 17 例 |
| **合计** | **171** | 0 failed |

### 5.3 e2e Python 独立验证

~~~
cd e2e && .venv/bin/python python/verify_fixtures.py
Python verify: 40 passed, 0 failed, 40 total
~~~

包括：

- Argon2id（p4 / m64MiB / t3）与 PBKDF2-SHA1 64000 参数常量校验；
- Python 独立解密 e2e 的 strong/legacy 与 tools/fixtures 的加密夹具；
- **Stratum 官方 research/stratum/extra/decrypt_backup.py 可解密 e2e strong/legacy**（仅离线校验）；
- RFC 6238 夹具账号复算、预期 13 导入/10 跳过；
- **4c 节 Bitwarden 6 项**：独立解析/映射、7 导入 3 跳过、无 totp 本地账号（n_ id、secret ""）、
  加密导出拒绝；
- **4d 节 10 项**：用 hashlib.pbkdf2_hmac/sha1 独立复算 tools protocol-v3.json 与 e2e Node 的
  valid-session / pin-set / password-merge / v2-compat 夹具（pin hash、account.id 反向校验）。

### 5.4 手环端单测

~~~
cd band-app && npm test
# tests 116 / # pass 116 / # fail 0
~~~

覆盖 TOTP/Steam、Stratum 映射与跳过、协议 v2/v3、password 合并、pin 派生/锁定、
UI v4 结构、UI v5 固定高度/锁屏建链/尺寸字号等（pin.test.mjs、protocolV3.test.mjs、
uxV4.test.mjs、uxV5.test.mjs 等，共 11 个测试文件）。

### 5.5 Android 单测

~~~
cd android-app
JAVA_HOME=/home/lsl/.jdks/jdk-21.0.13+9 ANDROID_HOME=/home/lsl/Android/Sdk \
  ./gradlew :app:testDebugUnitTest --rerun-tasks --console=plain --no-daemon
# BUILD SUCCESSFUL；test-results: 16 个测试类 / 112 tests / 0 failures / 0 errors
~~~

仅 3 条 deprecation 警告（MainActivity.kt:250 getParcelableExtra；WristKeyApp.kt:998/1794
Icons.Filled.ArrowBack），不影响结果。新增/相关：PatternPinTest（1 次迭代、固定向量）、
PinProtocolTest（迭代 1、mfa_pin_set）、BitwardenImporterTest（6 导入/4 跳过、无 totp n_ 账号）、
SyncProtocolTest（syncableAccounts 过滤）。

### 5.6 签名一致性

~~~
JAVA_HOME=$(ls -d ~/.jdks/jdk-* | sort -V | tail -1)
PATH="$JAVA_HOME/bin:$PATH" bash scripts/check-signing.sh \
  android-app/app/build/outputs/apk/release/app-release.apk \
  band-app/dist/com.flykhan.wristkey.release.2.2.0.rpk
~~~

~~~
APK 证书 SHA-256: b7cfba158655bd329acc30a81cb6f5a62815b74df93db4c4931e608851da85c4
签名 PEM SHA-256: b7cfba158655bd329acc30a81cb6f5a62815b74df93db4c4931e608851da85c4
RPK 内嵌证书 DER: 是 (offset 105146)
PASS: 包名 com.flykhan.wristkey，APK 与 RPK 使用同一证书
~~~

注意：apksigner 除 JAVA_HOME 外还需要把 `$JAVA_HOME/bin` 加入 PATH，否则报找不到 java。
check-build 与 check-signing.sh 均优先选择 *.release.*.rpk。

## 6. 本轮夹具与检查新增

### 6.1 Bitwarden 无验证码条目（2.2.0 语义）

依据 docs/bitwarden-format.md 第 53–60 行：

- login.totp 为空的 type=1 登录条目**仍导入**，hasOtp=false，id = n_ + sha1(名称|用户名|序号) 前 12 位；
- 手机列表/详情可查看名称/用户名/密码，不显示验证码与倒计时；
- 协议要求 secret 为合法 Base32，因此这类账号只存在手机本地，**不同步到手环**；
  同步前 syncableAccounts 过滤并在导入摘要单独报告数量；
- 手动编辑补上 secret 后转为普通 s_ 账号，可正常同步。

夹具与断言同步：

| 项 | 2.1.2 | 2.2.0 |
| --- | --- | --- |
| e2e bitwarden-export.json | 10 item → 6 导入/4 跳过 | 10 item → **7 导入/3 跳过**（新增 noOtp 账号 PlainLogin，id n_752d154f3d5b） |
| e2e 跳过原因 | 含 NO_TOTP | NOT_LOGIN_TYPE / INVALID_TOTP / TYPE_NOT_TOTP |
| Android 单测夹具 | 6 导入/4 跳过 | 6 导入/4 跳过（新增 NoTotp，id n_8d68002a15ee，accountName carol，secret ""；跳过含 DUPLICATE_SECRET） |
| 同步断言 | 无 | 只同步 6 个有码账号；无码账号不进快照 |

e2e/fixtures/manifest.json 记录 Bitwarden 期望 total=10/imported=7/skipped=3 与跳过码。

### 6.2 检查框架（e2e/check-build.mjs）

- 版本期望更新：rpk **2.2.0 / versionCode 12**、APK **2.2.0 / versionCode 8**；
  release rpk 文件名断言 com.flykhan.wristkey.release.2.2.0.rpk；
- 新增 **band UI v5** 静态检查 26 项、**Android UI v5** 静态检查 13 项（第 5.1 节）；
- 保持手环 UI v3（17 项）、UI v4（21 项）、Android UI v4（13 项）回归；旧的 pages/lock 独立页
  期望未恢复（2.1.2 起锁屏内联在 index）；
- 首轮 3 个 FAIL 均为 e2e 断言过时，已修正：
  1. UI v4 rail 56px → 2.2.0 源码 64px；
  2. uxV5 单测 marker 实际是正则 `this\.setupChannel\(\)`，断言改为 'setupChannel'；
  3. Android Bitwarden 注释实际为“仅手机端可见”，旧 marker “不同步到手环”不存在；
- 结果写入 reports/e2e-build-result.json；退出码 0 = 无 FAIL（SKIP 可接受）。

## 7. 安全约定核对（docs/security.md）

| 约定 | 实现/验证 |
| --- | --- |
| 图案只存派生值 | 手环/手机均 PBKDF2-HMAC-SHA256、16 B salt、1 次、32 B 输出；不保存图案本身 |
| 图案提供本地门禁 | 冷启动/闲置 2 分钟显示内联锁屏，正确图案才进主界面；VVD 已验 2.1.2 门禁逻辑 |
| 图案是界面门禁，不是数据加密密钥 | 文档明确；快照仍含明文 secret，不夸大防护 |
| 失败锁定 | 连续 5 次错锁 30 s，之后每次 +30 s；手环锁计数持久化；VVD 实测锁定期间点击被拦截 |
| PBKDF2 1 轮的取舍 | 3^5=243 组合熵极低，1 轮不提供离线穷举成本；主要防护是失败锁定与设备持有假设 |
| 密码遮罩 | 详情页默认 ••••••••，点按显示 10 s 后自动隐藏；Stratum 无密码显示“未导入密码” |
| 权限最小化 | APK 无 INTERNET，仅 Android 自动生成的 DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION |
| 调试日志 | 发布构建不打印 secret/验证码/密码/图案；本轮未做真机日志复核 |
| 测试数据 | 所有 secret 为公开测试值；Bitwarden 密码字段为 fake-* 占位 |

> 说明：password 是账号数据，随 v3 同步明文进入手环快照（与 secret 同一安全模型），
> UI 遮罩只防肩窥，不提供静态加密；与图案锁的定位一致。

## 8. 未验证项与残余风险

1. **真机未验证（中）**：2.2.0 的锁屏建链、launchWearApp 拉起、重试时序、xms/interconnect
   实际链路均无真机复验；真机日志证据仅来自用户侧 `failed: -6` 与 8 s 无 ack。VVD 只能验证
   派生耗时（1 轮约 0.2 s），不能模拟 HyperOS 3 的 xms 代理行为。
2. **PBKDF2 1 轮（已接受的取舍）**：VVD 10 轮约 2.1 s、1 轮约 0.2 s；1 轮使离线穷举 243 种图案
   几乎无成本，安全性依赖“设备在手 + 5 次失败锁 30 s 递增”。若未来提高迭代，需真机实测解锁延迟。
3. **手机拉起/重试仍可能失败（中）**：手环快应用未安装/被系统限制/蓝牙断开时，launchWearApp
   与 3 次重试仍可能超时；当前表现为手机提示未确认，属已知降级，无自动恢复保证。
4. **pin 状态 best effort（低）**：手环广播 pin_state 依赖 xms 消息回调；手机查询超时/未连接时
   显示 unknown；真机 BLE 回调未验证。
5. **无验证码账号仅手机本地（产品限制）**：协议要求 secret 为合法 Base32，n_ 账号不能同步到
   手环；用户若期望在手表查看，必须先在手机补 secret。
6. **v3 旧手环不兼容（已知限制）**：1.0.x 手环忽略 v3 begin，无法同步 password/pin；
   手机提示“手环应用版本过低”，需升级手环应用。
7. **band-app Node 警告（低）**：band-app/package.json 未声明 type=module，
   e2e verify 导入 totp.js 时出现 MODULE_TYPELESS_PACKAGE_JSON 警告，不影响正确性。
8. **rpk 构建非确定性（无风险）**：同一提交多次构建的 rpk 字节数/hash 可能因时间戳/压缩差异变化；
   manifest、版本、路由、签名一致。以交付时记录的 SHA-256 为准。

## 9. 复现命令

~~~bash
# A. 夹具与 Node/Python 验证
cd e2e && npm install
npm run fixtures
npm run verify
python3 -m venv .venv && .venv/bin/pip install -r python/requirements.txt
.venv/bin/python python/verify_fixtures.py

# B. 两端单测
cd ..
npm --prefix band-app test
cd android-app
JAVA_HOME=/home/lsl/.jdks/jdk-21.0.13+9 ANDROID_HOME=/home/lsl/Android/Sdk \
  ./gradlew :app:testDebugUnitTest --rerun-tasks assembleRelease --console=plain --no-daemon
cd ..

# C. 全量构建/版本/权限/UI/签名验收（不重建产物，跑双端单测）
JAVA_HOME=/home/lsl/.jdks/jdk-21.0.13+9
PATH="$JAVA_HOME/bin:$PATH" node e2e/check-build.mjs --with-tests

# D. 签名一致性（显式传 APK 与 release rpk；PATH 必须含 java）
JAVA_HOME=$(ls -d ~/.jdks/jdk-* | sort -V | tail -1)
PATH="$JAVA_HOME/bin:$PATH" bash scripts/check-signing.sh \
  android-app/app/build/outputs/apk/release/app-release.apk \
  band-app/dist/com.flykhan.wristkey.release.2.2.0.rpk
~~~

## 10. 附录

### 10.1 夹具文件哈希（fixtures/manifest.json）

| 文件 | 字节 | SHA-256 |
| --- | --- | --- |
| plain-backup.json | 9117 | 08fec2213cb649aab13ffb030ef29aca4a1c1f1573a7b790ba7b1929012c5da0 |
| expected-import.json | 6314 | c6e85738422cc374e24bf4fea17c8bed5c37337d6e7e5a0c36516b9aa7ff9b5a |
| strong.stratum | 9177 | 0f2e4ede24e65e98f5353299373e54429eb8875688873bf1ad73931039a03b47 |
| legacy.stratum | 9172 | e09d27f3aba2aade51e028ce8afe2f0d9ec426bbdb89b4a6bdecaa33e9ec96f6 |
| uri-list.txt | 1060 | 84579b76426b442bea8a324187a95787f386ad6800eb177d14861df51e09b886 |
| protocol/valid-session.json | 7227 | 7033463ae3c5872ff7540951a154a2b62d907c0c430582e47269d360555f67ef |
| protocol-v3/valid-session.json | 12031 | 554b05a69058cc455adef82650e631b497faf6a7bff270ec319a4fab45f20c41 |
| protocol-v3/password-merge.json | 9765 | 8a9d75e7720d7a6f69907601e5095e3edd0e428163fc1409b6258992d494ae93 |
| protocol-v3/v2-compat-session.json | 3530 | b34727dd4542ce75d870f9ba53bce7e650642a93a4bf844f5d6bc7fce155a090 |
| protocol-v3/pin-set.json | 1254 | 8f6f62da3295b337b02a6b892876824c6965dc463ef4130f85ab439172b6624c |
| protocol-v3/pin-ack.json | 2719 | 991201e262e98c5f858d4a2f2c7171b2e011fb7b4c0d5f67aa69d46070a57228 |
| protocol-v3/pin-query-state.json | 998 | ffd86e2c556d7dfa487d0d790b99fba214f25ac5f43f4449e90cbbc95f19177a |
| protocol-v3/pin-clear.json | 562 | 7a13cada00a38540f6b968f4ff5f972409facdcfe0d93bb6ea6b0ec90371e392 |
| protocol-v3/invalid-pin.json | 7140 | c5347b9b566a76b537091a343d3146157bf5182e8032c217e06e3070a3163be2 |
| bitwarden-export.json | 3386 | 9fb083c28636361d5adf9eb01ba4a38590c45b92e568fbc9072df460650659dd |
| bitwarden-encrypted-export.json | 266 | 9fc2c8da5355a55f382878308ac748ca8ee8b0ad6fad54406835c220aeaa29f2 |
| bitwarden-expected-import.json | 2968 | a755fcf74523afa065610f1095df620743088fdee3878321da4c3da85456fda6 |

### 10.2 本次验收日志与结果

- check-build 完整结果：reports/e2e-build-result.json（121 项，全部 PASS）；
- Node verify：e2e/verify-result.json（171 项，171 passed）；
- Python：40 项（命令输出见终端）；
- band npm test：116 项；Android test-results：16 个 XML / 112 tests；
- 签名：scripts/check-signing.sh 输出见 5.6，RPK DER offset 105146。

### 10.3 相关文档

- docs/protocol.md（v3）、docs/security.md、docs/stratum-format.md、docs/bitwarden-format.md；
- docs/design/ui-v4-analysis.md、docs/design/android-v2-spec.md、docs/design/ui-v3-spec.md；
- e2e/README.md（夹具/框架用法、覆盖矩阵、2.2.0 检查说明）。
