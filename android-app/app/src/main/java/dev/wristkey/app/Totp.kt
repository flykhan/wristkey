package dev.wristkey.app

import java.util.Locale
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** RFC 4226 / RFC 6238 TOTP（纯 JVM，可在单元测试中直接验证）。 */
object Totp {

    val SUPPORTED_ALGORITHMS: Set<String> = setOf("SHA1", "SHA256", "SHA512")

    fun generate(
        secret: String,
        timeMillis: Long,
        period: Int = 30,
        digits: Int = 6,
        algorithm: String = "SHA1",
    ): String {
        require(period in 5..300) { "period 必须在 5-300 秒" }
        require(digits in 6..10) { "digits 必须在 6-10 位" }
        val counter = timeMillis / 1000L / period
        return generateHotp(secret, counter, digits, algorithm)
    }

    fun generateHotp(
        secret: String,
        counter: Long,
        digits: Int = 6,
        algorithm: String = "SHA1",
    ): String {
        require(digits in 6..10) { "digits 必须在 6-10 位" }
        val normalizedAlgorithm = algorithm.uppercase(Locale.US)
        require(normalizedAlgorithm in SUPPORTED_ALGORITHMS) { "不支持的算法: $algorithm" }

        val key = Secret.decodeBase32(secret)
        val mac = Mac.getInstance("Hmac" + normalizedAlgorithm)
        mac.init(SecretKeySpec(key, "RAW"))
        val hash = mac.doFinal(counterToBytes(counter))

        val offset = hash[hash.size - 1].toInt() and 0x0F
        val binary = ((hash[offset].toInt() and 0x7F) shl 24) or
            ((hash[offset + 1].toInt() and 0xFF) shl 16) or
            ((hash[offset + 2].toInt() and 0xFF) shl 8) or
            (hash[offset + 3].toInt() and 0xFF)
        val modulus = POWERS_OF_TEN[digits]
        val otp = binary.toLong() % modulus
        return otp.toString().padStart(digits, '0')
    }

    /** 当前周期剩余秒数（1..period）。 */
    fun remainingSeconds(timeMillis: Long, period: Int = 30): Int {
        val elapsed = (timeMillis / 1000L) % period
        return (period - elapsed).toInt()
    }

    private fun counterToBytes(counter: Long): ByteArray {
        val buffer = ByteArray(8)
        var value = counter
        for (index in 7 downTo 0) {
            buffer[index] = (value and 0xFF).toByte()
            value = value ushr 8
        }
        return buffer
    }

    private val POWERS_OF_TEN = longArrayOf(1, 10, 100, 1_000, 10_000, 100_000, 1_000_000, 10_000_000, 100_000_000, 1_000_000_000, 10_000_000_000L)
}
