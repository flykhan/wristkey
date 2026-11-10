package dev.wristkey.app.protocol

import dev.wristkey.app.Secret
import dev.wristkey.app.WristKeyAccount
import org.json.JSONObject
import java.util.Locale
import java.util.Random

/**
 * 同步协议 v2（docs/protocol.md）的消息构造与手机端入站解析。
 *
 * 纯 JVM 实现（只依赖 org.json），可在单元测试中直接验证；Android 侧只负责
 * 把 [SyncSession.messages] 逐条经 xms `sendMessage(nodeId, bytes)` 发出。
 */
object SyncProtocol {

    const val VERSION = 2

    const val TYPE_BEGIN = "mfa_sync_begin"
    const val TYPE_ACCOUNT = "mfa_sync_account"
    const val TYPE_COMMIT = "mfa_sync_commit"
    const val TYPE_ACK = "mfa_sync_ack"
    const val TYPE_REQUEST = "mfa_sync_request"

    /** 单条消息上限（字节，不含末尾）；设计目标见 docs/protocol.md。 */
    const val MAX_MESSAGE_BYTES = 1024

    const val MAX_ID_LENGTH = 64
    const val MAX_NAME_LENGTH = 64
    const val MAX_CATEGORY_LENGTH = 32
    const val MAX_SYNC_ID_LENGTH = 128

    data class SyncSession(
        val syncId: String,
        val messages: List<String>,
    ) {
        val accountCount: Int
            get() = (messages.size - 2).coerceAtLeast(0)
    }

    data class Ack(
        val syncId: String,
        val ok: Boolean,
        val received: Int,
        val committed: Int,
        val error: String?,
    )

    data class SyncRequest(val requestId: String)

    sealed interface Incoming {
        data class Ack(val ack: SyncProtocol.Ack) : Incoming

        data class Request(val request: SyncProtocol.SyncRequest) : Incoming

        /** 无法解析 / 版本不符 / 未知 type：按协议忽略（记录日志即可）。 */
        data class Ignored(val reason: String) : Incoming
    }

    /** `sync-<sentAt>-<4 位十六进制随机>`；同一轮同步的后续消息必须复用同一值。 */
    fun newSyncId(sentAt: Long, random: Random = Random()): String =
        "sync-$sentAt-" + String.format(Locale.US, "%04x", random.nextInt(0x10000))

    /** 生成 begin → account×N → commit 的完整消息序列（每条均已序列化为 UTF-8 JSON 字符串）。 */
    fun buildSession(
        accounts: List<WristKeyAccount>,
        sentAt: Long = System.currentTimeMillis(),
        syncId: String = newSyncId(sentAt),
    ): SyncSession {
        val messages = ArrayList<String>(accounts.size + 2)
        messages += beginJson(syncId, accounts.size, sentAt).toString()
        accounts.forEachIndexed { index, account ->
            messages += accountMessageJson(syncId, index, account, sentAt + index + 1).toString()
        }
        messages += commitJson(syncId, accounts.size, sentAt + accounts.size + 1).toString()
        return SyncSession(syncId, messages)
    }

    fun beginJson(syncId: String, accountCount: Int, sentAt: Long): JSONObject = JSONObject()
        .put("type", TYPE_BEGIN)
        .put("version", VERSION)
        .put("sentAt", sentAt)
        .put("syncId", syncId)
        .put("accountCount", accountCount)

    fun accountMessageJson(syncId: String, index: Int, account: WristKeyAccount, sentAt: Long): JSONObject =
        JSONObject()
            .put("type", TYPE_ACCOUNT)
            .put("version", VERSION)
            .put("sentAt", sentAt)
            .put("syncId", syncId)
            .put("index", index)
            .put("account", encodeAccount(account))

    fun commitJson(syncId: String, accountCount: Int, sentAt: Long): JSONObject = JSONObject()
        .put("type", TYPE_COMMIT)
        .put("version", VERSION)
        .put("sentAt", sentAt)
        .put("syncId", syncId)
        .put("accountCount", accountCount)

    /** 协议 account 载荷；字段超长时截断，保证手环端校验通过。 */
    fun encodeAccount(account: WristKeyAccount): JSONObject = JSONObject()
        .put("id", account.id.take(MAX_ID_LENGTH))
        .put("issuer", account.issuer.take(MAX_NAME_LENGTH))
        .put("accountName", account.accountName.take(MAX_NAME_LENGTH))
        .put("category", account.categoryLabel.take(MAX_CATEGORY_LENGTH))
        .put("secret", Secret.normalize(account.secret))
        .put("algorithm", account.algorithm.uppercase(Locale.US))
        .put("digits", account.digits)
        .put("period", account.period)
        .put("updatedAt", account.updatedAt)

    fun messageBytes(message: String): Int = message.toByteArray(Charsets.UTF_8).size

    fun isWithinSizeLimit(message: String): Boolean = messageBytes(message) < MAX_MESSAGE_BYTES

