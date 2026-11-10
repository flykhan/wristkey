# 同步协议 v2

手机（Android App）↔ 手环（Vela 快应用）。消息体均为 **UTF-8 JSON 字符串**，经小米穿戴服务通道传输；
手机 → 手环用 xms `MessageApi.sendMessage(nodeId, bytes)`，手环 → 手机用 `system.interconnect`
`connect.send({ data: "<json string>" })`。

## 信封字段

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | string | 是 | 消息类型 |
| `version` | number | 是 | 协议版本，当前 `2` |
| `sentAt` | number | 是 | 发送时刻 Unix 毫秒 |

未知 `type` / `version` 必须忽略（向前兼容）。所有消息必须是单个 JSON 对象。

## 手机 → 手环

### 1. `mfa_sync_begin`

开始一次全量同步。收到即清空 staging。

`~json
{ "type": "mfa_sync_begin", "version": 2, "sentAt": 1760000000000,
  "syncId": "sync-1760000000000-7f3a", "accountCount": 12 }
`~

- `syncId`：本次同步唯一标识，同一次同步的后续消息必须携带相同值。
- `accountCount`：即将发送的 `mfa_sync_account` 条数（0 表示清空手环账号）。

### 2. `mfa_sync_account`

`~json
{ "type": "mfa_sync_account", "version": 2, "sentAt": 1760000000001,
  "syncId": "sync-1760000000000-7f3a", "index": 0,
  "account": {
    "id": "s_ab12cd34ef56",
    "issuer": "GitHub",
    "accountName": "me@example.com",
    "category": "开发",
    "secret": "JBSWY3DPEHPK3PXP",
    "algorithm": "SHA1",
    "digits": 6,
    "period": 30,
    "updatedAt": 1760000000000
  } }
`~

校验规则（手环端必须执行，非法消息直接丢弃并计入错误，不中断同步）：

| 字段 | 规则 |
| --- | --- |
| `id` | 非空字符串，≤64；同一次同步内唯一；缺省时用 `index` 兜底 |
| `issuer` / `accountName` | 字符串，各 ≤64；不能同时为空（否则丢弃） |
| `category` | 字符串，缺省 `"默认分类"`，≤32 |
| `secret` | Base32，A–Z2–7（可含空格/`=`，手环端归一化）；长度为 8 的倍数最优，非 8 倍数按位补齐 |
| `algorithm` | `SHA1` / `SHA256` / `SHA512`，缺省 `SHA1` |
| `digits` | 6–10 整数，缺省 6 |
| `period` | 5–300 整数秒，缺省 30 |
| `updatedAt` | 可选，毫秒时间戳 |

### 3. `mfa_sync_commit`

`~json
{ "type": "mfa_sync_commit", "version": 2, "sentAt": 1760000000010,
  "syncId": "sync-1760000000000-7f3a", "accountCount": 12 }
`~

手环端处理：

1. 校验 `syncId` 是当前 staging 的 id、`accountCount` 与 begin 一致、已接收条数（合法且去重后）等于 `accountCount`；
2. 全部通过 → 原子写入 `mfa_snapshot_v2` → 回复成功 ack；
3. 任一不满足 → 丢弃 staging，旧快照不变 → 回复失败 ack（`error` 说明原因）。

## 手环 → 手机（best effort）

### `mfa_sync_ack`

`~json
{ "type": "mfa_sync_ack", "version": 2, "sentAt": 1760000000011,
  "syncId": "sync-1760000000000-7f3a", "ok": true,
  "received": 12, "committed": 12, "error": null }
`~

手机端若实现接收回调则更新为"已确认"；否则显示"已发送（手环将离线使用）"。

### `mfa_sync_request`

手环端无快照或用户主动点"重新同步"时发出，请求手机推送全量快照：

`~json
{ "type": "mfa_sync_request", "version": 2, "sentAt": 1760000000020,
  "requestId": "req-1760000000020-1" }
`~

手机端收到后执行一次完整同步（若已连接且已授权），否则忽略并记录日志。

## 错误与重试

- 手环端：begin 超时（默认 120 s 无新 account）或收到新 begin 时丢弃旧 staging；
- 手机端：发送失败（无设备/未授权/BLE 断连）时不修改本地账号数据，仅更新同步状态；
- 重试策略：整轮重发（幂等，全量替换）；
- 消息大小：单条 < 1 KB（Stratum 32 字符 issuer/account 限额 + Base32 secret 通常 < 200 字符）。

## 兼容性

- v1（BandOTP 的 `mfa_config_snapshot` 单条消息）**不再使用**；手环端可选择性兼容读取旧快照，
  但不参与新同步。
- 版本升级：新增字段必须可选；破坏性变更提升 `version` 并在手环端保留旧版本解析分支。

## 测试夹具

`tools/fixtures/` 提供合法/非法消息样例与完整同步脚本，手环端/手机端/CLI 三端复用同一套 JSON。
