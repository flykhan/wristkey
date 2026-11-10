# WristKey 端到端验收报告 v5（v2.1.0：包名迁移 com.flykhan.wristkey + 发布规范；含 v2.0.1/v2.0.2 回归修复）

- 任务：task-14（QA：v2.0 全量验收）；v2.0.1 解锁回弹、v2.0.2 页面栈回归、v2.1.0 包名迁移与发布由 Lead 复验
- 执行：qa，2026-11-10 20:00 (Asia/Shanghai)
- 结论：**PASS** —— v2.0 的入口图案锁屏、协议 v3（password/pin）、手环 UI v4 与 Android 重设计均已实现并通过自动化验证：
  band-app **106/106**、android-app JVM **106/106（16 个测试类）**、Node e2e **171/171**、Python **40/40**；
  构建/包名/版本/权限/UI/签名检查 **82 PASS / 0 FAIL / 0 SKIP**；APK 与 .rpk 同证书、包名一致。
- 本轮未发现 band-app / android-app 实现 bug。唯一调整是 e2e 自身的 v3 picker 静态检查与新分页网格不匹配，
  已按 v4 架构更新检查逻辑（非产品缺陷，详见 6.2）。
- **v2.0.1 回归修复（2026-11-10 20:56）**：真机反馈“输完图案没有进入下一屏”。根因是 Vela 每页独立打包，
  内存中的解锁时间戳不跨页面共享，index 读不到后跳回锁屏。改为把解锁时间戳写入 `@system.storage`
  （`wristkey_unlock_v1`），lock 页写成功后再导航，index/app.ux 异步读取；2 分钟闲置重锁、冷启动清除。
  手环 2.0.1 / versionCode 7：band 105/105、e2e 171/171、构建检查 82 PASS、签名 PASS。
- **v2.0.2 回归修复（2026-11-10 21:10）**：用户复测仍无法进入主界面。手环日志显示
  `PageNavigator getState error: empty stack!` 与 `state_error`。根因是入口 `/pages/index` 在 onInit 与 onShow
  各上锁一次、app.ux onShow 再上锁，且锁屏/解锁都用 `router.replace`，把页面栈清空。改为**入口 push 锁屏、
  解锁 back、只在 onShow 做一次门禁、app.ux 只处理非入口页重锁、移除全部 replace**。
  手环 2.0.2 / versionCode 8：band 106/106（新增页面栈回归用例）、e2e 171/171、Python 40/40、
  构建检查 80 PASS / 0 FAIL、签名 PASS。
- **v2.1.0 发布准备（2026-11-10 21:29）**：包名由 `dev.wristkey.app` 迁移到 **`com.flykhan.wristkey`**
  （域名 flykhan.com；全仓库 60 个文件 + Kotlin 源码目录 git mv），两端版本升到 **2.1.0**
  （手环 versionCode 9 / 手机 versionCode 5）。重建后 band 106/106、Android 106/106、Node 171/171、
  Python 40/40、check-build 82 PASS / 0 FAIL、签名三方一致。因包名变化，2.0.x 不能覆盖升级，需先卸载旧包。
- 未覆盖：小米手环 10 Pro 真机上的 UI v4/图案交互与 pin 状态同步，见第 8 节。

## 1. v2.0 交付范围与 UI v4 实现

### 1.1 手环端（rpk 2.1.0 / versionCode 9；v2.0 功能 + 持久化解锁会话 + 页面栈修复 + 包名迁移）

依据 docs/design/ui-v4-analysis.md：

- **入口图案锁屏**：入口 pages/index 只在 onShow 做一次门禁，调用 `router.push('/pages/lock')`；
  解锁成功 `router.back()`；app.ux 只对**非入口页**在离开超过 2 分钟后重新上锁（2.0.2 起彻底移除 replace）。
- **锁屏 pages/lock**：5 个图案槽位、T/S/C 三个图形键、顶部 5 个进度圆点、左上角 X 退出、
  输错抖动并清空；图案规范串为 5 位 /^[TSC]{5}$/（3^5 = 243 种组合）。
- **三色固定**：三角形 = 薄荷绿 #6EE7C7、方形 = 雾蓝 #7AA2F7、圆形 = 暖橙 #F2B880。
- **入口图案设置页 pages/pin**：设置/确认/管理模式；派生 **PBKDF2-HMAC-SHA256**，16 字节随机 salt、
  1200 次迭代、32 字节输出；只保存派生值（wristkey_pin_v1），不保存图案本身。
