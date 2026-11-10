package dev.wristkey.app.protocol

import dev.wristkey.app.MAX_PASSWORD_LENGTH
import dev.wristkey.app.OTP_TYPE_STEAM
import dev.wristkey.app.Secret
import dev.wristkey.app.SteamOtp
import dev.wristkey.app.SUPPORTED_OTP_TYPES
import dev.wristkey.app.WristKeyAccount
import dev.wristkey.app.normalizeOtpType
import dev.wristkey.app.normalizePassword
import org.json.JSONObject
import java.util.Locale
import java.util.Random

/**
 * 同步协议 v3（docs/protocol.md）的消息构造与手机端入站解析。
 *
 * v3 相对 v2 的新增：account.`password`（可选，≤128）、`mfa_pin_set/clear/query` 发送，
 * 以及 `mfa_pin_ack/mfa_pin_state` 接收；入站仍兼容 v2 的 ack / sync_request。
 *
 * 纯 JVM 实现（只依赖 org.json），可在单元测试中直接验证；Android 侧只负责
 * 把 [SyncSession.messages] 逐条经 xms `sendMessage(nodeId, bytes)` 发出。
 */
object SyncProtocol {

    const val VERSION = 3

    /** 手机端解析手环消息时接受的版本（v2 手环/旧手环兼容，docs/protocol.md 版本兼容矩阵）。 */
    val SUPPORTED_INCOMING_VERSIONS: Set<Long> = setOf(2L, 3L)

    const val TYPE_BEGIN = "mfa_sync_begin"
    const val TYPE_ACCOUNT = "mfa_sync_account"
    const val TYPE_COMMIT = "mfa_sync_commit"
    const val TYPE_ACK = "mfa_sync_ack"
    const val TYPE_REQUEST = "mfa_sync_request"
    const val TYPE_PIN_SET = "mfa_pin_set"
    const val TYPE_PIN_CLEAR = "mfa_pin_clear"
    const val TYPE_PIN_QUERY = "mfa_pin_query"
    const val TYPE_PIN_ACK = "mfa_pin_ack"
    const val TYPE_PIN_STATE = "mfa_pin_state"

    /** 单条消息上限（字节，不含末尾）；设计目标见 docs/protocol.md。 */
    const val MAX_MESSAGE_BYTES = 1024

    const val MAX_ID_LENGTH = 64
    const val MAX_NAME_LENGTH = 64
    const val MAX_CATEGORY_LENGTH = 32
    const val MAX_SYNC_ID_LENGTH = 128

    // ---------------------------------------------------------------- 入口图案（v3）
    const val PIN_ALGORITHM = "PBKDF2-SHA256"
    const val PIN_ITERATIONS = 1200
    const val PIN_MIN_ITERATIONS = 1000
    const val PIN_MAX_ITERATIONS = 20000
    const val PIN_SALT_HEX_LENGTH = 32
    const val PIN_HASH_HEX_LENGTH = 64

    private val PIN_SALT_REGEX = Regex("^[0-9a-f]{32}$")
    private val PIN_HASH_REGEX = Regex("^[0-9a-f]{64}$")

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

    /** `mfa_pin_ack`：ok=false 时 error ∈ invalid_pin_payload / invalid_version / storage_error。 */
    data class PinAckInfo(
        val ok: Boolean,
        val enabled: Boolean?,
        val error: String?,
    )

    /** `mfa_pin_state`：手机端只缓存 enabled / updatedAt，无法取回图案或 hash。 */
    data class PinStateInfo(
        val enabled: Boolean,
        val updatedAt: Long?,
        val requestId: String?,
    )

    sealed interface Incoming {
        data class Ack(val ack: SyncProtocol.Ack) : Incoming

        data class Request(val request: SyncProtocol.SyncRequest) : Incoming

        data class PinAck(val info: SyncProtocol.PinAckInfo) : Incoming

        data class PinState(val info: SyncProtocol.PinStateInfo) : Incoming

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

