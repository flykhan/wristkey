#!/usr/bin/env python3
"""WristKey e2e — Python 独立验证（第三方实现，语言级交叉验证）。

按照 docs/stratum-format.md 独立实现 Strong / Legacy 解密与 RFC 6238 TOTP：
  - Strong:  AUTHENTICATORPRO | salt16 | iv12 | AES-256-GCM(Argon2id p=4,m=64MiB,t=3) | tag16
  - Legacy:  AuthenticatorPro | salt20 | iv16 | AES-256-CBC/PKCS7(PBKDF2-HMAC-SHA1, 64000)
以及 RFC 6238 测试向量（Python hmac/hashlib，不依赖 Node 代码）。

验证内容：
  1. e2e 夹具（Node 生成）可被 Python 实现解密 → 与 plain-backup.json 语义一致；
  2. tools/fixtures（Python 生成）可被本脚本解密 → 与其明文一致；
  3. 用 Stratum 官方 extra/decrypt_backup.py（如可用）解密 e2e 夹具，做第三方工具验证；
  4. 明文夹具中的 3 个 RFC 6238 账号在 T=59/1111111109/1111111111/1234567890 的 TOTP 与 RFC 表一致；
  5. 加密参数与 docs/stratum-format.md 的常量一致（头部/长度/迭代次数）。

用法（建议 venv）：
    python3 -m venv .venv && .venv/bin/pip install argon2-cffi cryptography
    .venv/bin/python python/verify_fixtures.py
退出码：0 全部通过；1 存在失败；2 缺少依赖。
"""

import base64
import hashlib
import hmac
import json
import os
import subprocess
import sys

E2E_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKSPACE = os.path.dirname(E2E_ROOT)
FIXTURES = os.path.join(E2E_ROOT, "fixtures")
TOOLS_FIXTURES = os.path.join(WORKSPACE, "tools", "fixtures")
PASSWORD = "test-password"

STRONG_HEADER = b"AUTHENTICATORPRO"
LEGACY_HEADER = b"AuthenticatorPro"
ARGON2_TIME_COST = 3
ARGON2_MEMORY_KIB = 65536
ARGON2_PARALLELISM = 4
ARGON2_HASH_LEN = 32
PBKDF2_ITERATIONS = 64000
PBKDF2_HASH_LEN = 32

RESULTS = []


def check(name, fn):
    try:
        detail = fn()
        RESULTS.append((name, True, detail if isinstance(detail, str) else ""))
        print("  [PASS] " + name + ((" (" + detail + ")") if detail else ""))
    except Exception as error:  # noqa: BLE001 - 测试运行器需要捕获全部失败
        RESULTS.append((name, False, str(error)))
        print("  [FAIL] " + name)
        for line in str(error).splitlines():
            print("         " + line)


def load_json(path):
    with open(path, "rb") as handle:
        return json.loads(handle.read().decode("utf-8"))


def read_bytes(path):
    with open(path, "rb") as handle:
        return handle.read()


# ---------------------------------------------------------------- 解密实现
def decrypt_strong(data, password):
    from argon2.low_level import Type, hash_secret_raw
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    if not data.startswith(STRONG_HEADER):
        raise ValueError("not a Strong backup")
    salt = data[16:32]
    iv = data[32:44]
    payload = data[44:]
    if len(payload) <= 16:
        raise ValueError("strong backup truncated")
    key = hash_secret_raw(
        secret=password.encode("utf-8"),
        salt=salt,
        time_cost=ARGON2_TIME_COST,
        memory_cost=ARGON2_MEMORY_KIB,
        parallelism=ARGON2_PARALLELISM,
        hash_len=ARGON2_HASH_LEN,
        type=Type.ID,
    )
    plain = AESGCM(key).decrypt(iv, payload, None)
    return plain.decode("utf-8")


def decrypt_legacy(data, password):
    from cryptography.hazmat.primitives import padding
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    if not data.startswith(LEGACY_HEADER):
        raise ValueError("not a Legacy backup")
    salt = data[16:36]
    iv = data[36:52]
    ciphertext = data[52:]
    if not ciphertext or len(ciphertext) % 16 != 0:
        raise ValueError("legacy backup truncated or misaligned")
    key = hashlib.pbkdf2_hmac("sha1", password.encode("utf-8"), salt, PBKDF2_ITERATIONS, PBKDF2_HASH_LEN)
    decryptor = Cipher(algorithms.AES(key), modes.CBC(iv)).decryptor()
    padded = decryptor.update(ciphertext) + decryptor.finalize()
    unpadder = padding.PKCS7(128).unpadder()
    plain = unpadder.update(padded) + unpadder.finalize()
    return plain.decode("utf-8")


# ---------------------------------------------------------------- RFC 6238
RFC6238_SEEDS = {
    "SHA1": b"12345678901234567890",
    "SHA256": b"12345678901234567890123456789012",
    "SHA512": b"1234567890123456789012345678901234567890123456789012345678901234",
}

