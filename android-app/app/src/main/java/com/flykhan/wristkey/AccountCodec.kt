package com.flykhan.wristkey

import org.json.JSONArray
import org.json.JSONObject

/**
 * SharedPreferences 中账号 JSON 的纯 JVM 编解码（便于单元测试旧数据兼容）。
 *
 * 旧版本（1.x）没有 `otpType` / `password` 字段：缺省按 totp / 空密码读取，
 * 保证升级到 2.0 后已有账号不丢失（docs/design/android-v2-spec.md §4）。
 */
object AccountCodec {

    fun encode(accounts: List<WristKeyAccount>): String {
        val array = JSONArray()
        accounts.forEach { account -> array.put(account.toJson()) }
        return array.toString()
    }

    fun decode(raw: String): List<WristKeyAccount> {
        if (raw.isBlank()) {
            return emptyList()
        }
        return runCatching {
            val array = JSONArray(raw)
            buildList {
                for (index in 0 until array.length()) {
                    val item = array.optJSONObject(index) ?: continue
                    decodeAccount(item)?.let { add(it) }
                }
            }
        }.getOrDefault(emptyList())
    }

    private fun decodeAccount(item: JSONObject): WristKeyAccount? {
        val id = item.optString("id")
        val secret = Secret.normalize(item.optString("secret"))
        if (id.isBlank() || secret.isEmpty()) {
            return null
        }
        val otpType = normalizeOtpType(item.optString("otpType", OTP_TYPE_TOTP))
        val isSteam = otpType == OTP_TYPE_STEAM
        return WristKeyAccount(
            id = id,
            issuer = item.optString("issuer"),
            accountName = item.optString("accountName"),
            category = item.optString("category").ifBlank { DEFAULT_CATEGORY },
            secret = secret,
            algorithm = if (isSteam) {
                SteamOtp.ALGORITHM
            } else {
                item.optString("algorithm", DEFAULT_ALGORITHM)
                    .takeIf { it in SUPPORTED_ALGORITHMS } ?: DEFAULT_ALGORITHM
            },
            digits = if (isSteam) {
                SteamOtp.DIGITS
            } else {
                item.optInt("digits", DEFAULT_DIGITS).coerceIn(6, 10)
            },
            period = if (isSteam) {
                SteamOtp.PERIOD
            } else {
                item.optInt("period", DEFAULT_PERIOD).coerceIn(5, 300)
            },
            updatedAt = item.optLong("updatedAt", System.currentTimeMillis()),
            otpType = otpType,
            // 1.x 数据没有 password 字段：optString 返回 ""，按"无密码"处理。
            password = normalizePassword(item.optString("password")),
        )
    }

    private fun WristKeyAccount.toJson(): JSONObject = JSONObject()
        .put("id", id)
        .put("issuer", issuer)
        .put("accountName", accountName)
        .put("category", categoryLabel)
        .put("secret", secret)
        .put("algorithm", algorithm)
        .put("digits", digits)
        .put("period", period)
        .put("otpType", normalizedOtpType)
        .put("password", password)
        .put("updatedAt", updatedAt)
}
