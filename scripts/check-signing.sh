#!/usr/bin/env bash
# 校验 APK 与 .rpk 是否使用同一张证书（interconnect 的硬性要求）。
# 用法: scripts/check-signing.sh [APK] [RPK]
#   APK 默认: android-app/app/build/outputs/apk/release/app-release.apk
#   RPK 默认: band-app/dist/*.rpk（取第一个）
set -euo pipefail
cd "$(dirname "$0")/.."

APK="${1:-android-app/app/build/outputs/apk/release/app-release.apk}"
if [ "${2:-}" != "" ]; then
  RPK="$2"
else
  RPK="$(ls band-app/dist/*.rpk 2>/dev/null | head -1 || true)"
fi

APKSIGNER="$(ls ~/Android/Sdk/build-tools/*/apksigner 2>/dev/null | sort -V | tail -1)"
CERT_PEM="signing/rpk-sign/certificate.pem"

fail=0
if [ ! -f "$APK" ]; then echo "缺少 APK: $APK"; fail=1; fi
if [ ! -f "$RPK" ]; then echo "缺少 RPK: $RPK"; fail=1; fi
if [ -z "$APKSIGNER" ]; then echo "找不到 apksigner（Android SDK build-tools）"; fail=1; fi
if [ "$fail" != 0 ]; then exit 1; fi

echo "APK: $APK"
echo "RPK: $RPK"
echo "apksigner: $APKSIGNER"

apk_out="$("$APKSIGNER" verify --print-certs "$APK" 2>&1)"
apk_sha="$(printf '%s\n' "$apk_out" | grep -o 'SHA-256 digest: [0-9a-f]*' | head -1 | awk '{print $3}')"
apk_cert_b64="$(printf '%s\n' "$apk_out" | grep -o 'certificate DN: .*' | head -1)"
[ -n "$apk_sha" ] || { echo "解析 APK 证书指纹失败"; printf '%s\n' "$apk_out"; exit 1; }
echo "APK 证书 SHA-256: $apk_sha"
echo "APK 证书 DN: ${apk_cert_b64#certificate DN: }"

[ -f "$CERT_PEM" ] || { echo "缺少 $CERT_PEM"; exit 1; }
pem_sha="$(openssl x509 -in "$CERT_PEM" -noout -fingerprint -sha256 | sed 's/.*=//; s/://g' | tr 'A-F' 'a-f')"
echo "签名 PEM SHA-256: $pem_sha"

if [ "$apk_sha" != "$pem_sha" ]; then
  echo "FAIL: APK 证书与 signing/rpk-sign/certificate.pem 不一致"
  exit 1
fi

# .rpk 的签名块内嵌证书 DER：直接检测 DER 是否出现在 rpk 字节流中
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
openssl x509 -in "$CERT_PEM" -outform DER -out "$tmp/cert.der"
python3 - "$RPK" "$tmp/cert.der" <<'PY'
import sys
rpk = open(sys.argv[1], "rb").read()
der = open(sys.argv[2], "rb").read()
ok = der in rpk
print("RPK 内嵌证书 DER:", "是" if ok else "否", "(offset %d)" % rpk.find(der) if ok else "")
sys.exit(0 if ok else 1)
PY

echo "PASS: APK 与 RPK 使用同一证书（SHA-256 $pem_sha）"
