package dev.wristkey.app

import java.security.MessageDigest
import java.util.Locale

/**
 * Base32（RFC 4648，字母表 A-Z2-7）secret 的规范化、校验与解码。
 *
 * 归一化规则（与 docs/stratum-format.md、docs/protocol.md 对齐）：
 * 转大写、去除空白、`-` 与 `=` 填充；归一化后的 secret 用于生成稳定账号 id。
 */
object Secret {

    private const val BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
    private val BASE32_INDEX: Map<Char, Int> = buildMap {
        BASE32_ALPHABET.forEachIndexed { index, char -> put(char, index) }
    }
    private val STRATUM_SECRET_REGEX = Regex("^[A-Z2-7]+=*$")

    /** 归一化：大写、去所有空白/连字符/填充（与 docs/protocol.md 的 normalizedSecret 一致）。 */
    fun normalize(raw: String): String = raw
        .uppercase(Locale.US)
        .filterNot { char -> char.isWhitespace() || char == '-' || char == '=' }

    /** 归一化后是否为合法 Base32（非空，仅 A-Z2-7）。 */
    fun isNormalizedBase32(value: String): Boolean =
        value.isNotEmpty() && value.all { it in BASE32_INDEX }

    /**
     * Stratum 明文备份的 secret 校验：Stratum 写出的是大写 Base32，允许 `=` 尾部填充。
     * 注意不先转大写——小写 secret 视为非法（与 docs/stratum-format.md 的“大写 Base32”一致）。
     */
    fun isStratumSecret(raw: String): Boolean = STRATUM_SECRET_REGEX.matches(raw)

    /** 归一化并进行 Base32 校验，非法时抛 [IllegalArgumentException]。 */
    fun normalizeOrThrow(raw: String): String {
        val normalized = normalize(raw)
        require(isNormalizedBase32(normalized)) { "secret 不是合法 Base32" }
        return normalized
    }

    /** 解码为字节；非法时抛 [IllegalArgumentException]。 */
    fun decodeBase32(raw: String): ByteArray {
        val normalized = normalizeOrThrow(raw)
        val out = java.io.ByteArrayOutputStream(normalized.length * 5 / 8)
        var buffer = 0
        var bitsLeft = 0
        for (char in normalized) {
            buffer = (buffer shl 5) or BASE32_INDEX.getValue(char)
            bitsLeft += 5
            if (bitsLeft >= 8) {
                out.write((buffer shr (bitsLeft - 8)) and 0xFF)
                bitsLeft -= 8
            }
        }
        return out.toByteArray()
    }

    fun sha1Hex(text: String): String {
        val digest = MessageDigest.getInstance("SHA-1").digest(text.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { byte -> "%02x".format(byte) }
    }

    /** 协议账号 id：`"s_" + sha1(归一化 secret 的 UTF-8)[0:12]`，跨次导入稳定。 */
    fun accountIdForSecret(rawSecret: String): String = "s_" + sha1Hex(normalize(rawSecret)).take(12)
}
