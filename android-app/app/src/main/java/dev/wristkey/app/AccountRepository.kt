package dev.wristkey.app

import android.content.SharedPreferences

/** 手机端账号存储：应用私有 SharedPreferences（完整 secret / 密码只存在本机，不上传云端）。 */
class AccountRepository(
    private val preferences: SharedPreferences,
) {
    fun loadAll(): List<WristKeyAccount> =
        AccountCodec.decode(preferences.getString(KEY_ACCOUNTS, null).orEmpty())

    /** 按传入顺序保存（导入时保持 Ranking 排序，不重新排序）。 */
    fun saveAll(accounts: List<WristKeyAccount>) {
        preferences.edit().putString(KEY_ACCOUNTS, AccountCodec.encode(accounts)).apply()
    }

    companion object {
        const val KEY_ACCOUNTS = "wristkey_accounts"
        const val PREFERENCES_NAME = "wristkey_accounts"
    }
}
