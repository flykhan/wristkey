package com.flykhan.wristkey.stratum

import com.flykhan.wristkey.DEFAULT_CATEGORY
import com.flykhan.wristkey.DEFAULT_DIGITS
import com.flykhan.wristkey.bitwarden.BitwardenImporter
import com.flykhan.wristkey.DEFAULT_PERIOD
import com.flykhan.wristkey.OTP_TYPE_STEAM
import com.flykhan.wristkey.OTP_TYPE_TOTP
import com.flykhan.wristkey.OtpAuthParser
import com.flykhan.wristkey.Secret
import com.flykhan.wristkey.SteamOtp
import com.flykhan.wristkey.WristKeyAccount
import org.bouncycastle.crypto.generators.Argon2BytesGenerator
import org.bouncycastle.crypto.params.Argon2Parameters
import org.json.JSONArray
import org.json.JSONObject
import java.security.GeneralSecurityException
import java.util.Locale
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/** 支持的备份/导出文件形态；按内容嗅探，不依赖扩展名。 */
enum class StratumFormat {
    /** Strong：AUTHENTICATORPRO + Argon2id + AES-256-GCM。 */
    STRONG,

    /** Legacy：AuthenticatorPro + PBKDF2-SHA1 + AES-256-CBC（仅旧备份恢复用）。 */
    LEGACY,

    /** 明文 JSON 备份（密码留空时导出，扩展名同样是 .stratum）。 */
    PLAIN_JSON,

    /** 每行一个 otpauth:// URI 的文本。 */
    URI_LIST,

    /** Stratum 的 HTML 导出（二维码 + 明文），只可人工查看，不能导回。 */
    HTML,

    /** Bitwarden Vault 未加密 JSON 导出（顶层 items 数组）。 */
    BITWARDEN,

    /** Bitwarden 加密导出（encrypted=true）：暂不支持。 */
    BITWARDEN_ENCRYPTED,

    UNKNOWN,
}

open class StratumImportException(message: String) : Exception(message)

/** 解密失败统一提示（密码错误或文件损坏），不泄露密码/算法细节。 */
const val STRATUM_PASSWORD_ERROR_MESSAGE = "密码错误或文件损坏"

class StratumPasswordException : StratumImportException(STRATUM_PASSWORD_ERROR_MESSAGE)

data class StratumSkip(
    val issuer: String,
    val accountName: String,
    val code: String,
    val reason: String,
    val lineNumber: Int? = null,
) {
    val displayTitle: String
        get() = listOf(issuer, accountName)
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .joinToString(" · ")
            .ifBlank { lineNumber?.let { "第 $it 行" } ?: "未知条目" }
}

data class StratumImportResult(
    val format: StratumFormat,
    val accounts: List<WristKeyAccount>,
    val skipped: List<StratumSkip>,
) {
    val importedCount: Int
        get() = accounts.size

    val skippedCount: Int
        get() = skipped.size
}

/**
 * Stratum 备份导入器（docs/stratum-format.md）。
 *
 * 纯 JVM（BouncyCastle 仅用于 Argon2id），不依赖 Android 框架，便于单元测试。
 * 流程：**按内容嗅探** → 解密（如需）→ JSON 解析 / URI 列表解析 → 映射为协议 account。
 */
object StratumImporter {

    const val PASSWORD_ERROR_MESSAGE = STRATUM_PASSWORD_ERROR_MESSAGE

    const val STRONG_HEADER = "AUTHENTICATORPRO"
    const val LEGACY_HEADER = "AuthenticatorPro"

    const val HTML_MESSAGE = "HTML 导出无法导入（HTML 只包含二维码与明文 secret，不是可解析的备份格式）。请使用 .stratum 备份或 otpauth:// URI 列表。"
    const val UNKNOWN_MESSAGE = "无法识别的文件格式：请选择 Stratum 导出的 .stratum 备份、明文 JSON 或 otpauth:// URI 列表（.txt）。"

    private const val STRONG_SALT_LENGTH = 16
    private const val STRONG_IV_LENGTH = 12
    private const val GCM_TAG_LENGTH = 16
    private const val LEGACY_SALT_LENGTH = 20
    private const val LEGACY_IV_LENGTH = 16

    private const val ARGON2_PARALLELISM = 4
    private const val ARGON2_MEMORY_KIB = 65536
    private const val ARGON2_ITERATIONS = 3
    private const val ARGON2_OUTPUT_LENGTH = 32

    private const val PBKDF2_ITERATIONS = 64000
    private const val PBKDF2_OUTPUT_BITS = 256

