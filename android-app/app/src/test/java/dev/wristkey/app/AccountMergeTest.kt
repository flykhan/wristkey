package dev.wristkey.app

import dev.wristkey.app.stratum.AccountMerge
import dev.wristkey.app.stratum.ImportMode
import dev.wristkey.app.stratum.StratumSkip
import org.junit.Assert.assertEquals
import org.junit.Test

class AccountMergeTest {

    private fun account(secret: String, issuer: String, updatedAt: Long = 1L): WristKeyAccount = WristKeyAccount(
        id = Secret.accountIdForSecret(secret),
        issuer = issuer,
        accountName = "user",
        secret = secret,
        updatedAt = updatedAt,
    )

    @Test
    fun mergeOverwritesSameSecretAndKeepsOthers() {
        val existing = listOf(
            account(TestFixtures.SHA1_SEED, "GitHub"),
            account(TestFixtures.SHA256_SEED, "Google"),
        )
        val imported = listOf(
            account(TestFixtures.SHA1_SEED, "GitHub 新", updatedAt = 9L),
            account(TestFixtures.SHA512_SEED, "AWS"),
        )
        val summary = AccountMerge.merge(existing, imported, ImportMode.MERGE)

        assertEquals(ImportMode.MERGE, summary.mode)
        assertEquals(3, summary.accounts.size)
        assertEquals(listOf("GitHub 新", "AWS", "Google"), summary.accounts.map { it.issuer })
        assertEquals(1, summary.added.size)
        assertEquals("AWS", summary.added.single().issuer)
        assertEquals(1, summary.updated.size)
        assertEquals("GitHub 新", summary.updated.single().issuer)
        assertEquals(9L, summary.accounts.first().updatedAt)
    }

    @Test
    fun replaceDiscardsExistingAccounts() {
        val existing = listOf(
            account(TestFixtures.SHA1_SEED, "GitHub"),
            account(TestFixtures.SHA256_SEED, "Google"),
        )
        val imported = listOf(
            account(TestFixtures.SHA1_SEED, "GitHub 新", updatedAt = 9L),
            account(TestFixtures.SHA512_SEED, "AWS"),
        )
        val summary = AccountMerge.merge(existing, imported, ImportMode.REPLACE)

        assertEquals(ImportMode.REPLACE, summary.mode)
        assertEquals(2, summary.accounts.size)
        assertEquals(listOf("GitHub 新", "AWS"), summary.accounts.map { it.issuer })
        assertEquals(1, summary.added.size)
        assertEquals(1, summary.updated.size)
    }

    @Test
    fun duplicateSecretsInsideImportAreDeduplicated() {
        val imported = listOf(
            account(TestFixtures.SHA1_SEED, "GitHub"),
            account(TestFixtures.SHA1_SEED, "GitHub duplicate"),
        )
        val summary = AccountMerge.merge(emptyList(), imported, ImportMode.MERGE)
        assertEquals(1, summary.accounts.size)
        assertEquals(1, summary.added.size)
    }

    @Test
    fun mergeCorrectsMisimportedTotpIntoSteamBySecret() {
        val secret = "OJZ2BP7STWSLUD7I23Q5AYZELZB5OAFU"
        val misimported = WristKeyAccount(
            id = Secret.accountIdForSecret(secret),
            issuer = "Steam",
            accountName = "alice",
            secret = secret,
            digits = 6,
            period = 30,
            algorithm = "SHA1",
            updatedAt = 1L,
            otpType = OTP_TYPE_TOTP,
        )
        val steam = misimported.copy(digits = 5, updatedAt = 9L, otpType = OTP_TYPE_STEAM)

        val summary = AccountMerge.merge(listOf(misimported), listOf(steam), ImportMode.MERGE)

        assertEquals(1, summary.accounts.size)
        assertEquals(1, summary.updated.size)
        assertEquals(0, summary.added.size)
        assertEquals(OTP_TYPE_STEAM, summary.accounts.single().otpType)
        assertEquals(5, summary.accounts.single().digits)
        assertEquals(9L, summary.accounts.single().updatedAt)
    }

    @Test
    fun skippedItemsAreCarriedIntoSummary() {
        val skipped = listOf(StratumSkip("HOTP", "u1", "TYPE_NOT_TOTP", "Type=1 不是 TOTP（2）"))
        val summary = AccountMerge.merge(
            existing = emptyList(),
            imported = listOf(account(TestFixtures.SHA1_SEED, "GitHub")),
            mode = ImportMode.REPLACE,
            skipped = skipped,
            errors = listOf("某个错误"),
        )
        assertEquals(1, summary.skipped.size)
        assertEquals(1, summary.errors.size)
    }
}
