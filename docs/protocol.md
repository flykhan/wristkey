# 同步协议 v3

手机（Android App）↔ 手环（Vela 快应用）。消息体均为 **UTF-8 JSON 字符串**，经小米穿戴服务通道传输；
手机 → 手环用 xms `MessageApi.sendMessage(nodeId, bytes)`，手环 → 手机用 `system.interconnect`
`connect.send({ data: "<json string>" })`。

## 信封字段

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | string | 是 | 消息类型 |
| `version` | number | 是 | 协议版本，当前 `3` |
| `sentAt` | number | 是 | 发送时刻 Unix 毫秒 |

未知 `type` / `version` 必须忽略（向前兼容）。所有消息必须是单个 JSON 对象，单条 < 1 KB。

## 版本兼容矩阵

| 发送方 | 接收方 | 行为 |
| --- | --- | --- |
| 手环 v2.0（v3） | 手机 v2.0（v3） | 完整功能：账号 + 密码 + 入口图案 |
| 手机 v2.0（v3） | 手环 v1.0.x（v2） | 手环忽略 begin（version 不匹配），不同步；手机 8 s 无 ack 时提示"手环应用版本过低" |
| 手机 v1.2（v2） | 手环 v2.0（v3） | 手环按 v2 解析，同步账号但**不带密码**；手环 ack 用 v3，旧手机忽略 ack（显示已发送） |
| 手环 v2.0（v3） | 手机 v1.2（v2） | 手机忽略 pin/ack v3；不影响账号数据 |

实现要求：

- 手环端解析 `mfa_sync_begin/account/commit` 时接受 `version ∈ {2, 3}`；`account.password` 仅 v3 可选字段，v2 视为无密码。
- 手机端解析手环消息时接受 `version ∈ {2, 3}`；pin 相关消息仅接受 `version == 3`。
- 手机端发出 v3 同步后若 8 s 内未收到 ack，提示用户升级手环应用（旧手环不会回"版本不支持"）。

## 手机 → 手环

### 1. `mfa_sync_begin`

开始一次全量同步。收到即清空 staging。

```json
{ "type": "mfa_sync_begin", "version": 3, "sentAt": 1760000000000,
  "syncId": "sync-1760000000000-7f3a", "accountCount": 12 }
```

- `syncId`：本次同步唯一标识，同一次同步的后续消息必须携带相同值。
- `accountCount`：即将发送的 `mfa_sync_account` 条数（0 表示清空手环账号）。

### 2. `mfa_sync_account`

```json
{ "type": "mfa_sync_account", "version": 3, "sentAt": 1760000000001,
  "syncId": "sync-1760000000000-7f3a", "index": 0,
  "account": {
    "id": "s_ab12cd34ef56",
    "issuer": "steam",
    "accountName": "flw.halo",
    "category": "默认分类",
    "secret": "JBSWY3DPEHPK3PXP",
    "algorithm": "SHA1",
    "digits": 6,
    "period": 30,
    "otpType": "totp",
    "password": "correct horse battery staple",
    "updatedAt": 1760000000000
  } }
```

校验规则（手环端必须执行，非法消息直接丢弃并计入错误，不中断同步）：

| 字段 | 规则 |
| --- | --- |
| `id` | 非空字符串，≤64；同一次同步内唯一；缺省时用 `index` 兜底 |
| `issuer` / `accountName` | 字符串，各 ≤64；不能同时为空（否则丢弃） |
| `category` | 字符串，缺省 `"默认分类"`，≤32 |
| `secret` | Base32，A–Z2–7（可含空格/`=`，手环端归一化）；长度为 8 的倍数最优，非 8 倍数按位补齐 |
| `otpType` | 可选：`"totp"`（缺省）或 `"steam"`（大小写不敏感）；见下方 Steam 规则 |
| `algorithm` | `SHA1` / `SHA256` / `SHA512`，缺省 `SHA1`；Steam 固定 SHA1 |
| `digits` | 6–10 整数，缺省 6；Steam 固定 5（表示 5 位字母数字码，不是 5 位数字） |
| `period` | 5–300 整数秒，缺省 30；Steam 固定 30 |
| `password` | **v3 可选**：字符串，≤128，允许空格与 Unicode，不允许 `\u0000`–`\u001f` 控制字符；空字符串等同缺省；缺省表示"手机端没有密码" |
| `updatedAt` | 可选，毫秒时间戳 |

> 密码只用于手环详情页展示（默认遮罩），不参与 TOTP 计算。密码不是必填项：Stratum 备份没有密码；
> Bitwarden 未加密 JSON 的 `items[].login.password` 会带入。

