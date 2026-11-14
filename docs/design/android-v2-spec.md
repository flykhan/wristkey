# Android App v2.0 重设计说明

目标：把现有"技术演示"式界面重做成一只**日常可用的验证码钱包**——深色、克制、信息层级清楚，
打开就能看到 6 位码；导入、编辑、同步各自有明确入口，不再把大表单常驻在列表里。

## 1. 视觉规范

| Token | 值 | 用途 |
| --- | --- | --- |
| `bg` | `#0B0F0E` | 全屏背景 |
| `surface` | `#121A16` | 卡片 |
| `surfaceHigh` | `#1A241F` | 输入框、底部弹层 |
| `outline` | `#24312B` | 分隔线/描边 |
| `mint` | `#6EE7C7` | 主色：验证码、选中态、主按钮 |
| `text` | `#E8F1EC` | 主文字 |
| `textDim` | `#8FA39A` | 次级文字 |
| `warning` | `#F2B880` | 密码/提醒 |
| `error` | `#F26D6D` | 错误 |
| `steamBlue` | `#7AA2F7` | Steam 标签 |

- 形状：卡片圆角 24dp，按钮 16dp，底部导航用 tonal surface；不使用纯白背景。
- 字体：标题 24–28sp SemiBold，验证码 40–44sp Medium + `FontFamily.Monospace` + 字距 2sp；
  正文 14–15sp，说明 12sp。
- 动效：验证码倒计时用 3dp 圆角进度条（mint → outline），每秒平滑推进；列表用 `animateItemPlacement`。
- 沉浸式：`enableEdgeToEdge()` 保留，状态栏透明；顶部内容留 `WindowInsets.statusBars`。

## 2. 信息架构（3 个底部 Tab）

```
┌──────────────────────────────┐
│  腕证             ● 已连接   │  ← 顶栏：标题 + 连接状态胶囊（点按刷新）
│                              │
│  [搜索 issuer / 账号]         │
│                              │
│  ┌────────────────────────┐  │
│  │ steam           13s    │  │
│  │ flw.halo               │  │
│  │ 467JW                  │  │  ← 验证码 40sp，Steam 蓝/数字薄荷绿
│  │ ▓▓▓▓▓▓▓░░░░░░░         │  │
│  └────────────────────────┘  │
│  ┌────────────────────────┐  │
│  │ GitHub         13s     │  │
│  │ dev@example.com        │  │
│  │ 792 685                │  │
│  │ ▓▓▓▓▓▓▓▓▓▓░░░░         │  │
│  └────────────────────────┘  │
│                              │
│                    ( + 导入 )│  ← FAB
├──────────────────────────────┤
│   账号       同步       设置  │
└──────────────────────────────┘
```

- **账号（默认页）**：搜索框 + 账号卡列表（按 issuer 排序，忽略分类）。每张卡：issuer + `accountName` +
  当前验证码 + 秒数 + 进度条；Steam 显示 5 位字母数字，右上角小标签 `STEAM`。点卡片 → 详情底部弹层。
- 搜索框为空时隐藏键盘，不做分类 chip（分类不参与手环筛选，避免两套维度）。
- 列表为空时显示插画式空状态 + "导入备份"主按钮。
- **FAB「导入」** → 模态底部弹层，四个入口：`Stratum 备份`、`Bitwarden JSON`、`otpauth 链接`、`手动添加`。
  前三个走现有文件选择/解析流程；导入预览改成底部弹层（保留 合并/替换 两个按钮）。
- **同步**：设备状态卡 + 立即同步 + 入口图案卡。
- **设置**：导入、账号统计、关于/版本/签名指纹、开源许可、安全说明。

## 3. 关键页面行为

### 3.1 账号详情（`ModalBottomSheet`）

- 标题：issuer + 分类小字；关闭按钮。
- 字段：`用户名`（accountName）、`密码`（无密码显示"未保存"）、`验证码`（大号 + 进度条）。
- 密码默认 `••••••••`；点按整行显示 10 s，右上角提示"10s 后自动隐藏"；离开弹层立即恢复遮罩。
- 密码行右侧提供"复制"图标（`ClipboardManager`，复制后 toast）。
- 底部：`编辑`（打开全屏编辑器）、`删除`（二次确认 AlertDialog）。

### 3.2 账号编辑器（全屏页面/`AnimatedVisibility` sheet）

- 字段：issuer、accountName、密码（可选，可见性切换）、secret（默认遮罩 + 可见性切换）、类型（TOTP/Steam）、
  算法、位数、周期、分类。
- 高级参数折叠在"高级"里；TOTP 默认 SHA1/6/30；Steam 固定 5/30/SHA1 且高级参数隐藏。
- `otpauth://` 粘贴框保留（作为"从链接添加"入口）。
- 保存校验错误就地显示，不再用一长串 error 文本。

### 3.3 同步页

