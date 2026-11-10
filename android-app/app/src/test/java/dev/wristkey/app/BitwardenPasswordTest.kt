package dev.wristkey.app

import dev.wristkey.app.stratum.StratumImporter
import org.junit.Assert.assertEquals
import org.junit.Test

/** v2.0：Bitwarden login.password 随导入进入账号（protocol v3 account.password）。 */
class BitwardenPasswordTest {

    @Test
    fun importsLoginPasswordsAndLeavesMissingOnesEmpty() {
        val result = StratumImporter.import(
            TestFixtures.bytes("bitwarden-export.json"),
            updatedAt = TestFixtures.FIXED_UPDATED_AT,
        )

        val byIssuer = result.accounts.associateBy { it.issuer }
        assertEquals("not-a-real-password", byIssuer.getValue("GitHub").password)
        assertEquals("not-a-real-password", byIssuer.getValue("Steam").password)
        assertEquals("", byIssuer.getValue("RawBase32").password)
        assertEquals("", byIssuer.getValue("LabelOnly").password)
        assertEquals(2, result.accounts.count { it.password.isNotEmpty() })
    }
}
