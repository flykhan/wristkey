# WristKey 端到端验收报告（终版）

- 任务：task-4（e2e 测试夹具与验证框架）
- 执行：qa，2026-11-10 15:37 (Asia/Shanghai)
- 结论：**PASS** —— 两端构建产物齐全、包名/应用名一致、APK 与 .rpk 使用同一签名证书；
  Node 端 121/121、Python 端 17/17、构建/签名检查 25 PASS / 0 FAIL / 0 SKIP；
  band-app 单测 48/48、android-app JVM 单测 58/58（9 个测试类）。
- 未覆盖：真机（小米手环 10 Pro）上的安装、interconnect 握手、xms 投递与 480×336 UI 实机表现，
  本环境无真机，见第 6 节。

## 1. 环境

| 项 | 值 |
| --- | --- |
| OS | Linux x86_64 |
| Node | v22.22.2 |
| npm | 10.9.7 |
| Python | 3.14.8（e2e/.venv：argon2-cffi 25.1.0 + cryptography 50.0.2） |
| JDK | /home/lsl/.jdks/jdk-21.0.13+9 |
| Android SDK | ~/Android/Sdk（platforms android-34/36.1；build-tools 34.0.0/36.1.0/37.0.0） |
| 时间 | 2026-11-10 15:37 CST |
| 真机 | **无** |

## 2. 产物清单与校验值

| 产物 | 路径 | 大小 | SHA-256 | 关键属性 |
| --- | --- | --- | --- | --- |
| band .rpk | band-app/dist/dev.wristkey.app.release.1.0.0.rpk | 54,726 B | e7acdfbcab6c29db0daa5f76a66dd25a520cf44ff0570df7a6abe8ade5374c10 | package=dev.wristkey.app，name=腕证，versionName=1.0.0，deviceTypeList=[watch]，features=router/storage/interconnect，designWidth=device-width |
| android release APK | android-app/app/build/outputs/apk/release/app-release.apk | 26,263,473 B | ff1a9eb94907d4573ca3b0b38fcc0c5a5d8a45b3f024858c31fe685d06eac300 | package=dev.wristkey.app，label=腕证，versionName=1.0，minSdk 28，targetSdk 36 |
| 签名证书 PEM | signing/rpk-sign/certificate.pem | — | SHA-256 指纹 b7cfba158655bd329acc30a81cb6f5a62815b74df93db4c4931e608851da85c4 | CN=WristKey Dev, OU=WristKey, O=WristKey, C=CN |
| 测试夹具 | e2e/fixtures/（6 个文件） | 见附录 | 见附录 | 确定性生成，密码 test-password |

> APK 证书 SHA-256 = signing/rpk-sign/certificate.pem = b7cfba…85c4；
> .rpk 内嵌同一证书 DER（命中 offset 51180）；三者一致。dist 中旧参考 rpk 已被 band-dev 清理，
> 当前 dist 仅含本项目的 release rpk。

## 3. 验收执行结果

### 3.1 band-app 构建与单测

~~~
npm --prefix band-app test
# tests 48 / pass 48 / fail 0

npm --prefix band-app run release     # 由 check-build --build 执行，退出码 0
# 产出 band-app/dist/dev.wristkey.app.release.1.0.0.rpk (54,726 B)
~~~

### 3.2 android-app 构建与单测

~~~
cd android-app && ./gradlew testDebugUnitTest assembleDebug
# BUILD SUCCESSFUL；JVM 单测 58 passed / 0 failed / 9 个测试类
# release APK 已由 android-dev 产出（本次未重新 assembleRelease，仅核验现有产物）
~~~

### 3.3 构建/包名/签名检查（node e2e/check-build.mjs --build --with-tests）

~~~
构建检查: 25 PASS / 0 FAIL / 0 SKIP
~~~

