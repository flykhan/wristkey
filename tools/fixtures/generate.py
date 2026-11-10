#!/usr/bin/env python3
"""用 Python 独立生成 Stratum Strong/Legacy 加密夹具（用于交叉验证）。

与 docs/stratum-format.md 的规范一致：
  Strong: AUTHENTICATORPRO | salt16 | iv12 | AES-256-GCM(Argon2id p=4,m=64MiB,t=3) 密文+tag16
  Legacy: AuthenticatorPro | salt20 | iv16 | AES-256-CBC/PKCS7 (PBKDF2-HMAC-SHA1 64000)

用法: python3 fixtures/generate.py
"""
import base64
import hashlib
import json
import os
import sys

try:
    from argon2.low_level import Type, hash_secret_raw
    from cryptography.hazmat.primitives import padding
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
except ImportError:
    sys.exit("需要: pip install argon2-cffi cryptography")

HERE = os.path.dirname(os.path.abspath(__file__))
PASSWORD = "test-password"
STRONG_HEADER = b"AUTHENTICATORPRO"
LEGACY_HEADER = b"AuthenticatorPro"

BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

def b32(raw: bytes) -> str:
    bits = "".join(f"{b:08b}" for b in raw)
    out = []
    for i in range(0, len(bits), 5):
        chunk = bits[i:i + 5]
        out.append(BASE32[int(chunk.ljust(5, "0"), 2)])
    return "".join(out)

# RFC 6238 测试密钥（公开值，不要用于真实账号）
SECRET_SHA1 = base64.b32encode(b"12345678901234567890").decode().rstrip("=")
SECRET_SHA256 = base64.b32encode(b"12345678901234567890123456789012").decode().rstrip("=")
SECRET_SHA512 = base64.b32encode(b"1234567890123456789012345678901234567890123456789012345678901234").decode().rstrip("=")

def category_id(name: str) -> str:
    return hashlib.sha1(name.encode()).hexdigest()[:8]

def build_backup():
    categories = [
        {"Id": category_id("开发"), "Name": "开发", "Ranking": 0},
        {"Id": category_id("社交"), "Name": "社交", "Ranking": 1},
        {"Id": category_id("云服务"), "Name": "云服务", "Ranking": 2},
    ]
    auths = [
        # SHA1 / 6 位 / 30s，两个分类中取 Ranking 最小的"社交"
        {"Type": 2, "Icon": None, "Issuer": "GitHub", "Username": "dev@example.com",
         "Secret": SECRET_SHA1, "Pin": None, "Algorithm": 0, "Digits": 6, "Period": 30,
         "Counter": 0, "Ranking": 0, "CopyCount": 0},
        # SHA256 / 8 位 / 60s
        {"Type": 2, "Icon": "google", "Issuer": "Google", "Username": "me@gmail.com",
         "Secret": SECRET_SHA256, "Pin": None, "Algorithm": 1, "Digits": 8, "Period": 60,
         "Counter": 0, "Ranking": 1, "CopyCount": 0},
        # SHA512 / 10 位 / 15s
        {"Type": 2, "Icon": None, "Issuer": "AWS", "Username": "root",
         "Secret": SECRET_SHA512, "Pin": None, "Algorithm": 2, "Digits": 10, "Period": 15,
         "Counter": 0, "Ranking": 2, "CopyCount": 0},
        # 需要跳过：HOTP
        {"Type": 1, "Icon": None, "Issuer": "LegacyHOTP", "Username": "u1",
         "Secret": SECRET_SHA1, "Pin": None, "Algorithm": 0, "Digits": 6, "Period": 30,
         "Counter": 0, "Ranking": 3, "CopyCount": 0},
        # 需要跳过：Steam
        {"Type": 4, "Icon": None, "Issuer": "Steam", "Username": "steamuser",
         "Secret": SECRET_SHA1, "Pin": None, "Algorithm": 0, "Digits": 5, "Period": 30,
         "Counter": 0, "Ranking": 4, "CopyCount": 0},
        # 需要跳过：非法 base32
        {"Type": 2, "Icon": None, "Issuer": "BadBase32", "Username": "u2",
         "Secret": "NOT-BASE32!", "Pin": None, "Algorithm": 0, "Digits": 6, "Period": 30,
         "Counter": 0, "Ranking": 5, "CopyCount": 0},
        # 需要跳过：period 越界
        {"Type": 2, "Icon": None, "Issuer": "BadPeriod", "Username": "u3",
         "Secret": b32(b"period-test-secret!"), "Pin": None, "Algorithm": 0, "Digits": 6,
         "Period": 999, "Counter": 0, "Ranking": 6, "CopyCount": 0},
        # 需要跳过：issuer 与 username 均为空
        {"Type": 2, "Icon": None, "Issuer": None, "Username": None,
         "Secret": b32(b"empty-name-secret!"), "Pin": None, "Algorithm": 0, "Digits": 6,
         "Period": 30, "Counter": 0, "Ranking": 7, "CopyCount": 0},
    ]
    links = [
        {"CategoryId": categories[0]["Id"], "AuthenticatorSecret": SECRET_SHA1, "Ranking": 5},
        {"CategoryId": categories[1]["Id"], "AuthenticatorSecret": SECRET_SHA1, "Ranking": 1},
        {"CategoryId": categories[0]["Id"], "AuthenticatorSecret": SECRET_SHA256, "Ranking": 0},
        {"CategoryId": categories[2]["Id"], "AuthenticatorSecret": SECRET_SHA512, "Ranking": 0},
        {"CategoryId": categories[0]["Id"], "AuthenticatorSecret": SECRET_SHA1, "Ranking": 9},
    ]
    return {"Authenticators": auths, "Categories": categories,
            "AuthenticatorCategories": links, "CustomIcons": []}

