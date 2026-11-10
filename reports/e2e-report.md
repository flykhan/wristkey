# WristKey 端到端测试报告（v1 — 夹具与验证框架）

- 任务：task-4（e2e 测试夹具与验证框架）
- 执行：qa，2026-11-10 15:30 (Asia/Shanghai)
- 状态：**夹具与验证框架完成并通过**；构建产物/签名验证**待 band-app 与 android-app 构建完成后补跑**
  （见“待完成”一节，复现命令已给出）
- 结论摘要：Node 端 121/121 断言通过，Python 独立验证 17/17 通过；
  跨实现双向交叉验证全部一致；当前 check-build 静态检查 3 项 FAIL 均来自
  band-app/dist 下**参考实现遗留的旧 .rpk**（非本项目产物），需清理后重新构建。

## 1. 环境

| 项 | 值 |
| --- | --- |
| OS | Linux（x86_64） |
| Node | v22.22.2 |
| npm | 10.9.7 |
| Python | 3.14.8（e2e/.venv，argon2-cffi 25.1.0 + cryptography 50.0.2） |
| JDK | /home/lsl/.jdks/jdk-21.0.13+9 |
| Android SDK | ~/Android/Sdk/build-tools 34.0.0 / 36.1.0 / 37.0.0 |
| 真机 | **无**（小米手环 10 Pro 真机链路未验证，见风险） |

依赖：e2e/package.json（私有，type=module，devDependency hash-wasm ^4.13.0）；
Python 依赖见 e2e/python/requirements.txt。

## 2. 产物清单

| 路径 | 说明 |
| --- | --- |
| e2e/fixtures/plain-backup.json | 明文 Stratum 备份：11 导入 + 11 跳过，覆盖算法/digits/period/分类/排序/边界 |
| e2e/fixtures/expected-import.json | 参考映射结果（协议 account + 跳过报告 + 统计） |
| e2e/fixtures/strong.stratum | Strong 加密（Argon2id p4 m65536 t3 + AES-256-GCM），密码 test-password |
| e2e/fixtures/legacy.stratum | Legacy 加密（PBKDF2-SHA1 64000 + AES-256-CBC/PKCS7），密码 test-password |
| e2e/fixtures/uri-list.txt | otpauth:// 列表（5 导入 + 2 跳过） |
| e2e/fixtures/protocol/valid-session.json | 合法同步序列（1 begin + 11 account + 1 commit，最大消息 400B） |
| e2e/fixtures/protocol/invalid-cases.json | 19 个非法/边界用例与逐条期望 |
| e2e/fixtures/manifest.json | 文件 SHA-256、加密参数、salt/iv、覆盖矩阵 |
| e2e/fixtures/generate.mjs | 确定性生成器（固定 salt/iv/时间戳，可复现） |
| e2e/verify.mjs | 主验证入口（A–I 九节，退出码 0/1） |
| e2e/check-build.mjs | 构建产物 + 包名 + 签名一致性检查 |
| e2e/python/verify_fixtures.py | Python 独立解密 + RFC 向量验证（第三方语言实现） |
| e2e/verify-result.json | 最近一次 Node 验证的逐项结果 |
| reports/e2e-build-result.json | 最近一次构建检查的逐项结果 |

## 3. 已执行命令与结果

### 3.1 夹具生成

~~~
cd e2e && npm install && npm run fixtures
夹具已生成：.../e2e/fixtures
  明文 8559 bytes，映射 11 导入 / 11 跳过
  strong 8619 bytes，legacy 8612 bytes，uri 7 行
  协议消息 13 条（syncId=sync-1760000000000-e2e）
~~~

重复执行生成器的产物 SHA-256 不变（确定性，manifest 自校验通过）。

### 3.2 Node 端验证 e2e/verify.mjs

~~~
cd e2e && npm run verify
WristKey e2e verify: 121 passed, 0 failed, 121 total
~~~

| 节 | 断言数 | 结果 |
| --- | --- | --- |
| A. RFC 6238 / RFC 4226 向量（独立 node:crypto 实现） | 21 | 全过 |
| B. 夹具覆盖矩阵与明文映射（id 独立复算、排序、分类 Id、哈希） | 12 | 全过 |
| C. Strong / Legacy 加解密一致性（错误密码/头部/截断、再加密逐字节一致） | 8 | 全过 |
| D. 跨实现交叉验证（Python 夹具 + tools/src/stratum.mjs 双向） | 9 | 全过 |
| E. otpauth:// URI 列表 | 2 | 全过 |
| F. 协议 v2 合法会话与双端状态机 | 9 | 全过 |
| G. 协议字段边界（最大字段 538B < 1KB；13 类非法 account 丢弃） | 18 | 全过 |
| H. 协议非法/边界用例回放（invalid-cases.json 19 例） | 19 | 全过 |
| I. 跨端 TOTP：band-app 纯模块 vs 独立实现 | 23 | 全过 |

