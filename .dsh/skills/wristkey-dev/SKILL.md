---
name: wristkey-dev
description: WristKey（腕证）项目工作流：小米手环 10 Pro 的 Vela 快应用 + Kotlin/Compose 手机端，TOTP/Steam Guard/密码、xms 同步协议 v3、Stratum/Bitwarden 导入、VVD 与真机调试、版本发布和签名校验。用于在 XiaomiBandProj 仓库内改代码、构建、测试、排查手环/同步/图案问题或发布 GitHub Release。
whenToUse: 任务涉及 WristKey / 腕证 / XiaomiBandProj，或要修改、构建、测试、发布、调试手环端或手机端应用时。
---

# WristKey 项目生存指南

> 这是给未来新会话的项目 skill，不是用户文档。先读本文件，再读仓库里的权威文档。
> 版本号、测试数量会变；**以仓库文件和 `README.md` 为准**，不要凭记忆断言。

## 0. 新会话开场检查

在改任何东西之前：

```bash
cd <仓库根目录>
git status --short
git log -1 --oneline
node -p "require('./band-app/src/manifest.json').versionName + ' / ' + require('./band-app/src/manifest.json').versionCode"
grep -n 'versionName\|versionCode' android-app/app/build.gradle.kts
```

然后按需读：

- `README.md`：当前版本、产物、命令、版本历史。
- `docs/protocol.md`：**协议 v3 的唯一权威**（消息、字段、校验、合并语义）。
- `docs/usage.md`：用户可见行为（锁屏、同步、导入、故障排查）。
- `docs/architecture.md`、`docs/security.md`：分层与威胁模型。
- `reports/e2e-report.md`：最近一次全量验收结果与残余风险。
- `research/notes/`：Vela 快应用、xms SDK、签名、AstroBox 等调研结论。

## 1. 项目地图

```
band-app/                 Vela 快应用（手环端，JS）
  src/manifest.json       package/version/versionCode、features、router.entry
  src/app.ux              必须是 <script>…</script> 包裹的 export default
  src/pages/index/        主界面 + 内联启动图案锁屏（关键）
  src/pages/menu/         立即同步 / 入口密码 / 关于 / 退出
  src/pages/pin/          设置/修改/关闭图案
  src/pages/detail/       账号详情（用户名/密码遮罩/验证码）
  src/pages/picker/       4x4 分页首字母筛选
  src/pages/lock/         旧版独立锁屏页，**当前启动流程不用它，不要接回去**
  src/common/scripts/     accountModel/syncProtocol/interconnect/totp/pin/pinStore/pinSession/settings
  tests/                  node --test

android-app/              Kotlin + Compose 手机端
  app/src/main/java/com/flykhan/wristkey/
    MainActivity.kt       入口、SAF/ACTION_SEND、导入、同步接线
    ui/WristKeyApp.kt     全部 Compose 界面（账号/同步/设置/图案/导入）
    ui/AppUiState.kt      state + actions
    protocol/SyncProtocol.kt     协议 v3 编码/解析（VERSION=3）
    sync/WearableSyncController.kt  xms 发送/监听/重试/图案消息
    pattern/PatternPin.kt 5 位 T/S/C 图案 PBKDF2
    stratum/              Stratum 解密/合并
    bitwarden/            Bitwarden 未加密 JSON
    Account*.kt / Totp.kt / SteamOtp.kt / Secret.kt
  app/src/test/           单元测试

e2e/                      Node + Python 独立验收（不参与发布）
tools/                    解密/转换 CLI 与 Python fixtures
signing/                  dev-release.jks、rpk-sign/ 证书
scripts/release.sh        两端构建 + 规范命名 + SHA256SUMS + 成功/
scripts/check-signing.sh  APK 与 rpk 证书/包名一致性
releases/v<version>/      归档产物；二进制被 .gitignore 忽略，只提交 SHA256SUMS
成功/                     当前版本安装包（git 忽略）
docs/design/              设计稿与 UI 分析
```

## 2. 绝对不能破坏的规则

1. **两端包名必须是 `com.flykhan.wristkey`**。xms 互联要求手环快应用与手机 App 同包名、同签名证书。
2. **签名证书必须一致**：`signing/rpk-sign/certificate.pem`、APK 证书、rpk 内嵌 DER 三方一致，SHA-256 为
   `b7cfba158655bd329acc30a81cb6f5a62815b74df93db4c4931e608851da85c4`。
3. **启动图案锁屏是 index 内联的，不是路由页**。不要恢复 `router.replace` 跳锁屏；
   `pages/lock` 是旧实现残留，入口只用 `index.ux` 的 `locked/mainVisible` 二选一。
4. **`app.ux` 必须是 `<script>…</script>` 包裹的 `export default`**，否则编译后 default 为 null，
   运行时报 `cannot set property 'style' of null`。
