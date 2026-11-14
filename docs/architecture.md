# 架构与数据流

## 组成

| 组件 | 技术 | 作用 |
| --- | --- | --- |
| `band-app/` | 小米 Vela 快应用（JS + .ux） | 手环上展示 TOTP；接收并持久化同步快照；本地计算 |
| `android-app/` | Kotlin + Jetpack Compose（minSdk 28） | 导入 Stratum 备份、账号管理、生成快照并发送 |
| `tools/` | Node.js | 解密/转换 Stratum 备份、生成协议夹具、与 App 对拍 |
| `signing/` | keystore + rpk 签名配置 | 保证两端包名与证书一致 |

## 端到端数据流

```text
Stratum 导出文件 (.stratum / .json / .txt)
        │  SAF 文件选择器（或 ACTION_SEND / ACTION_VIEW）
        ▼
Android: 格式嗅探 → 解密（如需密码）→ JSON 解析 → 映射到内部 Account
        │  合并 / 全量替换（用户选择）
        ▼
Android: 生成协议消息 begin → account × N → commit（JSON/UTF-8，经 xms 消息发送）
        │  小米穿戴服务（BLE）
        ▼
手环: 校验 → staging → commit 时原子写入本地 storage → UI 刷新
        │  通过 system.interconnect 回 ack（best effort）
        ▼
Android: 更新同步状态（已确认 / 已发送未确认 / 失败）
```

## 通信链路

- 手环侧：`system.interconnect`（`connect.onmessage` / `connect.send`），需在 `manifest.json` 的
  `features` 中声明；`package` 字段必须等于手机 App 的 `applicationId`。
- 手机侧：`com.xiaomi.xms.wearable` SDK（`xms-wearable-lib`，以 AAR 形式引入）：
  - `Wearable.getNodeApi` 发现设备；
  - `Wearable.getAuthApi` + `Permission.DEVICE_MANAGER` 授权；
  - `Wearable.getMessageApi` 发送消息；
  - 监听手环回传（若 SDK 提供接收回调；否则手环 ack 仅做 UI 提示，不影响离线使用）。
- 包名/签名一致是硬性要求；开发用 `signing/dev-release.jks`，发布前替换（见 `docs/build-install.md`）。

## 手环端存储模型

`system.storage` key `mfa_snapshot_v3`（旧版 `mfa_snapshot_v2` 在首次启动时迁移）：

```json
{
  "version": 3,
  "updatedAt": 1760000000000,
  "accounts": [
    {
      "id": "s_ab12cd34ef56",
      "issuer": "GitHub",
      "accountName": "me@example.com",
      "category": "开发",
      "secret": "BASE32...",
      "algorithm": "SHA1",
      "digits": 6,
      "period": 30,
      "otpType": "totp",
      "password": "",
      "updatedAt": 1760000000000
    }
  ]
}
```

- 快照整体写入（commit 时一次 set），避免半写；写入失败时保留旧快照。
- 入口图案单独存在 `wristkey_pin_v1`（salt/hash/iterations），锁定计数在 `wristkey_pin_lock_v1`，二者都不进快照。
  2.1.2 起入口图案内联在 index 页面（不再用路由页跳转），修复空页面栈与 evaluateGate 自动解锁两个根因；锁屏/设置/协议 pin 消息均已恢复。
- 列表标题脱敏显示；完整 secret 仅用于本地计算。
- 手环无网络，无云备份；卸载/清除数据会删除快照。

## 设计取舍

1. **消息分片而非单条大 JSON**：兼容未知的消息大小上限，丢包可重试，进度可见；单条消息 < 1 KB。
2. **替换式同步**：每次同步都是全量快照，手环 commit 后整体替换；删除账号无需增量协议。
3. **支持的 OTP 子集**：TOTP + SHA1/SHA256/SHA512 + 6–10 位 + 自定义周期，以及 Steam Guard 5 位字母数字；
   HOTP/Mobile-OTP/Yandex 会跳过并在导入报告中列出。
4. **不做二维码扫描（v1）**：本次需求是导入 Stratum 导出文件；设备管理界面保留手动新增/编辑。
5. **派生自 BandOTP 但重新设计协议与身份**：`band-app/` 与 `android-app/` 分别基于 BandOTP 两端
   （Apache-2.0）改造，保留 LICENSE/NOTICE；包名改为 `com.flykhan.wristkey`、自签证书、协议升级为 v3（v2 兼容），
   与上游互不兼容（这是预期行为：两端必须成对安装）。

## 失败与边界

- 手环未连接 / 未授权：手机端保留待同步状态，支持手动重试；手环端显示"未同步/上次同步时间"。
- 同步中途断开：手环丢弃 staging，旧快照不受影响；手机端可重发。
- 大账号列表（>100）：按 N 条消息发送，耗时可见；手环 UI 分页展示。
- 手环屏幕分辨率 480×336（小米手环 10 Pro）：`config.designWidth = "device-width"`，按实际宽度缩放。
- 手环端 PBKDF2 为纯 JS 实现，Vela 无 JIT：10 次迭代在 VVD 实测约 2.1 s（约 212 ms/轮），1200 次会阻塞 2 分钟以上，因此两端默认 10、协议下限 1；真正防护是 5 次失败锁 30 s 递增。