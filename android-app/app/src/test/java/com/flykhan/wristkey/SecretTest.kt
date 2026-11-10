package com.flykhan.wristkey

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SecretTest {

    @Test
    fun normalizeStripsWhitespaceDashesAndPadding() {
        assertEquals("JBSWY3DPEHPK3PXP", Secret.normalize(" jbsw y3dp-ehpk3pxp= "))
        assertEquals("GEZDGNBVGY3TQOJQ", Secret.normalize("GEZD GNBV\nGY3TQOJQ"))
    }

    @Test
    fun base32Validation() {
        assertTrue(Secret.isNormalizedBase32("JBSWY3DPEHPK3PXP"))
        assertFalse(Secret.isNormalizedBase32(""))
        assertFalse(Secret.isNormalizedBase32("JBSWY3DPEHPK3PX0"))
        assertFalse(Secret.isNormalizedBase32("NOT-BASE32!"))
        assertFalse(Secret.isNormalizedBase32("jbswy3dpehpk3pxp"))
    }

    @Test
    fun stratumSecretValidationRequiresUppercaseButAllowsPadding() {
        assertTrue(Secret.isStratumSecret("JBSWY3DPEHPK3PXP"))
        assertTrue(Secret.isStratumSecret("GEZDGNBVGY3TQOJQGEZA===="))
        assertFalse(Secret.isStratumSecret("jbswy3dpehpk3pxp"))
        assertFalse(Secret.isStratumSecret("JBSW Y3DP EHPK 3PXP"))
        assertFalse(Secret.isStratumSecret(""))
    }

    @Test
    fun decodeBase32MatchesSeedLength() {
        assertEquals(20, Secret.decodeBase32(TestFixtures.SHA1_SEED).size)
        assertEquals(32, Secret.decodeBase32(TestFixtures.SHA256_SEED).size)
        assertEquals(64, Secret.decodeBase32(TestFixtures.SHA512_SEED).size)
        assertEquals("12345678901234567890", String(Secret.decodeBase32(TestFixtures.SHA1_SEED), Charsets.US_ASCII))
    }

    @Test
    fun accountIdIsDerivedFromNormalizedSecret() {
        // sha1("JBSWY3DPEHPK3PXP") = b57fa0798cf1...（公开测试值）
        assertEquals("s_b57fa0798cf1", Secret.accountIdForSecret("jbswy3dp ehpk3pxp"))
        assertEquals("s_9bb1d7340577", Secret.accountIdForSecret(TestFixtures.SHA1_SEED))
        assertEquals("s_c31b0534e1e4", Secret.accountIdForSecret(TestFixtures.SHA256_SEED))
        assertEquals("s_537c9a35b939", Secret.accountIdForSecret(TestFixtures.SHA512_SEED))
        assertEquals(14, Secret.accountIdForSecret(TestFixtures.SHA1_SEED).length)
    }

    @Test(expected = IllegalArgumentException::class)
    fun decodeRejectsInvalidSecret() {
        Secret.decodeBase32("NOT-BASE32!")
    }
}
