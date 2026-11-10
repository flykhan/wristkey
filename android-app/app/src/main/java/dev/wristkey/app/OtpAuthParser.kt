package dev.wristkey.app

import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.util.Locale

/** otpauth:// URI 解析失败；[code] 与导入报告的分类型对应。 */
class OtpAuthParseException(val code: String, message: String) : IllegalArgumentException(message)

data class UriImportSkip(
    val lineNumber: Int,
    val uri: String,
    val code: String,
    val reason: String,
)

data class UriImportResult(
    val accounts: List<WristKeyAccount>,
    val skipped: List<UriImportSkip>,
)

/**
 * `otpauth://` URI 解析（手动新增与 URI 列表导入共用）。
 * 支持 SHA1/SHA256/SHA512、6-10 位、5-300 秒周期；非 TOTP（HOTP/Steam）会被明确拒绝。
 */
object OtpAuthParser {

    fun parse(raw: String, updatedAt: Long = System.currentTimeMillis()): WristKeyAccount {
        val source = raw.trim()
        if (source.isEmpty()) {
            throw OtpAuthParseException("INVALID_URI", "otpauth 内容为空")
        }
        val parsed = parseRaw(source)
        if (!parsed.type.equals("totp", ignoreCase = true)) {
            throw OtpAuthParseException(
                "TYPE_NOT_TOTP",
                "otpauth 类型 ${parsed.type} 不是 totp（仅支持 TOTP）",
            )
        }

        val labelParts = parsed.label.split(":", limit = 2)
        val labelIssuer = if (labelParts.size == 2) labelParts[0] else ""
        val labelName = if (labelParts.size == 2) labelParts[1] else parsed.label
        val issuer = parsed.query["issuer"] ?: labelIssuer
        val accountName = if (labelName.isEmpty()) labelIssuer else labelName

        if (issuer.trim().isEmpty() && accountName.trim().isEmpty()) {
            throw OtpAuthParseException("EMPTY_ISSUER_AND_USERNAME", "issuer 与账号名同时为空")
        }

        val secretRaw = parsed.query["secret"]
        if (secretRaw.isNullOrEmpty()) {
            throw OtpAuthParseException("INVALID_BASE32", "secret 缺失")
        }
        val secret = Secret.normalize(secretRaw)
        if (!Secret.isNormalizedBase32(secret)) {
            throw OtpAuthParseException("INVALID_BASE32", "secret 不是合法 Base32（A-Z、2-7）")
        }

        val isSteam = detectSteam(parsed, issuer)

        val algorithm: String
        val digits: Int
        val period: Int
        if (isSteam) {
            // Steam Guard 固定 5 位字母数字 / 30 秒 / SHA1。
            algorithm = SteamOtp.ALGORITHM
            digits = SteamOtp.DIGITS
            period = SteamOtp.PERIOD
        } else {
            algorithm = (parsed.query["algorithm"] ?: DEFAULT_ALGORITHM).trim().uppercase(Locale.US)
            if (algorithm !in SUPPORTED_ALGORITHMS) {
                throw OtpAuthParseException("INVALID_ALGORITHM", "algorithm=$algorithm 不受支持")
            }
            digits = parseBoundedInt(parsed.query["digits"], DEFAULT_DIGITS) { it in 6..10 }
                ?: throw OtpAuthParseException("DIGITS_OUT_OF_RANGE", "digits 必须是 6-10 的整数")
            period = parseBoundedInt(parsed.query["period"], DEFAULT_PERIOD) { it in 5..300 }
                ?: throw OtpAuthParseException("PERIOD_OUT_OF_RANGE", "period 必须是 5-300 的整数")
        }

        return WristKeyAccount(
            id = Secret.accountIdForSecret(secret),
            issuer = issuer,
            accountName = accountName,
            category = DEFAULT_CATEGORY,
            secret = secret,
            algorithm = algorithm,
            digits = digits,
            period = period,
            updatedAt = updatedAt,
            otpType = if (isSteam) OTP_TYPE_STEAM else OTP_TYPE_TOTP,
        )
    }

