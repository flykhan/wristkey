# 构建、签名与真机安装（研究素材）

> 面向 `docs/build-install.md` 的素材。标注说明：**[已验证]** = 本机命令/源码/官方文档可复核；**[未验证]** = 未在真机或未找到官方原文，需实测。
> 调研时间：2026-11-10。工程路径：`/home/lsl/Projects/XiaomiBandProj`。

## 0. TL;DR（关键结论）

1. **两端包名 + 证书必须一致**，这是 `system.interconnect` 的硬性要求。官方 Vela FAQ 原文："手表和手机通信前会检查应用的签名，如果签名不正确通信会被拒绝。所以调试通信时需要手机 app 和手表 rpk 使用配套的证书打包。"
   来源：<https://iot.mi.com/vela/quickapp/zh/guide/other/faq.html>（"如何解决通信过程中提示签名不正确的问题" 与 "构建 release 版本 rpk 时打包证书有什么要求"）**[已验证]**
2. `aiot-toolkit 2.0.5` 的证书查找顺序（源码确认）：
   - `aiot build`（debug）：`sign/debug/{private,certificate}.pem` → `sign/{private,certificate}.pem` → toolkit 内置调试证书
   - `aiot release`：`sign/release/{private,certificate}.pem` → `sign/{private,certificate}.pem`（**没有内置回退，缺证书直接报错**）
   源码：`band-app/node_modules/@aiot-toolkit/aiotpack/lib/compiler/javascript/vela/utils/signature/SignUtil.js` 的 `getProjectSignConfig()`、`Signer.defaultCryptoSignFunction()`（RSA-SHA256）**[已验证]**
3. 社区项目 **BandTOTP** 的 Android 端 `app/build.gradle` 把**同一个自签 JKS 同时用于 debug 和 release**，这是保证 APK 与 rpk 同证书的实用做法。**[已验证]**
   来源：<https://github.com/leset0ng/BandTOTP-Android> `app/build.gradle`。
4. **AstroBox 安装 rpk 是"原文件直传"，未发现重签名行为**；自签证书可正常安装，但若安装工具/封装工具改写了 rpk，签名会被破坏，依赖签名校验的（含与手机通信的）快应用会失效。**[部分已验证，见 §5]**
5. release rpk 必须用与 APK 相同证书；`aiot release` 找不到 `sign/` 会失败 → CI/本地构建前先把 PEM 放进 `band-app/sign/`。**[已验证]**

## 1. 两端构建命令

### 1.1 手环端（Vela 快应用，Node ≥ 18）

```bash
cd band-app
npm install
npm run build            # = aiot build，产物 dist/*.debug.rpk（调试证书）
# 放入与 APK 相同的证书后再出 release 包：
mkdir -p sign
cp ../signing/rpk-sign/private.pem ../signing/rpk-sign/certificate.pem sign/
# 或旧路径布局 sign/release/{private,certificate}.pem
npm run release          # = aiot release，产物 dist/*.release.rpk
```

- `package.json` scripts（参考项目一致）：`"start": "aiot start --watch"`、`"build": "aiot build"`、`"release": "aiot release"`。
- 可选：`aiot resign` 可对已有 `build/` 目录换证书重新打包（目录结构：`build/` + `sign/{certificate,private}.pem` → `dist/*.rpk`）。**[已验证]**（工具 README + `lib/bin.js`）
- **10 Pro 打包注意**：社区反馈 10 Pro 是 Vela 5.0，"部分使用 protobuf+jsc 打包的快应用在 10 Pro 上会不可用"；建议**不要**加 `--enable-protobuf` / `--enable-jsc`，先用普通版验证。**[已验证-二手]**（<https://www.bandbbs.cn/threads/29315/>）

### 1.2 手机端（Kotlin/Compose，JDK 17+，Android SDK 36）

```bash
cd android-app
./gradlew assembleDebug      # app/build/outputs/apk/debug/app-debug.apk
./gradlew assembleRelease    # 需 signingConfigs + signing/dev-release.jks
./gradlew testDebugUnitTest
```

### 1.3 产物自检

```bash
# rpk：包名/版本、文件清单、体积
unzip -l band-app/dist/*.release.rpk | head -40
unzip -p band-app/dist/*.release.rpk manifest.json | head -30

# apk：包名 + 证书指纹
$ANDROID_HOME/build-tools/36.1.0/aapt2 dump badging android-app/app/build/outputs/apk/release/*.apk | head -5
$ANDROID_HOME/build-tools/36.1.0/apksigner verify --print-certs android-app/app/build/outputs/apk/release/*.apk
```

