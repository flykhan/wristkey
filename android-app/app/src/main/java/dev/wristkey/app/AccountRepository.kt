package dev.wristkey.app

import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject

/** 手机端账号存储：应用私有 SharedPreferences（完整 secret 只存在本机）。 */
class AccountRepository(
    private val preferences: SharedPreferences,
) {
    fun loadAll(): List<WristKeyAccount> {
        val raw = preferences.getString(KEY_ACCOUNTS, null).orEmpty()
        if (raw.isBlank()) {
            return emptyList()
        }
        return runCatching {
            val array = JSONArray(raw)
            buildList {
                for (index in 0 until array.length()) {
                    val item = array.optJSONObject(index) ?: continue
                    val id = item.optString("id")
                    val secret = Secret.normalize(item.optString("secret"))
                    if (id.isBlank() || secret.isEmpty()) {
                        continue
                    }
                    add(
                        WristKeyAccount(
                            id = id,
                            issuer = item.optString("issuer"),
                            accountName = item.optString("accountName"),
                            category = item.optString("category").ifBlank { DEFAULT_CATEGORY },
                            secret = secret,
                            algorithm = item.optString("algorithm", DEFAULT_ALGORITHM)
                                .takeIf { it in SUPPORTED_ALGORITHMS } ?: DEFAULT_ALGORITHM,
                            digits = item.optInt("digits", DEFAULT_DIGITS).coerceIn(6, 10),
                            period = item.optInt("period", DEFAULT_PERIOD).coerceIn(5, 300),
                            updatedAt = item.optLong("updatedAt", System.currentTimeMillis()),
                        ),
                    )
                }
            }
        }.getOrDefault(emptyList())
    }

    /** 按传入顺序保存（导入时保持 Ranking 排序，不重新排序）。 */
    fun saveAll(accounts: List<WristKeyAccount>) {
        val array = JSONArray()
        accounts.forEach { account -> array.put(account.toJson()) }
        preferences.edit().putString(KEY_ACCOUNTS, array.toString()).apply()
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
        .put("updatedAt", updatedAt)

    companion object {
        const val KEY_ACCOUNTS = "wristkey_accounts"
        const val PREFERENCES_NAME = "wristkey_accounts"
    }
}
