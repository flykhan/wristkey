package com.flykhan.wristkey

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** SharedPreferences 账号 JSON 编解码与 1.x 旧数据兼容（docs/design/android-v2-spec.md §4）。 */
class AccountCodecTest {

    @Test
    fun decodesLegacyAccountWithoutPasswordOrOtpType() {
        val raw = """
            [{"id":"s_9bb1d7340577","issuer":"GitHub","accountName":"dev@example.com",
              "category":"开发","secret":"JBSWY3DPEHPK3PXP","algorithm":"SHA1",
              "digits":6,"period":30,"updatedAt":123}]
        """.trimIndent()
        val accounts = AccountCodec.decode(raw)

        assertEquals(1, accounts.size)
        val account = accounts.single()
        assertEquals("s_9bb1d7340577", account.id)
        assertEquals("开发", account.category)
        assertEquals(OTP_TYPE_TOTP, account.otpType)
        assertEquals("", account.password)
        assertEquals(123L, account.updatedAt)
        assertTrue(account.password.isEmpty())
    }

    @Test
    fun decodesLegacyAccountWithMissingCategory() {
        val raw = """[{"id":"s_1","issuer":"AWS","accountName":"root","secret":"JBSWY3DPEHPK3PXP"}]"""
        val account = AccountCodec.decode(raw).single()
        assertEquals(DEFAULT_CATEGORY, account.category)
        assertEquals(DEFAULT_ALGORITHM, account.algorithm)
        assertEquals(DEFAULT_DIGITS, account.digits)
        assertEquals(DEFAULT_PERIOD, account.period)
    }

    @Test
    fun roundTripsPasswordAndOtpType() {
        val account = WristKeyAccount(
            id = "s_9bb1d7340577",
            issuer = "Steam",
            accountName = "alice",
            category = "游戏",
            secret = TestFixtures.SHA1_SEED,
            algorithm = "SHA1",
            digits = 5,
            period = 30,
            updatedAt = 7L,
            otpType = OTP_TYPE_STEAM,
            password = "p@ss 中文",
        )
        val decoded = AccountCodec.decode(AccountCodec.encode(listOf(account))).single()

        assertEquals(account.id, decoded.id)
        assertEquals(account.issuer, decoded.issuer)
        assertEquals(account.category, decoded.category)
        assertEquals(account.secret, decoded.secret)
        assertEquals(account.otpType, decoded.otpType)
        assertEquals(account.password, decoded.password)
        assertEquals(TestFixtures.SHA1_SEED, decoded.secret)
    }

    @Test
    fun steamFieldsAreNormalizedOnDecode() {
        val raw = """[{"id":"s_2","issuer":"Steam","accountName":"bob","secret":"JBSWY3DPEHPK3PXP",
            "otpType":"steam","algorithm":"SHA512","digits":8,"period":60}]"""
        val steam = AccountCodec.decode(raw).single()
        assertEquals(OTP_TYPE_STEAM, steam.otpType)
        assertEquals("SHA1", steam.algorithm)
        assertEquals(5, steam.digits)
        assertEquals(30, steam.period)
        assertTrue(steam.isSteam)
    }

    @Test
    fun invalidOrEmptyJsonYieldsEmptyList() {
        assertTrue(AccountCodec.decode("").isEmpty())
        assertTrue(AccountCodec.decode("not json").isEmpty())
        assertTrue(AccountCodec.decode("[{\"id\":\"\",\"secret\":\"ABC\"}]").isEmpty())
        assertTrue(AccountCodec.decode("[{\"id\":\"s_1\",\"secret\":\"\"}]").isEmpty())
    }

    @Test
    fun passwordIsTrimmedToProtocolLimits() {
        val longPassword = "x".repeat(200)
        val raw = """[{"id":"s_3","issuer":"A","accountName":"b","secret":"JBSWY3DPEHPK3PXP",
            "password":"$longPassword"}]"""
        val account = AccountCodec.decode(raw).single()
        assertEquals(MAX_PASSWORD_LENGTH, account.password.length)
    }
}