    private const val STRATUM_TYPE_TOTP = 2.0
    private const val STRATUM_TYPE_STEAM = 4.0
    private val ALGORITHM_NAMES = listOf("SHA1", "SHA256", "SHA512")

    /** 按内容嗅探格式：加密魔数 → HTML → JSON → URI 列表。 */
    fun detectFormat(bytes: ByteArray): StratumFormat {
        if (bytes.isEmpty()) {
            return StratumFormat.UNKNOWN
        }
        if (bytes.size >= STRONG_HEADER.length) {
            val head = String(bytes, 0, STRONG_HEADER.length, Charsets.US_ASCII)
            if (head == STRONG_HEADER) {
                return StratumFormat.STRONG
            }
            if (head == LEGACY_HEADER) {
                return StratumFormat.LEGACY
            }
        }
        val text = decodeText(bytes).removePrefix("\uFEFF").trim()
        if (text.isEmpty()) {
            return StratumFormat.UNKNOWN
        }
        if (isHtml(text)) {
            return StratumFormat.HTML
        }
        // URI 列表允许空行与 # 注释行（OtpAuthParser.parseList 会跳过）。
        val lines = text.lines()
            .map { it.trim() }
            .filter { it.isNotEmpty() && !it.startsWith("#") }
        if (lines.isNotEmpty() && lines.all { it.startsWith("otpauth://", ignoreCase = true) }) {
            return StratumFormat.URI_LIST
        }
        if (text.startsWith("{")) {
            val json = runCatching { JSONObject(text) }.getOrNull()
            if (json != null) {
                if (readField(json, "authenticators") != null) {
                    return StratumFormat.PLAIN_JSON
                }
                // Bitwarden：未加密导出顶层 { items: [...] }；加密导出 { encrypted: true, data: ... }。
                // 与 Aegis（entries）、Stratum（Authenticators）字段名互不冲突。
                if (readField(json, "encrypted") == true) {
                    return StratumFormat.BITWARDEN_ENCRYPTED
                }
                if (readField(json, "items") is JSONArray) {
                    return StratumFormat.BITWARDEN
                }
            }
        }
        return StratumFormat.UNKNOWN
    }

    fun isEncrypted(bytes: ByteArray): Boolean = when (detectFormat(bytes)) {
        StratumFormat.STRONG, StratumFormat.LEGACY -> true
        else -> false
    }

    fun requiresPassword(bytes: ByteArray): Boolean = isEncrypted(bytes)

    /** 一次性导入：嗅探 +（按需）解密 + 解析 + 映射。 */
    fun import(
        bytes: ByteArray,
        password: String? = null,
        updatedAt: Long = System.currentTimeMillis(),
    ): StratumImportResult {
        return when (val format = detectFormat(bytes)) {
            StratumFormat.STRONG -> {
                val plain = decryptStrong(bytes, password ?: throw StratumPasswordException())
                parseDecryptedJson(plain, StratumFormat.STRONG, updatedAt)
            }

            StratumFormat.LEGACY -> {
                val plain = decryptLegacy(bytes, password ?: throw StratumPasswordException())
                parseDecryptedJson(plain, StratumFormat.LEGACY, updatedAt)
            }

            StratumFormat.PLAIN_JSON -> parsePlainJson(decodeText(bytes), updatedAt)
            StratumFormat.URI_LIST -> parseUriList(decodeText(bytes), updatedAt)
            StratumFormat.HTML -> throw StratumImportException(HTML_MESSAGE)
            StratumFormat.BITWARDEN -> BitwardenImporter.importJson(decodeText(bytes), updatedAt)
            StratumFormat.BITWARDEN_ENCRYPTED -> throw StratumImportException(BitwardenImporter.ENCRYPTED_MESSAGE)
            StratumFormat.UNKNOWN -> throw StratumImportException(UNKNOWN_MESSAGE)
        }
    }