25 项全 PASS，覆盖：
- band-app manifest（package/name/deviceTypeList/features/designWidth）；
- band-app npm test 48 用例、npm run release 构建成功、dist/*.rpk 存在；
- rpk manifest.package=dev.wristkey.app、manifest.name=腕证；
- android gradle testDebugUnitTest assembleDebug 成功、58 用例 / 9 测试类；
- release APK 存在、package=dev.wristkey.app、应用名=腕证；
- 签名 PEM / APK 证书 / RPK 内嵌 DER 三方一致；
- scripts/check-signing.sh PASS；APK 与 RPK 包名一致。

结果明细：reports/e2e-build-result.json。

### 3.4 签名一致性（bash scripts/check-signing.sh，显式 release 产物）

~~~
APK: android-app/app/build/outputs/apk/release/app-release.apk
RPK: band-app/dist/dev.wristkey.app.release.1.0.0.rpk
RPK package: dev.wristkey.app | name: 腕证
APK 证书 SHA-256: b7cfba158655bd329acc30a81cb6f5a62815b74df93db4c4931e608851da85c4
APK 证书 DN: CN=WristKey Dev, OU=WristKey, O=WristKey, C=CN
签名 PEM SHA-256: b7cfba158655bd329acc30a81cb6f5a62815b74df93db4c4931e608851da85c4
RPK 内嵌证书 DER: 是 (offset 51180)
PASS: 包名 dev.wristkey.app，APK 与 RPK 使用同一证书（SHA-256 b7cfba…85c4）
~~~

注：scripts/check-signing.sh 不带参数时默认取 dist 下字典序第一个 .rpk；若未来 dist 同时存在
debug/release 两个 rpk，建议显式传入 release rpk 路径（本次已显式传入）。

### 3.5 e2e Node 验证（cd e2e && npm run verify）

~~~
WristKey e2e verify: 121 passed, 0 failed, 121 total
~~~

| 节 | 断言数 | 内容 |
| --- | --- | --- |
| A. RFC 6238 / RFC 4226 向量 | 21 | 3 算法 × 6 时间点 + HOTP 10 向量 + digits 长度 |
| B. 夹具覆盖矩阵与明文映射 | 12 | 哈希可复现、11/11 映射、id 独立复算、分类 Id、排序、跳过报告无 secret |
| C. Strong/Legacy 加解密 | 8 | 解密 == 明文；错误密码/头部/截断；同 salt/iv 再加密逐字节一致 |
| D. 跨实现交叉验证 | 9 | Python 夹具解密、固定 salt/iv 再加密逐字节一致、映射 3/5、URI、与 tools/src/stratum.mjs 双向 |
| E. URI 列表 | 2 | 5 导入 / 2 跳过，字段与明文映射一致 |
| F. 协议 v2 合法会话与双端状态机 | 9 | 信封/大小/索引/同步号、手环端回放提交、ack、request |
| G. 协议字段边界 | 18 | 最大字段消息 538B < 1KB；13 类非法 account 丢弃；未知字段忽略 |
| H. 非法/边界用例回放 | 19 | invalid-cases.json 全过（超时/去重/空同步/新 begin 等） |
| I. 跨端 TOTP 对拍 | 23 | band-app totp.js vs 独立实现：RFC 向量 + 375 组矩阵 + 22 次夹具账号 |

### 3.6 e2e Python 独立验证

~~~
cd e2e && .venv/bin/python python/verify_fixtures.py
Python verify: 17 passed, 0 failed, 17 total
~~~

含：e2e 加密夹具 Python 独立解密、tools/fixtures 解密、**Stratum 官方 decrypt_backup.py
（GPL-3.0，仅离线校验）可解密 e2e 两个加密夹具**、RFC 6238 夹具账号复算、加密参数常量校验。

## 4. 跨实现交叉验证证据（双向、非自证）

| # | 方向 | 结果 |
| --- | --- | --- |
| 1 | e2e 密文 → Python 独立解密 | PASS |
| 2 | e2e 密文 → Stratum 官方工具解密 | PASS |
| 3 | tools/fixtures（Python 生成）→ e2e Node 解密 | PASS |
| 4 | e2e 密文 → tools/src/stratum.mjs 解密 | PASS |
| 5 | 固定 salt/iv 再加密 → 与 Python 产物逐字节一致 | PASS |
| 6 | 映射对拍（e2e vs tools）按 id 集合一致 | PASS（e2e 11/11、tools 3/5） |
| 7 | TOTP 跨端（band-app vs 独立实现） | PASS（RFC 向量、375 矩阵、夹具账号） |

## 5. 夹具覆盖矩阵

e2e/fixtures/plain-backup.json 共 22 条 Authenticator = 11 导入 + 11 跳过：

| 维度 | 覆盖 |
| --- | --- |
| 算法 | SHA1 / SHA256 / SHA512 |
| digits | 6 / 8 / 10 |
| period | 15 / 30 / 60 |
| 分类 | 开发 / 个人 / 云服务 / 社交 / 默认分类；多分类取 Binding Ranking 最小者 |
| 边界 | secret 带 = 填充、Unicode issuer/username、issuer 空、username 空 |
| 跳过 | HOTP(Type=1)、Steam(Type=4)、Mobile-OTP(Type=3)、非法 Base32、空 secret、period 4/301、digits 5/11、issuer+username 全空、Algorithm=7 |

加密夹具：Strong = AUTHENTICATORPRO + salt16 + iv12 + AES-256-GCM(Argon2id p4 m65536 t3 out32) + tag16；
Legacy = AuthenticatorPro + salt20 + iv16 + AES-256-CBC/PKCS7(PBKDF2-SHA1 64000 dk32)；密码 test-password。

协议夹具：valid-session.json（1 begin + 11 account + 1 commit，最大消息 400B < 1KB）；
invalid-cases.json（19 例：版本/未知 type/非法 JSON 忽略、非法字段丢弃、commit 条数/syncId 不匹配、
无 staging、重复 id 去重、缺省 id 兜底、缺省字段归一化、新 begin 丢弃旧 staging、空同步、120s 超时）。

## 6. 未验证项与残余风险

1. **真机链路未验证（中）**：无小米手环 10 Pro 真机，system.interconnect 的包名+签名握手、
   .rpk 通过 AstroBox/表盘自定义工具安装、xms 实际消息大小/投递/重连、手环端 480×336 UI 与
   离线计算均只在代码/单测/夹具层验证。
2. **ack 为 best effort（低）**：xms SDK 是否提供消息接收回调未在真机确认；手环 ack 目前只影响
   UI 提示，不影响离线可用性。
3. **APK 版本号**：APK versionName=1.0，rpk versionName=1.0.0，不影响校验，发布前可统一。
4. **band-app 导入 totp.js 的 Node 警告（低）**：band-app/package.json 未声明 type=module，
   e2e verify 导入时出现 MODULE_TYPELESS_PACKAGE_JSON 警告，不影响正确性；建议后续补上。
5. **夹具 secret 均为公开测试值**：不得替换为真实凭证（e2e/README 已注明）。

## 7. 协议/格式参考选择（docs 未明确规定处）

1. account.id = s_ + sha1(归一化 secret)[0:12]；归一化 = 大写、去空白、去 -、去 =（与 tools 一致）；
2. 快照排序：分类间按 Category.Ranking、类内按 AuthenticatorCategories.Ranking、无分类排最后；
   跨端对拍建议按 id 集合而非数组顺序；
3. 非法 begin（缺 syncId/accountCount）忽略并保留旧 staging；
4. account 单字段非法 → 丢弃整条并计错误，不中断同步；
5. URI 列表无分类 → 默认分类；
6. algorithm 小写容忍并归一化为大写。

## 8. 复现命令

~~~bash
# A. 夹具与 Node/Python 验证
cd e2e && npm install
npm run fixtures
npm run verify
python3 -m venv .venv && .venv/bin/pip install -r python/requirements.txt
.venv/bin/python python/verify_fixtures.py

# B. 两端构建 + 单测 + 包名/签名全量验收
cd ..
npm --prefix band-app test
npm --prefix band-app run release
cd android-app && ./gradlew testDebugUnitTest assembleDebug && cd ..
node e2e/check-build.mjs --build --with-tests

# C. 签名一致性（显式 release 产物，需 java 在 PATH）
JAVA_HOME=$(ls -d ~/.jdks/jdk-* | sort -V | tail -1)
PATH="$JAVA_HOME/bin:$PATH" bash scripts/check-signing.sh \
  android-app/app/build/outputs/apk/release/app-release.apk \
  band-app/dist/dev.wristkey.app.release.1.0.0.rpk
~~~

## 9. 附录

### 9.1 夹具文件哈希（fixtures/manifest.json）

| 文件 | 字节 | SHA-256 |
| --- | --- | --- |
| plain-backup.json | 8559 | 052ccc115ce287183d4b34d5cd73611fbab844f66b31f4e3796508ce2a695d2e |
| expected-import.json | 5538 | 87b1528d4626d63aa2cb89ebb034f6472700df1d6f194b8b001ecd099059f09a |
| strong.stratum | 8619 | 1696e381f0831c52106885f2699b74376ace82281b7a462df9d49fdb4a215e81 |
| legacy.stratum | 8612 | 314187a3843d4944a3649c0fcc33b06be223819ff09d8e84116916bf7a1b970a |
| uri-list.txt | 770 | 331aa191a0bb001815d4d20a867347e1877dbd59b254bac8f04734a7b54c00f5 |
| protocol/valid-session.json | 5879 | 9cdc6768cc5048692295bd9bb309ce680625d939a4560b601bded012d8e09f5b |

### 9.2 本次验收日志

完整命令输出保存于 /tmp/final-acceptance.log（含 band/android 单测、check-build 25 项、
e2e verify、Python verify、check-signing 输出）。关键退出码均为 0。

### 9.3 相关文档

- e2e/README.md：夹具/框架用法、覆盖矩阵、歧义记录；
- e2e/verify-result.json：Node 121 项逐条结果；
- reports/e2e-build-result.json：构建检查 25 项逐条结果。
