package com.flykhan.wristkey

import org.junit.Assert.assertEquals
import org.junit.Test

/** RFC 6238 Appendix B 官方测试向量（SHA1/SHA256/SHA512，8 位）。 */
class TotpTest {

    private data class Vector(val timeSeconds: Long, val sha1: String, val sha256: String, val sha512: String)

    private val vectors = listOf(
        Vector(59L, "94287082", "46119246", "90693936"),
        Vector(1111111109L, "07081804", "68084774", "25091201"),
        Vector(1111111111L, "14050471", "67062674", "99943326"),
        Vector(1234567890L, "89005924", "91819424", "93441116"),
        Vector(2000000000L, "69279037", "90698825", "38618901"),
        Vector(20000000000L, "65353130", "77737706", "47863826"),
    )

    @Test
    fun rfc6238Vectors() {
        vectors.forEach { vector ->
            val timeMillis = vector.timeSeconds * 1000L
            assertEquals("SHA1 @${vector.timeSeconds}", vector.sha1, Totp.generate(TestFixtures.SHA1_SEED, timeMillis, 30, 8, "SHA1"))
            assertEquals("SHA256 @${vector.timeSeconds}", vector.sha256, Totp.generate(TestFixtures.SHA256_SEED, timeMillis, 30, 8, "SHA256"))
            assertEquals("SHA512 @${vector.timeSeconds}", vector.sha512, Totp.generate(TestFixtures.SHA512_SEED, timeMillis, 30, 8, "SHA512"))
        }
    }

    @Test
    fun generateRespectsDigitsAndPeriod() {
        val code6 = Totp.generate(TestFixtures.SHA1_SEED, 59_000L, period = 30, digits = 6)
        assertEquals("287082", code6)
        // 同一时间点动态截断后的 31 位整数为 1094287082；8 位取模后是 94287082。
        val code10 = Totp.generate(TestFixtures.SHA1_SEED, 59_000L, period = 30, digits = 10)
        assertEquals(10, code10.length)
        assertEquals("1094287082", code10)
    }

    @Test
    fun remainingSeconds() {
        assertEquals(30, Totp.remainingSeconds(0L, 30))
        assertEquals(29, Totp.remainingSeconds(1_000L, 30))
        assertEquals(1, Totp.remainingSeconds(29_000L, 30))
        assertEquals(30, Totp.remainingSeconds(30_000L, 30))
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsUnsupportedAlgorithm() {
        Totp.generate(TestFixtures.SHA1_SEED, 0L, 30, 6, "MD5")
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsInvalidPeriod() {
        Totp.generate(TestFixtures.SHA1_SEED, 0L, 0, 6)
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsInvalidDigits() {
        Totp.generate(TestFixtures.SHA1_SEED, 0L, 30, 5)
    }
}