- **失败锁定**：连续错 5 次锁 30 s，之后每错一次 +30 s；锁计数持久化（wristkey_pin_lock_v1）。
- **主界面 index**：无顶栏，账号 3 条/页；右侧 56px rail（A-Z 圆钮、筛选账号数、页码、菜单按钮）；
  手势保留（上下翻页、右滑菜单、左滑退出）。
- **首字母筛选页 pages/picker**：4 列 × 4 行、共 3 页（P1 A–P；P2 Q…5；P3 6…9/#/全部/空白），
  上下滑动翻页，底部 3 个圆点 + X/右滑关闭；每格右下显示账号数。
- **详情页 pages/detail**：用户名 = accountName、密码 = 可选 password（遮罩 ••••••••，点按显示 10 s；
  Stratum 无密码显示“未导入密码”）、验证码大号 + 进度条。
- **菜单 pages/menu（4 项）**：入口密码 / 立即同步 / 关于 / 退出应用；分类入口已彻底移除。
- **协议 v3 手环侧**：syncProtocol.js PROTOCOL_VERSION=3、SUPPORTED_PROTOCOL_VERSIONS=[2,3]；
  account 支持 password，新增 mfa_pin_set/query/clear/ack/state；
  mfaConfig 活动存储键 mfa_snapshot_v3，保留 mfa_snapshot_v2 供回滚。

### 1.2 手机端（APK 2.1.0 / versionCode 5）

依据 docs/design/android-v2-spec.md：

- **3 个底部 Tab**：账号 / 同步 / 设置（NavigationBar + MainTab）。
- **深色 token**：bg #0B0F0E、surface #121A16、mint #6EE7C7、warning #F2B880、steamBlue #7AA2F7；
  账号卡显示 issuer + accountName + 验证码 + 秒数 + 进度条，Steam 5 位码带 STEAM 标签。
- **FAB 导入**：floatingActionButton + ImportEntriesSheet + ModalBottomSheet 四入口
  （Stratum / Bitwarden / otpauth / 手动）。
- **账号详情 ModalBottomSheet**：用户名、密码（默认遮罩，10 s 后自动隐藏，可复制）、验证码、编辑/删除。
- **入口图案设置页**：PatternScreen / PatternDot / PatternButton，5 位图案 + 三图形、两次确认；
  PatternPin.kt 使用 PBKDF2WithHmacSHA256、1200 次、16 字节 SecureRandom salt；
  MainActivity 调用 PatternPin.newSaltHex()/derive() 并 controller.setPin()/clearPin()/queryPin()，
  设置后发送 mfa_pin_set 等 ack，关闭发送 mfa_pin_clear。
- **同步页**：4 状态胶囊 + 立即同步 + 入口图案卡（mfa_pin_query，enabled true/false/unknown）。
- **权限最小化**：release APK 唯一权限 com.flykhan.wristkey.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION，
  **无 INTERNET**（离线应用）。

## 2. 同步协议 v3（docs/protocol.md）

### 2.1 版本兼容矩阵

| 手机 | 手环 | 行为 |
| --- | --- | --- |
| v3（2.0） | v2（1.0.x） | 手环忽略 begin（version 不匹配），不同步；手机 8 s 无 ack 提示“手环应用版本过低” |
| v3（2.0） | v3（2.0） | 完整同步，含 password 与 pin 消息 |
| v2（1.x） | v3（2.0） | 手环接受 version=2 的 begin/account/commit，无 password；快照 version=2，写活动键 mfa_snapshot_v3 |
| v2（1.x） | v2（1.0.x） | 原 v2 行为不变 |

- 手环解析同步消息接受 version ∈ {2, 3}；account.password 仅 v3 可选字段，v2 视为无密码；
- 手机解析手环消息接受 {2, 3}；pin 相关消息仅接受 version == 3；
- 未知 type / version 必须忽略，单条消息 < 1 KiB。

### 2.2 password 字段与合并语义

- 类型字符串，≤128 字符；允许空格与 Unicode，禁止 U+0000–U+001F 控制字符；
- 空串等同缺省；缺省表示“手机端没有密码”；
- 同一 account.id 再次同步：**缺省=保留旧值、显式空串=清空、非空=覆盖**，同一轮可混合；
- 手机 2.0 的全量同步策略：每条 account 都带 password，有密码发实际值、无密码发空串
  （手机是数据源，删除密码会同步到手表）。

