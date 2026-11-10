package dev.wristkey.app

import dev.wristkey.app.stratum.StratumFormat
import dev.wristkey.app.stratum.StratumImporter
import dev.wristkey.app.stratum.StratumImportException
import dev.wristkey.app.stratum.StratumPasswordException
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

        assertEquals(
            listOf(
                "TYPE_NOT_TOTP",
                "TYPE_NOT_TOTP",
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
    fun detectsFormatFromTextWithBomAndLeadingWhitespace() {
        val json = "\uFEFF\n  " + TestFixtures.text("plain-backup.json").trim()
        assertEquals(StratumFormat.PLAIN_JSON, StratumImporter.detectFormat(json.toByteArray(Charsets.UTF_8)))
    }
}
