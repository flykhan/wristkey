# Stratum Android 导出 UI 与备份格式核对

> 依据：`research/stratum` 源码（Stratum / Authenticator Pro，GPL-3.0，仅作格式参考）。
> 标注：**[已验证]** = 源码行号可复核；**[已验证-二手]** = 社区实际导出文件。

## 0. TL;DR（给 docs/stratum-format.md 的修正点）

Stratum.Droid 的"备份"菜单实际提供 **3 种导出**（不是 2 种）：

| 菜单项 | 内容 | 强制扩展名 | 能否导回 Stratum | docs 现状 |
| --- | --- | --- | --- | --- |
| Back up to encrypted file（推荐） | 有密码 → **Strong**（AUTHENTICATORPRO + Argon2id + AES-256-GCM）；**留空密码 → 明文 JSON**（`NoBackupEncryption`） | 均为 `.stratum` | 能 | 部分正确 |
| Back up to HTML file | 明文 HTML + 每个账号的二维码（`otpauth://`） | `.html` | **不能**（无导入逻辑） | **docs 缺失** |
| Back up to URI list file | 每行一个 `otpauth://` | `.txt` | 能（UriList 导入） | 正确 |

**必须修正**：
1. 明文 JSON 备份的扩展名也是 **`.stratum`**（`ShowPicker(..., Backup.FileExtension)` 与是否加密无关），不是 `.json`；导入必须按内容嗅探（当前 docs 也强调了嗅探，方向对）。
2. 增加 **`.html` HTML 备份**形态：文件以 `<html` 开头、含二维码/明文 otpauth，**不可导回**，导入器应识别后提示"HTML 备份不支持导入，请改用 URI 列表或加密备份"。
3. "Legacy 加密（AuthenticatorPro 头）" 在**当前 UI 不提供导出**，仅用于**恢复旧备份**（注册在解密器集合里，导出路径只使用 Strong/NoBackup）。docs 表述"Legacy .stratum（旧版本）"正确，但应说明"仅历史文件，无法从当前版本导出"。
4. **自动备份**（AutoBackupWorker）也生成同命名规则的 `.stratum`（Strong 加密，需密码；写入用户选定的 SAF 目录树）。

## 1. 导出入口与实现（源码）

文件：`research/stratum/Stratum.Droid/src/Activity/MainActivity.cs`

```csharp
private void OpenBackupMenu() {
    void ShowPicker(string mimeType, int requestCode, string fileExtension) {
        StartFileSaveActivity(mimeType, requestCode,
            FormattableString.Invariant($"backup-{DateTime.Now:yyyy-MM-dd_HHmmss}.{fileExtension}"));
    }
    fragment.BackupFileClicked    += delegate { ShowPicker("*/*", RequestBackupFile, Backup.FileExtension); };          // "stratum"
    fragment.BackupHtmlFileClicked+= delegate { ShowPicker(HtmlBackup.MimeType, RequestBackupHtml, HtmlBackup.FileExtension); }; // "text/html" / "html"
    fragment.BackupUriListClicked += delegate { ShowPicker(UriListBackup.MimeType, RequestBackupUriList, UriListBackup.FileExtension); }; // "text/plain" / "txt"
}
```

- **文件名格式：`backup-YYYY-MM-dd_HHmmss.{stratum|html|txt}`**（本地时区）。**[已验证]**
- 保存方式：`ACTION_CREATE_DOCUMENT`（SAF 另存为），**不是系统分享**（`BaseActivity.StartFileSaveActivity`）。**[已验证]**
- 主备份逻辑（`BackupToFile`）：
  ```csharp
  var backup = await _backupService.CreateBackupAsync();
  IBackupEncryption encryption = !string.IsNullOrEmpty(password)
      ? new StrongBackupEncryption()
      : new NoBackupEncryption();
  ```
  密码弹窗允许留空（有二次确认警告 `confirmEmptyPassword`："your backup will not be encrypted"）。**[已验证]**
  若开启 `Preferences.PasswordProtected && Preferences.DatabasePasswordBackup`，则直接用数据库密码做 Strong 加密、**不弹窗**。**[已验证]**
- 资源字符串（`Resources/values/strings.xml`）：
  - `backupToFile` = "Back up to encrypted file (recommended)"
  - `backupHtml` = "Back up to HTML file"；警告："HTML backups are unencrypted... This file cannot be restored within the app and does not contain categories and icons."
  - `backupUriList` = "Back up to URI list file"；警告："...unencrypted plain-text URI list file. This file is compatible with many alternative applications and services. Categories and icons are not saved."
  **[已验证]**

## 2. 四种文件形态（导入器必须按内容识别）

### 2.1 Strong 加密（`.stratum`）
`Stratum.Core/src/Backup/Encryption/StrongBackupEncryption.cs`：
- Header（16B ASCII）：`AUTHENTICATORPRO`
- Salt 16B、IV 12B、Payload = AES-256-GCM 密文（含 16B tag，GCM 输出格式为 cipher||tag）
- KDF：Argon2id，parallelism=**4**，iterations=**3**，memory=**65536 KiB**，输出 **32B**
- 明文：与 2.3 相同的 JSON（`JsonSerializer.SerializeToUtf8Bytes`，System.Text.Json 默认 PascalCase）
**[已验证]**
> 与 docs/stratum-format.md 一致。

