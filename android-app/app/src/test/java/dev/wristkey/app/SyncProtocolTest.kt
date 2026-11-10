package dev.wristkey.app

import dev.wristkey.app.protocol.SyncProtocol
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Random

class SyncProtocolTest {

    private val now = 1_760_000_000_000L

    private val accounts = listOf(
        WristKeyAccount(
            id = "s_9bb1d7340577",
            issuer = "GitHub",
            accountName = "dev@example.com",
            category = "开发",
            secret = TestFixtures.SHA1_SEED,
            algorithm = "SHA1",
            digits = 6,
            period = 30,
            updatedAt = now,
        ),
        WristKeyAccount(
            id = "s_c31b0534e1e4",
            issuer = "Google",
            accountName = "me@gmail.com",
            category = "默认分类",
            secret = TestFixtures.SHA256_SEED,
            algorithm = "SHA256",
            digits = 8,
            period = 60,
            updatedAt = now,
        ),
    )

    @Test
    fun sessionStartsWithBeginThenAccountsThenCommit() {
        val session = SyncProtocol.buildSession(accounts, sentAt = now, syncId = "sync-$now-7f3a")
        assertEquals(4, session.messages.size)
        assertEquals(2, session.accountCount)
        assertEquals("sync-$now-7f3a", session.syncId)

        val begin = JSONObject(session.messages.first())
        assertEquals(SyncProtocol.TYPE_BEGIN, begin.getString("type"))
        assertEquals(2, begin.getInt("version"))
        assertEquals(now, begin.getLong("sentAt"))
        assertEquals("sync-$now-7f3a", begin.getString("syncId"))
        assertEquals(2, begin.getInt("accountCount"))

        val firstAccount = JSONObject(session.messages[1])
        assertEquals(SyncProtocol.TYPE_ACCOUNT, firstAccount.getString("type"))
        assertEquals(2, firstAccount.getInt("version"))
        assertEquals(now + 1, firstAccount.getLong("sentAt"))
        assertEquals("sync-$now-7f3a", firstAccount.getString("syncId"))
        assertEquals(0, firstAccount.getInt("index"))
        val payload = firstAccount.getJSONObject("account")
        assertEquals("s_9bb1d7340577", payload.getString("id"))
        assertEquals("GitHub", payload.getString("issuer"))
        assertEquals("dev@example.com", payload.getString("accountName"))
        assertEquals("开发", payload.getString("category"))
        assertEquals(TestFixtures.SHA1_SEED, payload.getString("secret"))
        assertEquals("SHA1", payload.getString("algorithm"))
        assertEquals(6, payload.getInt("digits"))
        assertEquals(30, payload.getInt("period"))
        assertEquals(now, payload.getLong("updatedAt"))
        assertNull(SyncProtocol.validateAccountPayload(payload, 0))

        val secondAccount = JSONObject(session.messages[2])
        assertEquals(1, secondAccount.getInt("index"))
        assertEquals(now + 2, secondAccount.getLong("sentAt"))
        assertEquals("SHA256", secondAccount.getJSONObject("account").getString("algorithm"))

        val commit = JSONObject(session.messages.last())
        assertEquals(SyncProtocol.TYPE_COMMIT, commit.getString("type"))
        assertEquals(2, commit.getInt("version"))
        assertEquals(now + 3, commit.getLong("sentAt"))
        assertEquals("sync-$now-7f3a", commit.getString("syncId"))
        assertEquals(2, commit.getInt("accountCount"))
    }

    @Test
    fun emptyAccountListStillProducesBeginAndCommit() {
        val session = SyncProtocol.buildSession(emptyList(), sentAt = now, syncId = "sync-empty")
        assertEquals(2, session.messages.size)
        assertEquals(0, session.accountCount)
        assertEquals(0, JSONObject(session.messages[0]).getInt("accountCount"))
        assertEquals(0, JSONObject(session.messages[1]).getInt("accountCount"))
    }

    @Test
    fun newSyncIdMatchesDocumentedShape() {
        val syncId = SyncProtocol.newSyncId(now, Random(42))
        assertTrue(syncId.matches(Regex("^sync-$now-[0-9a-f]{4}$")))
        assertEquals("sync-$now-" + String.format("%04x", Random(42).nextInt(0x10000)), syncId)
    }

    @Test
    fun everyMessageStaysUnderSizeLimitWithMaxLengthFields() {
        val worstCase = WristKeyAccount(
            id = "s_9bb1d7340577",
            issuer = "I".repeat(64),
            accountName = "A".repeat(64),
            category = "C".repeat(32),
            secret = TestFixtures.SHA512_SEED,
            algorithm = "SHA512",
            digits = 10,
            period = 300,
            updatedAt = now,
        )
        val session = SyncProtocol.buildSession(listOf(worstCase), sentAt = now, syncId = SyncProtocol.newSyncId(now))
        session.messages.forEach { message ->
            assertTrue(
                "消息大小 ${SyncProtocol.messageBytes(message)} 超过限制",
                SyncProtocol.isWithinSizeLimit(message),
            )
            JSONObject(message)
        }
    }

