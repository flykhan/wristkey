# 构建与安装

> 本文为工程侧说明；用户使用流程见 [usage.md](usage.md)。AstroBox/真机细节以当前版本为准，
> 实测记录在 `research/notes/build-signing.md`（调研产物）。

## 环境要求

| 端 | 依赖 |
| --- | --- |
| 手环端 | Node.js ≥ 18（实测 v22）、npm；aiot-toolkit 2.0.5（npm 自动安装） |
| 手机端 | JDK 17+（实测 Temurin 21）、Android SDK Platform 36.1 / Build-Tools 36.1.0、Gradle 9.2.1（wrapper 自动下载） |
| 签名 | 同一个 keystore：APK 与 .rpk 必须使用同一证书（`system.interconnect` 校验） |

## 小米手环 10 Pro 平台注意

- 系统：HyperOS 3 / Vela 5.0；快应用 **无网络权限**（不支持 fetch），所有验证码必须本地计算；
- 打包：**不要**加 `--enable-protobuf` / `--enable-jsc`（社区反馈部分此类包在 10 Pro 上不可用）；
- 体积：未分包 rpk ≤ 1 MB；本项目实测远小于该值；
- manifest：`deviceTypeList: ["watch"]`（手环也用 watch）、`minPlatformVersion: 1000`、
  `config.designWidth: "device-width"`；
- 安装工具里设备型号选 **`xmb10p`**（10 Pro），选错会安装失败。

## 手环端（band-app/）

```bash
cd band-app
npm install
npm test           # Node 端单元测试（TOTP/协议状态机，不依赖快应用运行时）
npm run build      # aiot build（开发签名：sign/debug/ 或 sign/）
npm run release    # 产出 dist/<package>.<version>.rpk（发布签名：sign/release/）
```

签名机制（aiot-toolkit 2.0.5，已核对源码）：

- release 模式按顺序查找 `sign/release/{private,certificate}.pem` → `sign/{private,certificate}.pem`；
- build/dev 模式查找 `sign/debug/` → `sign/` → toolkit 内置默认证书；
- 本项目已把 `signing/rpk-sign/{private,certificate}.pem` 复制为 `band-app/sign/release/` 与 `sign/debug/`，
  证书与 `signing/dev-release.jks` 完全一致；
- 也可对已有 `build/` 目录手动重签：把 `build` 与 `sign` 放同一目录，执行 `aiot resign`，产物在 `dist/`。

> 发布前务必替换 `signing/dev-release.jks` 并同步替换两处 PEM，再重签两端；开发证书只能用于自用安装。

## 手机端（android-app/）

```bash
cd android-app
export JAVA_HOME=~/.jdks/jdk-21.0.13+9     # 按实际路径
./gradlew testDebugUnitTest                 # JVM 单元测试（Stratum 解密/映射/协议/TOTP）
./gradlew assembleDebug                     # app/build/outputs/apk/debug/app-debug.apk
./gradlew assembleRelease                   # app/build/outputs/apk/release/app-release.apk
```

Release 签名读取 `signing/dev-release.jks`（凭据见 `signing/README.md`，可用环境变量
`SIGNING_STORE_FILE` / `SIGNING_STORE_PASSWORD` / `SIGNING_KEY_ALIAS` / `SIGNING_KEY_PASSWORD` 覆盖）。

## 签名一致性校验

```bash
scripts/check-signing.sh android-app/app/build/outputs/apk/release/app-release.apk band-app/dist/*.rpk
```

脚本会：

1. 用 `apksigner verify --print-certs` 取 APK 证书 SHA-256 指纹；
2. 与 `signing/rpk-sign/certificate.pem` 指纹比对；
3. 检查该证书 DER 是否内嵌在 `.rpk` 签名块中（aiot 会把证书 DER 写进包尾签名块）。

三者一致才满足 interconnect 的"同包名 + 同证书"前提；包名在两侧也应为 `dev.wristkey.app`。

## 安装到真机（小米手环 10 Pro）

1. 手环与手机在「小米运动健康」中保持配对；手机安装 AstroBox（或表盘自定义工具）；
2. AstroBox 连接手环：打开 App → 授予附近设备/蓝牙权限 → 连接设备（工具内"AuthKey 读取工具"
   按提示跳转"小米健康研究"授权，或使用账号方式）→ 确认设备型号为 `xmb10p`；
3. AstroBox → 快应用 → 「+」选择 `band-app/dist/*.release.rpk` → 安装（原文件直传，不重签名）；
4. 手机安装 `app-release.apk`（与 rpk 同包名同证书）；打开 App → 授予"设备管理"权限；
5. 导入 Stratum/Bitwarden 备份 → 在「同步」页同步（或先在手环打开一次「腕证」，再回到 App 同步）；
6. 首次到「设置 → 入口图案」设置 5 位图形序列（或稍后在菜单里改）；
7. 在手环应用列表打开「腕证」：先解锁图案，再检查 3 条/页、A-Z 筛选、详情密码与验证码。

> 包名/签名不一致时，同步会失败（xms 返回签名校验失败 / 手环提示 fingerprint verify failed）；
> 先重装配套版本。安装工具本身不会重签名；但"快应用封装/改名"类工具会破坏签名，导致通信失效。
> 手环快应用无网络权限，验证码完全离线计算，时间取自手环系统时间。

## 真机验收清单

- [ ] 两端安装成功，手环应用列表可见「腕证」；
- [ ] App 能发现手环并授予设备管理权限；
- [ ] 导入加密/明文/URI 列表三种备份均成功，跳过项报告正确；
- [ ] 同步后手环显示 N 个账号，分类正确；
- [ ] 手机设置入口图案后，手环锁屏生效；手环本地改图案需旧图案；输错 5 次锁定；
- [ ] 手环冷启动/2 分钟重锁后要求图案；
- [ ] 手环端验证码与手机端（或 oathtool）对同一时刻一致；
- [ ] 手机关蓝牙/离开后，手环仍可离线显示验证码；
- [ ] 删除账号后重新同步，手环端同步移除。

## 常见问题

| 现象 | 排查 |
| --- | --- |
| 手环端安装失败 | AstroBox 版本/连接状态；rpk 是否 ≥1MB（未分包上限约 1MB）；设备型号是否选 `xmb10p`；报 `InstallFailed 3` 多为上一快应用未加载完/空间不足，稍后重试 |
| 手环提示 fingerprint verify failed | 两端证书不一致：用 `scripts/check-signing.sh` 校验；重装配套 APK/rpk |
| App 找不到手环 | 小米运动健康是否连接；蓝牙/附近设备权限；穿戴服务版本 |
| 同步提示签名错误 | 两端证书是否一致（`scripts/check-signing.sh`）；包名是否都是 `dev.wristkey.app` |
| 手环收不到消息 | 手环端应用是否打开过（interconnect 需两端都安装）；重开 App；查看 xms 错误码 |
| 验证码不一致 | 手环时间是否准确；算法/位数/周期是否导入正确 |
| Gradle 构建失败 | JAVA_HOME 是否为 17+；SDK 平台/build-tools 是否安装；网络能否访问 Google Maven |
| 手环图案与手机不一致 | 手机设置页改图案会自动下发；若失败，手机「同步」页确认连接后重新设置；手环端本地改需旧图案 |
| 解锁很慢 | 纯 JS PBKDF2 1200 次，低端设备可能数百毫秒级；若不可接受可在协议允许范围内下调（下限 1000） |