def encrypt_strong(plain: bytes, password: str) -> bytes:
    salt = bytes(range(16))
    iv = bytes(range(12))
    key = hash_secret_raw(
        secret=password.encode(), salt=salt, time_cost=3, memory_cost=65536,
        parallelism=4, hash_len=32, type=Type.ID,
    )
    ct = AESGCM(key).encrypt(iv, plain, None)  # 密文+tag
    return STRONG_HEADER + salt + iv + ct

def encrypt_legacy(plain: bytes, password: str) -> bytes:
    salt = bytes(range(20))
    iv = bytes(range(16))
    key = hashlib.pbkdf2_hmac("sha1", password.encode(), salt, 64000, 32)
    padder = padding.PKCS7(128).padder()
    padded = padder.update(plain) + padder.finalize()
    encryptor = Cipher(algorithms.AES(key), modes.CBC(iv)).encryptor()
    return LEGACY_HEADER + salt + iv + encryptor.update(padded) + encryptor.finalize()

# ---------------------------------------------------------------- 协议 v3 夹具（docs/protocol.md）
# 由 Python 独立生成，用于与 e2e Node 实现做语言级对拍（不依赖 Node 代码）。
PROTOCOL_V3_SYNC_ID = "sync-tools-python-v3"
PROTOCOL_V3_SENT_AT = 1760000010000
PIN_PATTERN = "TSCCT"
PIN_SALT = bytes(range(16))
PIN_ITERATIONS = 1200
PIN_SENT_AT = PROTOCOL_V3_SENT_AT + 5000


def normalize_protocol_secret(secret):
    return "".join(ch for ch in str(secret).upper() if not ch.isspace() and ch not in "=-")


def account_id(secret):
    canonical = normalize_protocol_secret(secret)
    return "s_" + hashlib.sha1(canonical.encode()).hexdigest()[:12]