RFC6238_VECTORS = [
    (59, {"SHA1": "94287082", "SHA256": "46119246", "SHA512": "90693936"}),
    (1111111109, {"SHA1": "07081804", "SHA256": "68084774", "SHA512": "25091201"}),
    (1111111111, {"SHA1": "14050471", "SHA256": "67062674", "SHA512": "99943326"}),
    (1234567890, {"SHA1": "89005924", "SHA256": "91819424", "SHA512": "93441116"}),
]


def base32_decode(value):
    normalized = "".join(value.upper().split()).replace("=", "")
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
    bits = 0
    bit_length = 0
    out = bytearray()
    for character in normalized:
        index = alphabet.find(character)
        if index < 0:
            raise ValueError("invalid base32 character: " + character)
        bits = (bits << 5) | index
        bit_length += 5
        if bit_length >= 8:
            out.append((bits >> (bit_length - 8)) & 0xFF)
            bit_length -= 8
    return bytes(out)


def totp(secret, seconds, period, digits, algorithm):
    key = base32_decode(secret)
    counter = int(seconds // period)
    message = counter.to_bytes(8, "big")
    digest = hmac.new(key, message, getattr(hashlib, algorithm.lower())).digest()
    offset = digest[-1] & 0x0F
    binary = (
        ((digest[offset] & 0x7F) << 24)
        | ((digest[offset + 1] & 0xFF) << 16)
        | ((digest[offset + 2] & 0xFF) << 8)
        | (digest[offset + 3] & 0xFF)
    )
    return str(binary % (10 ** digits)).zfill(digits)


def normalize_secret(secret):
    return "".join(str(secret).upper().split()).replace("=", "")


def main():
    try:
        import argon2  # noqa: F401
        import cryptography  # noqa: F401
    except ImportError as error:
        print("缺少依赖: " + str(error))
        print("请执行: python3 -m venv .venv && .venv/bin/pip install argon2-cffi cryptography")
        return 2

    print("Python 独立验证: " + sys.version.split()[0] + " / " + E2E_ROOT)

    plain = load_json(os.path.join(FIXTURES, "plain-backup.json"))
    expected = load_json(os.path.join(FIXTURES, "expected-import.json"))

    print("\n## 1. e2e 夹具（Node 生成）Python 解密")
    check("Strong 解密 + JSON 语义一致", lambda: (
        _assert_same(decrypt_strong(read_bytes(os.path.join(FIXTURES, "strong.stratum")), PASSWORD), plain),
        "AES-256-GCM"
    )[1])
    check("Legacy 解密 + JSON 语义一致", lambda: (
        _assert_same(decrypt_legacy(read_bytes(os.path.join(FIXTURES, "legacy.stratum")), PASSWORD), plain),
        "AES-256-CBC/PKCS7"
    )[1])
    check("Strong 错误密码应失败", lambda: _expect_raises(
        lambda: decrypt_strong(read_bytes(os.path.join(FIXTURES, "strong.stratum")), "wrong-password")))
    check("Legacy 错误密码应失败", lambda: _expect_raises(
        lambda: decrypt_legacy(read_bytes(os.path.join(FIXTURES, "legacy.stratum")), "wrong-password")))

    print("\n## 2. tools/fixtures（Python 生成）独立解密")
    if os.path.exists(os.path.join(TOOLS_FIXTURES, "plain-backup.json")):
        tools_plain = load_json(os.path.join(TOOLS_FIXTURES, "plain-backup.json"))
        check("tools Strong 解密 + 语义一致", lambda: (
            _assert_same(decrypt_strong(read_bytes(os.path.join(TOOLS_FIXTURES, "strong.stratum")), PASSWORD),
                         tools_plain),
            "Python 生成夹具")[1])
        check("tools Legacy 解密 + 语义一致", lambda: (
            _assert_same(decrypt_legacy(read_bytes(os.path.join(TOOLS_FIXTURES, "legacy.stratum")), PASSWORD),
                         tools_plain),
            "Python 生成夹具")[1])
    else:
        print("  NOTE tools/fixtures 不存在，跳过")

    print("\n## 3. Stratum 官方 decrypt_backup.py 第三方工具验证（e2e 夹具）")
    decrypt_tool = os.path.join(WORKSPACE, "research", "stratum", "extra", "decrypt_backup.py")
    if os.path.exists(decrypt_tool):
        for name in ("strong.stratum", "legacy.stratum"):
            def run_tool(name=name):
                result = subprocess.run(
                    [sys.executable, decrypt_tool, os.path.join(FIXTURES, name), "--password", PASSWORD],
                    capture_output=True,
                    text=True,
                    timeout=180,
                )
                if result.returncode != 0:
                    raise RuntimeError("工具失败: " + result.stderr.strip())
                _assert_same(result.stdout, plain)
                return "GPL 工具仅离线校验，不参与发布"
            check("Stratum 官方工具解密 " + name, run_tool)
    else:
        print("  NOTE research/stratum/extra/decrypt_backup.py 不存在，跳过")

    print("\n## 4. 夹具 RFC 6238 账号向量（Python 独立 TOTP 实现）")
    rfc_accounts = [a for a in plain["Authenticators"] if a["Issuer"] == "RFC6238"]
    check("夹具含 3 个 RFC 6238 账号（SHA1/SHA256/SHA512）", lambda: _assert_count(rfc_accounts, 3))

    algorithm_by_id = {0: "SHA1", 1: "SHA256", 2: "SHA512"}

    def vector_case(seconds, expected_codes):
        def verify():
            comparisons = 0
            for account in rfc_accounts:
                algorithm = algorithm_by_id[account["Algorithm"]]
                code = totp(account["Secret"], seconds, account["Period"], account["Digits"], algorithm)
                if code != expected_codes[algorithm]:
                    raise AssertionError(
                        algorithm + " T=" + str(seconds) + ": " + code + " != " + expected_codes[algorithm]
                    )
                comparisons += 1
            return str(comparisons) + " 个账号一致"
        return verify

    for seconds, expected_codes in RFC6238_VECTORS:
        check("RFC 6238 T=" + str(seconds) + "（夹具 secret 复算）", vector_case(seconds, expected_codes))

    print("\n## 5. 加密参数与 docs/stratum-format.md 常量一致性")
    strong = read_bytes(os.path.join(FIXTURES, "strong.stratum"))
    legacy = read_bytes(os.path.join(FIXTURES, "legacy.stratum"))
    check("Strong 头部/长度布局", lambda: _strong_layout(strong))
    check("Legacy 头部/长度布局", lambda: _legacy_layout(legacy))

    manifest = load_json(os.path.join(FIXTURES, "manifest.json"))
    check("manifest 与规范常量一致", lambda: _manifest_params(manifest))
    check("expected-import.json 统计 11 导入 / 11 跳过", lambda: _assert_expected_stats(expected))

    passed = sum(1 for item in RESULTS if item[1])
    failed = len(RESULTS) - passed
    print("\n==========================================")
    print("Python verify: " + str(passed) + " passed, " + str(failed) + " failed, " + str(len(RESULTS)) + " total")
    print("==========================================")
    if failed:
        print("失败用例：")
        for name, ok, detail in RESULTS:
            if not ok:
                print("  - " + name)
        return 1
    return 0


def _assert_same(text, expected_object):
    parsed = json.loads(text)
    if parsed != expected_object:
        raise AssertionError("解密 JSON 与明文语义不一致")
    return "语义一致"


def _assert_count(items, expected):
    if len(items) != expected:
        raise AssertionError("数量 " + str(len(items)) + " != " + str(expected))
    return str(expected) + " 个"


def _expect_raises(fn):
    try:
        fn()
    except Exception:  # noqa: BLE001 - 预期异常
        return "按预期失败"
    raise AssertionError("预期抛异常但成功返回")


def _strong_layout(data):
    if not data.startswith(STRONG_HEADER):
        raise AssertionError("Strong 头部错误")
    salt = data[16:32]
    iv = data[32:44]
    payload = data[44:]
    if len(salt) != 16 or len(iv) != 12 or len(payload) <= 16:
        raise AssertionError("Strong 长度布局错误")
    return "salt16 + iv12 + ciphertext(" + str(len(payload) - 16) + ") + tag16"


def _legacy_layout(data):
    if not data.startswith(LEGACY_HEADER):
        raise AssertionError("Legacy 头部错误")
    salt = data[16:36]
    iv = data[36:52]
    payload = data[52:]
    if len(salt) != 20 or len(iv) != 16 or not payload or len(payload) % 16 != 0:
        raise AssertionError("Legacy 长度布局错误")
    return "salt20 + iv16 + ciphertext(" + str(len(payload)) + ")"


def _manifest_params(manifest):
    strong = manifest["encryption"]["strong"]["keyDerivation"]
    legacy = manifest["encryption"]["legacy"]["keyDerivation"]
    checks = [
        (strong["algorithm"], "Argon2id"),
        (strong["parallelism"], ARGON2_PARALLELISM),
        (strong["memorySizeKiB"], ARGON2_MEMORY_KIB),
        (strong["iterations"], ARGON2_TIME_COST),
        (strong["outputBytes"], ARGON2_HASH_LEN),
        (legacy["algorithm"], "PBKDF2-HMAC-SHA1"),
        (legacy["iterations"], PBKDF2_ITERATIONS),
        (legacy["outputBytes"], PBKDF2_HASH_LEN),
    ]
    for actual, expected in checks:
        if actual != expected:
            raise AssertionError("manifest 参数 " + str(actual) + " != " + str(expected))
    return "Argon2id p4 m64MiB t3 / PBKDF2-SHA1 64000"


def _assert_expected_stats(expected):
    stats = expected["stats"]
    if stats.get("imported") != 11 or stats.get("skipped") != 11 or stats.get("total") != 22:
        raise AssertionError("统计不符: " + json.dumps(stats))
    return "11/11/22"


if __name__ == "__main__":
    sys.exit(main())