#### Steam Guard（`otpType: "steam"`）

Steam 的验证码**不是纯数字**，而是 5 位字母数字（字母表 `23456789BCDFGHJKMNPQRTVWXY`）。算法与
Stratum 的 `SteamOtp` 一致：

1. HMAC-SHA1(secret, `floor(unixSeconds / 30)` 的 8 字节大端)；
2. RFC 4226 动态截断得到 31 位整数 `material`；
3. 重复 5 次：`char = ALPHABET[material % 26]; material = floor(material / 26)`，从**低位字符**开始输出
   （即 Steam 客户端显示的 5 位顺序）。

因此 Steam 账号必须满足：`digits=5`、`period=30`、`algorithm=SHA1`、`otpType="steam"`；
手环端不得按 10 的幂取模、不得补零成 6 位数字。旧版手环会把 `digits=5` 视为非法并丢弃该账号，
这是预期的降级行为（升级两端即可）。

### 3. `mfa_sync_commit`

```json
{ "type": "mfa_sync_commit", "version": 3, "sentAt": 1760000000010,
  "syncId": "sync-1760000000000-7f3a", "accountCount": 12 }
```

手环端处理：

1. 校验 `syncId` 是当前 staging 的 id、`accountCount` 与 begin 一致、已接收条数（合法且去重后）等于 `accountCount`；
2. 全部通过 → 原子写入 `mfa_snapshot_v3` → 回复成功 ack；
3. 任一不满足 → 丢弃 staging，旧快照不变 → 回复失败 ack（`error` 说明原因）。

快照存储键：`mfa_snapshot_v3`（与 v2 的 `mfa_snapshot_v2` 并存；首次启动 v3 时若 v3 不存在则读取 v2 迁移，
迁移后保留 v2 作为回滚备份，不删除）。

### 4. `mfa_pin_set`（v3 新增）

手机 App 设置/修改入口图案。手机只发送**派生结果**，不发送图案明文。

```json
{ "type": "mfa_pin_set", "version": 3, "sentAt": 1760000000020,
  "pin": { "algorithm": "PBKDF2-SHA256", "salt": "0123456789abcdef0123456789abcdef",
           "hash": "64 位小写十六进制", "iterations": 1200 } }
```

- `salt`：16 字节随机盐，32 位小写十六进制。
- `hash`：PBKDF2-HMAC-SHA256(图案规范串, salt, iterations) 的 32 字节结果，64 位小写十六进制。
- `iterations`：1000–20000 的整数，当前两端默认 `1200`（手环端纯 JS 计算需保持 < 1 s）。
- 手环端校验失败（格式/范围不对）→ 回复 `mfa_pin_ack{ok:false,error:"invalid_pin_payload"}`，旧图案不变。
- 成功 → 原子写入 `wristkey_pin_v1`，回复 `mfa_pin_ack{ok:true,enabled:true}`，并向手机广播 `mfa_pin_state`。

#### 图案规范串

入口图案固定 **5 位**，每位是 `T`（三角形）/ `S`（方形）/ `C`（圆形）之一，按点击顺序拼接，例如 `TSCCT`。
手环端只接受 `/^[TSC]{5}$/`；手机端生成时同样校验。图形→字母映射固定：三角形 `T`、方形 `S`、圆形 `C`。

### 5. `mfa_pin_query`（v3 新增）

```json
{ "type": "mfa_pin_query", "version": 3, "sentAt": 1760000000030, "requestId": "pin-1760000000030" }
```

手机连接上手环后查询入口图案状态。手环收到后回复 `mfa_pin_state`（带同一个 `requestId`）。

### 6. `mfa_pin_clear`（v3 新增）

```json
{ "type": "mfa_pin_clear", "version": 3, "sentAt": 1760000000040 }
```

手机 App 关闭入口图案。手环删除 `wristkey_pin_v1` 与失败计数，回复 `mfa_pin_ack{ok:true,enabled:false}`。

## 手环 → 手机（best effort）

### `mfa_sync_ack`

```json
{ "type": "mfa_sync_ack", "version": 3, "sentAt": 1760000000011,
  "syncId": "sync-1760000000000-7f3a", "ok": true,
  "received": 12, "committed": 12, "error": null }
```

手机端若实现接收回调则更新为"已确认"；否则显示"已发送（手环将离线使用）"。

### `mfa_sync_request`

手环端无快照、用户主动点"重新同步"或数据库为空时发出，请求手机推送全量快照：

```json
{ "type": "mfa_sync_request", "version": 3, "sentAt": 1760000000020,
  "requestId": "req-1760000000020-1" }
```

