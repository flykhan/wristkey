# 参考来源与证据索引

> 图例：**[已验证]** 本机可复核/官方原文；**[已验证-二手]** 社区帖子/发行版；**[未验证]** 待真机或未找到原文。
> 本地路径均相对仓库根 `/home/lsl/Projects/XiaomiBandProj`。

## 1. 官方文档（小米 Vela / 快应用 / Android）

| # | 来源 | 用途 | 级别 |
| --- | --- | --- | --- |
| 1 | <https://iot.mi.com/vela/quickapp/zh/guide/other/faq.html> | **interconnect 签名一致性硬要求**；release 证书要求；屏幕适配（默认 480×480 设计基准）；官方 Debug 安装通道；日志拉取 | [已验证-官方] |
| 2 | <https://iot.mi.com/vela/quickapp/en/samples/> | interconnect 跨设备图片传输官方样例（onopen/onclose/onerror、分片 header→data→end） | [已验证-官方] |
| 3 | <https://github.com/open-vela/frameworks_runtimes_feature/blob/dev/modules/jidl/interconnect.jidl> | `system.interconnect@1.0` JIDL，`AppInfo` 用于"连接并验证手机上的应用" | [已验证-源码] |
| 4 | <https://doc.quickapp.cn/ide/static-detection.html> | rpk 体积规范：未分包 ≤1MB；分包总计 ≤4MB、单包 ≤1MB | [已验证-官方通用 / Vela 适用性未验证] |
| 5 | <https://www.mi.com/tw/product/xiaomi-smart-band-10-pro-nfc/specs/> | 手环 10 Pro 官方规格：1.74" AMOLED，**480×336**，60Hz | [已验证-官方] |
| 6 | <https://www.mi.com/gr/product/xiaomi-smart-band-10-pro/specs/> | 同上（欧洲站，希腊语） | [已验证-官方] |
| 7 | <https://iot.mi.com/vela/quickapp/zh/>（Vela JS 应用总览） | 技术特点、多屏适配、打包发布入口 | [已验证-官方] |
| 8 | AstroBox 官网 <https://astrobox.online/> / 文档 <https://abox.run/docs/usage> | AstroBox 定位、平台要求、设备连接与安装 | [已验证-官方] |
| 9 | <https://abox.run/docs/usage/cli-and-skills/resource> | 资源安装流程（下载 → 推送设备），无重签名步骤 | [已验证-官方] |
| 10 | <https://abox.run/docs/usage/cli-and-skills/quickstart> | CLI `device show` 获取重连 AuthKey；MAC+AuthKey 连接 | [已验证-官方] |
| 11 | <https://github.com/alipymanbu/Android/blob/master/官网版APP下载/AstroBox/连接手环设备方法.md> | AstroBox 连接设备（小米账号 or 手动 AuthKey + 系统配对） | [已验证-二手] |
| 12 | <https://www.pconline.com.cn/ask/220925.html> | AuthKey 获取流程（表盘自定义工具 → AuthKey 读取工具 → 小米健康研究授权） | [已验证-二手] |

## 2. 官方工具链（本机安装包源码）

| # | 来源 | 用途 | 级别 |
| --- | --- | --- | --- |
| 13 | `band-app/node_modules/aiot-toolkit/README.md` | `aiot build/release/resign`；`resign` 目录结构 `build/ + sign/{certificate,private}.pem → dist/` | [已验证] |
| 14 | `band-app/node_modules/@aiot-toolkit/aiotpack/lib/compiler/javascript/vela/utils/signature/SignUtil.js` | release 证书查找顺序 `sign/release` → `sign/`；debug 优先 `sign/debug`；RSA-SHA256；CERT 结构；签名块 `RPK Sig Block 42` | [已验证] |
| 15 | `band-app/node_modules/@aiot-toolkit/aiotpack/lib/compiler/javascript/vela/utils/signature/Signer.js` | 签名算法 `crypto.createSign('RSA-SHA256')` | [已验证] |
| 16 | `band-app/dist/asia.bilibili.mfa.debug.1.2.1.rpk`（本机 debug 产物） | 实测 rpk 结构：`META-INF/CERT`（zip + hash.json）+ 签名块；内嵌证书 CN=localhost，指纹与 toolkit 默认证书一致 | [已验证-本机] |

