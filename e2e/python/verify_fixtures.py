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
     并独立实现 Steam Guard 5 位字母数字码，对 6 组公开向量验证；
  5. 加密参数与 docs/stratum-format.md 的常量一致（头部/长度/迭代次数）；
  6. Bitwarden 未加密 Vault JSON 独立解析（docs/bitwarden-format.md）：6 导入 / 4 跳过、Steam 识别、
     加密导出负例拒绝。

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
from urllib.parse import parse_qs, unquote, urlparse

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


STEAM_ALPHABET = "23456789BCDFGHJKMNPQRTVWXY"


def steam_totp(secret, seconds):
    """Steam Guard：HMAC-SHA1 + 5 位字母数字码（独立于 Node 实现）。"""
    key = base32_decode(secret)
    counter = int(seconds // 30)
    digest = hmac.new(key, counter.to_bytes(8, "big"), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    material = (
        ((digest[offset] & 0x7F) << 24)
        | ((digest[offset + 1] & 0xFF) << 16)
        | ((digest[offset + 2] & 0xFF) << 8)
        | (digest[offset + 3] & 0xFF)
    )
    code = ""
    for _ in range(5):
        code += STEAM_ALPHABET[material % 26]
        material //= 26
    return code


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

    print("\n## 4b. Steam Guard 向量（Python 独立实现，docs/protocol.md SteamOtp）")
    steam_secret = "OJZ2BP7STWSLUD7I23Q5AYZELZB5OAFU"
    steam_vectors = [
        (59, "3DP36"),
        (1111111109, "GX57J"),
        (1111111111, "TCJ4Y"),
        (1234567890, "VYNVB"),
        (1640846388, "2Y4TM"),
        (1735689600, "DQ5KF"),
    ]

    def steam_vector_case(seconds, expected_code):
        def verify():
            code = steam_totp(steam_secret, seconds)
            if code != expected_code:
                raise AssertionError("T=" + str(seconds) + ": " + code + " != " + expected_code)
            if len(code) != 5:
                raise AssertionError("Steam 码应固定 5 位")
            return "code=" + code
        return verify

    for seconds, expected_code in steam_vectors:
        check("Steam Guard T=" + str(seconds), steam_vector_case(seconds, expected_code))

    def check_steam_fixture_accounts():
        steam_accounts = [a for a in plain["Authenticators"] if a["Type"] == 4]
        if len(steam_accounts) != 2:
            raise AssertionError("夹具应含 2 个 Type=4 Steam 账号，实际 " + str(len(steam_accounts)))
        issuers = sorted(a["Issuer"] for a in steam_accounts)
        if issuers != ["Steam", "Valve"]:
            raise AssertionError("Steam 账号 issuer 应覆盖 Steam/Valve，实际 " + str(issuers))
        return "2 个（Steam/Valve）"

    check("夹具 Steam(Type=4) 条目：2 个，issuer 覆盖 Steam/Valve", check_steam_fixture_accounts)

    print("\n## 4c. Bitwarden 未加密 Vault 导入（Python 独立实现，docs/bitwarden-format.md）")
    bitwarden_path = os.path.join(FIXTURES, "bitwarden-export.json")
    bitwarden_encrypted_path = os.path.join(FIXTURES, "bitwarden-encrypted-export.json")

    def bitwarden_detect(value):
        if not isinstance(value, dict):
            return "unknown"
        if value.get("encrypted") is True:
            return "encrypted"
        items = value.get("items")
        if not isinstance(items, list):
            return "unknown"
        if not any(isinstance(item.get("login"), dict) for item in items if isinstance(item, dict)):
            return "unknown"
        return "vault"

    def bitwarden_import(export):
        imported = []
        skipped = []
        for item in export.get("items") or []:
            name = (item.get("name") or "").strip()
            login = item.get("login") or {}
            username = (login.get("username") or "").strip()
            if item.get("type") != 1:
                skipped.append(("NOT_LOGIN_TYPE", name))
                continue
            totp = (login.get("totp") or "").strip()
            if not totp:
                skipped.append(("NO_TOTP", name))
                continue
            issuer = name or "Bitwarden"
            if totp.lower().startswith("otpauth://"):
                parsed = urlparse(totp)
                params = parse_qs(parsed.query, keep_blank_values=True)
                if parsed.netloc.lower() != "totp":
                    skipped.append(("TYPE_NOT_TOTP", name))
                    continue
                secret_raw = (params.get("secret") or [""])[0]
                try:
                    base32_decode(secret_raw)
                except Exception:
                    skipped.append(("INVALID_BASE32", name))
                    continue
                label = unquote(parsed.path.lstrip("/"))
                label_issuer, _, label_name = label.partition(":")
                uri_issuer = (params.get("issuer") or [label_issuer])[0].strip()
                account_name = username or (label_name or label_issuer).strip() or issuer
                is_steam = (
                    "steam" in params
                    or (params.get("encoder") or [""])[0].lower() == "steam"
                    or uri_issuer.lower().startswith("steam")
                    or label.lower().startswith("steam")
                )
                if is_steam:
                    imported.append({"issuer": issuer, "accountName": account_name, "digits": 5, "period": 30, "algorithm": "SHA1", "otpType": "steam"})
                else:
                    imported.append({
                        "issuer": issuer,
                        "accountName": account_name,
                        "digits": int((params.get("digits") or ["6"])[0]),
                        "period": int((params.get("period") or ["30"])[0]),
                        "algorithm": (params.get("algorithm") or ["SHA1"])[0].upper(),
                        "otpType": "totp",
                    })
            else:
                try:
                    base32_decode(totp)
                except Exception:
                    skipped.append(("INVALID_TOTP", name))
                    continue
                imported.append({"issuer": issuer, "accountName": username or issuer, "digits": 6, "period": 30, "algorithm": "SHA1", "otpType": "totp"})
        return imported, skipped

    if os.path.exists(bitwarden_path):
        bitwarden_export = load_json(bitwarden_path)
        bitwarden_encrypted = load_json(bitwarden_encrypted_path)
        bitwarden_expected = load_json(os.path.join(FIXTURES, "bitwarden-expected-import.json"))
        bw_imported, bw_skipped = bitwarden_import(bitwarden_export)

        check("Bitwarden 内容嗅探：vault / encrypted / Stratum 不误判", lambda: _bitwarden_detect_cases(
            bitwarden_detect, bitwarden_export, bitwarden_encrypted, plain))
        check("Bitwarden 独立解析：6 导入 / 4 跳过", lambda: _assert_bitwarden_counts(bw_imported, bw_skipped))
        check("Bitwarden Steam 条目：otpType=steam / digits=5 / period=30 / SHA1", lambda: _assert_bitwarden_steam(bw_imported))
        check("Bitwarden 字段兜底：name 空 → Bitwarden，username 空 → otpauth label", lambda: _assert_bitwarden_fallbacks(bw_imported))
        check("Bitwarden 加密导出必须拒绝", lambda: _assert_bitwarden_encrypted(bitwarden_detect(bitwarden_encrypted)))
        check("bitwarden-expected-import.json 统计 6/4/10", lambda: _assert_bitwarden_stats(bitwarden_expected))
    else:
        print("  NOTE bitwarden-export.json 不存在，跳过")

    print("\n## 5. 加密参数与 docs/stratum-format.md 常量一致性")
    strong = read_bytes(os.path.join(FIXTURES, "strong.stratum"))
    legacy = read_bytes(os.path.join(FIXTURES, "legacy.stratum"))
    check("Strong 头部/长度布局", lambda: _strong_layout(strong))
    check("Legacy 头部/长度布局", lambda: _legacy_layout(legacy))

    manifest = load_json(os.path.join(FIXTURES, "manifest.json"))
    check("manifest 与规范常量一致", lambda: _manifest_params(manifest))
    check("expected-import.json 统计 13 导入 / 10 跳过", lambda: _assert_expected_stats(expected))

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


def _bitwarden_detect_cases(detect, vault, encrypted, stratum_plain):
    if detect(vault) != "vault":
        raise AssertionError("未加密 Vault 应识别为 vault")
    if detect(encrypted) != "encrypted":
        raise AssertionError("加密导出应识别为 encrypted")
    if detect(stratum_plain) != "unknown":
        raise AssertionError("Stratum 备份不应被识别为 Bitwarden")
    if detect({"items": [{"id": "x", "type": 1}]}) != "unknown":
        raise AssertionError("无 login 的导出不应识别")
    return "vault/encrypted/unknown"


def _assert_bitwarden_counts(imported, skipped):
    if len(imported) != 6 or len(skipped) != 4:
        raise AssertionError("Bitwarden 映射应为 6 导入 / 4 跳过，实际 " + str(len(imported)) + "/" + str(len(skipped)))
    codes = sorted(code for code, _ in skipped)
    expected_codes = sorted(["NO_TOTP", "NOT_LOGIN_TYPE", "INVALID_TOTP", "TYPE_NOT_TOTP"])
    if codes != expected_codes:
        raise AssertionError("跳过原因不符: " + str(codes))
    return "6/4"


def _assert_bitwarden_steam(imported):
    steam = [item for item in imported if item["otpType"] == "steam"]
    if len(steam) != 1:
        raise AssertionError("应识别 1 个 Steam 条目，实际 " + str(len(steam)))
    item = steam[0]
    if item["digits"] != 5 or item["period"] != 30 or item["algorithm"] != "SHA1":
        raise AssertionError("Steam 字段应固定 5/30/SHA1，实际 " + json.dumps(item))
    return "1 个（" + item["issuer"] + "）"


def _assert_bitwarden_fallbacks(imported):
    bitwarden_issuer = [item for item in imported if item["issuer"] == "Bitwarden"]
    if len(bitwarden_issuer) != 1:
        raise AssertionError("name 为空的条目应兜底 issuer=Bitwarden")
    if bitwarden_issuer[0]["accountName"] != "noname@test.invalid":
        raise AssertionError("username 为空时应取 otpauth label 账号部分")
    email = [item for item in imported if item["issuer"] == "邮件"]
    if len(email) != 1 or email[0]["accountName"] != "邮箱用户":
        raise AssertionError("Unicode name/label 映射不符")
    return "Bitwarden/邮件"


def _assert_bitwarden_encrypted(kind):
    if kind != "encrypted":
        raise AssertionError("加密导出应识别为 encrypted")
    return "拒绝"


def _assert_bitwarden_stats(expected):
    stats = expected["stats"]
    if stats.get("imported") != 6 or stats.get("skipped") != 4 or stats.get("total") != 10:
        raise AssertionError("Bitwarden 期望统计不符: " + json.dumps(stats))
    return "6/4/10"


def _assert_expected_stats(expected):
    stats = expected["stats"]
    if stats.get("imported") != 13 or stats.get("skipped") != 10 or stats.get("total") != 23:
        raise AssertionError("统计不符: " + json.dumps(stats))
    return "13/10/23"


if __name__ == "__main__":
    sys.exit(main())