    /**
     * 协议 account 载荷；字段超长时截断，保证手环端校验通过。
     * Steam 账号强制 digits=5 / period=30 / algorithm=SHA1，并显式携带 otpType。
     *
     * v3 的 `password` 始终发送实际值（含空串）：空串在手环端表示"清空密码"，
     * 这样手机端删除密码能生效（docs/design/android-v2-spec.md §4；协议"缺省=保留"用于增量场景）。
     */
    fun encodeAccount(account: WristKeyAccount): JSONObject {
        val otpType = normalizeOtpType(account.otpType)
        val isSteam = otpType == OTP_TYPE_STEAM
        return JSONObject()
            .put("id", account.id.take(MAX_ID_LENGTH))
            .put("issuer", account.issuer.take(MAX_NAME_LENGTH))
            .put("accountName", account.accountName.take(MAX_NAME_LENGTH))
            .put("category", account.categoryLabel.take(MAX_CATEGORY_LENGTH))
            .put("secret", Secret.normalize(account.secret))
            .put("algorithm", if (isSteam) SteamOtp.ALGORITHM else account.algorithm.uppercase(Locale.US))
            .put("digits", if (isSteam) SteamOtp.DIGITS else account.digits)
            .put("period", if (isSteam) SteamOtp.PERIOD else account.period)
            .put("otpType", otpType)
            .put("password", normalizePassword(account.password).take(MAX_PASSWORD_LENGTH))
            .put("updatedAt", account.updatedAt)
    }

    // ---------------------------------------------------------------- 入口图案消息（v3）

    /**
     * `mfa_pin_set`：只发送派生结果（salt 32 位 hex、hash 64 位 hex、iterations 1000-20000）。
     * 参数非法时抛 [IllegalArgumentException]（调用方保证来自 [dev.wristkey.app.pattern.PatternPin]）。
     */
    fun pinSetJson(
        saltHex: String,
        hashHex: String,
        iterations: Int = PIN_ITERATIONS,
        sentAt: Long = System.currentTimeMillis(),
    ): JSONObject {
        require(PIN_SALT_REGEX.matches(saltHex)) { "salt 必须是 32 位小写十六进制" }
        require(PIN_HASH_REGEX.matches(hashHex)) { "hash 必须是 64 位小写十六进制" }
        require(iterations in PIN_MIN_ITERATIONS..PIN_MAX_ITERATIONS) {
            "iterations 必须在 $PIN_MIN_ITERATIONS-$PIN_MAX_ITERATIONS 之间"
        }
        return JSONObject()
            .put("type", TYPE_PIN_SET)
            .put("version", VERSION)
            .put("sentAt", sentAt)
            .put(
                "pin",
                JSONObject()
                    .put("algorithm", PIN_ALGORITHM)
                    .put("salt", saltHex)
                    .put("hash", hashHex)
                    .put("iterations", iterations),
            )
    }

    fun buildPinSet(
        saltHex: String,
        hashHex: String,
        iterations: Int = PIN_ITERATIONS,
        sentAt: Long = System.currentTimeMillis(),
    ): String = pinSetJson(saltHex, hashHex, iterations, sentAt).toString()

    /** `mfa_pin_clear`：关闭入口图案。 */
    fun buildPinClear(sentAt: Long = System.currentTimeMillis()): String = JSONObject()
        .put("type", TYPE_PIN_CLEAR)
        .put("version", VERSION)
        .put("sentAt", sentAt)
        .toString()

    /** `mfa_pin_query`：连接后查询入口图案状态；手环回复带同一 requestId 的 `mfa_pin_state`。 */
    fun buildPinQuery(
        requestId: String? = null,
        sentAt: Long = System.currentTimeMillis(),
    ): String {
        val id = requestId?.takeIf { it.isNotBlank() } ?: "pin-$sentAt"
        require(id.length <= MAX_SYNC_ID_LENGTH) { "requestId 超过 $MAX_SYNC_ID_LENGTH 字符" }
        return JSONObject()
            .put("type", TYPE_PIN_QUERY)
            .put("version", VERSION)
            .put("sentAt", sentAt)
            .put("requestId", id)
            .toString()
    }

    fun messageBytes(message: String): Int = message.toByteArray(Charsets.UTF_8).size

    fun isWithinSizeLimit(message: String): Boolean = messageBytes(message) < MAX_MESSAGE_BYTES

