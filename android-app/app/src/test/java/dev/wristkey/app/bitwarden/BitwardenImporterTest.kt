package dev.wristkey.app.bitwarden

import dev.wristkey.app.OTP_TYPE_STEAM
import dev.wristkey.app.OTP_TYPE_TOTP
import dev.wristkey.app.Secret
import dev.wristkey.app.TestFixtures
import dev.wristkey.app.stratum.AccountMerge
import dev.wristkey.app.stratum.ImportMode
import dev.wristkey.app.stratum.StratumFormat
import dev.wristkey.app.stratum.StratumImportException
import dev.wristkey.app.stratum.StratumImporter
import dev.wristkey.app.stratum.StratumPasswordException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** Bitwarden 未加密 Vault JSON 导出导入（夹具 bitwarden-export.json / bitwarden-encrypted.json）。 */
class BitwardenImporterTest {

    private fun importFixture() = StratumImporter.import(
        TestFixtures.bytes("bitwarden-export.json"),
        updatedAt = TestFixtures.FIXED_UPDATED_AT,
    )

    @Test
    fun detectsBitwardenFormatsAndDistinguishesOtherBackups() {
        assertEquals(
            StratumFormat.BITWARDEN,
            StratumImporter.detectFormat(TestFixtures.bytes("bitwarden-export.json")),
        )
        assertEquals(
            StratumFormat.BITWARDEN_ENCRYPTED,
            StratumImporter.detectFormat(TestFixtures.bytes("bitwarden-encrypted.json")),
        )
        // 原有 Stratum 明文备份仍按 Authenticators 识别。
        assertEquals(
            StratumFormat.PLAIN_JSON,
            StratumImporter.detectFormat(TestFixtures.bytes("plain-backup.json")),
        )
        // Aegis 的 entries 不应被当作 Bitwarden。
        assertEquals(
            StratumFormat.UNKNOWN,
            StratumImporter.detectFormat("""{"version":1,"entries":[]}""".toByteArray(Charsets.UTF_8)),
        )
    }

    @Test
    fun importsItemsAndReportsSkips() {
        val result = importFixture()

        assertEquals(StratumFormat.BITWARDEN, result.format)
        assertEquals(5, result.importedCount)
        assertEquals(5, result.skippedCount)

        assertEquals(
            listOf("GitHub", "Steam", "RawBase32", "LabelOnly", "Bitwarden"),
            result.accounts.map { it.issuer },
        )
        assertEquals(
            listOf("dev@example.com", "alice", "bob", "labelacct", ""),
            result.accounts.map { it.accountName },
        )
        assertTrue(result.accounts.all { it.category == "默认分类" })

        assertEquals(
            listOf("NO_TOTP", "INVALID_BASE32", "TYPE_NOT_TOTP", "NO_TOTP", "DUPLICATE_SECRET"),
            result.skipped.map { it.code },
        )
        assertEquals(
            listOf("NoTotp", "BadSecret", "BadUri", "NoLogin", "Duplicate"),
            result.skipped.map { it.issuer },
        )
        assertTrue(result.skipped.all { it.reason.isNotBlank() })
    }

    @Test
    fun mapsBitwardenFieldsPerRules() {
        val result = importFixture()
        val github = result.accounts.first { it.issuer == "GitHub" }

        // issuer 来自 item.name（不是 otpauth 的 issuer 参数），accountName 来自 login.username。
        assertEquals("dev@example.com", github.accountName)
        assertEquals("默认分类", github.category)
        assertEquals(TestFixtures.SHA1_SEED, github.secret)
        assertEquals("SHA1", github.algorithm)
        assertEquals(6, github.digits)
        assertEquals(30, github.period)
        assertEquals(OTP_TYPE_TOTP, github.otpType)
        assertEquals(Secret.accountIdForSecret(TestFixtures.SHA1_SEED), github.id)
        assertEquals(TestFixtures.FIXED_UPDATED_AT, github.updatedAt)

        val raw = result.accounts.first { it.issuer == "RawBase32" }
        assertEquals("JBSWY3DPEHPK3PXP", raw.secret)
        assertEquals("SHA1", raw.algorithm)
        assertEquals(6, raw.digits)
        assertEquals(30, raw.period)
        assertEquals(OTP_TYPE_TOTP, raw.otpType)

        // username 为空 → 回退到 otpauth label 的账号；其余字段沿用 otpauth。
        val labelOnly = result.accounts.first { it.issuer == "LabelOnly" }
        assertEquals("labelacct", labelOnly.accountName)
        assertEquals("SHA256", labelOnly.algorithm)
        assertEquals(8, labelOnly.digits)
        assertEquals(60, labelOnly.period)

        // item.name 为空 → issuer 回退 "Bitwarden"；username 为空且非 URI → accountName 为空。
        val fallback = result.accounts.first { it.issuer == "Bitwarden" }
        assertEquals("", fallback.accountName)
        assertEquals(OTP_TYPE_TOTP, fallback.otpType)
    }

    @Test
    fun steamTotpInBitwardenUsesSteamDetection() {
        val steam = importFixture().accounts.first { it.issuer == "Steam" }

        assertEquals(OTP_TYPE_STEAM, steam.otpType)
        assertEquals(5, steam.digits)
        assertEquals(30, steam.period)
        assertEquals("SHA1", steam.algorithm)
        assertEquals("alice", steam.accountName)
        // Steam 向量：T=59 → 3DP36。
        assertEquals("3DP36", steam.currentCode(59_000L))
    }

    @Test
    fun encryptedExportGivesExplicitMessageAndIsNotPasswordError() {
        val error = assertThrows(StratumImportException::class.java) {
            StratumImporter.import(TestFixtures.bytes("bitwarden-encrypted.json"))
        }
        assertEquals("Bitwarden 加密导出暂不支持，请导出未加密 JSON", error.message)
        assertEquals(BitwardenImporter.ENCRYPTED_MESSAGE, error.message)
        assertTrue("加密导出不应提示密码错误", error !is StratumPasswordException)
    }

    @Test
    fun bitwardenImportMergesBySecretOverwritingExisting() {
        val existing = importFixture().accounts.filter { it.issuer == "GitHub" }
            .map { it.copy(algorithm = "SHA256", digits = 8, period = 60) }
        val imported = importFixture().accounts.filter { it.issuer == "GitHub" }

        val summary = AccountMerge.merge(existing, imported, ImportMode.MERGE)

        assertEquals(1, summary.accounts.size)
        assertEquals(1, summary.updated.size)
        assertEquals(0, summary.added.size)
        assertEquals("SHA1", summary.accounts.single().algorithm)
        assertEquals(6, summary.accounts.single().digits)
    }
}