    /** Strong 解密：header16 + salt16 + iv12 + (ciphertext + tag16)。 */
    fun decryptStrong(data: ByteArray, password: String): ByteArray {
        if (!startsWith(data, STRONG_HEADER)) {
            throw StratumImportException("不是 Strong 加密的 Stratum 备份")
        }
        val saltStart = STRONG_HEADER.length
        val ivStart = saltStart + STRONG_SALT_LENGTH
        val payloadStart = ivStart + STRONG_IV_LENGTH
        if (data.size < payloadStart + GCM_TAG_LENGTH) {
            throw StratumPasswordException()
        }
        val salt = data.copyOfRange(saltStart, ivStart)
        val iv = data.copyOfRange(ivStart, payloadStart)
        val payload = data.copyOfRange(payloadStart, data.size)

        val key = deriveArgon2id(password, salt)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            SecretKeySpec(key, "AES"),
            GCMParameterSpec(GCM_TAG_LENGTH * 8, iv),
        )
        return try {
            cipher.doFinal(payload)
        } catch (error: GeneralSecurityException) {
            throw StratumPasswordException()
        }
    }

    /** Legacy 解密：header16 + salt20 + iv16 + AES-256-CBC/PKCS7。 */
    fun decryptLegacy(data: ByteArray, password: String): ByteArray {
        if (!startsWith(data, LEGACY_HEADER)) {
            throw StratumImportException("不是 Legacy 加密的 Stratum 备份")
        }
        val saltStart = LEGACY_HEADER.length
        val ivStart = saltStart + LEGACY_SALT_LENGTH
        val payloadStart = ivStart + LEGACY_IV_LENGTH
        val payloadLength = data.size - payloadStart
        if (payloadLength <= 0 || payloadLength % 16 != 0) {
            throw StratumPasswordException()
        }
        val salt = data.copyOfRange(saltStart, ivStart)
        val iv = data.copyOfRange(ivStart, payloadStart)
        val payload = data.copyOfRange(payloadStart, data.size)

        val key = try {
            val factory = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA1")
            val spec = PBEKeySpec(password.toCharArray(), salt, PBKDF2_ITERATIONS, PBKDF2_OUTPUT_BITS)
            factory.generateSecret(spec).encoded
        } catch (error: GeneralSecurityException) {
            throw StratumImportException("无法初始化 Legacy 解密")
        }
        val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), IvParameterSpec(iv))
        return try {
            cipher.doFinal(payload)
        } catch (error: GeneralSecurityException) {
            throw StratumPasswordException()
        }
    }

    /** 明文 JSON 备份 → account 列表 + 跳过报告。 */
    fun parsePlainJson(text: String, updatedAt: Long = System.currentTimeMillis()): StratumImportResult {
        val root = parseJsonObject(text)
        return mapBackup(root, StratumFormat.PLAIN_JSON, updatedAt)
    }

    /** 每行 `otpauth://` → account 列表 + 跳过报告。 */
    fun parseUriList(text: String, updatedAt: Long = System.currentTimeMillis()): StratumImportResult {
        val result = OtpAuthParser.parseList(text, updatedAt)
        val skipped = result.skipped.map { skip ->
            StratumSkip(
                issuer = "",
                accountName = "",
                code = skip.code,
                reason = skip.reason,
                lineNumber = skip.lineNumber,
            )
        }
        return StratumImportResult(StratumFormat.URI_LIST, result.accounts, skipped)
    }

    // ------------------------------------------------------------ JSON 映射

    private fun parseDecryptedJson(
        plain: ByteArray,
        format: StratumFormat,
        updatedAt: Long,
    ): StratumImportResult {
        val text = decodeText(plain).removePrefix("\uFEFF").trim()
        if (!text.startsWith("{")) {
            throw StratumImportException("解密成功但内容不是 Stratum JSON 备份")
        }
        return mapBackup(parseJsonObject(text), format, updatedAt)
    }

    private fun parseJsonObject(text: String): JSONObject {
        val cleaned = text.removePrefix("\uFEFF").trim()
        val parsed = runCatching { JSONObject(cleaned) }.getOrElse {
            throw StratumImportException("不是合法的 Stratum JSON 备份")
        }
        if (readField(parsed, "authenticators") == null) {
            throw StratumImportException("Stratum 备份缺少 Authenticators 列表")
        }
        return parsed
    }

    private data class CategoryInfo(val id: String, val name: String, val ranking: Double)

    private data class CategoryBinding(val categoryId: String, val ranking: Double)

    private data class CategoryPick(
        val name: String,
        val categoryRanking: Double,
        val bindingRanking: Double,
    )

    private data class MappedEntry(
        val account: WristKeyAccount,
        val categoryRanking: Double,
        val bindingRanking: Double,
        val authenticatorRanking: Double,
    )

    private fun mapBackup(
        root: JSONObject,
        format: StratumFormat,
        updatedAt: Long,
    ): StratumImportResult {
        val authenticators = readArray(root, "authenticators")
        val categories = readArray(root, "categories")
        val bindings = readArray(root, "authenticatorCategories")

        val categoryById = HashMap<String, CategoryInfo>()
        categories.forEachIndexed { index, categoryObject ->
            val id = readString(categoryObject, "id")
            categoryById[id] = CategoryInfo(
                id = id,
                name = readString(categoryObject, "name"),
                ranking = numberOr(readField(categoryObject, "ranking"), index.toDouble()),
            )
        }

        val bindingsBySecret = HashMap<String, MutableList<CategoryBinding>>()
        bindings.forEach { binding ->
            val secret = Secret.normalize(readString(binding, "authenticatorSecret"))
            if (secret.isEmpty()) {
                return@forEach
            }
            val list = bindingsBySecret.getOrPut(secret) { ArrayList() }
            list += CategoryBinding(
                categoryId = readString(binding, "categoryId"),
                ranking = numberOr(readField(binding, "ranking"), 0.0),
            )
        }

        val entries = ArrayList<MappedEntry>(authenticators.size)
        val skipped = ArrayList<StratumSkip>()
        val seenSecrets = HashSet<String>()

        authenticators.forEach { authenticator ->
            val issuer = readString(authenticator, "issuer")
            val username = readString(authenticator, "username")
            val secret = (readField(authenticator, "secret") as? String)?.trim().orEmpty()

            fun skip(code: String, reason: String) {
                skipped += StratumSkip(issuer, username, code, reason)
            }

            val typeValue = readField(authenticator, "type")
            val type = toNumber(typeValue)
            val isSteam = type == STRATUM_TYPE_STEAM
            if (type == null || (!isSteam && type != STRATUM_TYPE_TOTP)) {
                skip("TYPE_NOT_SUPPORTED", "Type=${typeValue ?: "null"} 不是 TOTP（2）或 Steam（4）")
                return@forEach
            }
            if (secret.isEmpty()) {
                skip("EMPTY_SECRET", "secret 为空")
                return@forEach
            }
            if (!Secret.isStratumSecret(secret)) {
                skip("INVALID_BASE32", "非法 Base32（要求 A-Z2-7，允许 = 填充）")
                return@forEach
            }
            val canonicalSecret = Secret.normalize(secret)
            if (!seenSecrets.add(canonicalSecret)) {
                skip("DUPLICATE_SECRET", "与前面的条目 secret 重复（Stratum 以 secret 为主键）")
                return@forEach
            }

            val algorithmNumber: Double
            val digitsNumber: Double
            val periodNumber: Double
            if (isSteam) {
                // Steam 固定 5 位 / 30 秒 / SHA1，忽略备份里存储的 Digits/Period/Algorithm。
                algorithmNumber = 0.0
                digitsNumber = SteamOtp.DIGITS.toDouble()
                periodNumber = SteamOtp.PERIOD.toDouble()
            } else {
                val algorithmValue = readField(authenticator, "algorithm")
                algorithmNumber = if (algorithmValue == null) 0.0 else toNumber(algorithmValue) ?: Double.NaN
                if (algorithmNumber.isNaN() || algorithmNumber !in 0.0..2.0) {
                    skip("INVALID_ALGORITHM", "Algorithm=${algorithmValue ?: "null"} 不是 0/1/2")
                    return@forEach
                }

                val digitsValue = readField(authenticator, "digits")
                digitsNumber = if (digitsValue == null) DEFAULT_DIGITS.toDouble() else toNumber(digitsValue) ?: Double.NaN
                if (digitsNumber.isNaN() || digitsNumber % 1.0 != 0.0 || digitsNumber < 6.0 || digitsNumber > 10.0) {
                    skip("DIGITS_OUT_OF_RANGE", "Digits=${digitsValue ?: "null"} 不在 6-10")
                    return@forEach
                }

                val periodValue = readField(authenticator, "period")
                periodNumber = if (periodValue == null) DEFAULT_PERIOD.toDouble() else toNumber(periodValue) ?: Double.NaN
                if (periodNumber.isNaN() || periodNumber % 1.0 != 0.0 || periodNumber < 5.0 || periodNumber > 300.0) {
                    skip("PERIOD_OUT_OF_RANGE", "Period=${periodValue ?: "null"} 不在 5-300")
                    return@forEach
                }
            }

            if (issuer.trim().isEmpty() && username.trim().isEmpty()) {
                skip("EMPTY_ISSUER_AND_USERNAME", "issuer 与 username 同时为空")
                return@forEach
            }

            val category = pickCategory(canonicalSecret, bindingsBySecret, categoryById)
            val authenticatorRanking = numberOr(readField(authenticator, "ranking"), 0.0)
            val normalizedSecret = Secret.normalize(secret)
            val account = WristKeyAccount(
                id = Secret.accountIdForSecret(normalizedSecret),
                issuer = issuer,
                accountName = username,
                category = category.name,
                secret = normalizedSecret,
                algorithm = ALGORITHM_NAMES[algorithmNumber.toInt()],
                digits = digitsNumber.toInt(),
                period = periodNumber.toInt(),
                updatedAt = updatedAt,
                otpType = if (isSteam) OTP_TYPE_STEAM else OTP_TYPE_TOTP,
            )
            entries += MappedEntry(
                account = account,
                categoryRanking = category.categoryRanking,
                bindingRanking = category.bindingRanking,
                authenticatorRanking = authenticatorRanking,
            )
        }

        entries.sortWith(
            compareBy<MappedEntry> { if (it.categoryRanking.isFinite()) 0 else 1 }
                .thenBy { it.categoryRanking }
                .thenBy { it.bindingRanking }
                .thenBy { it.authenticatorRanking }
                .thenBy { it.account.secret },
        )

        return StratumImportResult(format, entries.map { it.account }, skipped)
    }

    private fun pickCategory(
        secret: String,
        bindingsBySecret: Map<String, List<CategoryBinding>>,
        categoryById: Map<String, CategoryInfo>,
    ): CategoryPick {
        val candidates = bindingsBySecret[secret].orEmpty().mapNotNull { binding ->
            val category = categoryById[binding.categoryId] ?: return@mapNotNull null
            Triple(category, binding.ranking, 0)
        }
        if (candidates.isEmpty()) {
            return CategoryPick(
                name = DEFAULT_CATEGORY,
                categoryRanking = Double.POSITIVE_INFINITY,
                bindingRanking = Double.POSITIVE_INFINITY,
            )
        }
        val chosen = candidates.minWithOrNull(
            compareBy<Triple<CategoryInfo, Double, Int>> { it.second }
                .thenBy { it.first.ranking }
                .thenBy { it.first.name },
        ) ?: candidates.first()
        return CategoryPick(
            name = chosen.first.name,
            categoryRanking = chosen.first.ranking,
            bindingRanking = chosen.second,
        )
    }

    // ------------------------------------------------------------ 解密辅助

    private fun deriveArgon2id(password: String, salt: ByteArray): ByteArray {
        val parameters = Argon2Parameters.Builder(Argon2Parameters.ARGON2_id)
            .withVersion(Argon2Parameters.ARGON2_VERSION_13)
            .withIterations(ARGON2_ITERATIONS)
            .withMemoryAsKB(ARGON2_MEMORY_KIB)
            .withParallelism(ARGON2_PARALLELISM)
            .withSalt(salt)
            .build()
        val generator = Argon2BytesGenerator()
        generator.init(parameters)
        val output = ByteArray(ARGON2_OUTPUT_LENGTH)
        generator.generateBytes(password.toByteArray(Charsets.UTF_8), output)
        return output
    }

    // ------------------------------------------------------------ 字段读取

    private fun startsWith(data: ByteArray, header: String): Boolean {
        if (data.size < header.length) {
            return false
        }
        val expected = header.toByteArray(Charsets.US_ASCII)
        for (index in expected.indices) {
            if (data[index] != expected[index]) {
                return false
            }
        }
        return true
    }

    private fun decodeText(bytes: ByteArray): String = String(bytes, Charsets.UTF_8)

    private fun isHtml(text: String): Boolean {
        val lower = text.lowercase(Locale.US)
        return lower.startsWith("<!doctype html") || lower.startsWith("<html")
    }

    /** PascalCase 优先，其次不区分大小写的字段读取（容忍 camelCase）。 */
    private fun readField(json: JSONObject?, name: String): Any? {
        if (json == null) {
            return null
        }
        if (json.has(name)) {
            return unwrapNull(json.opt(name))
        }
        val lowerName = name.lowercase(Locale.US)
        val keys = json.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            if (key.lowercase(Locale.US) == lowerName) {
                return unwrapNull(json.opt(key))
            }
        }
        return null
    }

    private fun unwrapNull(value: Any?): Any? = if (value === JSONObject.NULL) null else value

    private fun readArray(json: JSONObject, name: String): List<JSONObject> {
        val array = readField(json, name) as? JSONArray ?: return emptyList()
        return (0 until array.length()).mapNotNull { array.optJSONObject(it) }
    }

    private fun readString(json: JSONObject, name: String): String = readField(json, name) as? String ?: ""

    private fun numberOr(value: Any?, fallback: Double): Double = toNumber(value) ?: fallback

    private fun toNumber(value: Any?): Double? = when (value) {
        is Number -> value.toDouble()
        is String -> value.trim().toDoubleOrNull()
        else -> null
    }
}
