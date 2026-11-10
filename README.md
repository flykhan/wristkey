# 腕证 · WristKey — 把 Stratum 的 OTP 带进小米手环

在 **小米手环 10 Pro** 上离线查看 TOTP 验证码。手机端从 **Stratum**（stratum-auth，Aegis 分支）导出的备份文件中导入 OTP，
再通过小米穿戴服务同步到手环；手环端本地计算验证码，不依赖手机在线。

> 状态：可构建/可验证的工程（无真机时靠单元测试 + 协议夹具验证）。真机安装与同步流程见
> [docs/build-install.md](docs/build-install.md)。

## 为什么这样做

小米手环（Vela / HyperOS 3）支持安装第三方「快应用」（.rpk），社区用
[AstroBox](https://astrobox.online/) / 表盘自定义工具安装。手环快应用与手机原生 App 之间通过
`system.interconnect`（手环侧）↔ 小米穿戴服务 SDK（手机侧，`xms-wearable-lib`）通信，**要求两端包名与签名证书一致**。

社区项目 [BandOTP](https://github.com/lin945/mi_band_mfa)（Apache-2.0）与
[BandTOTP](https://github.com/leset0ng/BandTOTP-Android) 表明这套链路在小米手环/手表系列上可行；
官方 FAQ 明确"手表和手机通信前会检查应用签名，rpk 与手机 App 必须用配套证书"。
本项目在其思路基础上改造并做两件事：

1. **导入 Stratum 备份**：支持 Strong（Argon2id + AES-256-GCM）、Legacy（PBKDF2-SHA1 + AES-256-CBC）、
   明文 JSON 备份、`otpauth://` 文本列表；
2. **支持 TOTP 与 Steam Guard**：TOTP SHA1/256/512、6–10 位；Steam Guard 5 位字母数字（`otpType: "steam"`）；
3. **把快照分片传输**：手环端做 staging + commit，避免消息大小/丢包问题，并返回 ack；
4. **按 480×336 手环屏优化显示**：每页 2 个账号、大号 issuer/账号/验证码，长码自动缩小字号，
   码与信息各占固定区域，不遮挡、不裁切。

## 架构

```text
┌────────────────────────────┐          ┌──────────────────────────────┐
│ Android App (Kotlin)       │  xms     │ Vela 快应用 (JS)              │
│  · Stratum 备份解密/解析    │ ───────▶ │  · 接收 begin/account/commit  │
│  · 账号管理（合并/替换）    │  消息    │  · staging → 本地存储          │
│  · 生成快照并分片发送       │ ◀─────── │  · TOTP 计算（SHA1/256/512）  │
│  · 显示同步状态/ack         │  ack     │  · 分类浏览 / 详情 / 状态提示  │
└────────────────────────────┘          └──────────────────────────────┘
       手机（应用私有存储）                   手环（快应用 storage，离线可用）
```

- 协议：[docs/protocol.md](docs/protocol.md)
- Stratum 备份格式与字段映射：[docs/stratum-format.md](docs/stratum-format.md)
- 架构与安全：[docs/architecture.md](docs/architecture.md) / [docs/security.md](docs/security.md)
- 构建与安装：[docs/build-install.md](docs/build-install.md)

## 仓库结构

```text
band-app/       手环端 Vela 快应用（aiot-toolkit 构建 .rpk）
android-app/    手机端 Android App（Gradle + Kotlin + Compose）
docs/           架构、协议、格式、构建安装、安全
tools/          Node 工具：Stratum 备份解密/转换、协议夹具、交叉验证
e2e/            端到端测试与构建报告
signing/        开发用签名材料（两端口径一致，发布前必须替换）
```

## 快速构建

```bash
# 手环端（需要 Node >= 18）
cd band-app && npm install && npm run build && npm run release   # 产物 dist/*.rpk

# 手机端（需要 JDK 17+ 与 Android SDK 36）
cd android-app && ./gradlew assembleDebug                      # 产物 app/build/outputs/apk/debug/
```

手环端安装（真机）：用 AstroBox / 表盘自定义工具把 `.rpk` 装到小米手环 10 Pro；手机端安装同名同签名的 APK。
**两端包名 + 签名证书必须一致**，否则 `system.interconnect` 无法建立连接。

## 验证状态（2026-11-10，无真机）

| 检查 | 结果 |
| --- | --- |
| 手环端 `npm test`（TOTP/Steam 向量、协议状态机、模型边界、ux 结构、分页/字号回归） | **70/70** |
| 手机端 `./gradlew testDebugUnitTest`（Stratum 解密/映射、TOTP/Steam、协议、合并） | **72/72** |
| e2e Node 验证（跨实现加解密、协议回放、非法用例、band 模块对拍、Steam 向量） | **145/145** |
| e2e Python 独立验证（第三方实现解密 + RFC/Steam 向量） | **24/24** |
| 构建 / 包名 / 签名检查 | **29/29 PASS** |
| CLI 工具测试（`tools/`） | **12/12** |
| APK 与 .rpk 同证书 | ✅ `SHA-256 b7cfba…85c4`（= `signing/rpk-sign/certificate.pem`） |
| 真机（安装、interconnect 握手、xms 投递、480×336 UI、Steam 显示） | **部分验证**：启动闪退已由真机日志定位修复；Steam 显示待复测 |

产物：

- 手环：`band-app/dist/dev.wristkey.app.release.1.0.3.rpk`（约 56 KB，versionCode 4，大字体 2 码/页）
- 手机：`android-app/app/build/outputs/apk/release/app-release.apk`（约 25 MB，v1.1 / versionCode 2）
- 验收报告：[reports/e2e-report.md](reports/e2e-report.md)；调研证据：[research/notes/](research/notes/)

## 参考与许可

- 手环快应用与 Android App 派生自 [BandOTP](https://github.com/lin945/mi_band_mfa)（Apache-2.0）：
  `band-app/` 派生自其手环端，`android-app/` 派生自其 [Android 端](https://github.com/lin945/mi_band_mfa_android)，
  保留 LICENSE、NOTICE 与修改说明。协议 v2、Stratum 导入、包名/签名方案为本项目新增。
- Stratum 备份格式来自 [stratumauth/app](https://github.com/stratumauth/app) 的文档与实现（GPL-3.0）。
  本项目只依据公开格式规范独立实现解析器，不复制其代码；`tools/` 中的测试夹具生成脚本可调用其
  `extra/decrypt_backup.py` 做**离线校验**，不参与发布产物。

## 免责声明

TOTP Secret 等同于账号凭证。请仅在自己信任的设备上使用；使用前阅读 [安全说明](docs/security.md)。

## 真机回归记录

1. **2026-11-10 启动闪退**（v1.0.0）：真机日志显示 `TypeError: cannot set property 'style' of null`
   + `appData is undefined`，根因是 `app.ux` 缺少 `<script>` 包裹导致默认导出为 null。
   已修复并发布 **v1.0.1（versionCode 2）**，新增 `band-app/tests/uxStructure.test.mjs` 回归测试。
2. **2026-11-10 Steam 验证码错误**：旧版把 Stratum 的 Steam 账号当普通 TOTP，显示错误的 6 位数字
   （备份 `Type=4` 被跳过；URI 列表里 `otpauth://totp/Steam:...` 无标记时被当作 TOTP）。
   已按 `otpType="steam"` 实现 5 位字母数字码（固定 SHA1/30s/字母表），修复并发布
   **手环 v1.0.2（versionCode 3） + 手机 APK v1.1（versionCode 2）**；Steam 6 组向量两端均验证通过。
3. **2026-11-10 手环字体过小 / 一页放不下**：真机反馈字体偏小、3 行拥挤。改为 **每页 2 个大卡片**，
   issuer 26px、验证码 44px（8 位 38px / 10 位 32px）、账号 16px，验证码列固定 236px 宽并随长度缩字号，
   header/status/footer 固定高度，主要信息不被遮挡或裁切；发布 **手环 v1.0.3（versionCode 4）**。

详见 [reports/e2e-report.md](reports/e2e-report.md) 第 10/11/12 节。
