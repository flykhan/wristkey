package dev.wristkey.app

import java.text.DateFormat
import java.util.Date
import java.util.Locale

const val DEFAULT_CATEGORY = "默认分类"
const val DEFAULT_ALGORITHM = "SHA1"
const val DEFAULT_DIGITS = 6
const val DEFAULT_PERIOD = 30

const val OTP_TYPE_TOTP = "totp"
const val OTP_TYPE_STEAM = "steam"
val SUPPORTED_OTP_TYPES: Set<String> = setOf(OTP_TYPE_TOTP, OTP_TYPE_STEAM)

const val MAX_ISSUER_LENGTH = 64
const val MAX_ACCOUNT_NAME_LENGTH = 64
const val MAX_CATEGORY_LENGTH = 32

val SUPPORTED_ALGORITHMS: Set<String> = Totp.SUPPORTED_ALGORITHMS

/** `otpType` 归一化：大小写不敏感，缺省/未知值回退为 totp（兼容旧数据）。 */
fun normalizeOtpType(raw: String?): String {
    val value = raw?.trim()?.lowercase(Locale.US).orEmpty()
    return if (value in SUPPORTED_OTP_TYPES) value else OTP_TYPE_TOTP
}

/**
 * 手机端保存的 OTP 账号（与协议 v2 的 account 字段一一对应）。
 *
 * [otpType] 为 `totp`（缺省）或 `steam`；Steam 账号固定 digits=5 / period=30 / SHA1，
 * 码为 5 位字母数字（见 [SteamOtp]）。
 */
data class WristKeyAccount(
    val id: String,
    val issuer: String,
    val accountName: String,
    val category: String = DEFAULT_CATEGORY,
    val secret: String,
    val algorithm: String = DEFAULT_ALGORITHM,
    val digits: Int = DEFAULT_DIGITS,
    val period: Int = DEFAULT_PERIOD,
    val updatedAt: Long = System.currentTimeMillis(),
    val otpType: String = OTP_TYPE_TOTP,
) {
    val normalizedOtpType: String
        get() = normalizeOtpType(otpType)

    val isSteam: Boolean
        get() = normalizedOtpType == OTP_TYPE_STEAM

    val categoryLabel: String
        get() = category.trim().ifBlank { DEFAULT_CATEGORY }

    val displayTitle: String
        get() = listOf(issuer.trim(), accountName.trim())
            .filter { it.isNotBlank() }
            .joinToString(" · ")
            .ifBlank { "未命名账号" }

    /** 列表展示用的脱敏 secret（仅用于 UI，绝不写日志）。 */
    val maskedSecret: String
        get() = when {
            secret.isEmpty() -> ""
            secret.length <= 8 -> "*".repeat(secret.length)
            else -> "${secret.take(4)}...${secret.takeLast(4)}"
        }

    val updatedAtLabel: String
        get() = DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(updatedAt))

    /** 计算当前验证码（手机端用于核对）：TOTP 为 6-10 位数字，Steam 为 5 位字母数字。 */
    fun currentCode(timeMillis: Long = System.currentTimeMillis()): String =
        if (isSteam) {
            SteamOtp.generate(secret, timeMillis)
        } else {
            Totp.generate(secret, timeMillis, period = period, digits = digits, algorithm = algorithm)
        }

    /** 当前周期的剩余秒数（Steam 固定 30 秒周期）。 */
    fun remainingSeconds(timeMillis: Long = System.currentTimeMillis()): Int =
        if (isSteam) SteamOtp.remainingSeconds(timeMillis) else Totp.remainingSeconds(timeMillis, period)
}

/** 手动新增/编辑表单的草稿。 */
data class AccountDraft(
    val id: String? = null,
    val category: String = DEFAULT_CATEGORY,
    val issuer: String = "",
    val accountName: String = "",
    val secret: String = "",
    val digits: String = DEFAULT_DIGITS.toString(),
    val period: String = DEFAULT_PERIOD.toString(),
    val algorithm: String = DEFAULT_ALGORITHM,
    val otpType: String = OTP_TYPE_TOTP,
) {
    val isEditing: Boolean
        get() = id != null

    val isSteam: Boolean
        get() = normalizeOtpType(otpType) == OTP_TYPE_STEAM
}