5. **PBKDF2 迭代次数保持 1 轮**（两端 + 协议下限 1）。Vela JS 无 JIT，实测约 212 ms/轮；
   1200 轮会阻塞数十秒，10 轮也约 2 秒。图案空间只有 3^5=243，真正防护是持久化的 5 次失败锁 30 秒递增。
   不要为了“更安全”把它调高而不做真机测量。
6. **手环锁屏期间也要建立 xms 通道**（2.2.0 起）。否则手机下发同步/图案会 `-6` 失败。
   `channelReady` 只能在连接成功回调里置 true，不能提前置 true。
7. **不要加网络权限/上传**：两端都是离线计算，Android 不声明 INTERNET；凭据只走 xms 本地通道。
8. **版本号三处同步**：`band-app/src/manifest.json`、`band-app/package.json`、`android-app/app/build.gradle.kts`。
   测试和 `e2e/check-build.mjs` 也会断言版本，忘了会红。
9. **rpk 构建非确定性**：每次 `npm run release` 的 sha256 可能不同；文档/Release 必须用最终构建的 hash。
10. **不要提交 APK/rpk 到 git**（已在 .gitignore）；发布走 `releases/` + GitHub Release。
11. **不要凭记忆改协议**：先读 `docs/protocol.md` 和 `e2e/lib/protocol.mjs`，再改两端与夹具。

## 3. 常用命令

### 手环端

```bash
cd band-app
npm test                 # node --test tests/*.test.mjs
npm run build            # aiot build -> dist/com.flykhan.wristkey.debug.<version>.rpk
npm run release          # aiot release -> dist/com.flykhan.wristkey.release.<version>.rpk
npm run verify:rpk       # 校验 rpk 内嵌证书/包名
```

调试产物较大、启动慢；发布用 release。

### 手机端

```bash
cd android-app
JAVA_HOME=$HOME/.jdks/jdk-21.0.13+9 ./gradlew :app:testDebugUnitTest :app:assembleRelease
# 只跑单测：
JAVA_HOME=$HOME/.jdks/jdk-21.0.13+9 ./gradlew :app:testDebugUnitTest --rerun-tasks
```

APK：`android-app/app/build/outputs/apk/release/app-release.apk`。

### e2e / 独立验证

```bash
cd e2e && npm run verify                 # Node 参考实现/状态机/夹具
cd e2e && .venv/bin/python python/verify_fixtures.py   # Python 独立实现
cd <仓库根目录> && node e2e/check-build.mjs --with-tests
bash scripts/check-signing.sh            # 默认取最新 release rpk + release APK
```

`check-build` 会检查版本、包名、UI 结构、签名和关键回归断言；失败项写在
`reports/e2e-build-result.json`。不要为了让检查变绿而删断言，先判断是不是代码回归。

### 一键发布

```bash
bash scripts/release.sh 2.2.0
```

它会校验三处版本一致，跑两端测试+构建，产物归档到 `releases/v<version>/`，
生成 `SHA256SUMS`，并同步到 `成功/`（含 README.txt）。**发布前先把三处版本和测试断言改好。**

## 4. 发布到 GitHub

仓库：`git@github.com:flykhan/wristkey.git` / https://github.com/flykhan/wristkey
默认分支 `main`，GitHub 账号 `flykhan`，gh CLI 已登录（keyring）。

规范命名：

- Git tag：`v<version>`
- 资产：`wristkey-band-v<version>.rpk`、`wristkey-android-v<version>.apk`、`SHA256SUMS`
- 本地：`releases/v<version>/`、`成功/`

流程：

```bash
# 1) 版本/文档/测试断言全部更新
bash scripts/release.sh <version>
bash scripts/check-signing.sh releases/v<version>/wristkey-android-v<version>.apk \
  releases/v<version>/wristkey-band-v<version>.rpk
# 2) 提交并推送
git add -A && git commit -m "feat: ..." && git push origin main
# 3) 创建 Release（notes 写清重点/安装/资产表/sha256/验证/残余风险）
gh release create v<version> --target main --title "WristKey v<version>" \
  --notes-file /tmp/wristkey-release-notes-<version>.md \
  releases/v<version>/wristkey-band-v<version>.rpk \
  releases/v<version>/wristkey-android-v<version>.apk \
  releases/v<version>/SHA256SUMS
# 4) 下载远端资产校验
rm -rf /tmp/wkrel && mkdir /tmp/wkrel
gh release download v<version> -D /tmp/wkrel -p 'wristkey-*' -p 'SHA256SUMS'
(cd /tmp/wkrel && sha256sum -c SHA256SUMS)
```

安装提示固定写：