### 2.3 入口图案消息（pin）

| 消息 | 方向 | 语义 |
| --- | --- | --- |
| mfa_pin_set | 手机 → 手环 | pin{algorithm:"PBKDF2-SHA256", salt 32 hex, hash 64 hex, iterations 1000–20000}；成功写 wristkey_pin_v1 并广播 mfa_pin_state |
| mfa_pin_query | 手机 → 手环 | 查询状态；手环回 mfa_pin_state（回填同一 requestId） |
| mfa_pin_clear | 手机 → 手环 | 删除图案与失败计数；ack {ok:true, enabled:false} |
| mfa_pin_ack | 手环 → 手机 | 成功 {ok:true, enabled} 不得带 error；失败 error ∈ invalid_pin_payload / invalid_version / storage_error |
| mfa_pin_state | 手环 → 手机 | enabled、updatedAt、requestId（广播时省略） |

- 非法 pin 载荷 → invalid_pin_payload，**旧图案不变**；pin 消息 version≠3 → invalid_version；
- 图案格式 /^[TSC]{5}$/；PBKDF2-SHA256 / 16 B salt / 1200 次 / 32 B 输出为两端默认值。

### 2.4 其他确定性约定

- account.id = s_ + sha1(归一化 secret) 前 12 位；归一化 = 大写、去空白/-/=；
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
| 时间 | 2026-11-10 20:00 CST |
| 真机 | **无** |

## 4. 产物清单与校验值

| 产物 | 路径 | 大小 | SHA-256 | 关键属性 |
| --- | --- | --- | --- | --- |
| band .rpk | band-app/dist/com.flykhan.wristkey.release.2.1.0.rpk | 114,661 B | 34e1fcd0fed80ffd1551bd749d93d4bffed30840bcc508ef3efd3302949aa2f0 | package=com.flykhan.wristkey，name=腕证，versionName=2.1.0，versionCode=9，deviceTypeList=[watch] |
| android release APK | android-app/app/build/outputs/apk/release/app-release.apk | 26,492,673 B | 4c1647243fcd96aaebe474eb22ec6124936eb32c69d6c6d45d4fc344198f2676 | package=com.flykhan.wristkey，label=腕证，versionName=2.1.0，versionCode=5，minSdk 28，targetSdk 36 |
| 发布归档 | releases/v2.1.0/（及根目录 成功/） | — | 见 SHA256SUMS | wristkey-band-v2.1.0.rpk、wristkey-android-v2.1.0.apk、SHA256SUMS |
| 签名证书 PEM | signing/rpk-sign/certificate.pem | — | SHA-256 指纹 b7cfba158655bd329acc30a81cb6f5a62815b74df93db4c4931e608851da85c4 | CN=WristKey Dev, OU=WristKey, O=WristKey, C=CN |
| 测试夹具 | e2e/fixtures/（含 protocol-v3/） | 见 10.1 | 见 10.1 | 确定性生成，密码 test-password |

> 历史：v2.0.0 rpk 113,923 B、v2.0.1 114,700 B、v2.0.2 114,640 B（构建含时间戳，非确定性）。
> v2.1.0 迁移包名后 rpk 为 114,661 B、APK 为 26,492,673 B。
> .rpk 内嵌证书 DER 命中 offset 110635；APK 证书 = PEM = b7cfba…85c4。

## 5. 验收执行结果

### 5.1 构建/包名/版本/权限/UI/签名静态检查

~~~
node e2e/check-build.mjs --build --with-tests   # 重建 rpk+APK、双端单测、全量检查
构建检查: 82 PASS / 0 FAIL / 0 SKIP
~~~

覆盖：

- band：manifest.package/name、deviceTypeList、features（router/storage/interconnect）、designWidth；
- band npm test（106 用例）、npm run release；rpk 文件名 com.flykhan.wristkey.release.2.1.0.rpk、
  versionName 2.1.0、versionCode 9；
- **手环 UI v3 回归检查 17 项**（无顶栏、56px rail、ACCOUNTS_PER_PAGE=3、picker 路由/字母桶、测试覆盖），
  其中 picker 的“全部/#”检查已兼容 v4 分页网格（由 settings.js PICKER_PAGE_KEYS 提供）；
