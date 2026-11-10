package dev.wristkey.app

import dev.wristkey.app.stratum.StratumFormat
import dev.wristkey.app.stratum.StratumImporter
import dev.wristkey.app.stratum.StratumPasswordException
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/** 用 Python 独立生成的 Strong/Legacy 夹具验证解密（密码 test-password）。 */
class StratumDecryptTest {

    @Test
    fun strongDecryptsToSameAccountsAsPlainJson() {
        val plain = StratumImporter.import(TestFixtures.bytes("plain-backup.json"), updatedAt = TestFixtures.FIXED_UPDATED_AT)
        val decrypted = StratumImporter.import(
            TestFixtures.bytes("strong.stratum"),
            TestFixtures.PASSWORD,
            updatedAt = TestFixtures.FIXED_UPDATED_AT,
        )

        assertEquals(StratumFormat.STRONG, decrypted.format)
        assertEquals(plain.accounts, decrypted.accounts)
        assertEquals(plain.skipped, decrypted.skipped)
    }

    @Test
    fun legacyDecryptsToSameAccountsAsPlainJson() {
        val plain = StratumImporter.import(TestFixtures.bytes("plain-backup.json"), updatedAt = TestFixtures.FIXED_UPDATED_AT)
        val decrypted = StratumImporter.import(
            TestFixtures.bytes("legacy.stratum"),
            TestFixtures.PASSWORD,
            updatedAt = TestFixtures.FIXED_UPDATED_AT,
        )

        assertEquals(StratumFormat.LEGACY, decrypted.format)
        assertEquals(plain.accounts, decrypted.accounts)
        assertEquals(plain.skipped, decrypted.skipped)
    }

    @Test
    fun strongDecryptBytesMatchPlainBackupText() {
        val plainBytes = StratumImporter.decryptStrong(TestFixtures.bytes("strong.stratum"), TestFixtures.PASSWORD)
        val expected = TestFixtures.bytes("plain-backup.json")
        assertArrayEquals(expected, plainBytes)
    }

    @Test
    fun legacyDecryptBytesMatchPlainBackupText() {
        val plainBytes = StratumImporter.decryptLegacy(TestFixtures.bytes("legacy.stratum"), TestFixtures.PASSWORD)
        val expected = TestFixtures.bytes("plain-backup.json")
        assertArrayEquals(expected, plainBytes)
    }

    @Test
    fun wrongPasswordOnStrongIsReportedUniformly() {
        val error = assertThrows(StratumPasswordException::class.java) {
            StratumImporter.import(TestFixtures.bytes("strong.stratum"), "wrong-password")
        }
        assertEquals(StratumImporter.PASSWORD_ERROR_MESSAGE, error.message)
        assertEquals("密码错误或文件损坏", error.message)
    }

    @Test
    fun wrongPasswordOnLegacyIsReportedUniformly() {
        val error = assertThrows(StratumPasswordException::class.java) {
            StratumImporter.import(TestFixtures.bytes("legacy.stratum"), "wrong-password")
        }
        assertEquals(StratumImporter.PASSWORD_ERROR_MESSAGE, error.message)
    }

    @Test
    fun encryptedWithoutPasswordIsReportedAsPasswordError() {
        assertThrows(StratumPasswordException::class.java) {
            StratumImporter.import(TestFixtures.bytes("strong.stratum"), null)
        }
        assertThrows(StratumPasswordException::class.java) {
            StratumImporter.import(TestFixtures.bytes("legacy.stratum"), null)
        }
    }

    @Test
    fun isEncryptedDetectsOnlyEncryptedFormats() {
        assertEquals(true, StratumImporter.isEncrypted(TestFixtures.bytes("strong.stratum")))
        assertEquals(true, StratumImporter.isEncrypted(TestFixtures.bytes("legacy.stratum")))
        assertEquals(false, StratumImporter.isEncrypted(TestFixtures.bytes("plain-backup.json")))
        assertEquals(false, StratumImporter.isEncrypted(TestFixtures.bytes("uri-list.txt")))
    }
}