- 2.1.x 及以后同包名可直接覆盖；2.0.x 旧包名 `dev.wristkey.app` 必须先卸载两端旧应用。
- 两端同包名同签名；装完手环从应用列表彻底退出再打开一次，然后手机「同步」页同步。

## 5. VVD 工具链调试（无真机时）

VVD 路径：`~/.vela/vvd/Vela_WristKey.vvd`，480x336，vela-watch-5.0。

启动：

```bash
cd ~/.vela/sdk/emulator/linux-x86_64
setsid nohup ./emulator -vela -avd Vela_WristKey -no-window -no-audio -show-kernel \
  -network-user-mode-options hostfwd=tcp:127.0.0.1:10055-10.0.2.15:101 \
  -qemu -device virtio-snd,bus=virtio-mmio-bus.2 -allow-host-audio -semihosting \
  -qmp unix:/tmp/vvd-qmp.sock,server=on,wait=off > /tmp/emu.log 2>&1 < /dev/null &
```

- adb serial：`emulator-5554`；启动到 device 约 10 秒，debug 快应用首屏 30–40 秒。
- 安装 rpk：**必须 push 后 pm install，且不能加 `-r`**：
  ```bash
  adb push band-app/dist/com.flykhan.wristkey.debug.<ver>.rpk /data/local/tmp/wk.rpk
  adb -s emulator-5554 shell 'pm install /data/local/tmp/wk.rpk'
  adb -s emulator-5554 shell 'am start com.flykhan.wristkey'
  ```
  加 `-r` 会报 `onInstallResult: -r(Failed to deal with rpkpackage -38)`。
- 触控：VVD 无 `input`/`wm`；QMP `input-send-event` 无效，VNC 不支持；
  gRPC `sendMouse` 可用。仓库有临时脚本 `band-app/.tmp-touch.cjs <x> <y>`（git 忽略），
  从 `/run/user/1000/avd/running/pid_*.ini` 找 grpc.port，发送按下/抬起。
- 截图：`screencap` 不存在；QMP `screendump` 在 `-no-window` 下全黑；
  gRPC `getScreenshot()` 会让模拟器崩溃，**不要用**。验证靠 `console.info` 日志 + 交互结果。
- VVD 缺 `system.interconnect`，会打印 `can not find feature: system.interconnect`，应用已 catch；
  **VVD 不能验证真实 xms 同步**。
- NSH 的 `fdcheck_restore` assert 会让 adbd offline；重启模拟器：
  `pkill -f '[q]emu-system-armel-headless'`，再执行启动命令。
- `am stop` 在 VVD 不生效；测试冷启动就重启模拟器。
- VVD 是软件模拟，**时间不能直接当真机性能**；1 轮 PBKDF2 的耗时按 212 ms/轮估算，真机另测。

导航坐标（480x336，旧布局参考）：菜单右下 (436,299)；菜单第二项入口密码 (240,149)；
pin 三键中心 T=(112,236)、S=(240,236)、C=(368,236)。布局改过后先用日志/边界确认。

## 6. 真机日志排查

用户通常给一个 offline log tar（路径在 `~/.dsh/attachments/...`）。解压后看
`data/offlinelog/tmp.log`（设备时间是 UTC，CST +8）。

高频关键行：

- `renameDir: ... to /data/app/com.flykhan.wristkey success !`：安装成功。
- `PageNavigator getState error: empty stack!` + `state_error`：页面栈被路由跳转打空。
  历史根因是入口/锁屏反复 `router.replace`；现已改为 index 内联门禁 + `router.back()`。不要再引入 replace。
- `quickapp_proxy_server_send ... failed: -6`：手环端 xms 通道不可用/应用不在前台。
  2.2.0 起锁屏也建链；仍失败时先确认手环应用开着、两端包名签名一致。
- `[AIOTJS] ... TypeError: cannot set property 'style' of null`：`app.ux` 缺 `<script>` 包裹。
- `initUserData ... appData is undefined` / `initAppEnv failed`：同上，启动脚本没被编译。
- `[AIOTJS] [operator():90] Element is Removed or Deleting` / `no current page`：页面销毁后还在回调，
  通常也是页面栈被破坏的次生现象。

复现顺序：先确认安装包版本/包名 → 冷启动 → 看是否有 state_error/empty stack → 再查 xms。

## 7. 协议与数据（v3 摘要）

权威：`docs/protocol.md`。要点：

- 信封：`type/version/sentAt`，version=3；单条消息 <1KB。
- 手机→手环：`mfa_sync_begin`（syncId, accountCount）→ `mfa_sync_account`×N → `mfa_sync_commit`；
  account 含 `id/issuer/accountName/category/secret/algorithm/digits/period/otpType/updatedAt`，
  v3 另有可选 `password`（≤128；缺省=保留旧值，`""`=清空）。
