#!/usr/bin/env bash
# 从开发 keystore 导出 .rpk 签名所需的 PEM（与手机 APK 同证书）。
#
# 用法:
#   bash scripts/prepare-signing.sh
#   SIGNING_STORE_FILE=/path/to/keystore.jks SIGNING_STORE_PASSWORD=*** \
#     SIGNING_KEY_ALIAS=wristkey bash scripts/prepare-signing.sh
#
# 环境变量:
#   SIGNING_STORE_FILE      默认: <repo>/signing/dev-release.jks
#   SIGNING_STORE_PASSWORD  默认: signing/README.md 中的开发密码（仅用于开发 keystore）
#   SIGNING_KEY_ALIAS       默认: wristkey
#   EXPECTED_CERT_SHA256    默认: 开发证书指纹；导出的证书不匹配则失败
#
# 生成:
#   sign/release/private.pem + sign/release/certificate.pem  (aiot release 使用)
#   sign/debug/private.pem   + sign/debug/certificate.pem    (aiot build 使用)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

KEYSTORE="$SIGNING_STORE_FILE"
if [ -z "$KEYSTORE" ]; then
  KEYSTORE="$ROOT/../signing/dev-release.jks"
fi
STORE_PASS="$SIGNING_STORE_PASSWORD"
if [ -z "$STORE_PASS" ]; then
  STORE_PASS="wristkey-dev"
fi
ALIAS="$SIGNING_KEY_ALIAS"
if [ -z "$ALIAS" ]; then
  ALIAS="wristkey"
fi
EXPECTED="$EXPECTED_CERT_SHA256"
if [ -z "$EXPECTED" ]; then
  EXPECTED="b7cfba158655bd329acc30a81cb6f5a62815b74df93db4c4931e608851da85c4"
fi
EXPECTED="$(printf '%s' "$EXPECTED" | tr 'A-F' 'a-f' | tr -d ':')"

if ! command -v openssl >/dev/null 2>&1; then
  echo "错误: 需要 openssl" >&2
  exit 1
fi
if [ ! -f "$KEYSTORE" ]; then
  echo "错误: 找不到 keystore: $KEYSTORE" >&2
  echo "提示: 先由 android-dev 生成 signing/dev-release.jks，或设置 SIGNING_STORE_FILE" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PKCS12="$KEYSTORE"
ERRLOG="$TMP/openssl.err"

# 1. 优先按 PKCS#12 读取（keytool 21 默认格式）。
if ! openssl pkcs12 -in "$KEYSTORE" -nocerts -nodes -passin "pass:$STORE_PASS" -out "$TMP/key.pem" 2>"$ERRLOG"; then
  # 2. 老式 JKS：尝试用 keytool 转成 PKCS#12 再导出（需要 JDK）。
  if command -v keytool >/dev/null 2>&1; then
    echo "检测到非 PKCS#12 keystore，使用 keytool 转换为 PKCS#12 ..."
    keytool -importkeystore \
      -srckeystore "$KEYSTORE" -srcstoretype JKS -srcstorepass "$STORE_PASS" \
      -srcalias "$ALIAS" -destkeystore "$TMP/ks.p12" -deststoretype PKCS12 \
      -deststorepass "$STORE_PASS" -destkeypass "$STORE_PASS" >/dev/null
    PKCS12="$TMP/ks.p12"
    openssl pkcs12 -in "$PKCS12" -nocerts -nodes -passin "pass:$STORE_PASS" -out "$TMP/key.pem"
  else
    cat "$ERRLOG" >&2 || true
    echo "错误: 无法读取 keystore，且没有 keytool 可转换 JKS。请安装 JDK 21 或使用 PKCS#12 keystore。" >&2
    exit 1
  fi
fi

openssl pkey -in "$TMP/key.pem" -out "$TMP/private.pem"
openssl pkcs12 -in "$PKCS12" -clcerts -nokeys -passin "pass:$STORE_PASS" -out "$TMP/cert.pem" 2>/dev/null
openssl x509 -in "$TMP/cert.pem" -out "$TMP/certificate.pem"

ACTUAL="$(openssl x509 -in "$TMP/certificate.pem" -noout -fingerprint -sha256 | sed 's/.*=//' | tr 'A-F' 'a-f' | tr -d ':')"
SUBJECT="$(openssl x509 -in "$TMP/certificate.pem" -noout -subject | sed 's/^subject=//')"

if [ -n "$EXPECTED" ] && [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "错误: 证书 SHA-256 指纹不匹配" >&2
  echo "  expected: $EXPECTED" >&2
  echo "  actual:   $ACTUAL" >&2
  exit 1
fi

mkdir -p "$ROOT/sign/release" "$ROOT/sign/debug"
install -m 600 "$TMP/private.pem" "$ROOT/sign/release/private.pem"
install -m 644 "$TMP/certificate.pem" "$ROOT/sign/release/certificate.pem"
install -m 600 "$TMP/private.pem" "$ROOT/sign/debug/private.pem"
install -m 644 "$TMP/certificate.pem" "$ROOT/sign/debug/certificate.pem"

echo "OK: 已导出签名 PEM"
echo "  subject: $SUBJECT"
echo "  SHA-256: $ACTUAL"
echo "  -> $ROOT/sign/release/ 与 $ROOT/sign/debug/"
