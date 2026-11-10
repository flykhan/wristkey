# 腕证 · WristKey — 把 Stratum 的 OTP 带进小米手环

在 **小米手环 10 Pro** 上离线查看 TOTP / Steam 验证码。手机端从 **Stratum**（stratum-auth，Aegis 分支）
或 **Bitwarden** 未加密导出中导入 OTP，再通过小米穿戴服务同步到手环；手环端本地计算验证码，
不依赖手机在线。v2.0 起支持 **5 位图形入口锁屏**、账号详情中的 **用户名/密码**、全屏字母网格筛选，
手机 App 的界面与交互也做了完整重设计。

> 状态：v2.0 已构建并通过全量自动化验收；真机 UI/图案交互等待用户实拍反馈。
> 安装与同步流程见 [docs/build-install.md](docs/build-install.md)，日常使用见 [docs/usage.md](docs/usage.md)。

## 为什么这样做

小米手环（Vela / HyperOS 3）支持安装第三方「快应用」（.rpk），社区用
[AstroBox](https://astrobox.online/) / 表盘自定义工具安装。手环快应用与手机原生 App 之间通过
`system.interconnect`（手环侧）↔ 小米穿戴服务 SDK（手机侧，`xms-wearable-lib`）通信，**要求两端包名与签名证书一致**。

社区项目 [BandOTP](https://github.com/lin945/mi_band_mfa)（Apache-2.0）与
[BandTOTP](https://github.com/leset0ng/BandTOTP-Android) 表明这套链路在小米手环/手表系列上可行；
官方 FAQ 明确"手表和手机通信前会检查应用签名，rpk 与手机 App 必须用配套证书"。
本项目在其思路基础上改造并做这些事：

1. **导入 Stratum 备份**：支持 Strong（Argon2id + AES-256-GCM）、Legacy（PBKDF2-SHA1 + AES-256-CBC）、
   明文 JSON 备份、`otpauth://` 文本列表；
2. **导入 Bitwarden 未加密 JSON**：读取 `items[].login.totp`（otpauth URI 或纯 Base32），
   同时导入用户名与密码；忽略文件夹/分类；
3. **支持 TOTP 与 Steam Guard**：TOTP SHA1/256/512、6–10 位；Steam Guard 5 位字母数字（`otpType: "steam"`）；
4. **协议 v3 分片同步**：begin/account×N/commit + ack/request，staging + 原子提交；密码字段、图案下发/查询；
5. **手环 UI v4**：5 位图形锁屏（三角/方形/圆形）、每页 3 个大号验证码、右侧 A-Z 筛选 + 页码 + 菜单、
   全屏 4×4×3 字母数字网格、详情页用户名/密码（10 秒遮罩显示）；
6. **手机 App v2.0**：深色薄荷绿 3 Tab（账号/同步/设置）、大号验证码卡、导入预览、底部弹层详情、
   全屏编辑器、入口图案双端设置。

## 架构

```text
┌────────────────────────────┐          ┌──────────────────────────────┐
│ Android App (Kotlin)       │  xms     │ Vela 快应用 (JS)              │
│  · Stratum/Bitwarden 导入   │ ───────▶ │  · 接收 begin/account/commit  │
│  · 账号/密码/图案管理       │  协议v3  │  · staging → 本地快照 v3       │
│  · 生成快照并分片发送       │ ◀─────── │  · TOTP/Steam 本地计算         │
│  · 图案下发/查询、同步状态  │  ack     │  · 图案锁屏 / 网格 / 详情      │
└────────────────────────────┘          └──────────────────────────────┘
       手机（应用私有存储）                   手环（快应用 storage，离线可用）
```

- 协议 v3：[docs/protocol.md](docs/protocol.md)
- Stratum 备份格式与字段映射：[docs/stratum-format.md](docs/stratum-format.md)
- Bitwarden JSON 导入：[docs/bitwarden-format.md](docs/bitwarden-format.md)
- 手环 UI v4 设计与分析：[docs/design/ui-v4-analysis.md](docs/design/ui-v4-analysis.md)
- 手机 App v2.0 设计规格：[docs/design/android-v2-spec.md](docs/design/android-v2-spec.md)
- 架构与安全：[docs/architecture.md](docs/architecture.md) / [docs/security.md](docs/security.md)
- 构建与安装：[docs/build-install.md](docs/build-install.md)

## 仓库结构

```text
band-app/       手环端 Vela 快应用（aiot-toolkit 构建 .rpk）
android-app/    手机端 Android App（Gradle + Kotlin + Compose）
docs/           架构、协议、格式、构建安装、安全、设计稿
tools/          Node 工具：Stratum 备份解密/转换、协议夹具、交叉验证
e2e/            端到端测试与构建报告
signing/        开发用签名材料（两端口径一致，发布前必须替换）
```

## 快速构建

```bash
# 手环端（需要 Node >= 18）
cd band-app && npm install && npm test && npm run release   # 产物 dist/*.rpk

# 手机端（需要 JDK 17+ 与 Android SDK 36）
cd android-app && export JAVA_HOME=~/.jdks/jdk-21.0.13+9
./gradlew testDebugUnitTest assembleRelease                 # 产物 app/build/outputs/apk/release/
```

手环端安装（真机）：用 AstroBox / 表盘自定义工具把 `.rpk` 装到小米手环 10 Pro；手机端安装同名同签名的 APK。
**两端包名 + 签名证书必须一致**，否则 `system.interconnect` 无法建立连接。

## 验证状态（2026-11-10，无真机 UI 验证）

| 检查 | 结果 |
| --- | --- |
| 手环端 `npm test`（TOTP/Steam 向量、协议 v2/v3、pin、UI v4 结构、分页/字号/筛选、页面栈回归） | **106/106** |
| 手机端 `./gradlew testDebugUnitTest`（Stratum/Bitwarden、密码、TOTP/Steam、协议 v3、图案、合并） | **106/106** |
| e2e Node 验证（跨实现加解密、协议回放、Bitwarden 映射、band 模块对拍、协议 v3/pin） | **171/171** |
| e2e Python 独立验证（第三方实现解密 + RFC/Steam/Bitwarden/pin 向量） | **40/40** |
| 构建 / 包名 / 版本 / 权限 / 签名 / UI v4 静态检查（`--build --with-tests`） | **80 PASS / 0 FAIL** |
| APK 与 .rpk 同证书 | ✅ `SHA-256 b7cfba…85c4`（= `signing/rpk-sign/certificate.pem` = rpk 内嵌 DER） |
| 真机（安装、interconnect、xms、480×336 UI、锁屏/图案/详情密码） | **待验证**：v1.0 启动闪退与 Steam 问题已由真机反馈定位修复；v2.0 UI 待实拍 |

产物：

- 手环：`band-app/dist/dev.wristkey.app.release.2.0.2.rpk`（114,640 B，sha256 `9f291264837ecd192d3bf7fe4cb727b395d9d132a9d01218f3a3a9623286b393`，2.0.2 / versionCode 8）
- 手机：`android-app/app/build/outputs/apk/release/app-release.apk`（26,492,665 B，sha256 `dd53148580a56881eee40e3389af96c37d5dbdee37dee7fc3b7aef85e10a47e1`，2.0.0 / versionCode 4，无 INTERNET 权限）
- 验收报告：[reports/e2e-report.md](reports/e2e-report.md)；调研证据：[research/notes/](research/notes/)

## 参考与许可

- 手环快应用与 Android App 派生自 [BandOTP](https://github.com/lin945/mi_band_mfa)（Apache-2.0）：
  `band-app/` 派生自其手环端，`android-app/` 派生自其 [Android 端](https://github.com/lin945/mi_band_mfa_android)，
  保留 LICENSE、NOTICE 与修改说明。协议 v2/v3、Stratum/Bitwarden 导入、图案锁、包名/签名方案为本项目新增。
- Stratum 备份格式来自 [stratumauth/app](https://github.com/stratumauth/app) 的文档与实现（GPL-3.0）。
  本项目只依据公开格式规范独立实现解析器，不复制其代码；`tools/` 中的测试夹具生成脚本可调用其
  `extra/decrypt_backup.py` 做**离线校验**，不参与发布产物。

## 免责声明

TOTP Secret 与账号密码等同于账号凭证。请仅在自己信任的设备上使用；使用前阅读 [安全说明](docs/security.md)。

## 真机回归记录

1. **2026-11-10 启动闪退**（v1.0.0）：真机日志显示 `TypeError: cannot set property 'style' of null`
   + `appData is undefined`，根因是 `app.ux` 缺少 `<script>` 包裹导致默认导出为 null。
   已修复并发布 **v1.0.1（versionCode 2）**，新增 `band-app/tests/uxStructure.test.mjs` 回归测试。
2. **2026-11-10 Steam 验证码错误**：旧版把 Stratum 的 Steam 账号当普通 TOTP，显示错误的 6 位数字。
   已按 `otpType="steam"` 实现 5 位字母数字码（固定 SHA1/30s/字母表），修复并发布
   **手环 v1.0.2（versionCode 3） + 手机 APK v1.1（versionCode 2）**；Steam 6 组向量两端均验证通过。
3. **2026-11-10 手环字体过小 / 一页放不下**（v1.0.3）：一度改为每页 2 个大卡片、固定 236px 验证码列；
   真机上名称被截成 `S..`/`YW...`，因此继续按用户草图重做。
4. **2026-11-10 UI v3 + Bitwarden 导入**：按用户草图和确认实现 **无顶栏 / 每页 3 个 / 右侧 A-Z 按钮 +
   字母数字筛选页 / 右滑菜单左滑退出**；手机端新增 **Bitwarden 未加密 JSON 导入**。发布
   **手环 v1.0.4（versionCode 5） + 手机 APK v1.2（versionCode 3）**。
5. **2026-11-10 UI v4 + v2.0**：按用户草图与"双端可设入口图案、重新设计手机 App"的要求，实现
   **5 位图形锁屏 / 3 条/页 + 右侧功能条 / 全屏 4×4×3 网格 / 详情用户名密码 / 菜单四项**；
   手机 App 全量重设计并支持图案设置与下发；协议升级 v3（密码字段 + pin 消息，兼容 v2）。
   发布 **手环 2.0.0（versionCode 6） + 手机 APK 2.0.0（versionCode 4）**。
6. **2026-11-10 手环输完图案没有进入下一屏**（2.0.0）：Vela 每个页面独立打包，内存中的解锁时间戳
   不跨页面共享，`/pages/index` 读不到刚写入的解锁状态又跳回锁屏。改为用 `@system.storage` 持久化
   解锁时间戳（`wristkey_unlock_v1`），跨页共享、2 分钟闲置重锁、冷启动清除；发布
   **手环 2.0.1（versionCode 7）**。
7. **2026-11-10 输入图案后仍无法进入主界面**（2.0.1）：日志显示页面栈为空（`PageNavigator getState error: empty stack`）
   并触发 `state_error`。根因是入口页与锁屏页都用 `router.replace` 跳转，且 index 的 onInit/onShow 与 app.ux
   重复上锁，把页面栈清空。改为**入口 push 锁屏、解锁 back、只在 onShow 做一次门禁、彻底移除 replace**；发布
   **手环 2.0.2（versionCode 8）**。

详见 [reports/e2e-report.md](reports/e2e-report.md)。