def build_protocol_v3():
    accounts = [
        {
            "id": account_id(SECRET_SHA1), "issuer": "GitHub", "accountName": "dev@example.com",
            "category": "开发", "secret": SECRET_SHA1, "algorithm": "SHA1", "digits": 6,
            "period": 30, "otpType": "totp", "password": "stratum-pass-1",
        },
        {
            "id": account_id(SECRET_SHA256), "issuer": "Google", "accountName": "me@gmail.com",
            "category": "云服务", "secret": SECRET_SHA256, "algorithm": "SHA256", "digits": 8,
            "period": 60, "otpType": "totp", "password": "",
        },
        {
            "id": account_id(SECRET_SHA512), "issuer": "AWS", "accountName": "root",
            "category": "开发", "secret": SECRET_SHA512, "algorithm": "SHA512", "digits": 10,
            "period": 15, "otpType": "totp",
        },
    ]
    messages = [{
        "type": "mfa_sync_begin", "version": 3, "sentAt": PROTOCOL_V3_SENT_AT,
        "syncId": PROTOCOL_V3_SYNC_ID, "accountCount": len(accounts),
    }]
    for index, account in enumerate(accounts):
        payload = {
            "id": account["id"], "issuer": account["issuer"], "accountName": account["accountName"],
            "category": account["category"], "secret": account["secret"], "algorithm": account["algorithm"],
            "digits": account["digits"], "period": account["period"], "otpType": account["otpType"],
        }
        if "password" in account:
            payload["password"] = account["password"]
        messages.append({
            "type": "mfa_sync_account", "version": 3, "sentAt": PROTOCOL_V3_SENT_AT + index + 1,
            "syncId": PROTOCOL_V3_SYNC_ID, "index": index, "account": payload,
        })
    messages.append({
        "type": "mfa_sync_commit", "version": 3,
        "sentAt": PROTOCOL_V3_SENT_AT + len(accounts) + 1,
        "syncId": PROTOCOL_V3_SYNC_ID, "accountCount": len(accounts),
    })
    pin_hash = hashlib.pbkdf2_hmac("sha256", PIN_PATTERN.encode(), PIN_SALT, PIN_ITERATIONS, 32).hex()
    pin_payload = {
        "algorithm": "PBKDF2-SHA256", "salt": PIN_SALT.hex(), "hash": pin_hash,
        "iterations": PIN_ITERATIONS,
    }
    pin_messages = [
        {"type": "mfa_pin_set", "version": 3, "sentAt": PIN_SENT_AT, "pin": pin_payload},
        {"type": "mfa_pin_query", "version": 3, "sentAt": PIN_SENT_AT + 1, "requestId": "pin-tools-python-1"},
        {"type": "mfa_pin_clear", "version": 3, "sentAt": PIN_SENT_AT + 2},
    ]
    return {
        "description": "Python 独立生成：v3 同步（含密码）+ 图案锁消息，用于语言级对拍",
        "version": 3,
        "syncId": PROTOCOL_V3_SYNC_ID,
        "sentAt": PROTOCOL_V3_SENT_AT,
        "messages": messages,
        "pinMessages": pin_messages,
        "expected": {
            "accountCount": len(accounts),
            "accountIds": [account["id"] for account in accounts],
            "effectivePasswords": ["stratum-pass-1", "", None],
            "pin": {
                "pattern": PIN_PATTERN, "algorithm": "PBKDF2-SHA256", "salt": PIN_SALT.hex(),
                "hash": pin_hash, "iterations": PIN_ITERATIONS, "storedAt": PIN_SENT_AT,
            },
            "pinAck": {"ok": True, "enabled": True},
            "pinState": {"enabled": True, "updatedAt": PIN_SENT_AT, "requestId": "pin-tools-python-1"},
            "pinClearAck": {"ok": True, "enabled": False},
        },
    }


def main():
    backup = build_backup()
    plain = json.dumps(backup, ensure_ascii=False, indent=2).encode()
    with open(os.path.join(HERE, "plain-backup.json"), "wb") as f:
        f.write(plain)
    with open(os.path.join(HERE, "strong.stratum"), "wb") as f:
        f.write(encrypt_strong(plain, PASSWORD))
    with open(os.path.join(HERE, "legacy.stratum"), "wb") as f:
        f.write(encrypt_legacy(plain, PASSWORD))
    uri_lines = [
        "otpauth://totp/GitHub:dev@example.com?secret=" + SECRET_SHA1 + "&issuer=GitHub&digits=6&period=30",
        "otpauth://totp/Google:me@gmail.com?secret=" + SECRET_SHA256 + "&issuer=Google&algorithm=SHA256&digits=8&period=60",
        "otpauth://totp/AWS:root?secret=" + SECRET_SHA512 + "&issuer=AWS&algorithm=SHA512&digits=10&period=15",
        "otpauth://hotp/LegacyHOTP:u1?secret=" + SECRET_SHA1 + "&counter=0",
    ]
    with open(os.path.join(HERE, "uri-list.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(uri_lines) + "\n")
    protocol_v3 = build_protocol_v3()
    with open(os.path.join(HERE, "protocol-v3.json"), "w", encoding="utf-8") as f:
        f.write(json.dumps(protocol_v3, ensure_ascii=False, indent=2) + "\n")
    print("已生成:", ", ".join(sorted(os.listdir(HERE))))

if __name__ == "__main__":
    main()