    @Test
    fun encodeAccountTruncatesProtocolFieldLimits() {
        val account = WristKeyAccount(
            id = "s_9bb1d7340577",
            issuer = "I".repeat(100),
            accountName = "A".repeat(100),
            category = "C".repeat(100),
            secret = TestFixtures.SHA1_SEED,
        )
        val json = SyncProtocol.encodeAccount(account)
        assertEquals(64, json.getString("issuer").length)
        assertEquals(64, json.getString("accountName").length)
        assertEquals(32, json.getString("category").length)
        assertNull(SyncProtocol.validateAccountPayload(json, 0))
    }

    @Test
    fun parsesSuccessfulAndFailedAcks() {
        val ok = SyncProtocol.parseIncoming(
            """{"type":"mfa_sync_ack","version":2,"sentAt":$now,"syncId":"sync-1","ok":true,"received":2,"committed":2,"error":null}""",
        )
        assertTrue(ok is SyncProtocol.Incoming.Ack)
        val ack = (ok as SyncProtocol.Incoming.Ack).ack
        assertEquals("sync-1", ack.syncId)
        assertEquals(true, ack.ok)
        assertEquals(2, ack.received)
        assertEquals(2, ack.committed)
        assertNull(ack.error)

        val failed = SyncProtocol.parseIncoming(
            """{"type":"mfa_sync_ack","version":2,"sentAt":$now,"syncId":"sync-1","ok":false,"received":1,"committed":0,"error":"条数不匹配"}""",
        )
        val failedAck = (failed as SyncProtocol.Incoming.Ack).ack
        assertEquals(false, failedAck.ok)
        assertEquals("条数不匹配", failedAck.error)
    }

    @Test
    fun ignoresMalformedOrUnknownInboundMessages() {
        val cases = listOf(
            "not json",
            """{"type":"mfa_sync_ack","version":1,"sentAt":1,"syncId":"s","ok":true,"received":0,"committed":0}""",
            """{"type":"mfa_sync_ack","version":2,"sentAt":1,"syncId":"s","ok":"yes","received":0,"committed":0}""",
            """{"type":"mfa_sync_ack","version":2,"sentAt":1,"syncId":"s","ok":false,"received":0,"committed":0}""",
            """{"type":"mfa_sync_account","version":2,"sentAt":1,"syncId":"s","index":0,"account":{}}""",
            """{"type":"mfa_sync_ack","version":2,"sentAt":1,"syncId":"","ok":true,"received":0,"committed":0}""",
        )
        cases.forEach { raw ->
            assertTrue("$raw 应被忽略", SyncProtocol.parseIncoming(raw) is SyncProtocol.Incoming.Ignored)
        }
    }

    @Test
    fun parsesSyncRequest() {
        val parsed = SyncProtocol.parseIncoming(
            """{"type":"mfa_sync_request","version":2,"sentAt":$now,"requestId":"req-1"}""",
        )
        assertTrue(parsed is SyncProtocol.Incoming.Request)
        assertEquals("req-1", (parsed as SyncProtocol.Incoming.Request).request.requestId)
    }

    @Test
    fun accountValidationCatchesProtocolViolations() {
        fun payload(vararg pairs: Pair<String, Any?>): JSONObject {
            val json = JSONObject()
            pairs.forEach { (key, value) -> json.put(key, value) }
            return json
        }
        val base = mapOf(
            "issuer" to "GitHub",
            "accountName" to "dev@example.com",
            "secret" to TestFixtures.SHA1_SEED,
            "algorithm" to "SHA1",
            "digits" to 6,
            "period" to 30,
        )
        assertNull(SyncProtocol.validateAccountPayload(payload(*base.toList().toTypedArray()), 0))
        assertTrue(SyncProtocol.validateAccountPayload(payload("issuer" to "", "accountName" to "", "secret" to TestFixtures.SHA1_SEED), 0) != null)
        assertTrue(SyncProtocol.validateAccountPayload(payload("issuer" to "A", "secret" to "0189"), 0) != null)
        assertTrue(SyncProtocol.validateAccountPayload(payload("issuer" to "A", "secret" to TestFixtures.SHA1_SEED, "digits" to 11), 0) != null)
        assertTrue(SyncProtocol.validateAccountPayload(payload("issuer" to "A", "secret" to TestFixtures.SHA1_SEED, "period" to 4), 0) != null)
        assertTrue(SyncProtocol.validateAccountPayload(payload("issuer" to "A", "secret" to TestFixtures.SHA1_SEED, "algorithm" to "MD5"), 0) != null)
        assertTrue(SyncProtocol.validateAccountPayload(payload("issuer" to "A", "secret" to TestFixtures.SHA1_SEED, "id" to "x".repeat(65)), 0) != null)
    }
}
