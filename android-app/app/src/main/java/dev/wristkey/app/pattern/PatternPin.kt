package dev.wristkey.app.pattern

import java.security.SecureRandom
import java.util.Locale
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

/**
 * 入口图案（5 位 T/S/C）与派生值（docs/protocol.md v3 `mfa_pin_set`）。
 *
 * 手机端只发送派生结果，不发送图案明文，也不在本地保存图案：
 * - 图案规范串：固定 5 位，每位 `T`（三角）/`S`（方形）/`C`（圆形），按点击顺序拼接；
 * - 派生：PBKDF2-HMAC-SHA256(图案规范串, salt 16 字节, iterations=1200) 的 32 字节结果（64 位小写 hex）。
 *
 * 纯 JVM 实现（PBKDF2WithHmacSHA256 在 JDK 与 Android API 26+ 均可用），单元测试可直接验证。
 */
object PatternPin {

    const val SHAPE_TRIANGLE = "T"
    const val SHAPE_SQUARE = "S"
    const val SHAPE_CIRCLE = "C"
    val SHAPES: List<String> = listOf(SHAPE_TRIANGLE, SHAPE_SQUARE, SHAPE_CIRCLE)

    const val LENGTH = 5
    const val ITERATIONS = 1200
    const val MIN_ITERATIONS = 1000
    const val MAX_ITERATIONS = 20000
    const val SALT_BYTES = 16
    const val SALT_HEX_LENGTH = SALT_BYTES * 2
    const val HASH_HEX_LENGTH = 64
    const val ALGORITHM = "PBKDF2-SHA256"

    private val PATTERN_REGEX = Regex("^[TSC]{5}$")
    private val SALT_HEX_REGEX = Regex("^[0-9a-f]{32}$")
    private val HASH_HEX_REGEX = Regex("^[0-9a-f]{64}$")

    /** 手环端只接受 `/^[TSC]{5}$/`（docs/protocol.md）。 */
    fun isValidPattern(pattern: String): Boolean = PATTERN_REGEX.matches(pattern)

    fun isValidSaltHex(saltHex: String): Boolean = SALT_HEX_REGEX.matches(saltHex)

    fun isValidHashHex(hashHex: String): Boolean = HASH_HEX_REGEX.matches(hashHex)

    fun isSupportedIterations(iterations: Int): Boolean = iterations in MIN_ITERATIONS..MAX_ITERATIONS

    fun newSalt(random: SecureRandom = SecureRandom()): ByteArray = ByteArray(SALT_BYTES).also { random.nextBytes(it) }

    /** 16 字节随机盐的 32 位小写十六进制表示。 */
    fun newSaltHex(random: SecureRandom = SecureRandom()): String = toHex(newSalt(random))

    /**
     * 图案规范串 → PBKDF2-HMAC-SHA256 32 字节结果（64 位小写 hex）。
     * [saltHex] 为 [SALT_HEX_LENGTH] 位小写十六进制；[iterations] 必须在 1000-20000。
     */
    fun derive(pattern: String, saltHex: String, iterations: Int = ITERATIONS): String {
        require(isValidPattern(pattern)) { "图案必须是 5 位 T/S/C" }
        require(isValidSaltHex(saltHex)) { "salt 必须是 32 位小写十六进制" }
        require(isSupportedIterations(iterations)) { "iterations 必须在 $MIN_ITERATIONS-$MAX_ITERATIONS 之间" }
        val spec = PBEKeySpec(pattern.toCharArray(), fromHex(saltHex), iterations, 256)
        return try {
            val factory = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
            toHex(factory.generateSecret(spec).encoded)
        } finally {
            spec.clearPassword()
        }
    }

    fun toHex(bytes: ByteArray): String = buildString(bytes.size * 2) {
        for (byte in bytes) {
            append(String.format(Locale.US, "%02x", byte.toInt() and 0xFF))
        }
    }

    fun fromHex(hex: String): ByteArray {
        require(hex.length % 2 == 0) { "hex 长度必须是偶数" }
        return ByteArray(hex.length / 2) { index ->
            hex.substring(index * 2, index * 2 + 2).toInt(16).toByte()
        }
    }
}