## 2. 签名材料：JKS ↔ PEM（两端口径一致）

原则：**只维护一套密钥**。推荐以 Android keystore 为准，导出 PEM 给 rpk：

```bash
# 1) JKS → PKCS12（keytool 需要先转格式）
keytool -importkeystore -srckeystore signing/dev-release.jks -srcstoretype JKS \
  -srcstorepass <STORE_PASS> -srcalias wristkey \
  -destkeystore /tmp/wristkey.p12 -deststoretype PKCS12 -deststorepass <STORE_PASS>

# 2) PKCS12 → PEM（私钥输出 PKCS#8 未加密，证书输出 X.509）
openssl pkcs12 -in /tmp/wristkey.p12 -nocerts -nodes -passin pass:<STORE_PASS> \
  -out signing/rpk-sign/private.pem
openssl pkcs12 -in /tmp/wristkey.p12 -nokeys -clcerts -passin pass:<STORE_PASS> \
  -out signing/rpk-sign/certificate.pem

# 3) 校验：私钥与证书是一对（两个输出必须一致）
openssl pkey -in signing/rpk-sign/private.pem -pubout | openssl sha256
openssl x509 -in signing/rpk-sign/certificate.pem -pubkey -noout | openssl sha256
```

反向（先有 PEM，给 Android 用）：

```bash
openssl pkcs12 -export -in certificate.pem -inkey private.pem -name wristkey \
  -out /tmp/wristkey.p12 -passout pass:<STORE_PASS>
keytool -importkeystore -srckeystore /tmp/wristkey.p12 -srcstoretype PKCS12 \
  -srcstorepass <STORE_PASS> -destkeystore signing/dev-release.jks -deststoretype JKS \
  -deststorepass <STORE_PASS>
```

若从零生成（自签即可，Vela 不要求 CA 签发）：

```bash
openssl req -newkey rsa:2048 -nodes -keyout private.pem -x509 -days 3650 \
  -out certificate.pem -subj "/CN=dev.wristkey.app"
```
（官方 FAQ 的打包说明即此方式；社区工具链调试证书也是自签 `CN=localhost`。）**[已验证]**

## 3. .rpk 的签名结构（aiot-toolkit 2.0.5）

本机解包实测（`band-app/dist/asia.bilibili.mfa.debug.1.2.1.rpk`，toolkit 调试证书）**[已验证]**：

1. `META-INF/CERT`：**一个 ZIP**，里面是 `hash.json`，形如
   `{"algorithm":"SHA-256","digests":{"manifest.json":"<sha256>", ...}}`，记录除签名块外每个文件的 SHA-256。
2. `META-INF/CERT` 自身先被签名（对其内容生成摘要，再用 RSA-SHA256 签名），然后参与整包签名。
3. **自定义签名块**插在"本地文件头区"与"中央目录"之间，块尾是魔法字符串 `RPK Sig Block 42`（16 字节）。块内包含：
   - `0x01000101` 签名块：三段 ZIP 结构摘要（`0xA5 + len + 数据` 的 SHA-256，再拼 `0x5A + count`）→ RSA-SHA256 签名 → 公钥（DER）→ 证书（DER）；
   - `0x01000201` 文件签名块（逐文件摘要/签名）；
   - EOCD 的中央目录偏移被重写以容纳该块。
   实现：`SignUtil.signPackage/doSign/signChunk/makeSignChunk/saveSignChunk`（本地 node_modules 源码）。
4. 签名算法固定 **RSA-SHA256**（`crypto.createSign('RSA-SHA256')`），私钥为 PEM。

### 3.1 手动校验：rpk 内证书 == 我们的 PEM

```bash
RPK=band-app/dist/*.release.rpk
# a) hash.json（文件级摘要）
unzip -p $RPK META-INF/CERT > /tmp/cert.zip
unzip -p /tmp/cert.zip hash.json | head -c 800; echo
# b) 定位签名块（可看到魔法串）
grep -abo "RPK Sig Block 42" $RPK
# c) 提取内嵌证书（Node，利用 crypto.X509Certificate 解析 DER）
node tools/verify-rpk-signature.mjs $RPK    # 自建脚本，见下
# d) 与我们的 PEM 指纹对比
openssl x509 -in signing/rpk-sign/certificate.pem -noout -fingerprint -sha256
```

