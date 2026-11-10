# 腕证 · WristKey — Android 手机端

小米手环 10 Pro 的 TOTP 伴侣应用：从 [Stratum](https://github.com/stratumauth/app) 导出的备份文件
导入 OTP，经小米穿戴服务（xms-wearable-lib）同步到 Vela 快应用；手环端离线计算验证码。

- 包名：`dev.wristkey.app`，应用名：腕证
- 最低 Android 9（API 28），targetSdk / compileSdk 36.1
- 同步协议：[../docs/protocol.md](../docs/protocol.md)（v2：begin / account×N / commit + ack / request）
- 备份格式：[../docs/stratum-format.md](../docs/stratum-format.md)

## 功能

- **Stratum 导入**：SAF 选文件或从其它 App 分享/打开（.stratum / .json / .txt），按内容嗅探格式：
  - Strong 加密：Argon2id（p=4, m=65536 KiB, t=3, out=32）+ AES-256-GCM；
  - Legacy 加密：PBKDF2-HMAC-SHA1（64000）+ AES-256-CBC/PKCS7；
  - 明文 JSON 备份、`otpauth://` URI 列表；HTML 导出会明确提示不可导入。
  - 密码只在导入时使用、不落盘；解密失败统一提示“密码错误或文件损坏”。
  - 字段映射、跳过报告、合并（同 secret 覆盖）/全量替换见 docs/stratum-format.md。
  - **Steam Guard**：备份 `Type=4` 与带 `&steam` / `encoder=steam` / issuer 前缀 Steam 的 URI 导入为
    `otpType=steam`（5 位字母数字码，固定 30 秒 / SHA1）；重新以合并模式导入可纠正误导入成 TOTP 的账号。
- **账号管理**：分类分组、搜索、脱敏 secret、手动新增/编辑（含 otpauth 解析）、当前验证码核对。
- **同步**：协议 v2 分片发送（begin → account×N → commit），逐条进度；
  `MessageApi.addListener` 接收 `mfa_sync_ack` 与 `mfa_sync_request`（手环请求全量重发）。
- 设备发现、设备管理授权、打开手环应用；签名为开发签名 `../signing/dev-release.jks`。

## 构建

需要 JDK 21 与 Android SDK（platform android-36.1、build-tools 36.x）。
`local.properties` 中写 `sdk.dir=/path/to/Android/Sdk`（或设置 `ANDROID_HOME`）。

```bash
export JAVA_HOME=$HOME/.jdks/jdk-21.0.13+9
export ANDROID_HOME=$HOME/Android/Sdk
./gradlew testDebugUnitTest      # JVM 单元测试（TOTP/Base32/Stratum/合并/协议）
./gradlew assembleDebug          # app/build/outputs/apk/debug/app-debug.apk
./gradlew assembleRelease        # app/build/outputs/apk/release/app-release.apk（开发签名）
```

Release 签名默认读取仓库根目录 `signing/dev-release.jks`（alias `wristkey`，密码见
`signing/README.md`），可用 `SIGNING_STORE_FILE` / `SIGNING_STORE_PASSWORD` /
`SIGNING_KEY_ALIAS` / `SIGNING_KEY_PASSWORD` 环境变量覆盖。**发布前必须更换。**
手环端 .rpk 必须使用同一证书签名，否则 `system.interconnect` 校验失败。

## 单元测试

`app/src/test` 为纯 JVM 测试（不依赖 Android 框架），夹具在 `app/src/test/resources/fixtures/`：

- `TotpTest`：RFC 6238 官方向量（SHA1/SHA256/SHA512，6 个时间点）；
- `SecretTest` / `AccountModelsTest`：Base32 归一化、账号 id、表单校验；
- `OtpAuthParserTest`：otpauth URI 与 URI 列表（含 HOTP 跳过）；
- `StratumImporterTest` / `StratumDecryptTest`：格式嗅探、明文映射、Strong/Legacy 解密、错误密码；
- `SteamOtpTest`：Steam Guard 6 组向量、字母表/长度、TOTP 分派；
- `AccountMergeTest`：合并 / 全量替换 / 去重 / 同 secret 重新导入纠正 otpType；
- `SyncProtocolTest`：begin/account/commit 消息（含 otpType/Steam 固定字段）、ack/request 解析、消息大小 < 1 KB。

夹具密码为 `test-password`，secret 为 RFC 6238 公开测试值，不含真实账号。

## 许可

Apache License 2.0，见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)（BandOTP 参考署名；
Stratum 仅作格式规范参考，未拷贝代码）。
