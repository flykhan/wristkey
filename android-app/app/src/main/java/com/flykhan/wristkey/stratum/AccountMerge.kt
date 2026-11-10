package com.flykhan.wristkey.stratum

import com.flykhan.wristkey.Secret
import com.flykhan.wristkey.WristKeyAccount

enum class ImportMode {
    /** 合并：同 secret 覆盖已有条目，保留未导入项。 */
    MERGE,

    /** 全量替换：手机端账号列表整体替换为本次导入结果。 */
    REPLACE,
}

data class ImportSummary(
    val mode: ImportMode,
    val accounts: List<WristKeyAccount>,
    val added: List<WristKeyAccount>,
    val updated: List<WristKeyAccount>,
    val skipped: List<StratumSkip>,
    val errors: List<String> = emptyList(),
)

/** 导入结果与手机端已有账号的合并（按 secret 派生的 id / secret 本身匹配）。 */
object AccountMerge {

    fun merge(
        existing: List<WristKeyAccount>,
        imported: List<WristKeyAccount>,
        mode: ImportMode,
        skipped: List<StratumSkip> = emptyList(),
        errors: List<String> = emptyList(),
    ): ImportSummary {
        val deduplicated = imported.distinctBy { it.id }
        val existingById = existing.associateBy { it.id }
        val existingBySecret = existing.associateBy { Secret.normalize(it.secret) }

        fun match(account: WristKeyAccount): WristKeyAccount? =
            existingById[account.id] ?: existingBySecret[Secret.normalize(account.secret)]

        // 密码合并规则（docs/design/android-v2-spec.md §4）：同 id 时新密码非空才覆盖；
        // 为空则保留旧密码（Stratum 备份不带密码，导入后不能丢掉 Bitwarden 带进来的密码）。
        val mergedImported = deduplicated.map { account ->
            val old = match(account)
            if (old != null && account.password.isEmpty()) {
                account.copy(password = old.password)
            } else {
                account
            }
        }
        val importedIds = mergedImported.mapTo(HashSet()) { it.id }
        val importedSecrets = mergedImported.mapTo(HashSet<String>()) { Secret.normalize(it.secret) }

        val updated = mergedImported.filter { account -> match(account) != null }
        val added = mergedImported.filter { account -> match(account) == null }

        val accounts = when (mode) {
            ImportMode.MERGE -> mergedImported + existing.filter { account ->
                account.id !in importedIds && Secret.normalize(account.secret) !in importedSecrets
            }

            ImportMode.REPLACE -> mergedImported
        }

        return ImportSummary(
            mode = mode,
            accounts = accounts,
            added = added,
            updated = updated,
            skipped = skipped,
            errors = errors,
        )
    }
}