- 手环→手机：`mfa_sync_ack`（ok/received/committed/error）、`mfa_sync_request`。
- 图案：`mfa_pin_set`（salt/hash/iterations）、`mfa_pin_query`、`mfa_pin_clear`；
  手环回 `mfa_pin_ack` / `mfa_pin_state`。
- staging + 原子提交：commit 校验条数/ID/字段；失败保留旧快照。快照键 `mfa_snapshot_v3`，
  读 v2 迁移；图案键 `wristkey_pin_v1`、锁定键 `wristkey_pin_lock_v1`、解锁会话 `wristkey_unlock_v1`。
- 合并语义：手机是数据源，2.0+ 全量同步每条都带 password（空串清空）；v2/增量省略 password 时保留旧值。
- Steam：`otpType="steam"`，固定 5 位字母数字、SHA1、30 秒；普通 TOTP 6–10 位。
- 重复 secret 按 id 去重；空同步合法（清空手环）。

## 8. 导入与安全

- Stratum：Strong（`AUTHENTICATORPRO`，Argon2id + AES-256-GCM）与 Legacy（`AuthenticatorPro`，
  PBKDF2-SHA1 + AES-256-CBC）都支持；HTML 导出不可导回。格式细节 `docs/stratum-format.md`。
- Bitwarden：仅**未加密** JSON；`encrypted:true` 要明确报“暂不支持”，不要误判密码错误。
  无 `login.totp` 的条目保存为“仅手机本地”（名称/用户名/密码可见，不参与手环同步）；
  编辑页补 Secret 后升级为正常账号。
- otpauth：支持一条或多条；Steam 标记（`encoder=steam` / issuer Steam / `&steam`）要按 Steam 处理。
- 安全模型：离线计算、不上传；手环只存图案派生值（不存图案本身），账号快照本身明文存 Vela storage；
  真正防护是系统锁屏 + 5 次失败锁 30 秒递增。不要虚假宣传 PBKDF2 1 轮提供强 KDF 防护。

## 9. UI 约定

手环（480x336，深色薄荷绿）：

- 主界面每页 3 个**固定 98px 高**卡片，筛选后 1–2 个也不拉伸；issuer 24px、验证码 48/46px。
- 右侧 56px rail：A-Z 圆钮（显示筛选字母/总数）、页码、菜单。
- 详情：用户名/密码 18px，密码默认遮罩，点按显示 10 秒；返回/菜单按钮要够大。
- 菜单顺序：立即同步 / 入口密码 / 关于 / 退出。
- picker：4x4 分页（A-P / Q-Z+0-5 / 6-9+#+全部），上下滑翻页，显示每字母账号数。
- 入口图案：5 位，三角/方形/圆形三色（薄荷绿/雾蓝/暖橙）；锁屏 5 个圆点 + 三个大键。

手机（Compose，深色薄荷绿）：

- 3 Tab：账号 / 同步 / 设置；账号卡大号验证码 + 倒计时 + 进度条；FAB 导入。
- 详情 ModalBottomSheet；密码遮罩 10 秒；编辑页全屏；同步页 4 状态胶囊 + 图案三态卡。
- 主题 token 在 `docs/design/android-v2-spec.md`；设计稿在 `docs/design/`。
- 用户对字号/按钮大小很敏感：改 UI 时优先保证可读性和触控面积，不要只改颜色。

## 10. 测试/回归清单

发布前至少：

```bash
(cd band-app && npm test)
(cd android-app && JAVA_HOME=$HOME/.jdks/jdk-21.0.13+9 ./gradlew :app:testDebugUnitTest :app:assembleRelease)
(cd e2e && npm run verify)
(cd e2e && .venv/bin/python python/verify_fixtures.py)
node e2e/check-build.mjs --with-tests
bash scripts/check-signing.sh
```

历史基线（v2.2.0）：band 116、Android 112、e2e 171、Python 40、check-build 121 PASS。数量变化时同步更新
README / reports，不要只让代码绿。

## 11. 最后更新时的状态（2026-11-20）

- 当前发布：**v2.2.0**（band versionCode 12，Android versionCode 8）。
- Release：https://github.com/flykhan/wristkey/releases/tag/v2.2.0
- 2.2.0 重点：锁屏建链、PBKDF2 1 轮、手机设图案重试、同步重试、Bitwarden 无码导入、UI 放大。
- 仍待真机验证：解锁速度、卡片排版、xms 同步稳定性。用户报 bug 时优先要 offline log / 手环照片，
  不要用“模拟器通过”代替真机结论。

## 12. 修改本 skill

架构/发布流程/关键坑变化时更新本文件；不要在这里堆版本历史（放 README/reports）。
保持 frontmatter 的 `name` 为 `wristkey-dev`，否则新会话目录里会找不到。