- **手环 UI v4 检查 20 项**：冷启动锁屏跳转、持久化解锁会话（pinSessionStore）、pages/lock、pages/pin、5 位 TSC 正则、三色、
  PBKDF2 1200/16 B、失败锁定 5 次/30 s、只存派生值与锁计数、rail 56px + 菜单 + 3 条/页、
  picker 4×4×3/全部、详情 username/password/code、密码遮罩 10 s、菜单 4 项、
  协议 v3 password/pin 消息、mfa_snapshot_v3、单测覆盖；
- android：gradle testDebugUnitTest assembleRelease（106 用例/16 类）、APK 包名/应用名/2.1.0/5、
  **无 INTERNET**、权限仅 DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION；
- **Android UI v4 检查 13 项**：PatternPin 5 位/TSC/PBKDF2 1200/16 B、随机 salt、设置页、
  set/clear/query pin、3 Tab、FAB + ModalBottomSheet、密码 10 s 遮罩、详情/入口图案卡、
  深色 token、协议 v3 password/pin、单测存在与覆盖；
- 签名：PEM / APK 证书 / RPK 内嵌 DER 三方一致，scripts/check-signing.sh PASS，APK 与 RPK 包名一致。

明细：reports/e2e-build-result.json（82 项）。

### 5.2 e2e Node 验证

~~~
cd e2e && npm run verify
WristKey e2e verify: 171 passed, 0 failed, 171 total
~~~

| 节 | 断言数 | 说明 |
| --- | --- | --- |
| A. RFC 6238 / RFC 4226 / Steam 向量 | 28 | SHA1/SHA256/SHA512、T=59/1111111109/1111111111/1234567890/1640846388/1735689600；HOTP 10 向量 |
| B. 夹具覆盖矩阵与明文映射 | 13 | manifest 哈希可复现、23 条 13 导入/10 跳过、id 独立复算、分类/排序、跳过报告无 secret |
| C. Strong / Legacy 加解密 | 8 | 解密 == 明文；错误密码/头/截断拒绝；同 salt/iv 再加密逐字节一致 |
| D. 跨实现交叉验证 | 9 | tools/fixtures Python 夹具解密/再加密、映射、URI、与 tools/src/stratum.mjs 双向对拍 |
| E. otpauth:// URI 列表 | 4 | 8 导入 / 2 跳过，3 种 Steam 形式 |
| F. 协议 v2 合法会话与状态机 | 9 | 信封/大小/索引、手环回放提交、ack、手机状态机、request |
| G. 协议字段边界 | 24 | 最大字段消息 < 1KB、非法 account/Steam 丢弃、未知字段忽略、大小写容忍 |
| H. 协议非法/边界用例 | 25 | protocol/invalid-cases.json 全量回放 |
| I. 跨端 TOTP/Steam 对拍 | 25 | band-app 纯模块 vs 独立实现（RFC/HOTP/矩阵/夹具/Steam） |
| J. Bitwarden 未加密 Vault | 10 | 嗅探/映射/6 导入 4 跳过/Steam/兜底/加密负例/Android 夹具对拍 |
| **K. 协议 v3（password + pin + 兼容）** | **16** | v3 会话与大小、password 边界、4 个合并场景、v2→v3、旧手环忽略 v3、8 s 超时、pin 全套、非法 pin 17 例 |

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
- **4d 节 10 项**：用 hashlib.pbkdf2_hmac/sha1 独立复算 tools protocol-v3.json 与 e2e Node 的
  valid-session / pin-set / password-merge / v2-compat 夹具（pin hash、account.id 反向校验）。

### 5.4 手环端单测

~~~
cd band-app && npm test
# tests 105 / # pass 105 / # fail 0
~~~

覆盖 TOTP/Steam、Stratum 映射与跳过、协议 v2/v3、password 合并、pin 派生/锁定、UI v4 结构等
（pin.test.mjs、protocolV3.test.mjs、uxV4.test.mjs 等）。

### 5.5 Android 单测

~~~
cd android-app
JAVA_HOME=/home/lsl/.jdks/jdk-21.0.13+9 ANDROID_HOME=/home/lsl/Android/Sdk \
  ./gradlew testDebugUnitTest --console=plain --no-daemon
# BUILD SUCCESSFUL；test-results: 16 个测试类 / 106 tests / 0 failures / 0 errors
~~~