I 节明细：RFC 6238 18 组向量、RFC 4226 10 组 HOTP、3 算法 × 5 digits × 5 period × 5 时间
= 375 组矩阵对拍、夹具 11 个账号 × 2 时间点 = 22 次对拍。

### 3.3 Python 独立验证（第三方语言实现）

~~~
cd e2e && .venv/bin/python python/verify_fixtures.py
Python verify: 17 passed, 0 failed, 17 total
~~~

关键项：
- e2e strong.stratum / legacy.stratum 用 Python 独立解密，JSON 与明文语义一致；
- **Stratum 官方 extra/decrypt_backup.py（GPL-3.0，仅离线校验）可解密 e2e 两个加密夹具**；
- tools/fixtures 的 strong/legacy 同样可解密；
- 明文备份中的 3 个 RFC6238 账号在 T=59/1111111109/1111111111/1234567890 复算结果与 RFC 表一致；
- 头部/长度/参数常量与 docs/stratum-format.md 一致。

### 3.4 手环端单测（只读运行，band-app 仍在开发中）

~~~
cd band-app && npm test
# tests 47 / pass 47 / fail 0
~~~

### 3.5 构建产物静态检查（当前状态，非终态）

~~~
node e2e/check-build.mjs
构建检查: 5 PASS / 3 FAIL / 4 SKIP
~~~

3 项 FAIL（**均为参考实现遗留物，不是 WristKey 产物问题**）：

- band-app/dist/asia.bilibili.mfa.debug.1.2.1.rpk 的 manifest.package = asia.bilibili.mfa（期望 dev.wristkey.app）；
- 同一文件的 manifest.name = 腕码（期望 腕证）；
- 该旧 .rpk 未内嵌 signing/rpk-sign/certificate.pem 证书。

SKIP：band-app/src/manifest.json 尚未生成（band-dev 进行中）、Android APK 未产出。

