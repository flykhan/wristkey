package dev.wristkey.app

import java.text.DateFormat
import java.util.Date

const val DEFAULT_CATEGORY = "默认分类"
const val DEFAULT_ALGORITHM = "SHA1"
const val DEFAULT_DIGITS = 6
const val DEFAULT_PERIOD = 30

const val MAX_ISSUER_LENGTH = 64
const val MAX_ACCOUNT_NAME_LENGTH = 64
const val MAX_CATEGORY_LENGTH = 32

val SUPPORTED_ALGORITHMS: Set<String> = Totp.SUPPORTED_ALGORITHMS

/** 手机端保存的 TOTP 账号（与协议 v2 的 account 字段一一对应）。 */
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
) {
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

    /** 计算当前 TOTP（手机端可用于核对）。 */
    fun currentCode(timeMillis: Long = System.currentTimeMillis()): String =
        Totp.generate(secret, timeMillis, period = period, digits = digits, algorithm = algorithm)
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
) {
    val isEditing: Boolean
        get() = id != null
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
)

/** 手动表单校验；导入路径不经过这里（导入按 docs/stratum-format.md 的规则校验）。 */
fun AccountDraft.validate(now: Long = System.currentTimeMillis()): DraftValidationResult {
    val normalizedIssuer = issuer.trim()
    val normalizedAccountName = accountName.trim()
    val normalizedCategory = category.trim().ifBlank { DEFAULT_CATEGORY }
    val normalizedAlgorithm = algorithm.trim().uppercase().ifBlank { DEFAULT_ALGORITHM }

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

    val parsedDigits = digits.trim().toIntOrNull()
    if (parsedDigits == null || parsedDigits !in 6..10) {
        return DraftValidationResult(errorMessage = "验证码位数必须在 6-10 之间")
    }
    val parsedPeriod = period.trim().toIntOrNull()
    if (parsedPeriod == null || parsedPeriod !in 5..300) {
        return DraftValidationResult(errorMessage = "周期必须在 5-300 秒之间")
    }
    if (normalizedAlgorithm !in SUPPORTED_ALGORITHMS) {
        return DraftValidationResult(errorMessage = "算法必须是 SHA1 / SHA256 / SHA512")
    }

    return DraftValidationResult(
        account = WristKeyAccount(
            // id 由 secret 派生，跨次导入/手动新增都稳定，用于去重。
            id = id ?: Secret.accountIdForSecret(normalizedSecret),
            issuer = normalizedIssuer,
            accountName = normalizedAccountName,
            category = normalizedCategory,
            secret = normalizedSecret,
            algorithm = normalizedAlgorithm,
            digits = parsedDigits,
            period = parsedPeriod,
            updatedAt = now,
        ),
    )
}
