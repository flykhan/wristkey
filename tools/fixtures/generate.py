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
    print("已生成:", ", ".join(os.listdir(HERE)))

if __name__ == "__main__":
    main()
