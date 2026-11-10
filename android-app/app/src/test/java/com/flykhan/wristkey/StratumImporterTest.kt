package com.flykhan.wristkey

import com.flykhan.wristkey.stratum.StratumFormat
import com.flykhan.wristkey.stratum.StratumImporter
import com.flykhan.wristkey.stratum.StratumImportException
import com.flykhan.wristkey.stratum.StratumPasswordException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** 明文 / URI 列表 / 格式嗅探（加密解密见 StratumDecryptTest）。 */
class StratumImporterTest {

    @Test
    fun detectsFormatByContent() {
        assertEquals(StratumFormat.PLAIN_JSON, StratumImporter.detectFormat(TestFixtures.bytes("plain-backup.json")))
        assertEquals(StratumFormat.STRONG, StratumImporter.detectFormat(TestFixtures.bytes("strong.stratum")))
        assertEquals(StratumFormat.LEGACY, StratumImporter.detectFormat(TestFixtures.bytes("legacy.stratum")))
        assertEquals(StratumFormat.URI_LIST, StratumImporter.detectFormat(TestFixtures.bytes("uri-list.txt")))
        assertEquals(StratumFormat.HTML, StratumImporter.detectFormat(TestFixtures.bytes("html-export.html")))
        assertEquals(StratumFormat.UNKNOWN, StratumImporter.detectFormat(TestFixtures.bytes("unknown.bin")))
        assertEquals(StratumFormat.UNKNOWN, StratumImporter.detectFormat(ByteArray(0)))
    }

    @Test
    fun plainJsonImportMapsAccountsAndReportsSkips() {
        val result = StratumImporter.import(TestFixtures.bytes("plain-backup.json"), updatedAt = TestFixtures.FIXED_UPDATED_AT)

        assertEquals(StratumFormat.PLAIN_JSON, result.format)
        assertEquals(3, result.importedCount)
        assertEquals(5, result.skippedCount)

        // 排序：分类按 Category.Ranking（开发 0 → 社交 1 → 云服务 2），分类内按 binding Ranking。
        assertEquals(listOf("Google", "GitHub", "AWS"), result.accounts.map { it.issuer })

        val google = result.accounts[0]
        assertEquals("me@gmail.com", google.accountName)
        assertEquals("开发", google.category)
        assertEquals(TestFixtures.SHA256_SEED, google.secret)
        assertEquals("SHA256", google.algorithm)
        assertEquals(8, google.digits)
        assertEquals(60, google.period)
        assertEquals("s_c31b0534e1e4", google.id)
        assertEquals(TestFixtures.FIXED_UPDATED_AT, google.updatedAt)

        val github = result.accounts[1]
        assertEquals("dev@example.com", github.accountName)
        // GitHub 绑定了「开发」(Ranking 5/9) 与「社交」(Ranking 1)，取排名最靠前者。
        assertEquals("社交", github.category)
        assertEquals("SHA1", github.algorithm)
        assertEquals(6, github.digits)
        assertEquals(30, github.period)
        assertEquals("s_9bb1d7340577", github.id)

        val aws = result.accounts[2]
        assertEquals("root", aws.accountName)
        assertEquals("云服务", aws.category)
        assertEquals("SHA512", aws.algorithm)
        assertEquals(10, aws.digits)
        assertEquals(15, aws.period)
        assertEquals("s_537c9a35b939", aws.id)

        // Steam(Type=4) 已支持；该夹具中的 Steam 条目与 GitHub 共用同一条 secret，按主键判为重复。
        assertEquals(
            listOf(
                "TYPE_NOT_SUPPORTED",
                "DUPLICATE_SECRET",
                "INVALID_BASE32",
                "PERIOD_OUT_OF_RANGE",
                "EMPTY_ISSUER_AND_USERNAME",
            ),
            result.skipped.map { it.code },
        )
        assertEquals("LegacyHOTP", result.skipped[0].issuer)
        assertEquals("Steam", result.skipped[1].issuer)
        assertEquals("BadBase32", result.skipped[2].issuer)
        assertEquals("BadPeriod", result.skipped[3].issuer)
        assertTrue(result.skipped.all { it.reason.isNotBlank() })
    }

    @Test
    fun plainJsonImportKeepsIdsStableAcrossRuns() {
        val first = StratumImporter.import(TestFixtures.bytes("plain-backup.json"), updatedAt = 1L)
        val second = StratumImporter.import(TestFixtures.bytes("plain-backup.json"), updatedAt = 2L)
        assertEquals(first.accounts.map { it.id }, second.accounts.map { it.id })
        first.accounts.forEach { account ->
            assertEquals(account.id, Secret.accountIdForSecret(account.secret))
            assertTrue(account.id.matches(Regex("^s_[0-9a-f]{12}$")))
        }
    }