>> 风险：band-app/dist 下若同时存在旧 rpk 与新 rpk，scripts/check-signing.sh 默认取
>> ls band-app/dist/*.rpk | head -1（字典序），会优先命中 asia.bilibili.mfa... 旧文件。
>> 建议 band-dev 构建前清空 band-app/dist，或脚本改为按 mtime 取最新。

当前签名材料指纹（signing/rpk-sign/certificate.pem）：
SHA-256 = b7cfba158655bd329acc30a81cb6f5a62815b74df93db4c4931e608851da85c4

## 4. 交叉验证证据（双向、非自证）

| # | 方向 | 证据 |
| --- | --- | --- |
| 1 | e2e 密文 → Python 独立解密 | e2e/python/verify_fixtures.py 全部通过 |
| 2 | e2e 密文 → Stratum 官方工具 | decrypt_backup.py 解密 strong/legacy 均成功，JSON 一致 |
| 3 | tools/fixtures（Python）→ e2e Node 解密 | Node 解密成功，JSON 语义一致 |
| 4 | e2e 密文 → tools/src/stratum.mjs | 另一套 Node 实现解密成功 |
| 5 | 固定 salt/iv 再加密 | 用 tools 夹具固定 salt/iv 重加密其明文，与 Python 产物**逐字节一致** |
| 6 | 映射对拍 | e2e 与 tools/src/stratum.mjs 对同一备份按 id 集合完全一致（e2e 11/11、tools 3/5） |
| 7 | TOTP 跨端 | band-app totp.js 与 e2e 独立实现：RFC 向量 + 375 组矩阵 + 22 次夹具账号一致 |

## 5. 夹具覆盖矩阵

明文备份 22 条 Authenticator = 11 条导入 + 11 条跳过：

| 维度 | 覆盖 |
| --- | --- |
| 算法 | SHA1 / SHA256 / SHA512 |
| digits | 6 / 8 / 10 |
| period | 15 / 30 / 60 |
| 分类 | 开发 / 个人 / 云服务 / 社交 / 默认分类；GitHub 多分类取 Ranking 最小者（社交） |
| 边界 | secret 带 = 填充（归一化）、Unicode issuer/username、issuer 空、username 空 |
| 跳过 | HOTP(Type=1)、Steam(Type=4)、Mobile-OTP(Type=3)、非法 Base32、空 secret、period 4/301、digits 5/11、issuer+username 全空、Algorithm=7 |

跳过的 11 条在 expected-import.json 中带 code 与原因（不含 secret）。

## 6. 待完成（阻塞于其他任务）

| # | 事项 | 前置 | 复现命令 | 通过标准 |
| --- | --- | --- | --- | --- |
| 1 | band-app .rpk 构建与包名 | band-dev 产出 src/manifest.json 并构建 | cd band-app && npm run release | dist/*.rpk manifest.package=dev.wristkey.app、name=腕证 |
| 2 | Android 单元测试与 APK | android-dev 完成 gradle 工程 | cd android-app && ./gradlew testDebugUnitTest assembleDebug | 测试通过；产出 app/build/outputs/apk/debug/app-debug.apk |
| 3 | APK 包名/应用名 | #2 | aapt2 dump badging <apk> | package=dev.wristkey.app、label=腕证 |
| 4 | 签名三方一致 | #1+#2 | bash scripts/check-signing.sh <apk> <rpk> | APK 指纹 == signing/rpk-sign/certificate.pem == rpk 内嵌 DER |
| 5 | 汇总终版报告 | #1–#4 | node e2e/check-build.mjs --build --with-tests | 0 FAIL |

复现完整流程：

~~~bash
# 夹具 + Node/Python 验证（已通过，可随时复跑）
cd e2e && npm install && npm run fixtures && npm run verify
python3 -m venv .venv && .venv/bin/pip install -r python/requirements.txt
.venv/bin/python python/verify_fixtures.py

# 构建 + 产物/签名检查（待两端可构建后）
cd ../band-app && npm test && npm run release
cd ../android-app && ./gradlew testDebugUnitTest assembleDebug
cd .. && node e2e/check-build.mjs --build --with-tests
bash scripts/check-signing.sh android-app/app/build/outputs/apk/debug/app-debug.apk band-app/dist/<新>.rpk
~~~

## 7. 风险与建议

1. **旧 .rpk 污染 dist（高）**：band-app/dist/asia.bilibili.mfa.debug.1.2.1.rpk 是参考实现遗留，
   会干扰包名断言与 scripts/check-signing.sh 的默认选取。建议构建前清空 dist。
2. **无真机**：system.interconnect 的包名+签名握手、xms 实际消息大小/投递、手环 UI 480×336 适配
   均无法在 CI 验证；当前只能以单元测试 + 协议夹具 + 签名材料一致性覆盖。
3. **band-app 仍在重写**：本次跨端 TOTP 对拍基于当前 totp.js（47 单测通过）跑通；
   完成后需重跑 e2e/verify.mjs 的 I 节。
4. **android-app 映射行为需与夹具对拍**：e2e 只验证夹具与参考实现；建议 android 单测复用
   e2e/fixtures 或 tools/fixtures 的同一套备份，断言 11 导入/11 跳过与字段映射。
5. **文档歧义**（已在 e2e/README.md 记录并同步 Lead）：
   - account.id 的 secret 归一化形式（建议明确去 = 填充后取 SHA-1）；
   - 快照输出顺序未定义（建议跨端按 id 集合对拍）；
   - 非法 begin 的处理未规定（参考实现为忽略并保留 staging）。
6. **ack 为 best effort**：协议已定义 mfa_sync_ack，但 xms SDK 是否提供接收回调解锁前，
   手环 ack 仅作 UI 提示，端到端“已确认”状态无法自动验证。

## 8. 附录：夹具文件哈希（来自 fixtures/manifest.json）

| 文件 | 字节 | SHA-256 |
| --- | --- | --- |
| plain-backup.json | 8559 | 052ccc115ce287183d4b34d5cd73611fbab844f66b31f4e3796508ce2a695d2e |
| expected-import.json | 5538 | 87b1528d4626d63aa2cb89ebb034f6472700df1d6f194b8b001ecd099059f09a |
| strong.stratum | 8619 | 1696e381f0831c52106885f2699b74376ace82281b7a462df9d49fdb4a215e81 |
| legacy.stratum | 8612 | 314187a3843d4944a3649c0fcc33b06be223819ff09d8e84116916bf7a1b970a |
| uri-list.txt | 770 | 331aa191a0bb001815d4d20a867347e1877dbd59b254bac8f04734a7b54c00f5 |
| protocol/valid-session.json | 5879 | 9cdc6768cc5048692295bd9bb309ce680625d939a4560b601bded012d8e09f5b |

加密参数：Strong = Argon2id(p=4, m=65536 KiB, t=3, out=32) + AES-256-GCM(tag16)；
Legacy = PBKDF2-HMAC-SHA1(64000, out=32) + AES-256-CBC/PKCS#7；密码 test-password。
salt/iv 固定值见 manifest.json（确定性夹具）。