    /** 逐行解析 `otpauth://` 文本；非法行进入 skipped 报告，不中断导入。 */
    fun parseList(text: String, updatedAt: Long = System.currentTimeMillis()): UriImportResult {
        val accounts = mutableListOf<WristKeyAccount>()
        val skipped = mutableListOf<UriImportSkip>()
        val lines = text.removePrefix("\uFEFF").lines()
        var lineNumber = 0
        for (line in lines) {
            lineNumber += 1
            val trimmed = line.trim()
            if (trimmed.isEmpty() || trimmed.startsWith("#")) {
                continue
            }
            try {
                accounts += parse(trimmed, updatedAt)
            } catch (error: OtpAuthParseException) {
                skipped += UriImportSkip(lineNumber, trimmed, error.code, error.message ?: "解析失败")
            }
        }
        return UriImportResult(accounts, skipped)
    }

    /**
     * Steam 账号识别（docs/stratum-format.md）：
     * - 查询参数含裸 `steam` 标记（Stratum 在 issuer ≠ "Steam" 时追加 `&steam`）；
     * - 或 `encoder=steam`（Aegis 等实现约定）；
     * - 或 issuer / label 前缀为 `Steam`（大小写不敏感）；
     * - 或 `digits=5` 且 issuer 为 `Steam`。
     */
    private fun detectSteam(parsed: RawOtpAuth, issuer: String): Boolean {
        if (parsed.query.containsKey("steam")) {
            return true
        }
        if (parsed.query["encoder"]?.trim()?.equals("steam", ignoreCase = true) == true) {
            return true
        }
        if (issuer.trim().startsWith("Steam", ignoreCase = true)) {
            return true
        }
        if (parsed.label.trim().startsWith("Steam", ignoreCase = true)) {
            return true
        }
        return parsed.query["digits"]?.trim() == "5" && issuer.trim().equals("Steam", ignoreCase = true)
    }

    private data class RawOtpAuth(
        val type: String,
        val label: String,
        val query: Map<String, String>,
    )

    private fun parseRaw(source: String): RawOtpAuth {
        val prefix = "otpauth://"
        if (!source.regionMatches(0, prefix, 0, prefix.length, ignoreCase = true)) {
            throw OtpAuthParseException("INVALID_URI", "不是 otpauth:// 链接")
        }
        val rest = source.substring(prefix.length)
        val queryIndex = rest.indexOf('?')
        val beforeQuery = if (queryIndex >= 0) rest.substring(0, queryIndex) else rest
        val queryRaw = if (queryIndex >= 0) rest.substring(queryIndex + 1) else ""
        val slashIndex = beforeQuery.indexOf('/')
        if (slashIndex < 0) {
            throw OtpAuthParseException("INVALID_URI", "otpauth 链接缺少类型")
        }
        val type = beforeQuery.substring(0, slashIndex)
        val label = decodeComponent(beforeQuery.substring(slashIndex + 1), plusAsSpace = false)
        return RawOtpAuth(type = type, label = label, query = parseQuery(queryRaw))
    }

    private fun parseQuery(rawQuery: String): Map<String, String> {
        if (rawQuery.isEmpty()) {
            return emptyMap()
        }
        val result = LinkedHashMap<String, String>()
        rawQuery.split("&").forEach { part ->
            if (part.isEmpty()) {
                return@forEach
            }
            val separator = part.indexOf('=')
            val key = decodeComponent(if (separator >= 0) part.substring(0, separator) else part, plusAsSpace = true)
            val value = if (separator >= 0) decodeComponent(part.substring(separator + 1), plusAsSpace = true) else ""
            // 与 URLSearchParams.get 一致：同名参数取第一个。
            result.putIfAbsent(key, value)
        }
        return result
    }

    private fun decodeComponent(value: String, plusAsSpace: Boolean): String {
        val prepared = if (plusAsSpace) value else value.replace("+", "%2B")
        return runCatching { URLDecoder.decode(prepared, StandardCharsets.UTF_8.name()) }
            .getOrElse { throw OtpAuthParseException("INVALID_URI", "otpauth 链接包含非法转义") }
    }

    /** 缺省值：参数不存在时返回 [fallback]；存在但非法时返回 null。 */
    private fun parseBoundedInt(raw: String?, fallback: Int, predicate: (Int) -> Boolean): Int? {
        if (raw == null) {
            return fallback
        }
        val value = raw.trim().toIntOrNull() ?: return null
        return if (predicate(value)) value else null
    }
}
