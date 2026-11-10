# 构建与安装

> 本章为第一版骨架，待研究任务补充实测细节（aiot-toolkit 构建/签名、AstroBox 安装、xms 真机权限流程）。

## 手环端

`~bash
cd band-app
npm install
npm run build      # aiot build
npm run release    # 生成 dist/*.rpk
`~

- 目标设备：小米手环 10 Pro（Vela / HyperOS 3；屏幕 480×336；`deviceTypeList: ["watch"]`）。
- 安装：AstroBox（或表盘自定义工具）→ 连接手环（需 Authkey）→ 快应用 → 安装 .rpk。
- 签名：.rpk 必须用与手机 APK 相同的证书签名（见 `signing/README.md`）。

## 手机端

`~bash
cd android-app
./gradlew assembleDebug   # 或 assembleRelease
`~

- JDK 17+，Android SDK Platform 36。
- 安装 APK 后：授予"设备管理"权限 → 打开 App → 导入 Stratum 备份 → 同步。
- 首次连接需手机与手环在"小米运动健康"中已配对。

## 常见问题

（待补：设备发现失败、签名不一致、快应用安装失败、同步收不到消息等）
