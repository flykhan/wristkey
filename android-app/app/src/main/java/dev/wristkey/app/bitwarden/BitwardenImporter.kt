package dev.wristkey.app.bitwarden

import dev.wristkey.app.DEFAULT_ALGORITHM
import dev.wristkey.app.DEFAULT_CATEGORY
import dev.wristkey.app.DEFAULT_DIGITS
import dev.wristkey.app.DEFAULT_PERIOD
import dev.wristkey.app.OTP_TYPE_TOTP
import dev.wristkey.app.OtpAuthParseException
import dev.wristkey.app.OtpAuthParser
import dev.wristkey.app.Secret
import dev.wristkey.app.WristKeyAccount
import dev.wristkey.app.stratum.StratumFormat
import dev.wristkey.app.stratum.StratumImportException
import dev.wristkey.app.stratum.StratumImportResult
import dev.wristkey.app.stratum.StratumSkip
import org.json.JSONObject

/**
 * Bitwarden Vault **未加密** JSON 导出导入。
 *
 * 规则（与 docs/ 约定一致）：
 * - 只支持未加密导出；顶层 {@code encrypted:true} 给出明确提示，不当作密码错误；
 * - 忽略 folders/分类，全部归入「默认分类」；
 * - `issuer = item.name`（trim，空则 "Bitwarden"）；`accountName = login.username`（空则 otpauth label 账号）；
 * - `login.totp`：otpauth:// 复用 [OtpAuthParser]（含 Steam 识别与各字段）；纯 Base32 按 SHA1/6/30；
 * - 空 totp、非法 secret/URI、重复 secret 逐条报告为 skipped，不中断导入。
 *
 * 纯 JVM（org.json），不依赖 Android 框架。
 */
object BitwardenImporter {

    const val ENCRYPTED_MESSAGE = "Bitwarden 加密导出暂不支持，请导出未加密 JSON"

    private const val FALLBACK_ISSUER = "Bitwarden"

    fun isEncryptedExport(root: JSONObject): Boolean = root.optBoolean("encrypted", false)

    fun isBitwardenExport(root: JSONObject): Boolean = root.optJSONArray("items") != null

    /** 解析 Bitwarden 未加密 JSON 导出为协议 account 列表 + 跳过报告。 */
    fun importJson(text: String, updatedAt: Long = System.currentTimeMillis()): StratumImportResult {
        val root = parseRoot(text)
        if (isEncryptedExport(root)) {
            throw StratumImportException(ENCRYPTED_MESSAGE)
        }
        val items = root.optJSONArray("items")
            ?: throw StratumImportException("不是 Bitwarden 导出：缺少 items 列表")

        val accounts = ArrayList<WristKeyAccount>(items.length())
        val skipped = ArrayList<StratumSkip>()
        val seenSecrets = HashSet<String>()

        for (index in 0 until items.length()) {
            val item = items.optJSONObject(index) ?: continue
            val name = item.optString("name").trim()
            val login = item.optJSONObject("login")
            val username = login?.optString("username")?.trim().orEmpty()
            val rawTotp = login?.optString("totp")?.trim().orEmpty()
            val issuer = name.ifBlank { FALLBACK_ISSUER }

            fun skip(code: String, reason: String) {
                skipped += StratumSkip(issuer = issuer, accountName = username, code = code, reason = reason)
            }

            if (rawTotp.isEmpty()) {
                skip("NO_TOTP", "该条目没有 login.totp，跳过")
                continue
            }

            val parsed = try {
                if (rawTotp.startsWith("otpauth://", ignoreCase = true)) {
                    OtpAuthParser.parse(rawTotp, updatedAt)
                } else {
                    parseRawBase32(rawTotp, updatedAt)
                }
            } catch (error: OtpAuthParseException) {
                skip(error.code, error.message ?: "otpauth URI 解析失败")
                continue
            } catch (error: IllegalArgumentException) {
                skip("INVALID_BASE32", error.message ?: "secret 不是合法 Base32")
                continue
            }

            val canonicalSecret = Secret.normalize(parsed.secret)
            if (!seenSecrets.add(canonicalSecret)) {
                skip("DUPLICATE_SECRET", "与前面的条目 secret 重复（以 secret 为主键）")
                continue
            }

            accounts += parsed.copy(
                id = Secret.accountIdForSecret(canonicalSecret),
                issuer = issuer,
                accountName = username.ifBlank { parsed.accountName },
                category = DEFAULT_CATEGORY,
                secret = canonicalSecret,
                updatedAt = updatedAt,
            )
        }

        return StratumImportResult(
            format = StratumFormat.BITWARDEN,
            accounts = accounts,
            skipped = skipped,
        )
    }

    private fun parseRoot(text: String): JSONObject {
        val cleaned = text.removePrefix("\uFEFF").trim()
        val parsed = runCatching { JSONObject(cleaned) }.getOrElse {
            throw StratumImportException("不是合法的 Bitwarden JSON 导出")
        }
        return parsed
    }

    /** 纯 Base32 secret：按默认 TOTP（SHA1 / 6 位 / 30 秒）。 */
    private fun parseRawBase32(raw: String, updatedAt: Long): WristKeyAccount {
        val secret = Secret.normalize(raw)
        if (!Secret.isNormalizedBase32(secret)) {
            throw IllegalArgumentException("totp 不是 otpauth:// URI，也不是合法 Base32 secret")
        }
        return WristKeyAccount(
            id = Secret.accountIdForSecret(secret),
            issuer = "",
            accountName = "",
            secret = secret,
            algorithm = DEFAULT_ALGORITHM,
            digits = DEFAULT_DIGITS,
            period = DEFAULT_PERIOD,
            updatedAt = updatedAt,
            otpType = OTP_TYPE_TOTP,
        )
    }
}