    @Test
    fun uriListImportMapsAccountsAndReportsHotp() {
        val result = StratumImporter.import(TestFixtures.bytes("uri-list.txt"), updatedAt = TestFixtures.FIXED_UPDATED_AT)

        assertEquals(StratumFormat.URI_LIST, result.format)
        assertEquals(3, result.importedCount)
        assertEquals(1, result.skippedCount)
        assertEquals(4, result.skipped.first().lineNumber)
        assertEquals("TYPE_NOT_TOTP", result.skipped.first().code)
        assertEquals(listOf("GitHub", "Google", "AWS"), result.accounts.map { it.issuer })
        assertEquals(DEFAULT_CATEGORY, result.accounts[0].category)
    }

    @Test
    fun htmlExportIsRejectedWithHelpfulMessage() {
        val error = assertThrows(StratumImportException::class.java) {
            StratumImporter.import(TestFixtures.bytes("html-export.html"))
        }
        assertEquals(StratumImporter.HTML_MESSAGE, error.message)
    }

    @Test
    fun unknownFormatIsRejected() {
        val error = assertThrows(StratumImportException::class.java) {
            StratumImporter.import(TestFixtures.bytes("unknown.bin"))
        }
        assertEquals(StratumImporter.UNKNOWN_MESSAGE, error.message)
    }

    @Test
    fun steamBackupType4ImportsAsSteamAccounts() {
        val result = StratumImporter.import(TestFixtures.bytes("steam-backup.json"), updatedAt = TestFixtures.FIXED_UPDATED_AT)

        assertEquals(StratumFormat.PLAIN_JSON, result.format)
        assertEquals(3, result.importedCount)
        assertEquals(0, result.skippedCount)
        assertEquals(listOf(true, false, true), result.accounts.map { it.isSteam })

        val steam = result.accounts.first { it.accountName == "alice" }
        assertEquals("Steam", steam.issuer)
        assertEquals("游戏", steam.category)
        assertEquals(OTP_TYPE_STEAM, steam.otpType)
        assertEquals(5, steam.digits)
        assertEquals(30, steam.period)
        assertEquals("SHA1", steam.algorithm)
        assertEquals(Secret.accountIdForSecret("OJZ2BP7STWSLUD7I23Q5AYZELZB5OAFU"), steam.id)
        // Steam 向量：T=59 → 3DP36；period 固定 30。
        assertEquals("3DP36", steam.currentCode(59_000L))

        // 备份里写的是 Digits=6 / Period=60 / Algorithm=1，Steam 导入必须强制 5/30/SHA1。
        val weird = result.accounts.first { it.accountName == "weird-fields" }
        assertEquals(OTP_TYPE_STEAM, weird.otpType)
        assertEquals(5, weird.digits)
        assertEquals(30, weird.period)
        assertEquals("SHA1", weird.algorithm)

        val github = result.accounts.first { it.issuer == "GitHub" }
        assertEquals(OTP_TYPE_TOTP, github.otpType)
        assertEquals(6, github.digits)
        assertEquals(30, github.period)
    }

    @Test
    fun steamUriListFormsAreDetected() {
        val result = StratumImporter.import(TestFixtures.bytes("steam-uri-list.txt"), updatedAt = TestFixtures.FIXED_UPDATED_AT)

        assertEquals(StratumFormat.URI_LIST, result.format)
        assertEquals(4, result.importedCount)
        assertEquals(0, result.skippedCount)
        // 前 3 行分别是 issuer 前缀 / 裸 &steam / encoder=steam；第 4 行是普通 TOTP。
        assertEquals(listOf(true, true, true, false), result.accounts.map { it.isSteam })
        result.accounts.filter { it.isSteam }.forEach { account ->
            assertEquals(5, account.digits)
            assertEquals(30, account.period)
            assertEquals("SHA1", account.algorithm)
        }
        assertEquals("3DP36", result.accounts.first().currentCode(59_000L))
        assertEquals(6, result.accounts.last().digits)
        assertEquals(OTP_TYPE_TOTP, result.accounts.last().otpType)
    }

    @Test
    fun detectsFormatFromTextWithBomAndLeadingWhitespace() {
        val json = "\uFEFF\n  " + TestFixtures.text("plain-backup.json").trim()
        assertEquals(StratumFormat.PLAIN_JSON, StratumImporter.detectFormat(json.toByteArray(Charsets.UTF_8)))
    }
}
