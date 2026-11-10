#!/usr/bin/env bash
# 校验 APK 与 .rpk 是否使用同一张证书、同一包名（interconnect 的硬性要求）。
# 用法: scripts/check-signing.sh [APK] [RPK]
#   APK 默认: android-app/app/build/outputs/apk/release/app-release.apk
#   RPK 默认: band-app/dist/ 下按修改时间最新的 .rpk
set -euo pipefail
cd "$(dirname "$0")/.."

EXPECTED_PACKAGE="dev.wristkey.app"
APK="${1:-android-app/app/build/outputs/apk/release/app-release.apk}"
if [ "${2:-}" != "" ]; then
  RPK="$2"
else
  RPK="$(ls -t band-app/dist/*.rpk 2>/dev/null | head -1 || true)"
fi

APKSIGNER="$(ls ~/Android/Sdk/build-tools/*/apksigner 2>/dev/null | sort -V | tail -1)"
CERT_PEM="signing/rpk-sign/certificate.pem"

# apksigner 需要 java 在 PATH 中；没有 JAVA_HOME 时自动找 ~/.jdks
if [ -z "${JAVA_HOME:-}" ]; then
  JAVA_DIR="$(ls -d ~/.jdks/jdk-* 2>/dev/null | sort -V | tail -1 || true)"
  if [ -n "$JAVA_DIR" ]; then
    export JAVA_HOME="$JAVA_DIR"
    export PATH="$JAVA_HOME/bin:$PATH"
  fi
fi

fail=0
[ -f "$APK" ] || { echo "缺少 APK: $APK"; fail=1; }
[ -f "$RPK" ] || { echo "缺少 RPK: $RPK"; fail=1; }
[ -n "$APKSIGNER" ] || { echo "找不到 apksigner（Android SDK build-tools）"; fail=1; }
[ -f "$CERT_PEM" ] || { echo "缺少 $CERT_PEM"; fail=1; }
[ "$fail" != 0 ] && exit 1

echo "APK: $APK"
echo "RPK: $RPK"
echo "apksigner: $APKSIGNER"

# 1. RPK 内 manifest 的包名/应用名
python3 - "$RPK" "$EXPECTED_PACKAGE" <<'PY'
import sys, zipfile, json
rpk, expected = sys.argv[1], sys.argv[2]
z = zipfile.ZipFile(rpk)
candidates = [n for n in z.namelist() if n.endswith("manifest.json") and "/" not in n]
if not candidates:
    print("FAIL: rpk 中没有 manifest.json"); sys.exit(1)
manifest = json.loads(z.read(candidates[0]).decode("utf-8"))
package = manifest.get("package", "")
name = manifest.get("name", "")
print("RPK package:", package, "| name:", name)
if package != expected:
    print("FAIL: rpk 包名 %r != %r（可能是参考实现遗留产物，请重新 npm run release）" % (package, expected))
    sys.exit(1)
PY

# 2. APK 证书指纹
apk_out="$("$APKSIGNER" verify --print-certs "$APK" 2>&1 || true)"
if [ -z "$apk_out" ]; then
  echo "FAIL: apksigner 无法执行（检查 JDK/JAVA_HOME）"
  exit 1
fi
apk_sha="$(printf '%s\n' "$apk_out" | grep -o 'SHA-256 digest: [0-9a-f]*' | head -1 | awk '{print $3}')"
apk_dn="$(printf '%s\n' "$apk_out" | grep -o 'certificate DN: .*' | head -1 | sed 's/certificate DN: //')"
[ -n "$apk_sha" ] || { echo "解析 APK 证书指纹失败"; printf '%s\n' "$apk_out"; exit 1; }
echo "APK 证书 SHA-256: $apk_sha"
echo "APK 证书 DN: $apk_dn"

# 3. 与 PEM 指纹比对
pem_sha="$(openssl x509 -in "$CERT_PEM" -noout -fingerprint -sha256 | sed 's/.*=//; s/://g' | tr 'A-F' 'a-f')"
echo "签名 PEM SHA-256: $pem_sha"
if [ "$apk_sha" != "$pem_sha" ]; then
  echo "FAIL: APK 证书与 signing/rpk-sign/certificate.pem 不一致（APK 与 .rpk 必须同证书）"
  exit 1
fi

# 4. RPK 内嵌证书 DER
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
openssl x509 -in "$CERT_PEM" -outform DER -out "$tmp/cert.der"
python3 - "$RPK" "$tmp/cert.der" <<'PY'
import sys
rpk = open(sys.argv[1], "rb").read()
der = open(sys.argv[2], "rb").read()
offset = rpk.find(der)
print("RPK 内嵌证书 DER:", ("是 (offset %d)" % offset) if offset >= 0 else "否")
sys.exit(0 if offset >= 0 else 1)
PY

echo "PASS: 包名 $EXPECTED_PACKAGE，APK 与 RPK 使用同一证书（SHA-256 $pem_sha）"
