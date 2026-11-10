package dev.wristkey.app.stratum

import dev.wristkey.app.Secret
import dev.wristkey.app.WristKeyAccount

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
        val importedIds = deduplicated.mapTo(HashSet()) { it.id }
        val importedSecrets = deduplicated.mapTo(HashSet()) { Secret.normalize(it.secret) }

        val updated = deduplicated.filter { account ->
            existingById.containsKey(account.id) ||
                existingBySecret.containsKey(Secret.normalize(account.secret))
        }
        val added = deduplicated.filter { account ->
            !existingById.containsKey(account.id) &&
                !existingBySecret.containsKey(Secret.normalize(account.secret))
        }

        val accounts = when (mode) {
            ImportMode.MERGE -> deduplicated + existing.filter { account ->
                account.id !in importedIds && Secret.normalize(account.secret) !in importedSecrets
            }

            ImportMode.REPLACE -> deduplicated
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
