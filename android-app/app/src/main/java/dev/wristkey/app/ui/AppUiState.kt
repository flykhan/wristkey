package dev.wristkey.app.ui

import dev.wristkey.app.AccountDraft
import dev.wristkey.app.WristKeyAccount
import dev.wristkey.app.stratum.ImportSummary
import dev.wristkey.app.stratum.StratumFormat
import dev.wristkey.app.stratum.StratumImportResult
import dev.wristkey.app.stratum.StratumSkip

enum class AppPage {
    HOME,
    ACCOUNTS,
    ABOUT,
}

data class SyncStatusUi(
    val serviceStatus: String = "等待服务连接",
    val connectionStatus: String = "未查询",
    val nodeName: String = "未连接手环",
    val nodeId: String = "-",
    val permissionStatus: String = "权限未查询",
    val hasDeviceManagerPermission: Boolean = false,
    val wearAppInstalled: Boolean? = null,
    val syncStatus: String = "连接手环后可同步",
    val lastAck: String = "",
    val sending: Boolean = false,
    val sent: Int = 0,
    val total: Int = 0,
) {
    val hasConnectedDevice: Boolean
        get() = nodeId != "-"
}

data class ImportUi(
    val reading: Boolean = false,
    val parsing: Boolean = false,
    val fileName: String = "",
    val format: StratumFormat? = null,
    val error: String? = null,
    val result: StratumImportResult? = null,
    val summary: ImportSummary? = null,
    val skipped: List<StratumSkip> = emptyList(),
) {
    val isBusy: Boolean
        get() = reading || parsing
}

data class AppUiState(
    val page: AppPage = AppPage.HOME,
    val accounts: List<WristKeyAccount> = emptyList(),
    val searchKeyword: String = "",
    val sync: SyncStatusUi = SyncStatusUi(),
    val importState: ImportUi = ImportUi(),
    val draft: AccountDraft = AccountDraft(),
    val editorError: String? = null,
    val passwordDialogVisible: Boolean = false,
    val passwordError: String? = null,
    val pendingImportLabel: String = "",
    val lastEvent: String = "请先连接手环，然后导入 Stratum 备份或手动添加账号",
) {
    val filteredAccounts: List<WristKeyAccount>
        get() {
            val keyword = searchKeyword.trim()
            if (keyword.isEmpty()) {
                return accounts
            }
            return accounts.filter { account ->
                account.categoryLabel.contains(keyword, ignoreCase = true) ||
                    account.issuer.contains(keyword, ignoreCase = true) ||
                    account.accountName.contains(keyword, ignoreCase = true)
            }
        }

    val categories: List<Pair<String, List<WristKeyAccount>>>
        get() = filteredAccounts.groupBy { it.categoryLabel }.toList()
}
