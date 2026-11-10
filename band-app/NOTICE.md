# NOTICE

本目录（band-app/，腕证 / WristKey 手环端）包含源自 **BandOTP** 的软件。

## 上游项目

- 名称：BandOTP（本仓库内调研副本：research/mi_band_mfa）
- 来源：https://github.com/lin945/mi_band_mfa
- 作者：林唯心（lin945）
- 许可：Apache License 2.0（完整文本见 band-app/LICENSE，保留自上游）

band-app/LICENSE 与下述署名是本项目对 Apache-2.0 第 4 条（保留版权、许可与 NOTICE）的履行。

## 本项目对上游的修改

本项目以 BandOTP 快应用工程为起点（页面组织、交互思路与整体视觉结构），随后为 WristKey 重写：

- src/manifest.json：包名 dev.wristkey.app、应用名「腕证」、版本 1.0.2、feature 保持
  router/storage/interconnect、config.designWidth = "device-width"；
- src/common/logo.png：替换为本项目生成的图标（不再使用上游图片资源）；
- src/common/scripts/totp.js：重写为与运行时无关的纯 JS 实现，Base32 归一化/解码、
  HMAC-SHA1/SHA256/SHA512（SHA-256/512 为自行实现）、RFC 4226 HOTP / RFC 6238 TOTP、
  digits 6–10、period 5–300，并以 RFC 6238 公开测试向量校验；另按 docs/protocol.md 的
  Steam Guard 规则实现 5 位字母数字码（字母表 23456789BCDFGHJKMNPQRTVWXY，固定 30 s / SHA1），
  并用公开 Steam 向量校验；
- src/common/scripts/accountModel.js、syncProtocol.js、settings.js：新增的纯函数模块
  （账号校验、协议 v2 状态机、分页/主题等），无运行时依赖，便于 Node 测试；
- src/common/scripts/mfaConfig.js：重写为 v2 快照存储（单 key 原子写、加载容错、
  BandOTP v1 mfa_config_snapshot 只读迁移）；
- src/common/scripts/interconnect.js：新增，封装 @system.interconnect 连接与 ack/request 发送；
- src/pages/*：重写列表/详情/菜单/分类/版权页，适配 480×336，加入分类分页、同步状态、
  空状态与"请求手机同步"；
- 新增 tests/（Node 单元测试）、sign/（开发签名 PEM）、scripts/（签名导出与 rpk 校验）；
- 删除上游的预览图片、i18n 占位与部分开发配置。

原上游代码的版权归其作者所有；修改部分版权归 WristKey 项目贡献者所有，整体仍按
Apache License 2.0 发布。

## 其他参考（未复制代码）

- **Stratum**（https://github.com/stratumauth/app，GPL-3.0）：仅依据其公开文档
  doc/BACKUP_FORMAT.md 与格式说明实现导入侧解析（见 docs/stratum-format.md），
  本项目不包含、也不链接其源代码。
- **RFC 4226 / RFC 6238**：HOTP/TOTP 算法与公开测试向量（IETF 文档，公开数据）。
- 构建工具（不作为发布产物分发）：aiot-toolkit 2.0.5（ISC）、@aiot-toolkit/jsc 1.0.3 及其依赖。

## 开发签名材料

band-app/sign/{release,debug}/private.pem 与 certificate.pem 由 signing/dev-release.jks
导出，**仅供开发联调**（与开发 APK 同证书，interconnect 要求）。它们不是生产密钥，
发布前必须按 docs/security.md 替换；泄露开发密钥不会影响已替换为生产密钥的发布版本。