新增/相关：PatternPinTest（派生与 1200 次）、PinProtocolTest（mfa_pin_set 等）、
MergePasswordTest（缺省保留/空串清空/覆盖）。

### 5.6 签名一致性（bash scripts/check-signing.sh，默认参数）

~~~
APK 证书 SHA-256: b7cfba158655bd329acc30a81cb6f5a62815b74df93db4c4931e608851da85c4
签名 PEM SHA-256: b7cfba158655bd329acc30a81cb6f5a62815b74df93db4c4931e608851da85c4
RPK 内嵌证书 DER: 是 (offset 110630)
PASS: 包名 com.flykhan.wristkey，APK 与 RPK 使用同一证书
~~~

check-build 与 check-signing.sh 均优先选择 *.release.*.rpk。

## 6. 本轮夹具与检查新增

### 6.1 协议 v3 夹具（e2e/fixtures/protocol-v3/，8 个）

| 夹具 | 内容 |
| --- | --- |
| valid-session.json | v3 合法同步 13 账号（前 3 个带 password：普通口令 / Unicode 口令 / 空串）；最大消息 430 B |
| password-merge.json | 4 个密码合并场景（缺省保留 / 空串清空 / 覆盖 / 混合），含 initialSnapshot 与 expected.passwords |
| v2-compat-session.json | v2 手机消息（version=2、无 password）→ v3 手环；预期快照 version=2、storageKey=mfa_snapshot_v3 |
| pin-set.json | 合法 mfa_pin_set（PIN_PATTERN=TSCCT、PBKDF2-SHA256、salt 16 B、iterations 1200、hash 32 B） |
| pin-ack.json | 10 个 ack 合法/非法用例（成功不带 error；失败原因码白名单） |
| pin-query-state.json | pin_query → pin_state（requestId 回填；广播省略 requestId） |
| pin-clear.json | pin_clear → ack/state enabled=false，失败计数归零 |
| invalid-pin.json | 17 个非法 pin 载荷/版本用例（失败不覆盖旧图案） |

另：tools/fixtures/generate.py 新增 protocol-v3.json，由 **纯 Python 独立生成**
（3 个账号 GitHub/Google/AWS + password 场景 + pin set/query/clear），用于跨语言对拍；
python/verify_fixtures.py 4d 节 10 项独立复算。

### 6.2 检查框架（e2e/check-build.mjs）

- 版本期望更新：rpk **2.1.0 / versionCode 9**、APK **2.1.0 / versionCode 5**；
  新增 release rpk 文件名断言 com.flykhan.wristkey.release.2.1.0.rpk；
- 新增 APK 权限检查：无 INTERNET；权限列表仅允许 *DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION；
- 新增手环 UI v4 静态检查 20 项、Android UI v4 静态检查 13 项（第 5.1 节）；
- 保留手环 UI v3 回归检查 17 项；picker 的“全部/#”检查改为同时接受
  v3 旧字母桶渲染与 v4 PICKER_PAGE_KEYS/buildPickerPage 分页网格。
  这是 e2e 检查逻辑适配，不是 band-app 实现问题。
- 结果写入 reports/e2e-build-result.json；退出码 0 = 无 FAIL（SKIP 可接受）。

## 7. 安全约定核对（docs/security.md）

| 约定 | 实现/验证 |
| --- | --- |
| 图案只存派生值 | 手环/手机均 PBKDF2-HMAC-SHA256、16 B salt、1200 次、32 B 输出；不保存图案本身 |
| 图案是界面门禁，不是数据加密密钥 | 文档明确；快照仍含明文 secret，报告不夸大防护 |
| 失败锁定 | 连续 5 次错锁 30 s，之后每次 +30 s；手环锁计数持久化，冷启动/重锁后仍生效 |
| 密码遮罩 | 详情页默认 ••••••••，点按显示 10 s 后自动隐藏；Stratum 无密码显示“未导入密码” |
| 权限最小化 | APK 无 INTERNET，仅 Android 自动生成的 DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION |
| 调试日志 | 发布构建不打印 secret/验证码/密码/图案（check-build 未发现 UI 明文日志；真机日志未验证） |
| 测试数据 | 所有 secret 为公开测试值；Bitwarden 密码字段为 fake-* 占位 |

