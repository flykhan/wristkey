package com.flykhan.wristkey

import com.flykhan.wristkey.pattern.PatternPin
import com.flykhan.wristkey.protocol.SyncProtocol
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** 协议 v3 入口图案消息（mfa_pin_set / clear / query / ack / state）。 */
class PinProtocolTest {

    private val now = 1_760_000_000_000L
    private val saltHex = "000102030405060708090a0b0c0d0e0f"
    private val hashHex = PatternPin.derive("TSCSC", saltHex)

    @Test
    fun pinSetCarriesDerivedPayloadOnly() {
        val message = SyncProtocol.buildPinSet(saltHex, hashHex, 1200, sentAt = now)
        val json = JSONObject(message)

        assertEquals(SyncProtocol.TYPE_PIN_SET, json.getString("type"))
        assertEquals(SyncProtocol.VERSION, json.getInt("version"))
        assertEquals(now, json.getLong("sentAt"))
        val pin = json.getJSONObject("pin")
        assertEquals("PBKDF2-SHA256", pin.getString("algorithm"))
        assertEquals(saltHex, pin.getString("salt"))
        assertEquals(hashHex, pin.getString("hash"))
        assertEquals(1200, pin.getInt("iterations"))
        // 消息里绝不能出现图案明文。
        assertFalse(message.contains("TSCSC"))
        assertTrue(SyncProtocol.messageBytes(message) <= SyncProtocol.MAX_MESSAGE_BYTES)
    }

    @Test
    fun pinSetRejectsInvalidPayloads() {
        assertThrows(IllegalArgumentException::class.java) {
            SyncProtocol.buildPinSet("bad-salt", hashHex, 1200, sentAt = now)
        }
        assertThrows(IllegalArgumentException::class.java) {
            SyncProtocol.buildPinSet(saltHex, "bad-hash", 1200, sentAt = now)
        }
        assertThrows(IllegalArgumentException::class.java) {
            SyncProtocol.buildPinSet(saltHex, hashHex, 999, sentAt = now)
        }
    }

    @Test
    fun pinClearAndQueryHaveNoPinPayload() {
        val clear = JSONObject(SyncProtocol.buildPinClear(sentAt = now))
        assertEquals(SyncProtocol.TYPE_PIN_CLEAR, clear.getString("type"))
        assertEquals(SyncProtocol.VERSION, clear.getInt("version"))
        assertFalse(clear.has("pin"))

        val query = JSONObject(SyncProtocol.buildPinQuery("pin-abc", sentAt = now))
        assertEquals(SyncProtocol.TYPE_PIN_QUERY, query.getString("type"))
        assertEquals("pin-abc", query.getString("requestId"))

        val defaultQuery = JSONObject(SyncProtocol.buildPinQuery(sentAt = now))
        assertEquals("pin-$now", defaultQuery.getString("requestId"))
    }

    @Test
    fun parsesPinAckV3() {
        val raw = """{"type":"mfa_pin_ack","version":3,"sentAt":$now,"ok":true,"enabled":true}"""
        val incoming = SyncProtocol.parseIncoming(raw)
        assertTrue(incoming is SyncProtocol.Incoming.PinAck)
        val ack = (incoming as SyncProtocol.Incoming.PinAck).info
        assertTrue(ack.ok)
        assertEquals(true, ack.enabled)
        assertNull(ack.error)
    }

    @Test
    fun parsesFailedPinAckWithReason() {
        val raw = """{"type":"mfa_pin_ack","version":3,"sentAt":$now,"ok":false,"error":"invalid_pin_payload"}"""
        val info = (SyncProtocol.parseIncoming(raw) as SyncProtocol.Incoming.PinAck).info
        assertFalse(info.ok)
        assertEquals("invalid_pin_payload", info.error)
    }

    @Test
    fun parsesPinStateBroadcastAndReply() {
        val broadcast = """{"type":"mfa_pin_state","version":3,"sentAt":$now,"enabled":true,"updatedAt":$now}"""
        val info = (SyncProtocol.parseIncoming(broadcast) as SyncProtocol.Incoming.PinState).info
        assertTrue(info.enabled)
        assertEquals(now, info.updatedAt)
        assertNull(info.requestId)

        val reply = """{"type":"mfa_pin_state","version":3,"sentAt":$now,"enabled":false,"requestId":"pin-$now"}"""
        val replyInfo = (SyncProtocol.parseIncoming(reply) as SyncProtocol.Incoming.PinState).info
        assertFalse(replyInfo.enabled)
        assertEquals("pin-$now", replyInfo.requestId)
    }

    @Test
    fun pinMessagesRequireVersionThree() {
        val v2Ack = """{"type":"mfa_pin_ack","version":2,"sentAt":$now,"ok":true}"""
        assertTrue(SyncProtocol.parseIncoming(v2Ack) is SyncProtocol.Incoming.Ignored)
        val v2State = """{"type":"mfa_pin_state","version":2,"sentAt":$now,"enabled":true}"""
        assertTrue(SyncProtocol.parseIncoming(v2State) is SyncProtocol.Incoming.Ignored)
    }

    @Test
    fun v2AckStillAcceptedForCompatibility() {
        val raw = """{"type":"mfa_sync_ack","version":2,"sentAt":$now,"syncId":"sync-1","ok":true,"received":1,"committed":1}"""
        val incoming = SyncProtocol.parseIncoming(raw)
        assertTrue(incoming is SyncProtocol.Incoming.Ack)
        assertEquals(1, (incoming as SyncProtocol.Incoming.Ack).ack.committed)
    }
}