### 2.2 Legacy 加密（`.stratum`，仅历史备份）
`LegacyBackupEncryption.cs`：Header `AuthenticatorPro`（16B）、Salt **20B**、IV **16B**、AES-256-CBC/PKCS7、PBKDF2-HMAC-SHA1 **64000** iter、输出 **32B** 密钥。**[已验证]**
- 当前导出 UI **不会**产生此格式；只有恢复旧文件时用。**[已验证]**
- `CanBeDecrypted` 按头部判断；恢复流程遍历 `_backupEncryptions` 找到可解者。**[已验证]**

### 2.3 明文 JSON（`.stratum`）
`NoBackupEncryption.cs`：直接 `JsonSerializer.SerializeToUtf8Bytes(backup)`，无头、无加密。**[已验证]**
结构（`doc/BACKUP_FORMAT.md` + 源码实体）：
```json
{
  "Authenticators": [
    { "Type": 2, "Icon": "google", "Issuer": "Google", "Username": "a@b.c",
      "Secret": "JBSWY3DPEHPK3PXP", "Pin": null, "Algorithm": 0,
      "Digits": 6, "Period": 30, "Counter": 0, "Ranking": 0, "CopyCount": 10 }
  ],
  "Categories": [ { "Id": "a8323a2a", "Name": "Web", "Ranking": 0 } ],
  "AuthenticatorCategories": [ { "CategoryId": "a8323a2a", "AuthenticatorSecret": "...", "Ranking": 0 } ],
  "CustomIcons": [ { "Id": "...", "Data": "..." } ]
}
```
- 判定：JSON 可反序列化且 `Authenticators != null`（`NoBackupEncryption.CanBeDecrypted`）。**[已验证]**
- 枚举：Type 1=HOTP 2=TOTP 3=MobileOTP 4=Steam 5=Yandex；Algorithm 0=SHA1 1=SHA256 2=SHA512；TOTP Digits 6–10，HOTP 6–8；Period>0。**[已验证-官方格式文档]**
- 注意：`Secret` 是**大写 Base32 无空格**、可为 Authenticator 主键；Issuer 非空。**[已验证]**

### 2.4 HTML 备份（`.html`，不可导回）
`HtmlBackup.cs`：模板 `backup_template.html` + 每行 `<tr><td>issuer</td><td>username</td><td><code>otpauth://...</code></td><td><img data:image/png;base64,...></td></tr>`；QR 用 QRCoder 生成。**没有对应导入解析器**。**[已验证]**
- 导入器识别策略：trim 后以 `<!doctype html`/`<html` 开头 → 提示不支持导入；**不要**尝试从 HTML 抽取 otpauth（可能误抓二维码 base64 垃圾）。

### 2.5 URI 列表（`.txt`）
`UriListBackup.cs`：遍历 authenticators，调用 `auth.GetUri()`；抛 `NotSupportedException` 的（Steam/Mobile-OTP/Yandex 等）**直接跳过**；每行一个 `otpauth://totp/...`。**[已验证]**
- 社区实证：BandTOTP 官方指南就是让用户在 Stratum 里"备份至 URI 列表文件"再喂给手机端。**[已验证-二手]**（<https://www.bandbbs.cn/resources/2119/>）

## 3. 自动备份（AutoBackupWorker）

文件：`Stratum.Droid/src/AutoBackupWorker.cs` **[已验证]**
- 触发：有变更时（OneTimeWorkRequest，`autobackup`）；需用户预先选定 SAF 目录树并授予持久化读写权限。
- 文件名：同样 `backup-{DateTime.Now:yyyy-MM-dd_HHmmss}.stratum`，MIME `application/octet-stream`，写入 `DocumentFile.CreateFile`。
- 加密：`GetBackupPassword()`（`DatabasePasswordBackup` ? 数据库密码 : 自动备份密码）；**密码为 null 直接抛 `InvalidOperationException("No password defined")`** → 自动备份只会是 Strong 加密（或失败）；空密码则走 NoBackupEncryption（明文）。
- 无账号时跳过（`!backup.Authenticators.Any()`）。
- 失败通知/成功通知走 `NotificationContext`。

## 4. 导入侧建议（针对本项目）

1. 首次打开文件：读前 16 字节判 `AUTHENTICATORPRO` / `AuthenticatorPro`；否则尝试 UTF-8 JSON（含 `Authenticators`）；否则尝试逐行 `otpauth://`；否则看是否 HTML → 明确报错。**不要依赖扩展名**（明文也用 `.stratum`）。
2. 对 `.stratum` 明文文件：允许直接导入，但 UI 要提示"该备份未加密"。
3. 对 HTML：拒绝并提示替代方案（URI 列表/加密备份）。
4. 文件名不作为元数据：用户可能改名，扩展名可能被系统改（如 `.stratum` → `.stratum.txt`）。
5. 跳过项报告：Type≠2、非法 Base32、digits/period 越界、issuer+username 均空（与 docs/stratum-format.md 一致）。
6. 扩展名建议：导入文件选择器 `*/*`，同时接受 `.stratum/.json/.txt/.html`。

## 5. 待确认/真机

- [ ] Stratum 不同版本的导出菜单是否变化（本研究基于当前源码；建议实测手机上的 Stratum 最新版）
- [ ] 自动备份密码提示与文件名在设备上的实际表现
- [ ] HTML 备份在真实设备上是否含图标/分类（源码说不含）
