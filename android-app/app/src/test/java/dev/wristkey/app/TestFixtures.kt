package dev.wristkey.app

/** 测试夹具读取（app/src/test/resources/fixtures）。 */
object TestFixtures {
    const val PASSWORD = "test-password"
    const val FIXED_UPDATED_AT = 1760000000000L

    fun bytes(name: String): ByteArray {
        val stream = TestFixtures::class.java.getResourceAsStream("/fixtures/$name")
            ?: error("缺少测试夹具: $name")
        return stream.use { it.readBytes() }
    }

    fun text(name: String): String = String(bytes(name), Charsets.UTF_8)

    /** RFC 6238 / Stratum 夹具中的公开测试 secret（非真实账号）。 */
    const val SHA1_SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
    const val SHA256_SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA"
    const val SHA512_SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA"
}
