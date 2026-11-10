# 开发签名材料（signing/）

本目录存放**仅供开发/联调**使用的签名材料。两端（Android APK 与手环 .rpk）必须使用**同一个证书**，
否则手环 `system.interconnect` 无法建立连接。

## 文件

| 文件 | 说明 |
| --- | --- |
| `dev-release.jks` | 开发用 JKS keystore（RSA 2048，有效期 10000 天） |

## 凭据（开发专用，可公开；发布前必须替换）

| 项 | 值 |
| --- | --- |
| Keystore 路径 | `signing/dev-release.jks` |
| Alias | `wristkey` |
| Store password | `wristkey-dev` |
| Key password | `wristkey-dev` |
| 密钥算法 | RSA 2048 |
| 有效期 | 10000 天 |
| DN | `CN=WristKey Dev, OU=WristKey, O=WristKey, C=CN` |
| SHA-256 证书指纹 | `B7:CF:BA:15:86:55:BD:32:9A:CC:30:A8:1C:B6:F5:A6:28:15:B7:4D:F9:3D:B4:C4:93:1E:60:88:51:DA:85:C4` |

生成命令：

```bash
~/.jdks/jdk-21*/bin/keytool -genkeypair -v \
  -keystore signing/dev-release.jks -alias wristkey \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass wristkey-dev -keypass wristkey-dev \
  -dname "CN=WristKey Dev, OU=WristKey, O=WristKey, C=CN"
```

## 使用方式

- Android：`android-app/app/build.gradle.kts` 的 release 签名配置读取本 keystore
  （可通过 `SIGNING_STORE_FILE` / `SIGNING_STORE_PASSWORD` / `SIGNING_KEY_ALIAS` / `SIGNING_KEY_PASSWORD`
  环境变量覆盖，默认指向本目录）。
- 手环 .rpk：用同一证书签名（见 `docs/build-install.md`）。

## 发布前

**必须替换** `dev-release.jks` 为你自己的 keystore，并同时更新两端签名；不要把这个开发密钥用于正式发布。
