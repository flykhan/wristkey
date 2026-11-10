# 腕证 · WristKey — 手环端（Vela 快应用）

小米手环 10 Pro（Vela / HyperOS 3，480×336）上的离线 TOTP / Steam Guard 展示端：

- 接收手机 App 经小米穿戴服务（xms）发来的协议 v2 快照（begin / account × N / commit）；
- 校验后**原子写入**本机快应用 storage（key: mfa_snapshot_v2），commit 成功后回复 ack；
- 本地计算 TOTP（SHA1 / SHA256 / SHA512，6–10 位，周期 5–300 s）与 Steam Guard
  （5 位字母数字，固定 30 s / SHA1），断连也可查看；
- 分类浏览、分页（每页 3 个）、详情、同步状态/空状态、"请求手机同步"。

包名 **dev.wristkey.app**，应用名「腕证」。**必须与手机 APK 同包名、同签名证书**，否则
system.interconnect 拒绝建立通道。

## 目录结构

~~~text
band-app/
  src/
    manifest.json                 # 包名/feature/router/config
    app.ux                        # 应用生命周期（不打印任何敏感信息）
    common/logo.png               # 应用图标（本项目生成）
    common/scripts/
      totp.js                     # 纯 JS Base32 + SHA1/256/512 + HMAC + TOTP + Steam Guard（无 @system 依赖）
      accountModel.js             # account 归一化/校验、快照构建/解析、分类、排序（纯函数）
      syncProtocol.js             # 协议 v2 状态机：begin/account/commit -> snapshot + ack（纯函数）
      mfaConfig.js                # @system.storage 持久化（单 key 原子写、legacy 迁移）
      interconnect.js             # @system.interconnect 连接/收发（ack best effort）
      settings.js                 # 主题/分页/时间格式化（纯函数）
    pages/                        # index / detail / menu / category / copyright
  tests/                          # Node 单元测试，不依赖快应用运行时
  sign/                           # 开发签名 PEM（与 APK 同证书，见 sign/README.md）
  scripts/
    prepare-signing.sh            # 从 signing/dev-release.jks 导出 PEM 到 sign/
    verify-rpk.mjs                # 校验 .rpk 签名链、证书指纹、包名与文件摘要
  LICENSE                         # Apache License 2.0（源自 BandOTP，保留）
  NOTICE.md                       # 上游署名与本项目修改点
~~~

## 构建与测试

需要 Node >= 18（实测 v22.22.2）。

~~~bash
npm install
npm test          # 纯 Node 单元测试（RFC 6238 向量 + 协议状态机 + 模型边界）
npm run build     # aiot build   -> dist/dev.wristkey.app.debug.<version>.rpk
npm run release   # aiot release -> dist/dev.wristkey.app.release.<version>.rpk
npm run verify:rpk  # 校验最新的 dist/*.rpk 签名与包名
~~~

npm test 通过 --experimental-default-type=module 直接加载 src/common/scripts/*.js
（快应用源码本身不使用 package.json 的 type 字段，避免影响 aiot 构建）。

## 签名

aiot-toolkit 2.0.5 的证书查找顺序：

- build（开发模式）：sign/debug/{private,certificate}.pem → sign/{...}.pem → toolkit 默认证书；
- release（发布模式）：sign/release/{private,certificate}.pem → sign/{...}.pem。

本仓库把开发用 PEM 放在 sign/release/ 与 sign/debug/（与 signing/dev-release.jks
同一张证书，SHA-256 指纹 B7:CF:BA:15:86:55:BD:32:9A:CC:30:A8:1C:B6:F5:A6:28:15:B7:4D:F9:3D:B4:C4:93:1E:60:88:51:DA:85:C4）。
它们**仅用于开发联调**，发布前必须替换（见 sign/README.md 与 docs/security.md）。

签名验证：npm run verify:rpk 会用 rpk 内嵌证书公钥验证 RPK Sig Block 的 RSA-SHA256
签名、比对证书指纹、校验 META-INF/CERT 的 hash.json 文件摘要以及 manifest 包名。

## 协议行为（docs/protocol.md v2 + 确定性约定）

- begin 合法才重置 staging；非法 begin（syncId 空/超长、accountCount 非 0–500 整数）被忽略，
  当前 staging 与旧快照保持不变。
- 同一 index 重复发送：后到者覆盖，duplicate_index 计数，不视为失败；
  同一 account.id 出现在不同 index：丢弃后到者。
- commit 校验 syncId、accountCount，且合法去重条数必须等于 accountCount；失败时丢弃 staging、
  旧快照不变，ack 原因码为 no_active_begin / sync_id_mismatch / account_count_mismatch /
  incomplete_sync。
- begin{accountCount:0} + commit{accountCount:0} 合法，写入空快照（清空账号）。
- staging 超过 120 s 无新消息自动丢弃，不计入错误。
- 快照数组顺序无协议含义；UI 按分类分组、分类内按 id 排序展示。
- otpType 缺省为 totp（旧快照/旧手机端兼容）；otpType=steam 时强制 digits=5、period=30、
  algorithm=SHA1，码为 5 位字母数字（不补零、不按数字分组）；冲突组合丢弃该账号并计入错误。
- 兼容读取 BandOTP v1 的 mfa_config_snapshot（只读兼容，不参与 v2 同步）。

## 安全

- 代码与日志不输出 secret / 验证码；详情页只显示掩码后的 secret；
- 测试只使用 RFC 6238 公开向量与占位账号；仓库不含真实 TOTP secret；
- storage 中含完整 secret，请仅在受信任的手环上安装；丢失手环应撤销相关 TOTP 并清除快应用数据。

## 许可

Apache License 2.0（见 LICENSE）。本项目源自 lin945/mi_band_mfa（BandOTP，Apache-2.0）并做了
较大重写，署名与修改点见 NOTICE.md。Stratum 备份格式仅依据公开文档实现，未复制 GPL-3.0 代码。