## 3. 参考项目（本仓库 research/ 本地副本）

| # | 来源 | 用途 | 级别 |
| --- | --- | --- | --- |
| 17 | `research/mi_band_mfa/src/manifest.json` | `package=asia.bilibili.mfa`、`minPlatformVersion=1000`、`deviceTypeList:["watch"]`、`designWidth:"device-width"`、features | [已验证] |
| 18 | `research/mi_band_mfa/src/pages/index/index.ux` | `system.interconnect` 用法：instance/onmessage/onopen/onerror/send；消息提取 `message.data` | [已验证] |
| 19 | `research/mi_band_mfa/src/common/scripts/totp.js` | 纯 JS HMAC-SHA1 TOTP、Base32、6/8 位 | [已验证] |
| 20 | `research/mi_band_mfa/README.md` | 声称支持小米手表/手环（社区），AstroBox 下载入口 | [已验证-README] |
| 21 | `research/mfa_android/app/build.gradle.kts` | `applicationId=asia.bilibili.mfa`、minSdk 28、SDK 36、`files("libs/xms-wearable-lib_1.4_release.aar")` | [已验证] |
| 22 | `research/mfa_android/app/src/main/java/asia/bilibili/mfa/MainActivity.kt` | xms 调用范式：connectedNodes / checkPermissions / requestPermission / sendMessage / ServiceApi | [已验证] |
| 23 | `research/mfa_android/app/src/main/AndroidManifest.xml` | 应用基本配置（无特殊权限声明） | [已验证] |
| 24 | `research/stratum/Stratum.Droid/src/Activity/MainActivity.cs` | 导出菜单/三种格式/文件名/SAF/Strong vs 明文 | [已验证] |
| 25 | `research/stratum/Stratum.Droid/src/AutoBackupWorker.cs` | 自动备份文件名、目录树、强加密、密码要求 | [已验证] |
| 26 | `research/stratum/Stratum.Core/src/Backup/Encryption/{Strong,Legacy,No}BackupEncryption.cs` | Strong/Legacy/明文格式常量 | [已验证] |
| 27 | `research/stratum/Stratum.Core/src/Backup/{Backup,UriListBackup,HtmlBackup}.cs` | `.stratum`/`.txt`/`.html` 扩展名与 MIME | [已验证] |
| 28 | `research/stratum/doc/BACKUP_FORMAT.md` | Stratum 官方明文 JSON 格式与字段约束 | [已验证-官方格式] |

## 4. 社区项目 / 帖子

