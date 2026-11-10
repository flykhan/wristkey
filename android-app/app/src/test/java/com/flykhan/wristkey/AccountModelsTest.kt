package com.flykhan.wristkey

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AccountModelsTest {

    @Test
    fun validateTrimsAndNormalizes() {
        val result = AccountDraft(
            category = " 工作 ",
            issuer = " GitHub ",
            accountName = " dev@example.com ",
            secret = "jbsw y3dp-ehpk3pxp=",
            digits = "6",
            period = "30",
            algorithm = "sha256",
        ).validate(now = TestFixtures.FIXED_UPDATED_AT)

        assertNull(result.errorMessage)
        assertNotNull(result.account)
        val account = result.account!!
        assertEquals("工作", account.category)
        assertEquals("GitHub", account.issuer)
        assertEquals("dev@example.com", account.accountName)
        assertEquals("JBSWY3DPEHPK3PXP", account.secret)
        assertEquals("SHA256", account.algorithm)
        assertEquals(6, account.digits)
        assertEquals(30, account.period)
        assertEquals("s_b57fa0798cf1", account.id)
        assertEquals(TestFixtures.FIXED_UPDATED_AT, account.updatedAt)
    }

    @Test
    fun validateDefaultsBlankCategory() {
        val result = AccountDraft(
            category = " ",
            issuer = "GitHub",
            accountName = "dev@example.com",
            secret = TestFixtures.SHA1_SEED,
        ).validate()
        assertEquals(DEFAULT_CATEGORY, result.account?.category)
    }

    @Test
    fun validateAcceptsDigitsAndPeriodBoundaries() {
        val minimum = AccountDraft(issuer = "A", secret = TestFixtures.SHA1_SEED, digits = "6", period = "5").validate()
        assertNotNull(minimum.account)
        val maximum = AccountDraft(issuer = "B", secret = TestFixtures.SHA1_SEED, digits = "10", period = "300").validate()
        assertNotNull(maximum.account)
    }

    @Test
    fun validateRejectsOutOfRangeDigitsAndPeriod() {
        assertEquals("验证码位数必须在 6-10 之间", AccountDraft(issuer = "A", secret = TestFixtures.SHA1_SEED, digits = "5").validate().errorMessage)
        assertEquals("验证码位数必须在 6-10 之间", AccountDraft(issuer = "A", secret = TestFixtures.SHA1_SEED, digits = "11").validate().errorMessage)
        assertEquals("周期必须在 5-300 秒之间", AccountDraft(issuer = "A", secret = TestFixtures.SHA1_SEED, period = "4").validate().errorMessage)
        assertEquals("周期必须在 5-300 秒之间", AccountDraft(issuer = "A", secret = TestFixtures.SHA1_SEED, period = "301").validate().errorMessage)
    }

    @Test
    fun validateRejectsMissingIssuerAndAccountName() {
        val result = AccountDraft(issuer = " ", accountName = " ", secret = TestFixtures.SHA1_SEED).validate()
        assertNull(result.account)
        assertEquals("Issuer 与账号名不能同时为空", result.errorMessage)
    }

    @Test
    fun validateRejectsInvalidSecretAndAlgorithm() {
        assertEquals("Secret 必须是 Base32（A-Z、2-7）", AccountDraft(issuer = "A", secret = "NOT-BASE32!").validate().errorMessage)
        assertEquals("算法必须是 SHA1 / SHA256 / SHA512", AccountDraft(issuer = "A", secret = TestFixtures.SHA1_SEED, algorithm = "MD5").validate().errorMessage)
    }

    @Test
    fun validateSteamDraftForcesSteamParameters() {
        val result = AccountDraft(
            issuer = "Steam",
            accountName = "alice",
            secret = "OJZ2BP7STWSLUD7I23Q5AYZELZB5OAFU",
            digits = "6",
            period = "60",
            algorithm = "SHA256",
            otpType = OTP_TYPE_STEAM,
        ).validate()

        assertNull(result.errorMessage)
        val account = result.account!!
        assertEquals(OTP_TYPE_STEAM, account.otpType)
        assertEquals(5, account.digits)
        assertEquals(30, account.period)
        assertEquals("SHA1", account.algorithm)
        assertEquals("3DP36", account.currentCode(59_000L))
    }

    @Test
    fun normalizeOtpTypeAndDraftRoundTrip() {
        assertEquals(OTP_TYPE_TOTP, normalizeOtpType(null))
        assertEquals(OTP_TYPE_TOTP, normalizeOtpType("unknown"))
        assertEquals(OTP_TYPE_STEAM, normalizeOtpType("STEAM"))

        val steam = WristKeyAccount(
            id = "s_x",
            issuer = "Steam",
            accountName = "alice",
            secret = "OJZ2BP7STWSLUD7I23Q5AYZELZB5OAFU",
            digits = 5,
            otpType = OTP_TYPE_STEAM,
        )
        val draft = steam.toDraft()
        assertEquals(OTP_TYPE_STEAM, draft.otpType)
        assertTrue(draft.isSteam)
        assertEquals("5", draft.digits)
        assertEquals("30", draft.period)
        assertEquals("SHA1", draft.algorithm)
    }

    @Test
    fun maskedSecretNeverExposesFullSecret() {
        val account = WristKeyAccount(
            id = "s_x",
            issuer = "GitHub",
            accountName = "dev@example.com",
            secret = TestFixtures.SHA1_SEED,
        )
        assertEquals("GEZD...QOJQ", account.maskedSecret)
        assertEquals("GitHub · dev@example.com", account.displayTitle)
        assertEquals("默认分类", account.categoryLabel)
    }

    @Test
    fun currentCodeUsesAccountParameters() {
        val account = WristKeyAccount(
            id = "s_x",
            issuer = "GitHub",
            accountName = "dev@example.com",
            secret = TestFixtures.SHA1_SEED,
            digits = 8,
        )
        assertEquals("94287082", account.currentCode(59_000L))
    }
}