data class DraftValidationResult(
    val account: WristKeyAccount? = null,
    val errorMessage: String? = null,
)

fun WristKeyAccount.toDraft(): AccountDraft = AccountDraft(
    id = id,
    category = categoryLabel,
    issuer = issuer,
    accountName = accountName,
    secret = secret,
    digits = digits.toString(),
    period = period.toString(),
    algorithm = algorithm,
    otpType = normalizedOtpType,
)

/** 手动表单校验；导入路径不经过这里（导入按 docs/stratum-format.md 的规则校验）。 */
fun AccountDraft.validate(now: Long = System.currentTimeMillis()): DraftValidationResult {
    val normalizedIssuer = issuer.trim()
    val normalizedAccountName = accountName.trim()
    val normalizedCategory = category.trim().ifBlank { DEFAULT_CATEGORY }
    val normalizedOtpType = normalizeOtpType(otpType)
    val isSteam = normalizedOtpType == OTP_TYPE_STEAM

    if (normalizedIssuer.isEmpty() && normalizedAccountName.isEmpty()) {
        return DraftValidationResult(errorMessage = "Issuer 与账号名不能同时为空")
    }
    if (normalizedIssuer.length > MAX_ISSUER_LENGTH) {
        return DraftValidationResult(errorMessage = "Issuer 不能超过 ${MAX_ISSUER_LENGTH} 个字符")
    }
    if (normalizedAccountName.length > MAX_ACCOUNT_NAME_LENGTH) {
        return DraftValidationResult(errorMessage = "账号名不能超过 ${MAX_ACCOUNT_NAME_LENGTH} 个字符")
    }
    if (normalizedCategory.length > MAX_CATEGORY_LENGTH) {
        return DraftValidationResult(errorMessage = "分类不能超过 ${MAX_CATEGORY_LENGTH} 个字符")
    }

    val normalizedSecret = Secret.normalize(secret)
    if (normalizedSecret.isEmpty()) {
        return DraftValidationResult(errorMessage = "Secret 不能为空")
    }
    if (!Secret.isNormalizedBase32(normalizedSecret)) {
        return DraftValidationResult(errorMessage = "Secret 必须是 Base32（A-Z、2-7）")
    }

    val parsedDigits: Int
    val parsedPeriod: Int
    val parsedAlgorithm: String
    if (isSteam) {
        // Steam Guard 固定 5 位 / 30 秒 / SHA1，忽略表单里的位数/周期/算法。
        parsedDigits = SteamOtp.DIGITS
        parsedPeriod = SteamOtp.PERIOD
        parsedAlgorithm = SteamOtp.ALGORITHM
    } else {
        parsedDigits = digits.trim().toIntOrNull() ?: -1
        if (parsedDigits !in 6..10) {
            return DraftValidationResult(errorMessage = "验证码位数必须在 6-10 之间")
        }
        parsedPeriod = period.trim().toIntOrNull() ?: -1
        if (parsedPeriod !in 5..300) {
            return DraftValidationResult(errorMessage = "周期必须在 5-300 秒之间")
        }
        parsedAlgorithm = algorithm.trim().uppercase(Locale.US).ifBlank { DEFAULT_ALGORITHM }
        if (parsedAlgorithm !in SUPPORTED_ALGORITHMS) {
            return DraftValidationResult(errorMessage = "算法必须是 SHA1 / SHA256 / SHA512")
        }
    }

    return DraftValidationResult(
        account = WristKeyAccount(
            // id 由 secret 派生，跨次导入/手动新增都稳定，用于去重。
            id = id ?: Secret.accountIdForSecret(normalizedSecret),
            issuer = normalizedIssuer,
            accountName = normalizedAccountName,
            category = normalizedCategory,
            secret = normalizedSecret,
            algorithm = parsedAlgorithm,
            digits = parsedDigits,
            period = parsedPeriod,
            updatedAt = now,
            otpType = normalizedOtpType,
        ),
    )
}