| # | 来源 | 用途 | 级别 |
| --- | --- | --- | --- |
| 29 | <https://github.com/lin945/mi_band_mfa> | BandOTP 手环端（Apache-2.0） | [已验证] |
| 30 | <https://github.com/lin945/mi_band_mfa_android> | BandOTP 手机端（Apache-2.0） | [已验证] |
| 31 | <https://github.com/leset0ng/BandTOTP-Band> | BandTOTP 手环端：manifest（designWidth 192）、interconnect、单页 UI | [已验证] |
| 32 | <https://github.com/leset0ng/BandTOTP-Android> | BandTOTP 手机端：自签 JKS 共用 debug/release、sendMessage | [已验证] |
| 33 | <https://github.com/leset0ng/astrobox-res-bandtotp> (`manifest_v2.json`) | AstroBox 资源结构、device key（含 `xmb10p`）、9 Pro/10 Pro 共用 rpk | [已验证] |
| 34 | <https://github.com/leset0ng/BandTotp-astrobox> | AstroBox 同步器插件（Rust→wasm） | [已验证-仓库] |
| 35 | <https://github.com/DaiYiZhi/BandTOTP-AstroBox-Importer> | 第三方 AstroBox 导入插件（TS） | [已验证-仓库] |
| 36 | <https://github.com/xiaolangduan/BandTOTP-RedmiWatch6> | Redmi Watch 6 移植 | [已验证-仓库] |
| 37 | <https://www.bandbbs.cn/resources/2119/> | BandTOTP 发行/使用指南：Stratum"备份至 URI 列表文件"→ 手机端导入；评论区 `fingerprint verify failed` | [已验证-二手] |
| 38 | <https://www.bandbbs.cn/threads/21364/> | 封装/重打包工具会破坏签名，影响手机通信/签名校验类快应用；未签名 rpk 可能致重启 | [已验证-二手] |
| 39 | <https://www.bandbbs.cn/threads/26051/> | 自编译 rpk 用 IDE 默认 debug 签名可在手环 10 NFC 安装 | [已验证-二手] |
| 40 | <https://www.bandbbs.cn/threads/29315/> | 10 Pro = Vela 5、不支持 fetch、protobuf+jsc 兼容性风险、装完重连运动健康、InstallFailed 3、无 20 个上限、p67cn/p67tc | [已验证-二手] |
| 41 | <https://www.bandbbs.cn/resources/8252/updates> | 10 Pro 腕上浏览器：普通版/JSC 优化版；包名与签名和手环 9/10 版一致，同步器正常 | [已验证-二手] |
| 42 | <https://linux.do/t/topic/1476518/6> | bandtotp 使用流程（Stratum 添加 → 安装 rpk → 运动健康同步后导入） | [已验证-二手] |
| 43 | <https://forum.rainyun.com/t/topic/7231/4> | 手环装 TOTP 的社区讨论（BandTOTP 适配新 Vela 设备） | [已验证-二手] |
| 44 | <https://www.bandbbs.cn/threads/19500/> | BandTOTP 导入路径 bug（Download 目录）、震动等 UI 反馈 | [已验证-二手] |
| 45 | <https://www.jindage.com/skills/xiaomi-vela-quickapp> | 第三方整理的 Vela 快应用开发约束（manifest/designWidth/机型表/媒体查询），非官方，但与本机证据一致 | [已验证-二手/非官方] |

## 5. 本地命令证据（可复跑）

```bash
# AAR API（自写解析器等价 javap -public）
unzip -o research/mfa_android/app/libs/xms-wearable-lib_1.4_release.aar -d /tmp/aarx
unzip -o /tmp/aarx/classes.jar -d /tmp/aarx/cls
node /tmp/javap2.js $(find /tmp/aarx/cls -name '*.class' | grep -E 'message/|auth/|NodeApi|tasks/')

# rpk 签名块与内嵌证书
grep -abo "RPK Sig Block 42" band-app/dist/*.rpk
node /tmp/rpkverify2.js band-app/dist/*.rpk    # /tmp 脚本为一次性验证脚本
openssl x509 -inform der -in /tmp/rpk-cert.der -noout -fingerprint -sha256

# Stratum 源码事实
grep -n "OpenBackupMenu\|Backup.FileExtension\|LegacyBackupEncryption" research/stratum/Stratum.Droid/src/Activity/MainActivity.cs
```

## 6. 未验证 / 待真机清单（汇总）

- [ ] **AstroBox 安装是否校验/重签名**：官方文档无重签名步骤、社区封装工具会破坏签名 → 推断"原样直传 + 设备侧验签"；但 AstroBox 自身是否校验 rpk 签名未确证。验证方法：a) 用 `aiot release` 自签 rpk 安装，观察是否成功；b) 用 `zip -d` 手工改一个文件后安装，看是否拒绝；c) 安装后用另签名的 APK 连接，复现 `fingerprint verify failed` ⇒ 证明安装未换证。
- [ ] 表盘自定义工具是否重签名（闭源）。
- [ ] 10 Pro 上 `system.interconnect` 首条消息与 `addListener` ack 往返。
- [ ] xms 单条消息实际上限（1KB/4KB/16KB/64KB 阶梯测试）。
- [ ] 10 Pro 对 `minPlatformVersion: 1000`、`designWidth: 480`/`"device-width"` 的实际渲染。
- [ ] 未分包 rpk ≤1MB 是否在 Vela 安装侧执行。
- [ ] `launchWearApp(nodeId, "pages/index")` 的 path 语义（`"/home"` vs `"pages/index"`）。