```
┌──────────────────────────────┐
│  同步                        │
│  ┌────────────────────────┐  │
│  │ 手环  Xiaomi Watch     │  │
│  │ 服务● 连接● 权限● 应用●│  │
│  │ [授权] [打开手环]       │  │
│  │ [      立即同步       ] │  │
│  │ 上次确认：已提交 32 个   │  │
│  └────────────────────────┘  │
│  ┌────────────────────────┐  │
│  │ 入口图案     已开启     │  │
│  │ 手机和手环都可设置/修改 │  │
│  │ [设置入口图案] [关闭]   │  │
│  └────────────────────────┘  │
└──────────────────────────────┘
```

- 状态用 4 个胶囊：服务/连接/权限/手环应用，异常项用 warning 色，点按刷新。
- 同步时按钮变为进度条（`sent/total`），完成后 Snackbar 显示 ack 结果；无 ack 8 s 提示版本过低。
- 入口图案状态：连接后自动发 `mfa_pin_query`；`enabled` 为 `true/false/unknown` 三态。
  点"设置入口图案"进入 3.4；已开启时显示"关闭入口密码"（二次确认后发 `mfa_pin_clear`）。

### 3.4 入口图案设置页（全屏）

- 与手环完全同构：5 个占位圆点 + 三个大图形按钮（三角 `#6EE7C7`、方形 `#7AA2F7`、圆形 `#F2B880`），
  点满 5 位后进入"再输入一次确认"，两次一致才可保存；不一致抖动清空。
- 顶部文案："设置入口图案 · 手机和手环都能改"；底部说明"只保存图案的派生值，不保存图案本身"。
- 保存：PBKDF2-HMAC-SHA256（10 次，16 字节随机盐）→ 发 `mfa_pin_set`；等待 `mfa_pin_ack`。
  成功 → 返回同步页并刷新状态；失败/8 s 超时 → Snackbar 提示（不影响手环旧图案）。
- 关闭入口密码：`AlertDialog` 确认后发 `mfa_pin_clear`。
- 图案规范串与手环一致：`T`/`S`/`C` 五位，见 `docs/protocol.md`。

### 3.5 设置页

- 分组卡片：`数据`（导入备份、账号数量、清空账号）、`安全`（入口图案说明、本地不存密码明文提示）、
  `关于`（版本 2.0.0、包名、签名证书 SHA-256 指纹、隐私说明、开源许可链接）。
- 不显示大段技术说明；需要时点进二级页。

## 4. 状态与代码组织（建议）

- `AppUiState` 扩展：`pinStatus: PinStatus`（`unknown/enabled/disabled`、`updatedAt`、`busy`、`error`）、
  `patternInput: String`、`patternConfirm: String`、`patternStage`、`detailAccountId: String?`、
  `importSheetVisible: Boolean`、`editorVisible: Boolean`（或继续用 `draft` 是否激活判断）。
- `AppActions` 新增：`onDetailOpen/Close`、`onImportSheetChange`、`onEditorOpen/Close`、
  `onPatternInput/Undo/Reset/Save`、`onPinDisable`、`onPinQuery`。
- `WearableSyncController.Listener` 新增：`onPinAck(SyncProtocol.PinAck)`、`onPinState(SyncProtocol.PinState)`；
  新增方法：`setPin(saltHex, hashHex, iterations)`、`clearPin()`、`queryPin(requestId)`。
- 协议客户端 `SyncProtocol.kt` 升至 v3：`VERSION = 3`、`encodeAccount` 加可选 `password`、
  新增 `buildPinSet/clearPin/pinQuery`、`parseIncoming` 支持 `mfa_pin_ack` / `mfa_pin_state` 并兼容 ack/request v2。
- 账号模型 `WristKeyAccount`/`AccountDraft` 加 `password: String = ""`；Repository JSON 读写加 `password`；
   旧数据缺字段按空串处理。BitwardenImporter 读取 `login.password`（≤128）；Stratum 无密码。
- **合并规则**：同 id 时新账号的 password 非空则覆盖；为空则保留旧密码（与协议"缺省保留"一致）。
  全量同步时：非空发实际值；空串发 `""`（清空）；实现上可统一发送实际字符串（含空串）——手环端把空串视为清空，
  这样手机端"删除密码"能生效；与文档中"省略=保留"不冲突。

## 5. 验收标准

- 视觉：不再有常驻大表单/大段说明；首屏只看到搜索、账号卡、底部导航、FAB；暗色主题统一。
- 功能：导入 Stratum/Bitwarden 后列表立即出现；点卡片能看到用户名/密码/验证码；密码 10 s 自动隐藏；
  编辑/删除/搜索可用；同步进度与 ack 正常；入口图案可设置/关闭，手环侧状态可查询。
- 兼容：旧 SharedPreferences 数据可读；v2 手环同步不传密码也不崩；无网络权限新增。
- 测试：`./gradlew testDebugUnitTest` 全绿（新增协议 v3、图案派生、密码合并、导入密码用例）；
  `assembleRelease` 产出 2.0.0 APK。
