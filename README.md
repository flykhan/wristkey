# 腕证 · WristKey — 把 Stratum 的 OTP 带进小米手环

在 **小米手环 10 Pro** 上离线查看 TOTP 验证码。手机端从 **Stratum**（stratum-auth，Aegis 分支）导出的备份文件中导入 OTP，
再通过小米穿戴服务同步到手环；手环端本地计算验证码，不依赖手机在线。

> 状态：可构建/可验证的工程（无真机时靠单元测试 + 协议夹具验证）。真机安装与同步流程见
> [docs/build-install.md](docs/build-install.md)。

## 为什么这样做

小米手环（Vela / HyperOS 3）支持安装第三方「快应用」（.rpk），社区用
[AstroBox](https://astrobox.online/) / 表盘自定义工具安装。手环快应用与手机原生 App 之间通过
`system.interconnect`（手环侧）↔ 小米穿戴服务 SDK（手机侧，`xms-wearable-lib`）通信，**要求两端包名与签名证书一致**。

参考实现 [lin945/mi_band_mfa](https://github.com/lin945/mi_band_mfa)（Apache-2.0）已经证明这套链路在
小米手环 9/9 Pro/10/10 Pro 上可用。本项目在其思路上重写并做两件事：

1. **导入 Stratum 备份**：支持 Strong（Argon2id + AES-256-GCM）、Legacy（PBKDF2-SHA1 + AES-256-CBC）、
   明文 JSON 备份、`otpauth://` 文本列表；
2. **把快照分片传输**：手环端做 staging + commit，避免消息大小/丢包问题，并返回 ack。

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

## 参考与许可

- 手环快应用与 Android App 派生自 [BandOTP](https://github.com/lin945/mi_band_mfa)（Apache-2.0）：
  `band-app/` 派生自其手环端，`android-app/` 派生自其 [Android 端](https://github.com/lin945/mi_band_mfa_android)，
  保留 LICENSE、NOTICE 与修改说明。协议 v2、Stratum 导入、包名/签名方案为本项目新增。
- Stratum 备份格式来自 [stratumauth/app](https://github.com/stratumauth/app) 的文档与实现（GPL-3.0）。
  本项目只依据公开格式规范独立实现解析器，不复制其代码；`tools/` 中的测试夹具生成脚本可调用其
  `extra/decrypt_backup.py` 做**离线校验**，不参与发布产物。

## 免责声明

TOTP Secret 等同于账号凭证。请仅在自己信任的设备上使用；使用前阅读 [安全说明](docs/security.md)。
