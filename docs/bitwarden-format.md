# Bitwarden 导入格式（手机端）

支持 **Bitwarden 密码管理器 → 导出保险库 → `.json`（未加密）**。用户已确认：不导入文件夹/分类、
不支持加密导出。

## 文件识别

| 形态 | 识别方式 | 处理 |
| --- | --- | --- |
| 未加密 Vault JSON | UTF-8 JSON，顶层有 `items` 数组，且元素含 `login` 字段；`encrypted` 为 `false` 或缺失 | 导入 `login.totp` |
| 加密 Vault JSON | 顶层 `encrypted: true`（通常还有 `data`/`salt`/kdf 字段） | 拒绝并提示："Bitwarden 加密导出暂不支持，请导出未加密 JSON" |
| 其它 Bitwarden 导出（Authenticator App） | 无 `login` 字段 | 不识别 |

必须与 Stratum（`Authenticators` 键）、Aegis（`entries` 键）区分；按内容嗅探，不依赖扩展名。

## 字段映射

`~json
{
  "encrypted": false,
  "folders": [ { "id": "f1", "name": "工作" } ],
  "items": [
    {
      "type": 1,
      "name": "GitHub",
      "folderId": "f1",
      "login": {
        "username": "me@example.com",
        "totp": "otpauth://totp/GitHub:me@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub"
      }
    }
  ]
}
`~

| Bitwarden | 本项目 account | 说明 |
| --- | --- | --- |
| `items[].name` | `issuer` | 去首尾空白；为空时用 `"Bitwarden"` |
| `login.username` | `accountName` | 为空时取 otpauth label 的账号部分；两者都空时用 issuer |
| `login.totp` | 解析为 secret/algorithm/digits/period/otpType | 见下 |
| `folders` / `folderId` | — | **忽略**（用户要求），分类统一"默认分类" |

### `login.totp` 的两种形式

1. **`otpauth://` URI**（Bitwarden 推荐形式）：直接复用 `OtpAuthParser`：
   - 支持 TOTP（SHA1/256/512、6–10 位、5–300s）；
   - `encoder=steam` 或 issuer/label 前缀 `Steam` → Steam Guard（5 位字母数字）；
   - 缺省参数按 SHA1 / 6 位 / 30s。
2. **纯 Base32 secret**（24 或 32 字符等）：按 SHA1 / 6 位 / 30s 导入；非法 Base32 跳过并报告。

## 跳过与报告

以下条目不导入，并在导入报告中列出（条目名 / 原因）：

- `login.totp` 为空或缺失（普通密码条目）；
- `login.totp` 非法（bad otpauth / 非法 Base32 / 不支持的算法）；
- secret 与已有账号重复（按 secret 去重，合并模式下同 secret 覆盖）；
- `type` 不是登录（1）的条目（安全笔记/卡片/身份）即使有 totp 字段也不导入。

## 不支持

- **加密导出**（Bitwarden 的密码保护导出）：需要 PBKDF2/Argon2 + AES-CBC/HMAC 解密，暂未实现；
  App 会识别并提示改用未加密导出（导出后建议立即删除文件）。
- 文件夹/分类、图标、自定义字段、TOTP 之外的类型。
- Bitwarden Authenticator（独立 App）的导出格式（与 Vault 不同），后续可加。

## 安全

- 未加密导出文件含全部密码（不只是 TOTP），导入后请立即删除；
- App 只读取 `login.totp` 与用户名，不保存密码字段；
- 完整 secret 仍存于手机应用私有存储并同步到手环，遵循 [security.md](security.md)。