    /** 解析手环 → 手机的入站消息（ack / request）。 */
    fun parseIncoming(raw: String): Incoming {
        val text = raw.trim()
        if (text.isEmpty()) {
            return Incoming.Ignored("空消息")
        }
        val json = runCatching { JSONObject(text) }.getOrElse {
            return Incoming.Ignored("不是合法 JSON 对象")
        }
        val type = json.optString("type", "")
        if (type.isEmpty()) {
            return Incoming.Ignored("缺少 type")
        }
        val version = readInteger(json, "version")
        if (version != VERSION.toLong()) {
            return Incoming.Ignored("version 不是 $VERSION")
        }
        return when (type) {
            TYPE_ACK -> parseAck(json)
            TYPE_REQUEST -> parseRequest(json)
            else -> Incoming.Ignored("未知 type: $type")
        }
    }

    /**
     * 手环端 account 校验（docs/protocol.md 表格）。返回 null 表示合法，否则为丢弃原因。
     * 供测试自检生成的消息，也表示协议约束的单一来源。
     */
    fun validateAccountPayload(json: JSONObject, index: Int): String? {
        val rawId = if (json.has("id")) json.opt("id") else null
        when {
            rawId == null || rawId === JSONObject.NULL || rawId == "" -> Unit
            rawId !is String -> return "id 不是字符串"
            rawId.length > MAX_ID_LENGTH -> return "id 超过 $MAX_ID_LENGTH 字符"
        }

        val issuer = readString(json, "issuer") ?: ""
        val accountName = readString(json, "accountName") ?: ""
        if (issuer.length > MAX_NAME_LENGTH || accountName.length > MAX_NAME_LENGTH) {
            return "issuer / accountName 超过 $MAX_NAME_LENGTH 字符"
        }
        if (issuer.trim().isEmpty() && accountName.trim().isEmpty()) {
            return "issuer 与 accountName 同时为空"
        }

        val category = readString(json, "category")
        if (category != null && category.isNotEmpty() && category.length > MAX_CATEGORY_LENGTH) {
            return "category 超过 $MAX_CATEGORY_LENGTH 字符"
        }

        val secretRaw = readString(json, "secret") ?: return "secret 缺失"
        val secret = Secret.normalize(secretRaw)
        if (!Secret.isNormalizedBase32(secret)) {
            return "secret 不是合法 Base32"
        }

        val algorithm = (readString(json, "algorithm") ?: "SHA1").uppercase(Locale.US)
        if (algorithm !in setOf("SHA1", "SHA256", "SHA512")) {
            return "algorithm 不是 SHA1/SHA256/SHA512"
        }

        val digits = readInteger(json, "digits") ?: 6L
        if (digits < 6L || digits > 10L) {
            return "digits 不是 6-10 的整数"
        }
        val period = readInteger(json, "period") ?: 30L
        if (period < 5L || period > 300L) {
            return "period 不是 5-300 的整数"
        }
        if (json.has("updatedAt")) {
            val updatedAt = readInteger(json, "updatedAt") ?: return "updatedAt 不是整数"
            if (updatedAt < 0) {
                return "updatedAt 非法"
            }
        }
        return null
    }

    private fun parseAck(json: JSONObject): Incoming {
        val syncId = readString(json, "syncId")
        if (syncId.isNullOrEmpty() || syncId.length > MAX_SYNC_ID_LENGTH) {
            return Incoming.Ignored("ack.syncId 缺失或非法")
        }
        val okValue = json.opt("ok")
        if (okValue !is Boolean) {
            return Incoming.Ignored("ack.ok 不是布尔值")
        }
        val received = readInteger(json, "received")
        val committed = readInteger(json, "committed")
        if (received == null || received < 0) {
            return Incoming.Ignored("ack.received 不是非负整数")
        }
        if (committed == null || committed < 0) {
            return Incoming.Ignored("ack.committed 不是非负整数")
        }
        val errorValue = json.opt("error")
        val error = if (errorValue == null || errorValue === JSONObject.NULL) null else errorValue.toString()
        if (!okValue && error == null) {
            return Incoming.Ignored("失败 ack 缺少 error")
        }
        if (received > Int.MAX_VALUE.toLong() || committed > Int.MAX_VALUE.toLong()) {
            return Incoming.Ignored("ack 计数溢出")
        }
        return Incoming.Ack(
            SyncProtocol.Ack(
                syncId = syncId,
                ok = okValue,
                received = received.toInt(),
                committed = committed.toInt(),
                error = error,
            ),
        )
    }

    private fun parseRequest(json: JSONObject): Incoming {
        val requestId = readString(json, "requestId")
        if (requestId.isNullOrEmpty() || requestId.length > MAX_SYNC_ID_LENGTH) {
            return Incoming.Ignored("requestId 缺失或非法")
        }
        return Incoming.Request(SyncRequest(requestId))
    }

    private fun readString(json: JSONObject, name: String): String? {
        if (!json.has(name)) {
            return null
        }
        val value = json.opt(name)
        if (value == null || value === JSONObject.NULL) {
            return null
        }
        return if (value is String) value else null
    }

    /** 读取整数（JSON 数字，且必须是整数值）；缺失/非法返回 null。 */
    private fun readInteger(json: JSONObject, name: String): Long? {
        if (!json.has(name)) {
            return null
        }
        val value = json.opt(name)
        if (value !is Number) {
            return null
        }
        val double = value.toDouble()
        if (double % 1.0 != 0.0 || double.isNaN() || double.isInfinite()) {
            return null
        }
        return double.toLong()
    }
}
