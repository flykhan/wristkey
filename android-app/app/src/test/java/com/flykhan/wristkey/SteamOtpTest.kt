package com.flykhan.wristkey

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Steam Guard 5 位字母数字码（字符串 secret，与 band-app 相同 6 组向量）。 */
class SteamOtpTest {

    private val secret = "OJZ2BP7STWSLUD7I23Q5AYZELZB5OAFU"

    /** (Unix 秒, 期望 5 位码)。 */
    private val vectors = listOf(
        59L to "3DP36",
        1111111109L to "GX57J",
        1111111111L to "TCJ4Y",
        1234567890L to "VYNVB",
        1640846388L to "2Y4TM",
        1735689600L to "DQ5KF",
    )

    @Test
    fun steamGuardVectors() {
        vectors.forEach { (timeSeconds, expected) ->
            assertEquals("T=$timeSeconds", expected, SteamOtp.generate(secret, timeSeconds * 1000L))
        }
    }

    @Test
    fun codeShapeIsFiveAlphanumericChars() {
        vectors.forEach { (timeSeconds, _) ->
            val code = SteamOtp.generate(secret, timeSeconds * 1000L)
            assertEquals(5, code.length)
            assertTrue("字符必须来自 Steam 字母表", code.all { it in SteamOtp.ALPHABET })
        }
        assertFalse(SteamOtp.generate(secret, 59_000L).all { it.isDigit() })
    }

    @Test
    fun constantsMatchSteamGuard() {
        assertEquals("23456789BCDFGHJKMNPQRTVWXY", SteamOtp.ALPHABET)
        assertEquals(5, SteamOtp.DIGITS)
        assertEquals(30, SteamOtp.PERIOD)
        assertEquals("SHA1", SteamOtp.ALGORITHM)
    }

    @Test
    fun remainingSecondsUsesThirtySecondPeriod() {
        assertEquals(30, SteamOtp.remainingSeconds(0L))
        assertEquals(29, SteamOtp.remainingSeconds(1_000L))
        assertEquals(1, SteamOtp.remainingSeconds(29_000L))
        assertEquals(30, SteamOtp.remainingSeconds(30_000L))
    }

    @Test
    fun accountCurrentCodeDispatchesOnOtpType() {
        val steam = WristKeyAccount(
            id = "s_x",
            issuer = "Steam",
            accountName = "alice",
            secret = secret,
            digits = 5,
            otpType = OTP_TYPE_STEAM,
        )
        assertEquals("3DP36", steam.currentCode(59_000L))
        assertEquals(29, steam.remainingSeconds(1_000L))

        val totp = steam.copy(digits = 6, otpType = OTP_TYPE_TOTP)
        val totpCode = totp.currentCode(59_000L)
        assertEquals(6, totpCode.length)
        assertTrue(totpCode.all { it.isDigit() })
        assertNotEquals("3DP36", totpCode)
        assertEquals(29, totp.remainingSeconds(1_000L))
    }
}
