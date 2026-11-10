package dev.wristkey.app.ui

import dev.wristkey.app.AccountDraft
import dev.wristkey.app.WristKeyAccount
import dev.wristkey.app.stratum.ImportMode
import dev.wristkey.app.stratum.ImportSummary
import dev.wristkey.app.stratum.StratumFormat
import dev.wristkey.app.stratum.StratumImportResult
import dev.wristkey.app.stratum.StratumSkip
import java.util.Locale

/** 主页面（底部 3 Tab）+ 入口图案设置页（全屏）。 */
enum class AppPage {
    ACCOUNTS,
    SYNC,
    SETTINGS,
    PATTERN,
}

/** 手环入口图案状态（手机端只缓存 enabled，无法取回图案或 hash）。 */
enum class PinStatus {
    UNKNOWN,
    ENABLED,
    DISABLED,
}

enum class PatternStage {
    /** 第一次输入。 */
    ENTER,

    /** 再次输入确认。 */
    CONFIRM,
}

data class PatternUi(
    val stage: PatternStage = PatternStage.ENTER,
    val input: String = "",
    val confirmInput: String = "",
    val mismatchCounter: Int = 0,
    val saving: Boolean = false,
    val error: String? = null,
) {
    /** 当前正在编辑的那一串（第一次或确认）。 */
    val current: String
        get() = if (stage == PatternStage.ENTER) input else confirmInput

    /** 界面上 5 个占位圆点要显示的内容：确认阶段优先显示确认串，否则显示第一串。 */
    val display: String
        get() = if (stage == PatternStage.CONFIRM) confirmInput else input
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
    /** 发完 8 秒仍无 ack 时的提示（旧版手环应用）。 */
    val ackHint: String = "",
    val pinStatus: PinStatus = PinStatus.UNKNOWN,
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

    /** 解析完成、等待用户选择合并方式。 */
    val readyForReview: Boolean
        get() = result != null
}

data class AppUiState(
    val page: AppPage = AppPage.ACCOUNTS,
    val accounts: List<WristKeyAccount> = emptyList(),
    val searchKeyword: String = "",
    val sync: SyncStatusUi = SyncStatusUi(),
    val importState: ImportUi = ImportUi(),
    val importSheetVisible: Boolean = false,
    val draft: AccountDraft = AccountDraft(),
    val editorVisible: Boolean = false,
    val editorError: String? = null,
    val detailAccountId: String? = null,
    val passwordDialogVisible: Boolean = false,
    val passwordError: String? = null,
    val otpAuthDialogVisible: Boolean = false,
    val pattern: PatternUi = PatternUi(),
    val versionName: String = "2.0.0",
    val certFingerprint: String = "读取中…",
    val lastEvent: String = "",
) {
    /** 账号列表：按 issuer 排序（忽略分类），搜索匹配 issuer / 账号名 / 分类。 */
    val filteredAccounts: List<WristKeyAccount>
        get() {
            val keyword = searchKeyword.trim()
            val matched = if (keyword.isEmpty()) {
                accounts
            } else {
                accounts.filter { account ->
                    account.issuer.contains(keyword, ignoreCase = true) ||
                        account.accountName.contains(keyword, ignoreCase = true) ||
                        account.categoryLabel.contains(keyword, ignoreCase = true)
                }
            }
            return matched.sortedWith(
                compareBy<WristKeyAccount> { it.issuer.trim().lowercase() }
                    .thenBy { it.accountName.trim().lowercase() }
                    .thenBy { it.id },
            )
        }

    val detailAccount: WristKeyAccount?
        get() = detailAccountId?.let { id -> accounts.firstOrNull { it.id == id } }

    val accountCount: Int
        get() = accounts.size

    val hasAccounts: Boolean
        get() = accounts.isNotEmpty()
}

/**
 * 界面到 Activity 的动作集合。所有回调在主线程调用；
 * Activity 负责读写 SharedPreferences、xms 发送与协议消息处理。
 */
data class AppActions(
    val onPageSelected: (AppPage) -> Unit,
    val onRefreshConnection: () -> Unit,
    val onRequestPermission: () -> Unit,
    val onLaunchWearApp: () -> Unit,
    val onSyncAll: () -> Unit,
    val onRunSyncRequest: (String) -> Unit = {},
    val onImportSheetOpen: () -> Unit,
    val onImportSheetDismiss: () -> Unit,
    val onPickBackup: () -> Unit,
    val onManualAdd: () -> Unit,
    val onOtpAuthDialogOpen: () -> Unit,
    val onOtpAuthDialogDismiss: () -> Unit,
    val onOtpAuthSubmit: (String) -> Unit,
    val onPasswordSubmit: (String) -> Unit,
    val onPasswordDismiss: () -> Unit,
    val onImportApply: (ImportMode) -> Unit,
    val onImportDiscard: () -> Unit,
    val onSearchChange: (String) -> Unit,
    val onDetailOpen: (String) -> Unit,
    val onDetailClose: () -> Unit,
    val onCopy: (String) -> Unit,
    val onEditorOpen: (WristKeyAccount) -> Unit,
    val onEditorClose: () -> Unit,
    val onDraftChange: (AccountDraft) -> Unit,
    val onSaveDraft: () -> Unit,
    val onDeleteAccount: (WristKeyAccount) -> Unit,
    val onClearAccounts: () -> Unit,
    val onPatternPageOpen: () -> Unit,
    val onPatternPageBack: () -> Unit,
    val onPatternInput: (String) -> Unit,
    val onPatternUndo: () -> Unit,
    val onPatternReset: () -> Unit,
    val onPatternSave: () -> Unit,
    val onPinQuery: () -> Unit,
    val onPinDisable: () -> Unit,
) {
    /** 未使用但保留：便于未来按语言切换格式名。 */
    fun formatLabel(format: StratumFormat?): String = when (format) {
        StratumFormat.STRONG, StratumFormat.LEGACY -> "Stratum 加密备份"
        StratumFormat.PLAIN_JSON -> "Stratum 明文备份"
        StratumFormat.URI_LIST -> "otpauth 链接列表"
        StratumFormat.HTML -> "HTML 导出（不支持）"
        StratumFormat.BITWARDEN, StratumFormat.BITWARDEN_ENCRYPTED -> "Bitwarden 导出"
        StratumFormat.UNKNOWN, null -> "未知格式"
    }.lowercase(Locale.US).ifEmpty { "未知格式" }
}