> 本机已用一次性脚本验证：签名块起始偏移 = 中央目录偏移 − 3508，内嵌证书 `CN=localhost`，SHA-256 指纹 `4E:8E:…:45:85`，与 toolkit 内置 `pem/certificate.pem` 完全一致。**[已验证]**
> 说明：单靠 openssl 无法直接验整包自定义签名块，需要按上述块格式解析；**最实用的验收是"rpk 内嵌证书指纹 == APK 签名证书指纹"**，这才是 interconnect 的判定条件。

### 3.2 手动校验：APK 证书指纹

```bash
apksigner verify --print-certs app-release.apk | grep -i 'SHA-256'
# 或
keytool -printcert -jarfile app-release.apk | grep -i SHA256
# rpk 侧
openssl x509 -in signing/rpk-sign/certificate.pem -noout -fingerprint -sha256
```

两者一致（忽略大小写与冒号）即满足 interconnect 的证书条件。**[已验证-原理]**（官方 FAQ 要求一致，具体比对字段由系统实现，未反编译确认）**[未验证]**

## 4. 安装到小米手环 10 Pro

### 4.1 AstroBox（推荐）

流程（官方文档 + 社区教程）**[已验证-二手]**：

1. 手机与手环在**小米运动健康**中已配对（手环端"连接新手机"确认蓝牙配对）。
2. AstroBox → 连接设备：
   - 登录小米账号同步设备，或
   - 手动填 **MAC + AuthKey**（"设备列表 → AuthKey 输入框 → 连接"，之后仍需系统蓝牙配对确认）。
   参考：<https://abox.run/docs/usage/cli-and-skills/quickstart>（`device show` 可显示重连所需 AuthKey）
3. 安装本地快应用：设备页/资源页 → 安装 → 选择本地 `.rpk`；CLI 为 `resource install`（下载后推送到已连接设备）。
4. 安装时**必须选对设备型号**（AstroBox 资源下载条目的 device key；10 Pro 为 `xmb10p`，见 BandTOTP 资源 `manifest_v2.json`）。**[已验证]**（<https://github.com/leset0ng/astrobox-res-bandtotp> `manifest_v2.json`）
5. 安装完**重新连接一次小米运动健康**，否则快应用可能没有联网/服务权限，表现像"没连上设备"。**[已验证-二手]**（<https://www.bandbbs.cn/threads/29315/>）
6. 失败排查：一次只装一个（上一个未加载完会 InstallFailed）；删除不用的表盘/快应用腾空间；10 Pro 与 Watch S5 **没有 20 个快应用上限**。

### 4.2 表盘自定义工具（Android / iOS）

- 安装后需要 **AuthKey** 才能读写手环：工具内「工具栏 → AuthKey 读取工具」，按提示跳转**小米健康研究** App 授权获取。**[已验证-二手]**（<https://www.pconline.com.cn/ask/220925.html>、<https://github.com/alipymanbu/Android/blob/master/官网版APP下载/AstroBox/连接手环设备方法.md>）
- 安装：工具 → **蓝牙一键安装** → 选择本地 `.rpk`/`.bin`（QQ 下载的文件先在文件管理里选"打开方式 → 表盘自定义工具"）。**[已验证-二手]**
- 在「探索」下方先选对设备型号，否则提示未适配；不要强行装其它机型资源。**[已验证-二手]**

### 4.3 官方调试通道（仅开发者）

官方 FAQ：小米运动健康 → 我的 → 关于 → Debug → 第三方应用 → 输入包名 → Install third app → 选择本地 rpk。该版运动健康需商务对接获取。**[已验证-官方]**（FAQ 页）

### 4.4 adb？

**不支持**直接 `adb install` rpk 到手环；手环快应用通过手机侧穿戴服务/第三方工具安装。**[未验证]** 未检索到可行案例（adbd 在手表上仅调试器场景）。

## 5. AstroBox / 表盘自定义工具是否重签名？（决定自签方案）

结论：**不重签名，原 rpk 直传；安装时由手环系统校验签名有效性；自签证书可行。**