    /** 解析手环 → 手机的入站消息（ack / sync_request / pin_ack / pin_state）。 */
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
        val version = readInteger(json, "version") ?: return Incoming.Ignored("缺少 version")
        if (version !in SUPPORTED_INCOMING_VERSIONS) {
            return Incoming.Ignored("不支持的 version: $version")
        }
        return when (type) {
            TYPE_ACK -> parseAck(json)
            TYPE_REQUEST -> parseRequest(json)
            TYPE_PIN_ACK -> if (version != 3L) {
                Incoming.Ignored("pin 消息仅接受 version 3")
            } else {
                parsePinAck(json)
            }

            TYPE_PIN_STATE -> if (version != 3L) {
                Incoming.Ignored("pin 消息仅接受 version 3")
            } else {
                parsePinState(json)
            }

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

        val otpTypeRaw = readString(json, "otpType")
        if (otpTypeRaw != null && otpTypeRaw.trim().lowercase(Locale.US) !in SUPPORTED_OTP_TYPES) {
            return "otpType 不是 totp / steam"
        }
        val otpType = normalizeOtpType(otpTypeRaw)
        val isSteam = otpType == OTP_TYPE_STEAM

        val algorithm = (readString(json, "algorithm") ?: "SHA1").uppercase(Locale.US)
        if (algorithm !in setOf("SHA1", "SHA256", "SHA512")) {
            return "algorithm 不是 SHA1/SHA256/SHA512"
        }

        val digits = readInteger(json, "digits") ?: if (isSteam) SteamOtp.DIGITS.toLong() else 6L
        val period = readInteger(json, "period") ?: if (isSteam) SteamOtp.PERIOD.toLong() else 30L
        if (isSteam) {
            // Steam 固定 5 位（字母数字）/ 30 秒 / SHA1（docs/protocol.md）。
            if (digits != SteamOtp.DIGITS.toLong()) {
                return "Steam 账号 digits 必须为 5"
            }
            if (period != SteamOtp.PERIOD.toLong()) {
                return "Steam 账号 period 必须为 30"
            }
            if (algorithm != SteamOtp.ALGORITHM) {
                return "Steam 账号 algorithm 必须为 SHA1"
            }
        } else {
            if (digits < 6L || digits > 10L) {
                return "digits 不是 6-10 的整数"
            }
            if (period < 5L || period > 300L) {
                return "period 不是 5-300 的整数"
            }
        }

        // v3 可选密码：≤128、不允许 U+0000-U+001F 控制字符；空串合法（表示清空）。
        if (json.has("password")) {
            val rawPassword = json.opt("password")
            if (rawPassword != null && rawPassword !== JSONObject.NULL && rawPassword !is String) {
                return "password 不是字符串"
            }
            val password = rawPassword as? String ?: ""
            if (password.length > MAX_PASSWORD_LENGTH) {
                return "password 超过 $MAX_PASSWORD_LENGTH 字符"
            }
            if (password.any { it.code in 0x00..0x1F }) {
                return "password 含控制字符"
            }
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

    private fun parsePinAck(json: JSONObject): Incoming {
        val okValue = json.opt("ok")
        if (okValue !is Boolean) {
            return Incoming.Ignored("pin_ack.ok 不是布尔值")
        }
        val enabledValue = json.opt("enabled")
        val enabled = when {
            enabledValue == null || enabledValue === JSONObject.NULL -> null
            enabledValue is Boolean -> enabledValue
            else -> return Incoming.Ignored("pin_ack.enabled 不是布尔值")
        }
        val errorValue = json.opt("error")
        val error = when {
            errorValue == null || errorValue === JSONObject.NULL -> null
            errorValue is String -> errorValue
            else -> return Incoming.Ignored("pin_ack.error 不是字符串")
        }
        if (!okValue && error.isNullOrBlank()) {
            return Incoming.Ignored("失败 pin_ack 缺少 error")
        }
        return Incoming.PinAck(PinAckInfo(ok = okValue, enabled = enabled, error = error))
    }

    private fun parsePinState(json: JSONObject): Incoming {
        val enabledValue = json.opt("enabled")
        if (enabledValue !is Boolean) {
            return Incoming.Ignored("pin_state.enabled 不是布尔值")
        }
        val updatedAt = if (json.has("updatedAt")) {
            val value = readInteger(json, "updatedAt") ?: return Incoming.Ignored("pin_state.updatedAt 不是整数")
            if (value < 0) {
                return Incoming.Ignored("pin_state.updatedAt 非法")
            }
            value
        } else {
            null
        }
        val requestId = readString(json, "requestId")
        if (requestId != null && requestId.length > MAX_SYNC_ID_LENGTH) {
            return Incoming.Ignored("pin_state.requestId 过长")
        }
        return Incoming.PinState(PinStateInfo(enabled = enabledValue, updatedAt = updatedAt, requestId = requestId))
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
