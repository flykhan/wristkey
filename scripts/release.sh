#!/usr/bin/env bash
# WristKey 统一发布脚本：构建两端、按命名规范归档、生成校验和。
#
# 用法：
#   bash scripts/release.sh            # 版本取 band-app/src/manifest.json
#   bash scripts/release.sh 2.1.1      # 指定版本（必须与两端版本号一致）
#
# 产物：
#   releases/v<version>/wristkey-band-v<version>.rpk
#   releases/v<version>/wristkey-android-v<version>.apk
#   releases/v<version>/SHA256SUMS
#   并同步一份到项目根目录的 成功/，便于直接取用。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PACKAGE="com.flykhan.wristkey"
VERSION="${1:-$(node -p "require('./band-app/src/manifest.json').versionName")}"
TAG="v$VERSION"
OUT="$ROOT/releases/$TAG"
SUCCESS="$ROOT/成功"

band_version="$(node -p "require('./band-app/src/manifest.json').versionName")"
apk_version="$(sed -n 's/.*versionName = "\(.*\)"/\1/p' android-app/app/build.gradle.kts)"
if [ "$band_version" != "$VERSION" ] || [ "$apk_version" != "$VERSION" ]; then
  echo "版本不一致：目标 $VERSION / band $band_version / android $apk_version" >&2
  echo "请先同步修改 band-app/src/manifest.json、band-app/package.json 与 android-app/app/build.gradle.kts" >&2
  exit 1
fi

echo "==> 手环端测试与构建 ($PACKAGE $VERSION)"
(cd band-app && npm test && npm run release)

echo "==> 手机端测试与构建 ($PACKAGE $VERSION)"
if [ -z "${JAVA_HOME:-}" ] && [ -d "$HOME/.jdks/jdk-21.0.13+9" ]; then
  export JAVA_HOME="$HOME/.jdks/jdk-21.0.13+9"
fi
(cd android-app && ./gradlew :app:testDebugUnitTest :app:assembleRelease)

RPK="band-app/dist/$PACKAGE.release.$VERSION.rpk"
APK="android-app/app/build/outputs/apk/release/app-release.apk"
[ -f "$RPK" ] || { echo "缺少 rpk：$RPK" >&2; exit 1; }
[ -f "$APK" ] || { echo "缺少 apk：$APK" >&2; exit 1; }

mkdir -p "$OUT" "$SUCCESS"
cp -f "$RPK" "$OUT/wristkey-band-$TAG.rpk"
cp -f "$APK" "$OUT/wristkey-android-$TAG.apk"
( cd "$OUT" && sha256sum "wristkey-band-$TAG.rpk" "wristkey-android-$TAG.apk" > SHA256SUMS )

cp -f "$OUT/wristkey-band-$TAG.rpk" "$SUCCESS/"
cp -f "$OUT/wristkey-android-$TAG.apk" "$SUCCESS/"
cp -f "$OUT/SHA256SUMS" "$SUCCESS/"

cat > "$SUCCESS/README.txt" <<EOF
腕证 WristKey $TAG（包名 $PACKAGE）

手环端：wristkey-band-$TAG.rpk
手机端：wristkey-android-$TAG.apk
校验和：SHA256SUMS

安装提示：仍是 2.0.x（旧包名 dev.wristkey.app）的，先卸载手环快应用与手机 App 再安装；
2.1.0 及以后同包名版本可直接覆盖安装，数据保留。
两端必须同包名同签名（$PACKAGE）。手环菜单 → 关于 可确认版本为 $VERSION。
旧版安装包已放到 成功/ 下的「旧版-版本号」目录，不要与当前版本混装。
EOF

echo "==> 完成：$OUT"
ls -lh "$OUT"
cat "$OUT/SHA256SUMS"
