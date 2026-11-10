# 小米手环 10 Pro 与 Vela 快应用（JS App）调研

> 标注：**[已验证]** = 有官方文档/源码/本机命令证据；**[已验证-二手]** = 社区教程/发行版实际可用；**[未验证]** = 需真机实测。

## 0. TL;DR

| 问题 | 结论 | 证据级别 |
| --- | --- | --- |
| 10 Pro 支持第三方 Vela 快应用吗 | 支持（Vela 5.0，HyperOS 3）；通过 AstroBox / 表盘自定义工具安装 | [已验证-二手] |
| 屏幕分辨率 | **480 × 336**（1.74" AMOLED，60Hz，官方规格） | [已验证] 官方 |
| 框架设计基准 | `config.designWidth` 默认 480；可设 `"device-width"`（BandOTP 做法）或具体数值 | [已验证] manifest 实例 |
| deviceTypeList | 只支持 `"watch"`（手环也用 watch，不能写 band） | [已验证] 官方文档 + 实例 |
| minPlatformVersion | **1000** 足够（BandOTP 声称支持 9/9 Pro/10/10 Pro；BandTOTP 资源覆盖 xmb10p） | [已验证-二手] |
| rpk 体积 | ≤ 1 MB（未分包）；分包总计 ≤ 4 MB、单包 ≤ 1 MB | [已验证-官方通用规范 / Vela 未验证] |
| 手环 10 Pro 快应用数量上限 | 无 20 个上限（与 Watch S5 相同） | [已验证-二手] |
| 安装是否需要 Authkey | 第三方工具（AstroBox/表盘自定义工具）需要；官方 Debug 通道不需要 | [已验证-二手] |
| 与手机 App 通信 | `system.interconnect`，要求两端**包名一致 + 签名证书一致** | [已验证-官方 FAQ] |
| fetch/网络 | 10 Pro 不支持 fetch（Vela 5 特性），必须离线设计 | [已验证-二手] |

## 1. 设备与系统事实

- 小米手环 10 Pro：1.74" AMOLED，**480 × 336 像素**，最高 2000 nits，60Hz。官方规格页：
  <https://www.mi.com/tw/product/xiaomi-smart-band-10-pro-nfc/specs/>（"解析度：480 x 336 畫素"）**[已验证]**
- 国行型号代号 `p67cn`（铝合金）/ `p67tc`（陶瓷）；海外版未被社区设备库完整收录，安装第三方资源出错风险高，必要时刷国行固件。**[已验证-二手]**（<https://www.bandbbs.cn/threads/29315/>）
- 10 Pro 运行 **Vela 5.0**：不支持 `fetch`；"部分使用 protobuf+jsc 打包的快应用在 10 Pro 上会不可用"；不要安装标注"支持 fetch"的 9 Pro 资源。**[已验证-二手]**
- 社区已有多款 10 Pro 快应用（浏览器、课程表、TOTP、电子书），说明第三方快应用生态可用。**[已验证-二手]**
- 官方开发者安装通道存在：运动健康 Debug → 第三方应用 → Install third app（需商务对接提供特制运动健康）。**[已验证-官方 FAQ]**

## 2. manifest.json 约束（Vela JS App / 快应用）

以两个真实可运行项目为参照（均为 10/10 Pro 可用）：

**BandOTP（lin945/mi_band_mfa，Apache-2.0）** `src/manifest.json` **[已验证]**
```json
{
  "package": "asia.bilibili.mfa",
  "name": "腕码",
  "versionName": "1.2.1",
  "versionCode": 1,
  "minPlatformVersion": 1000,
  "icon": "/common/logo.png",
  "deviceTypeList": ["watch"],
  "features": [
    { "name": "system.router" },
    { "name": "system.storage" },
    { "name": "system.interconnect" }
  ],
  "config": { "logLevel": "log", "designWidth": "device-width" },
  "router": {
    "entry": "pages/index",
    "pages": {
      "pages/index": { "component": "index" },
      "pages/detail": { "component": "detail" }
    }
  }
}
```

