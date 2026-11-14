package com.flykhan.wristkey.pattern

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.SecureRandom

/**
 * 入口图案派生（docs/protocol.md v3 mfa_pin_set）单元测试。
 *
 * 固定向量由 Node crypto.pbkdf2Sync("TSCSC", 16 字节盐, 10, 32, "sha256") 生成，
 * 与本实现的 PBKDF2WithHmacSHA256 结果一致；Android 侧同一规范串必须得到同一 hash。
 */
class PatternPinTest {

    private val saltHex = "000102030405060708090a0b0c0d0e0f"
    private val expectedHash = "08c17173f5834afbde11e3cae68ab75a4f7b2c244ea90926c3a62a3c5566d4a6"

    @Test
    fun derivesKnownPbkdf2Sha256Vector() {
        assertEquals(expectedHash, PatternPin.derive("TSCSC", saltHex, 10))
    }

    @Test
    fun defaultIterationsMatchProtocol() {
        assertEquals(10, PatternPin.ITERATIONS)
        assertEquals(expectedHash, PatternPin.derive("TSCSC", saltHex))
    }

    @Test
    fun differentPatternsProduceDifferentHashes() {
        val first = PatternPin.derive("TSCSC", saltHex)
        val second = PatternPin.derive("TTTTT", saltHex)
        val third = PatternPin.derive("TSCSC", "f0e0d0c0b0a090807060504030201000")
        assertNotEquals(first, second)
        assertNotEquals(first, third)
        assertEquals(PatternPin.HASH_HEX_LENGTH, first.length)
        assertTrue(PatternPin.isValidHashHex(first))
    }

    @Test
    fun validatesPatternStrings() {
        assertTrue(PatternPin.isValidPattern("TSCSC"))
        assertTrue(PatternPin.isValidPattern("TTTTT"))
        assertFalse(PatternPin.isValidPattern("tscsc"))
        assertFalse(PatternPin.isValidPattern("TSCS"))
        assertFalse(PatternPin.isValidPattern("TSCSCC"))
        assertFalse(PatternPin.isValidPattern("TSCSX"))
        assertFalse(PatternPin.isValidPattern(""))
        assertTrue(PatternPin.SHAPES.all { PatternPin.isValidPattern(it + it + it + it + it) })
    }

    @Test
    fun validatesSaltAndHashHex() {
        assertTrue(PatternPin.isValidSaltHex(saltHex))
        assertTrue(PatternPin.isValidSaltHex(PatternPin.newSaltHex()))
        assertFalse(PatternPin.isValidSaltHex(saltHex.uppercase()))
        assertFalse(PatternPin.isValidSaltHex(saltHex.dropLast(1)))
        assertTrue(PatternPin.isValidHashHex(expectedHash))
        assertFalse(PatternPin.isValidHashHex(expectedHash.dropLast(2)))
        assertFalse(PatternPin.isValidHashHex("not-hex"))
    }

    @Test
    fun generatesRandomSixteenByteSalts() {
        val random = SecureRandom()
        val first = PatternPin.newSaltHex(random)
        val second = PatternPin.newSaltHex(random)
        assertEquals(PatternPin.SALT_HEX_LENGTH, first.length)
        assertEquals(16, PatternPin.fromHex(first).size)
        assertNotEquals(first, second)
    }

    @Test
    fun rejectsUnsupportedArguments() {
        assertThrows(IllegalArgumentException::class.java) {
            PatternPin.derive("tscsc", saltHex)
        }
        assertThrows(IllegalArgumentException::class.java) {
            PatternPin.derive("TSCSC", "zz")
        }
        assertThrows(IllegalArgumentException::class.java) {
            PatternPin.derive("TSCSC", saltHex, 0)
        }
        assertThrows(IllegalArgumentException::class.java) {
            PatternPin.derive("TSCSC", saltHex, 20_001)
        }
        assertFalse(PatternPin.isSupportedIterations(0))
        assertFalse(PatternPin.isSupportedIterations(20_001))
        assertTrue(PatternPin.isSupportedIterations(1))
        assertTrue(PatternPin.isSupportedIterations(20_000))
    }

    @Test
    fun hexRoundTripIsStable() {
        val bytes = ByteArray(16) { index -> (index * 17).toByte() }
        val hex = PatternPin.toHex(bytes)
        assertEquals(32, hex.length)
        assertTrue(hex.all { it in '0'..'9' || it in 'a'..'f' })
        assertEquals(bytes.toList(), PatternPin.fromHex(hex).toList())
    }
}
