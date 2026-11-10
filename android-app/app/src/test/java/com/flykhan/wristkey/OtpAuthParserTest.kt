package com.flykhan.wristkey

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class OtpAuthParserTest {

    @Test
    fun parsesBasicTotpUri() {
        val account = OtpAuthParser.parse(
            "otpauth://totp/GitHub:dev@example.com?secret=${TestFixtures.SHA1_SEED}&issuer=GitHub",
            updatedAt = TestFixtures.FIXED_UPDATED_AT,
        )
        assertEquals("GitHub", account.issuer)
        assertEquals("dev@example.com", account.accountName)
        assertEquals(DEFAULT_CATEGORY, account.category)
        assertEquals(TestFixtures.SHA1_SEED, account.secret)
        assertEquals("SHA1", account.algorithm)
        assertEquals(6, account.digits)
        assertEquals(30, account.period)
        assertEquals("s_9bb1d7340577", account.id)
        assertEquals(TestFixtures.FIXED_UPDATED_AT, account.updatedAt)
    }

    @Test
    fun parsesAlgorithmDigitsAndPeriodAndNormalizesSecret() {
        val account = OtpAuthParser.parse(
            "otpauth://totp/Google:me@gmail.com?secret=gezdgnbvgy3tqojqgezdgnbvgy3tqojqgezdgnbvgy3tqojqgeza&issuer=Google&algorithm=SHA256&digits=8&period=60",
        )
        assertEquals("Google", account.issuer)
        assertEquals("me@gmail.com", account.accountName)
        assertEquals(TestFixtures.SHA256_SEED, account.secret)
        assertEquals("SHA256", account.algorithm)
        assertEquals(8, account.digits)
        assertEquals(60, account.period)
    }

    @Test
    fun usesIssuerFromLabelWhenQueryMissing() {
        val account = OtpAuthParser.parse("otpauth://totp/Example:alice?secret=${TestFixtures.SHA1_SEED}")
        assertEquals("Example", account.issuer)
        assertEquals("alice", account.accountName)
    }

    @Test
    fun labelWithoutColonBecomesAccountName() {
        val account = OtpAuthParser.parse("otpauth://totp/alice?secret=${TestFixtures.SHA1_SEED}")
        assertEquals("", account.issuer)
        assertEquals("alice", account.accountName)
    }

    @Test
    fun decodesPercentEncodedLabels() {
        val account = OtpAuthParser.parse(
            "otpauth://totp/%E5%BC%80%E5%8F%91:alice?secret=${TestFixtures.SHA1_SEED}&issuer=%E5%BC%80%E5%8F%91",
        )
        assertEquals("开发", account.issuer)
        assertEquals("alice", account.accountName)
    }

    @Test
    fun rejectsHotp() {
        val error = assertThrows(OtpAuthParseException::class.java) {
            OtpAuthParser.parse("otpauth://hotp/Legacy:u1?secret=${TestFixtures.SHA1_SEED}&counter=0")
        }
        assertEquals("TYPE_NOT_TOTP", error.code)
    }

    @Test
    fun rejectsInvalidAlgorithmDigitsPeriodAndSecret() {
        assertEquals(
            "INVALID_ALGORITHM",
            assertThrows(OtpAuthParseException::class.java) {
                OtpAuthParser.parse("otpauth://totp/A:b?secret=${TestFixtures.SHA1_SEED}&algorithm=MD5")
            }.code,
        )
        assertEquals(
            "DIGITS_OUT_OF_RANGE",
            assertThrows(OtpAuthParseException::class.java) {
                OtpAuthParser.parse("otpauth://totp/A:b?secret=${TestFixtures.SHA1_SEED}&digits=5")
            }.code,
        )
        assertEquals(
            "PERIOD_OUT_OF_RANGE",
            assertThrows(OtpAuthParseException::class.java) {
                OtpAuthParser.parse("otpauth://totp/A:b?secret=${TestFixtures.SHA1_SEED}&period=999")
            }.code,
        )
        assertEquals(
            "INVALID_BASE32",
            assertThrows(OtpAuthParseException::class.java) {
                OtpAuthParser.parse("otpauth://totp/A:b?secret=NOT-BASE32!")
            }.code,
        )
    }

    @Test
    fun parsesUriListFixtureAndReportsHotpLine() {
        val result = OtpAuthParser.parseList(TestFixtures.text("uri-list.txt"), updatedAt = TestFixtures.FIXED_UPDATED_AT)
        assertEquals(3, result.accounts.size)
        assertEquals(1, result.skipped.size)
        assertEquals("TYPE_NOT_TOTP", result.skipped.first().code)
        assertEquals(4, result.skipped.first().lineNumber)

        assertEquals("GitHub", result.accounts[0].issuer)
        assertEquals("SHA1", result.accounts[0].algorithm)
        assertEquals("Google", result.accounts[1].issuer)
        assertEquals("SHA256", result.accounts[1].algorithm)
        assertEquals(8, result.accounts[1].digits)
        assertEquals("AWS", result.accounts[2].issuer)
        assertEquals("SHA512", result.accounts[2].algorithm)
        assertEquals(10, result.accounts[2].digits)
        assertEquals(15, result.accounts[2].period)
    }

    @Test
    fun detectsSteamFromIssuerPrefixBareMarkerAndEncoder() {
        val byIssuer = OtpAuthParser.parse(
            "otpauth://totp/Steam:alice?secret=OJZ2BP7STWSLUD7I23Q5AYZELZB5OAFU&issuer=Steam",
        )
        assertEquals(OTP_TYPE_STEAM, byIssuer.otpType)
        assertEquals(5, byIssuer.digits)
        assertEquals(30, byIssuer.period)
        assertEquals("SHA1", byIssuer.algorithm)
        assertEquals("Steam", byIssuer.issuer)
        assertEquals("alice", byIssuer.accountName)
        assertEquals("3DP36", byIssuer.currentCode(59_000L))

        val byBareMarker = OtpAuthParser.parse(
            "otpauth://totp/Game:bob?secret=${TestFixtures.SHA256_SEED}&issuer=Game&steam",
        )
        assertEquals(OTP_TYPE_STEAM, byBareMarker.otpType)
        assertEquals("Game", byBareMarker.issuer)

        val byEncoder = OtpAuthParser.parse(
            "otpauth://totp/Other:carol?secret=${TestFixtures.SHA1_SEED}&issuer=Other&encoder=steam",
        )
        assertEquals(OTP_TYPE_STEAM, byEncoder.otpType)

        val normal = OtpAuthParser.parse(
            "otpauth://totp/GitHub:dave?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&digits=6&period=30",
        )
        assertEquals(OTP_TYPE_TOTP, normal.otpType)
        assertEquals(6, normal.digits)
    }

    @Test
    fun totpUriWithDigitsFiveWithoutSteamMarkerIsStillRejected() {
        val error = assertThrows(OtpAuthParseException::class.java) {
            OtpAuthParser.parse("otpauth://totp/GitHub:dave?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&digits=5")
        }
        assertEquals("DIGITS_OUT_OF_RANGE", error.code)
    }

    @Test
    fun ignoresBlankLinesAndComments() {
        val text = "# comment\n\notpauth://totp/A:b?secret=${TestFixtures.SHA1_SEED}\n"
        val result = OtpAuthParser.parseList(text)
        assertEquals(1, result.accounts.size)
        assertEquals(0, result.skipped.size)
    }
}