**BandTOTP（leset0ng/BandTOTP-Band，MIT）** `manifest.json` **[已验证]**
```json
{
  "package": "com.lst.bandtotp",
  "name": "BandTOTP",
  "versionName": "1.1",
  "versionCode": 2,
  "minPlatformVersion": 1000,
  "icon": "/common/logo.png",
  "deviceTypeList": ["watch"],
  "features": [
    { "name": "system.interconnect" },
    { "name": "system.storage" },
    { "name": "system.prompt" }
  ],
  "config": { "logLevel": "log", "designWidth": 192 }
}
```

要点：
- `package`：全小写字母/数字/点；**与手机 App 的 applicationId 完全相同**（interconnect 要求）。本项目两端 = `dev.wristkey.app`。
- `name`：应用名，≤ 6 个汉字（"腕证" 满足）；与图标 `icon`（建议 192×192）一起展示。
- `deviceTypeList`：**只支持 `["watch"]`**；手环也归类为 watch，不能写 band/pill。**[已验证-官方文档 + 实例]**
- `minPlatformVersion`：`1000` 是当前可用基线。官方文档另有 `minAPILevel`（API 版本）用于能力分级；interconnect 无高版本要求。**[已验证-实例]**
- `features`：用到哪个 `@system.*` 就声明哪个（interconnect/storage/router 必须）。
- `designWidth`：
  - 默认 **480**（官方 FAQ："框架默认的屏幕分辨率是 480*480，Vela 三方应用会自动适配"）。
  - BandOTP 用 `"device-width"`（1:1 实际像素），并明确支持 10 Pro。
  - BandTOTP 用 `192` 因为面向胶囊屏手环 9/10（192 宽基准）。
  - **10 Pro 建议 `480` 或 `"device-width"`**；按 480×336 设计稿写绝对 px 即可。
- `router.entry`/`pages`：页面目录名、key、ux 文件名保持一致；页面必须在 `router.pages` 注册。
- `versionCode` 每次发版 +1；`package` 不可与原生应用重名（但本项目刻意与手机 App 同名以满足 interconnect）。
- 不允许使用自定义组件时忘记 `--enable-custom-component`；手环上不建议用自定义组件。

## 3. 屏幕与 UI 适配（480×336）

- 实际像素 **480(宽) × 336(高)**；官方规格写作 480×336。设计稿按 480 基准，1 单位 = 1px（designWidth=480 时）。
- 手环屏幕为**矩形**，无圆形安全区问题；但仍有圆角/边缘触控区，主要控件留 12–16px 内边距。
- 参考布局（BandOTP，10 Pro 可用）：
  - 首页一屏显示 1 或 2 个验证码卡片（`layoutMode` 1/2），分类按钮 + 分页；
  - 字号：标题 ~28–32px、验证码 ~48–56px、辅助文字 ~20–24px（`config.designWidth=device-width` 下按实际像素）；
  - 用 `<list>`/`<scroll>` 时必须显式高度；`if/elif/else` 必须相邻兄弟节点；文本必须在 `<text>` 内。
- 详情页/菜单页通过 `@system.router` 跳转；返回用 `onBackPress` 或页面按钮。
- **不要**依赖 `:hover`、`*`、后代选择器等 Web 选择器（Vela 不支持）。

## 4. rpk 体积与数量限制

- 快应用静态检测（官方通用规范，适用于快应用打包）：
  "如果未分包，rpk 不能超过 1M；如果分包，整个快应用的所有分包大小不超过 4M，单个分包/基础包大小不能超过 1M。"
  来源：<https://doc.quickapp.cn/ide/static-detection.html> **[已验证-官方通用规范]**
  Vela 侧是否同样执行该限制**未见官方原文 [未验证]**；按更保险的 1MB 控制。
- 本机现有 debug 构建实测：`dist/asia.bilibili.mfa.debug.1.2.1.rpk` 压缩后 **49 KB**、解压后约 291 KB（含 5 个页面 js + 图片）。本项目的纯文本 TOTP 应用远低于限制。**[已验证-本机]**
- 手环 10 Pro 无 20 个快应用数量上限（Watch S5 同）；限制主要来自设备剩余空间与单个安装耗时。**[已验证-二手]**
- 安装建议：一次只装一个并等待完成；先在模拟器/9 Pro 验证再上 10 Pro；避免 protobuf/jsc 打包。

