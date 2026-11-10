package dev.wristkey.app

import dev.wristkey.app.stratum.AccountMerge
import dev.wristkey.app.stratum.ImportMode
import org.junit.Assert.assertEquals
import org.junit.Test

/** 合并规则：同 id/secret 的导入项覆盖字段，但导入项无密码时保留旧密码（Stratum 不携带密码）。 */
class MergePasswordTest {

    private fun account(
        secret: String,
        issuer: String,
        password: String = "",
        updatedAt: Long = 1L,
    ): WristKeyAccount = WristKeyAccount(
        id = Secret.accountIdForSecret(secret),
        issuer = issuer,
        accountName = "user",
        secret = secret,
        updatedAt = updatedAt,
        password = password,
    )

    @Test
    fun stratumImportWithoutPasswordKeepsExistingPasswordInMergeMode() {
        val existing = listOf(account(TestFixtures.SHA1_SEED, "GitHub", password = "old-secret"))
        val imported = listOf(account(TestFixtures.SHA1_SEED, "GitHub 新", password = "", updatedAt = 9L))

        val summary = AccountMerge.merge(existing, imported, ImportMode.MERGE)

        assertEquals(1, summary.accounts.size)
        assertEquals("GitHub 新", summary.accounts.single().issuer)
        assertEquals("old-secret", summary.accounts.single().password)
        assertEquals(1, summary.updated.size)
        assertEquals(0, summary.added.size)
    }

    @Test
    fun stratumImportWithoutPasswordKeepsExistingPasswordInReplaceMode() {
        val existing = listOf(account(TestFixtures.SHA1_SEED, "GitHub", password = "old-secret"))
        val imported = listOf(account(TestFixtures.SHA1_SEED, "GitHub 新", password = ""))

        val summary = AccountMerge.merge(existing, imported, ImportMode.REPLACE)

        assertEquals(1, summary.accounts.size)
        assertEquals("old-secret", summary.accounts.single().password)
    }

    @Test
    fun importedPasswordOverridesExistingPassword() {
        val existing = listOf(account(TestFixtures.SHA1_SEED, "GitHub", password = "old-secret"))
        val imported = listOf(account(TestFixtures.SHA1_SEED, "GitHub", password = "imported"))
        val summary = AccountMerge.merge(existing, imported, ImportMode.MERGE)
        assertEquals("imported", summary.accounts.single().password)
    }

    @Test
    fun newImportedAccountKeepsEmptyPassword() {
        val summary = AccountMerge.merge(
            existing = listOf(account(TestFixtures.SHA256_SEED, "Google", password = "g")),
            imported = listOf(account(TestFixtures.SHA1_SEED, "GitHub")),
            mode = ImportMode.MERGE,
        )
        val added = summary.accounts.first { it.issuer == "GitHub" }
        assertEquals(1, summary.added.size)
        assertEquals("GitHub", added.issuer)
        assertEquals("", added.password)
    }

    @Test
    fun duplicateImportedSecretsKeepFirstPassword() {
        val imported = listOf(
            account(TestFixtures.SHA1_SEED, "GitHub", password = "first"),
            account(TestFixtures.SHA1_SEED, "GitHub duplicate", password = "second"),
        )
        val summary = AccountMerge.merge(emptyList(), imported, ImportMode.MERGE)
        assertEquals(1, summary.accounts.size)
        assertEquals("first", summary.accounts.single().password)
    }
}
