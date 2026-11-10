# tools —— Stratum 备份转换/验证工具

用于离线检查 Stratum 备份、生成协议夹具，以及和 App 交叉验证。

## 安装与使用

```bash
cd tools && npm install
# 解密并转成协议 v2 快照 JSON
node src/cli.mjs fixtures/strong.stratum --password test-password --pretty

# 明文备份 / URI 列表
node src/cli.mjs fixtures/plain-backup.json --pretty
node src/cli.mjs fixtures/uri-list.txt --report
```

支持的输入形态（按内容识别，与 docs/stratum-format.md 一致）：

- Strong：`AUTHENTICATORPRO` 头 + Argon2id + AES-256-GCM；
- Legacy：`AuthenticatorPro` 头 + PBKDF2-HMAC-SHA1 + AES-256-CBC；
- 明文 JSON 备份（含 `Authenticators` 键）；
- `otpauth://` 文本列表。

输出为协议 v2 快照（`{version, updatedAt, accounts[]}`），可用于手环端/手机端联调与夹具。
支持 TOTP（SHA1/256/512、6–10 位）与 **Steam Guard**（`otpType: "steam"`，5 位字母数字，固定 30 秒/SHA1）；
Steam 识别覆盖备份 `Type=4` 与 URI 标记（裸 `&steam`、`encoder=steam`、issuer/label 前缀 Steam）。

## 夹具

`fixtures/generate.py` 用 Python 独立实现（argon2-cffi + cryptography）按规范生成
Strong/Legacy 加密夹具（固定 salt/iv，密码 `test-password`），与 Node 实现互相印证；
测试密钥全部来自 RFC 6238 公开向量。

```bash
pip install argon2-cffi cryptography
python3 fixtures/generate.py
npm test
```

## 限制

- 不导入 HOTP / Yandex / Mobile-OTP（Steam 已支持；不支持项会列入跳过报告）；
- 不处理图标（`CustomIcons` 忽略）；
- 不保存密码，不做联网。