## 5. 安装方式

### 5.1 AstroBox（跨平台，推荐）
- 支持 Android/iOS/桌面/Web；iOS 连接安装快应用前需要"安卓伪装"（官方说明）。**[已验证-官方]**
- 连接设备：登录小米账号同步，或手动 MAC + **AuthKey**（还需系统蓝牙配对确认）。AuthKey 可从"表盘自定义工具 → AuthKey 读取工具"（小米健康研究授权）获取。**[已验证-二手]**
- 安装：资源社区搜 `quick_app` → 选设备型号下载安装；或"安装本地资源"选 `.rpk`。
- device key 示例（AstroBox 资源清单）：`xmb9`=手环9、`xmb9p`=9 Pro、`xmb10`=手环10、`xmb10p`=**手环10 Pro**、`xmrw5/6`=Redmi Watch。**[已验证]**（BandTOTP 资源 `manifest_v2.json`）

### 5.2 表盘自定义工具（Android/iOS）
- 需要 AuthKey（米坛社区实名注册后下载工具，工具内读取）。
- 「工具 → 蓝牙一键安装」选择本地 rpk/bin；资源区安装需先选对设备型号。
- 社区反馈：该工具 + AstroBox 是当前 10 Pro 装快应用的主流方式。**[已验证-二手]**

### 5.3 官方调试通道
- 运动健康（特制版）→ 我的 → 关于 → Debug → 第三方应用 → 输入包名（卸载时才需精确包名）→ Install third app → 选本地 rpk。**[已验证-官方 FAQ]**

### 5.4 adb
- 未发现可行方案；rpk 不是 APK，手环侧安装由手机穿戴服务完成。**[未验证/无案例]**

## 6. 与手机 App 通信（system.interconnect）

- 手环端：`import interconnect from '@system.interconnect'`，`const conn = interconnect.instance()`；
  `conn.onopen/onclose/onerror/onmessage`；发送 `conn.send({ data: <string|object>, success, fail })`；
  收到消息取 `message.data`（BandOTP 兼容 string 或 `{data}`）。
  （BandOTP：`src/pages/index/index.ux` `setupPhoneChannel()` / `extractPayload()` / `sendConfigResponse()`）**[已验证-源码]**
- 手机端：小米穿戴服务 SDK `xms-wearable-lib`，见 [xms-sdk.md](./xms-sdk.md)。
- **硬性要求**：快应用包名 == 手机 App 包名，且 rpk 证书 == APK 证书。官方 FAQ 明确指出通信前会检查签名，不一致直接拒绝。**[已验证-官方]**
- 官方 JIDL：`system.interconnect@1.0`，注释写明 `AppInfo` "用于连接并验证手机上的应用"。**[已验证-源码]**
  <https://github.com/open-vela/frameworks_runtimes_feature/blob/dev/modules/jidl/interconnect.jidl>
- 官方样例（手表↔Android 图片传输，演示 onopen/onclose/onerror、分片 header→data→end）：<https://iot.mi.com/vela/quickapp/en/samples/> **[已验证-官方]**
- 消息大小：官方 interconnect 文档未给出明确上限；官方样例采用**分片**传输大图，说明存在单条限制（具体值未知）。我们协议每包 <1 KB，天然安全。**[未验证：具体上限]**

## 7. 待真机验证（本任务相关）

- [ ] 10 Pro 实机安装本 rpk（AstroBox local install，device=xmb10p）
- [ ] `designWidth=480` vs `"device-width"` 下的实际排版（480×336 是否 1:1）
- [ ] 10 Pro 对 `minPlatformVersion: 1000` 的接受度（预期 OK）
- [ ] 未分包 rpk 体积是否被执行 ≤1MB 限制（本项目远低于）
- [ ] 手机↔手环 interconnect 首条消息与 ack
