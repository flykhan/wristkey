# 开发签名材料（band-app/sign/）

这两个 PEM 用于给手环端 .rpk 签名。system.interconnect 要求手环快应用与手机 APK
**同包名 + 同签名证书**，因此它们必须来自与 APK 相同的 keystore：

- 来源：../signing/dev-release.jks（alias: wristkey）
- 证书 SHA-256 指纹：B7:CF:BA:15:86:55:BD:32:9A:CC:30:A8:1C:B6:F5:A6:28:15:B7:4D:F9:3D:B4:C4:93:1E:60:88:51:DA:85:C4
- 私钥：PKCS#8 PEM；证书：X.509 PEM（CN=WristKey Dev）

## 文件与使用

aiot-toolkit 2.0.5 查找顺序（源码 @aiot-toolkit/aiotpack 的 SignUtil.js）：

| 模式 | 优先 1 | 优先 2 | 兜底 |
| --- | --- | --- | --- |
| aiot build（开发） | sign/debug/ | sign/ | toolkit 自带默认证书 |
| aiot release（发布） | sign/release/ | sign/ | 无（缺证书则报错） |

因此：

- sign/release/{private,certificate}.pem 供 npm run release；
- sign/debug/{private,certificate}.pem 供 npm run build（便于真机调试包和 APK 证书一致）。

## 重新生成

~~~bash
# 默认读取 ../signing/dev-release.jks，密码取 signing/README.md 中的开发凭据
npm run sign:prepare

# 或显式指定（不要把生产密码写进仓库）
SIGNING_STORE_FILE=/path/to/keystore.jks \
SIGNING_STORE_PASSWORD=*** \
SIGNING_KEY_ALIAS=wristkey \
bash scripts/prepare-signing.sh
~~~

脚本会校验导出的证书 SHA-256 是否与开发证书一致（可用 EXPECTED_CERT_SHA256 覆盖）。

## 安全

- 这是**开发用密钥**，已在 signing/README.md 中公开，仅用于本仓库联调；
- 发布前必须替换为你自己的 keystore 并重新导出两端签名（见 docs/security.md 检查清单）；
- 不要用该密钥给上架/正式分发的 APK/RPK 签名。