证据：
- AstroBox 资源安装流程是"下载文件 → 推送到已连接设备"，文档没有任何重签名步骤。**[已验证-官方文档]**（<https://abox.run/docs/usage/cli-and-skills/resource>）
- 社区"快应用封装/改名"教程明确警告："**由于过程会破坏原始签名**，因此可能会导致部分应用无法正常使用或失去部分功能，如『环间电子书』，或其他包含与手机软件通信功能的快应用、有签名校验功能的快应用。" → 说明正常安装路径不会破坏签名，破坏签名的工具会导致 interconnect 失效。**[已验证-二手]**（<https://www.bandbbs.cn/threads/21364/>）
- 社区自编译 rpk **使用 IDE 默认 debug 签名**即可在小米手环 10 NFC 上安装成功 → 设备接受任意有效自签，不要求厂商/资源方统一证书。**[已验证-二手]**（<https://www.bandbbs.cn/threads/26051/>）
- BandTOTP 是自编译发行：手环端 `package=com.lst.bandtotp`，Android 端 `applicationId=com.lst.bandtotp`，并用作者自己的 `lst.jks` 自签；其 AstroBox 资源可安装且与手机同步正常 → 社区发行版是**作者各自自签**，不是统一签名。**[已验证-源码]**（<https://github.com/leset0ng/BandTOTP-Android> `app/build.gradle`）
- 社区常见报错 "fingerprint verify failed"（手环提示手机端未安装/证书不一致）正是两端证书不一致时的典型现象；重签 APK 或换证书后会出现。**[已验证-二手]**（bandbbs BandTOTP 评论区）

剩余不确定（**[未验证]**，需真机/工具实测）：
- AstroBox 是否在推送前校验 rpk 的签名块格式（即使校验，也不改变"不重签"的结论）；
- 表盘自定义工具闭源，是否在某些机型流程里重打包（未有公开证据）；
- 10 Pro 安装时对证书有效期/CN 是否有额外要求（用自签 10 年证书，风险低）。

## 6. 常见问题（FAQ 素材）

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 手机端同步报 `fingerprint verify failed` / 手环提示未安装 | APK 与 rpk 证书不一致；或手环端未安装/包名不一致 | 用同一 JKS 重出 APK 与 rpk；确认包名都是 `dev.wristkey.app`；手环成功安装后重开快应用 |
| 设备发现失败 / `getConnectedNodes` 为空 | 未配对、运动健康未在后台、穿戴服务未连接、权限未授权 | 打开小米运动健康确认已连接；重启蓝牙；用 `ServiceApi` 监听服务连接；申请 `DEVICE_MANAGER` |
| 发送成功但手环没反应 | 包名/签名不一致；手环端未监听；消息不是合法 JSON；手环快应用未前台/被系统冻结 | 检查两端包名+指纹；先 `onopen` 后再发；每包 <1 KB |
| AstroBox `third-party app install failed: InstallFailed 3` | 上一个快应用未加载完 / 空间不足 / 机型选错 | 等待后重试、清理空间、选 `xmb10p` |
| 安装后快应用打不开/像临时文件 | 装了未签名或被破坏签名的 rpk | 用 `aiot release` 正常产出的 rpk，不要手工 re-zip |
| 10 Pro 上白屏/异常 | 用了 protobuf/jsc 打包或 9 Pro 专用资源 | 普通构建重打包；确认资源适配 10 Pro |

## 7. 真机验证清单（待逐项打勾）

- [ ] `aiot release` 使用 `sign/` 证书成功产出 `.release.rpk`（无证书时应失败，验证查找顺序）
- [ ] rpk 内嵌证书 SHA-256 == APK 签名证书 SHA-256
- [ ] APK `applicationId` 与 rpk `manifest.package` 均为 `dev.wristkey.app`
- [ ] AstroBox 连接 10 Pro 成功（AuthKey/小米账号两种方式至少一种）
- [ ] AstroBox 安装 release rpk 成功，设备型号选 `xmb10p`
- [ ] 安装后重连小米运动健康，手环快应用可启动
- [ ] 手机端发现设备、申请 `DEVICE_MANAGER` 成功
- [ ] 首条消息手环能收到（interconnect `onmessage` 回调触发）
- [ ] 手环 ack 能回到手机（`MessageApi.addListener` 生效）——若 SDK/系统不支持则退化为"已发送"
- [ ] 断开手机后手环仍能离线生成 TOTP
- [ ] 换证书重装 APK（不换 rpk）能复现 `fingerprint verify failed`，换回一致证书恢复正常
