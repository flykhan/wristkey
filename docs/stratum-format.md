# Stratum 备份格式（导入侧规范）

来源：Stratum（[stratumauth/app](https://github.com/stratumauth/app)，GPL-3.0）的
`doc/BACKUP_FORMAT.md` 与 `Stratum.Core/src/Backup/Encryption/*`。本项目依据公开格式**独立实现**解析，
不包含其源代码。

## 文件形态

Stratum 的导出菜单实际提供 3 项（文件名 `backup-yyyy-MM-dd_HHmmss.{ext}`，经系统文件保存器写出）：

| 形态 | 识别方式 | 扩展名（导出时） |
| --- | --- | --- |
| Strong 加密（设置密码） | 文件以 16 字节 ASCII `AUTHENTICATORPRO` 开头 | `.stratum` |
| 明文 JSON 备份（密码留空） | UTF-8，JSON 对象，含 `Authenticators` 键 | `.stratum` |
| Legacy 加密（旧版本恢复用） | 文件以 16 字节 ASCII `AuthenticatorPro` 开头 | `.stratum` |
| URI 列表 | UTF-8 文本，每行 `otpauth://...` | `.txt` |
| HTML（QR + 明文，**不可导回**） | 以 `<!DOCTYPE html` / `<html` 开头 | `.html` |

导入器必须按**内容**而不是扩展名判断：先做加密魔数判断 → HTML 判断（提示"HTML 导出无法导入，请用 .stratum 备份或 URI 列表"）
→ 尝试 JSON → 尝试 URI 列表。加密与明文都可能是 `.stratum`，不能靠扩展名区分。

## Strong 加密布局

| 段 | 长度 | 内容 |
| --- | --- | --- |
| Header | 16 | ASCII `AUTHENTICATORPRO` |
| Salt | 16 | 随机 |
| IV | 12 | 随机 |
| Payload+Tag | 剩余 | AES-256-GCM 密文 + 16 字节 GCM tag（密文在前） |

- 密钥：**Argon2id**，password = UTF-8 编码的密码，salt 如上，
  parallelism=4，memory=65536 KiB (64 MiB)，iterations=3，输出 32 字节；
- 加密：AES-256-GCM，无 AAD，tag 16 字节，附在密文后；
- 明文：与"明文 JSON 备份"完全相同的 JSON（UTF-8）。

## Legacy 加密布局

| 段 | 长度 | 内容 |
| --- | --- | --- |
| Header | 16 | ASCII `AuthenticatorPro` |
| Salt | 20 | 随机 |
| IV | 16 | 随机 |
| Payload | 剩余 | AES-256-CBC + PKCS#7 密文 |

- 密钥：**PBKDF2-HMAC-SHA1**，password 同上，salt 20 字节，迭代 **64000**，输出 32 字节；
- 加密：AES-256-CBC，PKCS#7 填充。

> 验证：GCM tag 校验失败 / CBC 填充非法 → 密码错误（不要泄露具体解密细节给用户，统一提示"密码错误或文件损坏"）。

## 明文 JSON 结构

`~json
{
  "Authenticators": [
    { "Type": 2, "Icon": "google", "Issuer": "Google", "Username": "me@gmail.com",
      "Secret": "JBSWY3DPEHPK3PXP", "Pin": null, "Algorithm": 0,
      "Digits": 6, "Period": 30, "Counter": 0, "Ranking": 0, "CopyCount": 10 }
  ],
  "Categories": [ { "Id": "a8323a2a", "Name": "Web", "Ranking": 0 } ],
  "AuthenticatorCategories": [
    { "CategoryId": "a8323a2a", "AuthenticatorSecret": "JBSWY3DPEHPK3PXP", "Ranking": 0 }
  ],
  "CustomIcons": []
}
`~

键名为 **PascalCase**（System.Text.Json 默认序列化行为）；解析器应同时容忍 camelCase。

### 枚举与约束

| 字段 | 取值/约束 |
| --- | --- |
| `Type` | 1=HOTP，2=TOTP，3=Mobile-OTP，4=Steam，5=Yandex |
| `Algorithm` | 0=SHA1，1=SHA256，2=SHA512（HOTP/TOTP 有效） |
| `Secret` | 大写 Base32，无空格，可带 `=` 填充；**是 Authenticator 的主键**（全局唯一） |
| `Issuer` | 非空，≤32（Stratum 限制） |
| `Username` | 可为 null，≤40 |
| `Digits` | TOTP 6–10，HOTP 6–8 |
| `Period` | >0（秒） |
| `Ranking` | 排序；分类内按 AuthenticatorCategories.Ranking 排序 |
| `Category.Id` | 名称 SHA-1 前 8 位十六进制（可忽略，按 Name 关联） |
| `Icon` | 以 `@` 开头表示自定义图标 id（本项目忽略图标） |

## 映射到同步快照

| Stratum | 本项目 `account` | 说明 |
| --- | --- | --- |
| `Secret`（归一化后） | `secret` | 去空格、转大写；`=` 可保留，手环端归一化 |
| `Issuer` | `issuer` | 保持原值（可为空，仅当 Username 也空时跳过并报错） |
| `Username` | `accountName` | null → `""` |
| 分类（AuthenticatorCategories → Category.Name） | `category` | 无分类 → `"默认分类"`；多个分类取排名最靠前者 |
| `Algorithm` 0/1/2 | `SHA1`/`SHA256`/`SHA512` | |
| `Digits` | `digits` | 6–10 原样 |
| `Period` | `period` | 5–300 原样，越界则丢弃并报错 |
| `Secret` 的 SHA-1 前 12 位（十六进制） | `id` | `"s_" + sha1(secret)[0:12]`，跨次导入稳定，用于去重 |
| `Ranking` | — | 用于排序；快照按排序输出 |

## 跳过与报告

以下条目**不导入**，但在导入结果中逐条列出（issuer/username/原因）：

- `Type != 2`（HOTP/Steam/Mobile-OTP/Yandex）；
- `period` 不在 5–300、`digits` 不在 6–10；
- 非法 Base32（包含 A–Z2–7 之外字符）、空 secret；
- issuer 与 username 同时为空。

## 安全

- 导入后建议删除/移走导出的备份文件；App 内不保留原始备份内容；
- 密码只在导入时使用，不落盘；解密在内存中完成，错误信息不包含密码；
- 手机端存储完整 secret（应用私有 SharedPreferences），请启用锁屏；
- 手环端快照含完整 secret，请勿在不可信设备上安装。
