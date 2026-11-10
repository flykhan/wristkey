package dev.wristkey.app

/**
 * Steam Guard 验证码（5 位字母数字）。
 *
 * 与 Stratum 的 `SteamOtp` 一致：
 * 1. HMAC-SHA1(secret, floor(unixSeconds / 30) 的 8 字节大端)；
 * 2. RFC 4226 动态截断得到 31 位整数 material；
 * 3. 重复 5 次：`char = ALPHABET[material % 26]; material /= 26`，从低位字符开始输出。
 */
object SteamOtp {

    const val ALPHABET = "23456789BCDFGHJKMNPQRTVWXY"
    const val DIGITS = 5
    const val PERIOD = 30
    const val ALGORITHM = "SHA1"

    fun generate(secret: String, timeMillis: Long): String {
        var material = Totp.truncatedMaterial(secret, Totp.counterFor(timeMillis, PERIOD), ALGORITHM)
        val builder = StringBuilder(DIGITS)
        repeat(DIGITS) {
            builder.append(ALPHABET[material % ALPHABET.length])
            material /= ALPHABET.length
        }
        return builder.toString()
    }

    fun remainingSeconds(timeMillis: Long): Int = Totp.remainingSeconds(timeMillis, PERIOD)
}