手机端收到后执行一次完整同步（若已连接且已授权），否则忽略并记录日志。

### `mfa_pin_ack`（v3 新增）

```json
{ "type": "mfa_pin_ack", "version": 3, "sentAt": 1760000000021,
  "ok": true, "enabled": true, "error": null }
```

- `ok=false` 时 `error` ∈ `invalid_pin_payload` / `invalid_version` / `storage_error`。
- 手环设置/关闭图案后主动发送（无 requestId），手机据此刷新"入口图案"状态。

### `mfa_pin_state`（v3 新增）

```json
{ "type": "mfa_pin_state", "version": 3, "sentAt": 1760000000031,
  "enabled": true, "updatedAt": 1760000000020, "requestId": "pin-1760000000030" }
```

手环回复 `mfa_pin_query`，或在本地设置/关闭图案后主动广播（`requestId` 省略表示广播）。
手机端只缓存 `enabled` / `updatedAt`，无法从手环取回图案或 hash。

## 入口图案安全约定

- 手环只存 `salt + hash + iterations + updatedAt`，不存图案明文；手机也不存图案（只缓存 enabled 状态）。
- 3^5 = 243 种组合，只能挡"随手拿到手环的人"和肩窥，**不能**作为静态加密密钥；静态加密密钥必须由手机下发随机密钥。
- 手环失败策略：连续 5 次错误锁 30 s，之后每错一次增加 30 s；成功解锁或重启后按实现重置。
- 手机端关闭入口图案只要求手机已解锁且手环已连接（xms 通道已做包名+签名校验）；没有"旧图案"校验，
  这是产品取舍：手机 App 本身是信任根。手环端修改/关闭图案必须先验证旧图案。

## 错误与重试

- 手环端：begin 超时（默认 120 s 无新 account）或收到新 begin 时丢弃旧 staging；
- 手机端：发送失败（无设备/未授权/BLE 断连）时不修改本地账号数据，仅更新同步状态；
- 重试策略：整轮重发（幂等，全量替换）；
- 消息大小：单条 < 1 KB（Stratum 32 字符 issuer/account 限额 + Base32 secret 通常 < 200 字符；密码 ≤128）。

## 确定性约定（实现对齐）

以下细节用于消除跨端歧义，手环端/手机端/测试必须一致：

- **account.id**：手机端生成为 `"s_" + sha1(normalizedSecret) 十六进制前 12 位`，其中
  `normalizedSecret` = 去空格、`-`、`=` 后转大写（与 Stratum 主键一致）。手环端只校验非空、≤64、
  同轮唯一，不重新计算。
- **快照顺序**：协议不保证账号顺序；跨端对拍用 **id 集合 + 字段值**，不比较数组下标。手环端 UI 自行
  分组/排序（分类 → id）。
- **空同步**：`begin{accountCount:0}` + `commit{accountCount:0}` 合法，手环写入空快照（清空全部账号）。
- **重复 index**：同一轮内重复发送同一 index，后到者覆盖先到者（计入 `duplicate_index`，不视为失败）；
  同一 `account.id` 出现在不同 index → 丢弃后到者。
- **非法 begin**：`syncId` 为空/超长或 `accountCount` 非法（非 0–500 整数）→ 忽略该 begin，**保留**当前
  staging 与已存快照；只有合法 begin 才重置 staging。
- **失败 ack 原因码**：`no_active_begin` / `sync_id_mismatch` / `account_count_mismatch` /
  `incomplete_sync`（均为提交后丢弃 staging、旧快照不变）。
- **超时**：staging 超过 120 s 无新消息自动丢弃，不计入错误。
- **密码合并**：同一 `account.id` 再次同步时，`password` 为空/缺省表示"不修改已有密码"，手环保留旧值；
  显式清空密码需要手机端发送空字符串 `""`（协议层视为"清空"）。

> 实现注意：手环端把 `password` 缺省与 `""` 区分开——缺省=保留，空串=清空。手机端 2.0 的全量同步策略：
> 每条 account 都带 `password`，有密码发实际字符串、无密码发 `""`（手机是数据源，删除密码会同步到手表）。
> 只有旧版（v2）消息或未来做增量同步时才省略字段，手环保留旧值；因此旧手机同步不会清掉手环上已有的密码。

## 测试夹具

`tools/fixtures/` 与 `e2e/fixtures/` 提供合法/非法消息样例、加密备份与完整同步序列，
手环端/手机端/CLI/QA 四端复用同一套 JSON。v3 新增夹具：`protocol-v3/`（带密码账号、pin_set/pin_ack、
pin_query/pin_state、pin_clear、非法 pin 载荷、v2 兼容样例）。