> 说明：password 是账号数据，随 v3 同步明文进入手环快照（与 secret 同一安全模型），
> UI 遮罩只防肩窥，不提供静态加密；与图案锁的定位一致。

## 8. 未验证项与残余风险

1. **真机未验证（中）**：小米手环 10 Pro 上的锁屏/图案设置/失败锁定、重锁时机、
   4×4×3 picker 滑动分页、详情页密码 10 s 遮罩，以及手机设置/清除图案后手环 pin 状态同步，
   均未实机复验；需真机走“安装 → 导入 → 同步 → 设置图案 → 冷启动/重锁 → 手环与手机改/关”全流程。
2. **PBKDF2 纯 JS 性能（中/低）**：手环端图案派生为纯 JS PBKDF2-SHA256 1200 次，
   低端设备解锁可能有可感知延迟；本轮未做真机耗时测量，建议真机确认并在必要时调低默认迭代
   （协议下限 1000）。
3. **pin 状态为 best effort（低）**：手环广播 pin_state 依赖 xms 消息回调；
   手机查询超时/未连接时显示 unknown，属预期降级；真机 BLE 回调未验证。
4. **v3 旧手环不兼容（已知限制）**：1.0.x 手环忽略 v3 begin，无法同步 password/pin；
   手机仅提示“手环应用版本过低”，需用户升级手环应用。
5. **band-app Node 警告（低）**：band-app/package.json 未声明 type=module，
   e2e verify 导入 totp.js 时出现 MODULE_TYPELESS_PACKAGE_JSON 警告，不影响正确性。
6. **rpk 构建非确定性（无风险）**：同一提交多次构建的 rpk 字节数/hash 可能因时间戳/压缩差异变化；
   manifest、版本、路由、签名一致。以 `SHA256SUMS` 记录的交付件为准。

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
JAVA_HOME=/home/lsl/.jdks/jdk-21.0.13+9 ANDROID_HOME=/home/lsl/Android/Sdk ./gradlew testDebugUnitTest assembleRelease --console=plain --no-daemon
cd ..

# C. 全量构建/版本/权限/UI/签名验收（重建 rpk+APK + 双端单测）
node e2e/check-build.mjs --build --with-tests

# D. 签名一致性（默认参数优先选 release rpk）
JAVA_HOME=$(ls -d ~/.jdks/jdk-* | sort -V | tail -1)
PATH="$JAVA_HOME/bin:$PATH" bash scripts/check-signing.sh
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
| protocol-v3/pin-set.json | 1266 | 2e57d8f1c46f66143954d5b9a1977abf308c2179e1e9917a2e4d81e796fd4ec8 |
| protocol-v3/pin-ack.json | 2719 | 991201e262e98c5f858d4a2f2c7171b2e011fb7b4c0d5f67aa69d46070a57228 |
| protocol-v3/pin-query-state.json | 1001 | 206c63fe81e7e5b215cfec8c7a19ac7331b9fdb98443b9432f97773b096f9784 |
| protocol-v3/pin-clear.json | 562 | 7a13cada00a38540f6b968f4ff5f972409facdcfe0d93bb6ea6b0ec90371e392 |
| protocol-v3/invalid-pin.json | 7171 | 44eabb80783f63d5518fe6d984474fd3b1b9f56c4cf760301fec244e5faacbbb |
| bitwarden-export.json | 3386 | 9fb083c28636361d5adf9eb01ba4a38590c45b92e568fbc9072df460650659dd |
| bitwarden-encrypted-export.json | 266 | 9fc2c8da5355a55f382878308ac748ca8ee8b0ad6fad54406835c220aeaa29f2 |
| bitwarden-expected-import.json | 2871 | b091607b0f270b6e1e7d245bf535b2e8308c12a5e5d93dca54cf77a186cda802 |

### 10.2 本次验收日志与结果

- check-build 完整日志：/tmp/t14-check-build.log（82 项）；
- Node verify：e2e/verify-result.json（171 项，171 passed）；
- 构建检查：reports/e2e-build-result.json（82 项）；
- Python：40 项（命令输出见终端）。

### 10.3 相关文档

- docs/protocol.md（v3）、docs/security.md、docs/stratum-format.md、docs/bitwarden-format.md；
- docs/design/ui-v4-analysis.md、docs/design/android-v2-spec.md、docs/design/ui-v3-spec.md；
- e2e/README.md（夹具/框架用法、覆盖矩阵、UI v4 检查说明）。
