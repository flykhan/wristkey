package com.flykhan.wristkey

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.flykhan.wristkey.pattern.PatternPin
import com.flykhan.wristkey.stratum.AccountMerge
import com.flykhan.wristkey.stratum.ImportMode
import com.flykhan.wristkey.stratum.StratumFormat
import com.flykhan.wristkey.stratum.StratumImportException
import com.flykhan.wristkey.stratum.StratumImportResult
import com.flykhan.wristkey.stratum.StratumImporter
import com.flykhan.wristkey.stratum.StratumPasswordException
import com.flykhan.wristkey.stratum.StratumSkip
import com.flykhan.wristkey.sync.WearableSyncController
import com.flykhan.wristkey.ui.AppActions
import com.flykhan.wristkey.ui.AppPage
import com.flykhan.wristkey.ui.AppUiState
import com.flykhan.wristkey.ui.ImportUi
import com.flykhan.wristkey.ui.PatternStage
import com.flykhan.wristkey.ui.PatternUi
import com.flykhan.wristkey.ui.PinStatus
import com.flykhan.wristkey.ui.SyncStatusUi
import com.flykhan.wristkey.ui.WristKeyApp
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.Executors

/**
 * v2.0 单一 Activity：Compose UI + 状态容器 + xms 同步 + 导入 + 入口图案接线。
 *
 * 状态集中在 [AppUiState]（不可变），所有界面动作走 [AppActions]；
 * 账号与密码保存在应用私有 SharedPreferences（[AccountRepository] / [AccountCodec]）。
 */
class MainActivity : ComponentActivity(), WearableSyncController.Listener {

    private val ioExecutor = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())

    private lateinit var repository: AccountRepository
    private lateinit var controller: WearableSyncController

    private var uiState by mutableStateOf(AppUiState())

    private var pendingBackupBytes: ByteArray? = null
    private var pendingBackupLabel: String = ""
    private var ackReceived = false
    private var pinOperation = ""
    private var pinQuerySent = false

    private val importLauncher = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            handleBackupUri(uri)
        }
    }

    private val syncWatchdog = Runnable {
        if (!ackReceived) {
            update { state ->
                state.copy(
                    sync = state.sync.copy(
                        ackHint = "8 秒内未收到手环确认：手环应用可能为旧版本，已发送（未确认）。",
                    ),
                )
            }
        }
    }

    private val pinWatchdog = Runnable {
        if (pinOperation.isNotEmpty()) {
            val operation = pinOperation
            pinOperation = ""
            update { state ->
                val message = "8 秒内未收到手环确认，请确认手环应用版本为 2.0 及以上。"
                state.copy(
                    pattern = state.pattern.copy(saving = false, error = message),
                    lastEvent = message,
                )
            }
            Log.d(TAG, "入口图案操作超时: " + operation)
        }
    }

    private val actions: AppActions by lazy {
        AppActions(
            onPageSelected = { page -> update { it.copy(page = page) } },
            onRefreshConnection = { controller.refresh() },
            onRequestPermission = { controller.requestDeviceManagerPermission() },
            onLaunchWearApp = { controller.launchWearApp() },
            onSyncAll = { syncNow() },
            onRunSyncRequest = { syncNow() },
            onImportSheetOpen = { update { it.copy(importSheetVisible = true) } },
            onImportSheetDismiss = { update { it.copy(importSheetVisible = false) } },
            onPickBackup = {
                update { it.copy(importSheetVisible = false) }
                runCatching { importLauncher.launch(arrayOf("*/*")) }
            },
            onManualAdd = {
                update {
                    it.copy(
                        importSheetVisible = false,
                        draft = AccountDraft(category = DEFAULT_CATEGORY),
                        editorVisible = true,
                        editorError = null,
                    )
                }
            },
            onOtpAuthDialogOpen = {
                update { it.copy(importSheetVisible = false, otpAuthDialogVisible = true, editorError = null) }
            },
            onOtpAuthDialogDismiss = { update { it.copy(otpAuthDialogVisible = false, editorError = null) } },
            onOtpAuthSubmit = { text -> importOtpAuthList(text) },
            onPasswordSubmit = { password -> submitPassword(password) },
            onPasswordDismiss = {
                pendingBackupBytes = null
                pendingBackupLabel = ""
                update { it.copy(passwordDialogVisible = false, passwordError = null, importState = ImportUi()) }
            },
            onImportApply = { mode -> applyImport(mode) },
            onImportDiscard = {
                pendingBackupBytes = null
                pendingBackupLabel = ""
                update { it.copy(importState = ImportUi()) }
            },
            onSearchChange = { keyword -> update { it.copy(searchKeyword = keyword) } },
            onDetailOpen = { id -> update { it.copy(detailAccountId = id) } },
            onDetailClose = { update { it.copy(detailAccountId = null) } },
            onCopy = { text -> copyToClipboard(text) },
            onEditorOpen = { account ->
                update {
                    it.copy(
                        draft = account.toDraft(),
                        editorVisible = true,
                        editorError = null,
                        detailAccountId = null,
                    )
                }
            },
            onEditorClose = { update { it.copy(editorVisible = false, editorError = null) } },
            onDraftChange = { draft -> update { it.copy(draft = draft) } },
            onSaveDraft = { saveDraft() },
            onDeleteAccount = { account -> deleteAccount(account) },
            onClearAccounts = { clearAccounts() },
            onPatternPageOpen = {
                update { it.copy(page = AppPage.PATTERN, pattern = PatternUi()) }
            },
            onPatternPageBack = {
                update { it.copy(page = AppPage.SYNC, pattern = PatternUi()) }
            },
            onPatternInput = { shape -> appendPatternShape(shape) },
            onPatternUndo = { undoPatternShape() },
            onPatternReset = { update { it.copy(pattern = PatternUi()) } },
            onPatternSave = { savePattern() },
            onPinQuery = {
                controller.queryPin()
                update { it.copy(lastEvent = "已查询入口图案状态") }
            },
            onPinDisable = { disablePin() },
        )
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        repository = AccountRepository(
            getSharedPreferences(AccountRepository.PREFERENCES_NAME, Context.MODE_PRIVATE),
        )
        controller = WearableSyncController(this, this)
        val loaded = repository.loadAll()
        uiState = uiState.copy(accounts = loaded)
        loadAppInfo()
        setContent {
            WristKeyApp(state = uiState, actions = actions)
        }
        handleIntent(intent)
    }

    override fun onStart() {
        super.onStart()
        controller.start()
    }

    override fun onStop() {
        controller.stop()
        super.onStop()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    override fun onDestroy() {
        mainHandler.removeCallbacksAndMessages(null)
        ioExecutor.shutdown()
        super.onDestroy()
    }

    // ------------------------------------------------------------------ 状态工具

    private fun update(transform: (AppUiState) -> AppUiState) {
        runOnUiThread { uiState = transform(uiState) }
    }

    private fun copyToClipboard(text: String) {
        if (text.isEmpty()) {
            return
        }
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("WristKey", text))
        update { it.copy(lastEvent = "已复制到剪贴板") }
    }

    private fun loadAppInfo() {
        val packageInfo = try {
            packageManager.getPackageInfo(packageName, PackageManager.GET_SIGNING_CERTIFICATES)
        } catch (error: Exception) {
            Log.d(TAG, "读取签名信息失败", error)
            null
        }
        val versionName = try {
            packageManager.getPackageInfo(packageName, 0).versionName ?: "2.0.0"
        } catch (error: Exception) {
            "2.0.0"
        }
        val fingerprint = try {
            val signer = packageInfo?.signingInfo?.apkContentsSigners?.firstOrNull()
            if (signer == null) {
                "未知"
            } else {
                val digest = MessageDigest.getInstance("SHA-256").digest(signer.toByteArray())
                digest.joinToString(":") { byte -> String.format(Locale.US, "%02X", byte.toInt() and 0xFF) }
            }
        } catch (error: Exception) {
            "未知"
        }
        update { it.copy(versionName = versionName, certFingerprint = fingerprint) }
    }

    // ------------------------------------------------------------------ 意图 / 导入

    private fun handleIntent(intent: Intent?) {
        if (intent == null) {
            return
        }
        val uri = when (intent.action) {
            Intent.ACTION_VIEW -> intent.data
            Intent.ACTION_SEND -> intent.getParcelableExtra(Intent.EXTRA_STREAM)
            else -> null
        }
        if (uri != null) {
            handleBackupUri(uri)
        }
    }

    private fun queryDisplayName(uri: Uri): String {
        val fallback = uri.lastPathSegment?.substringAfterLast('/') ?: "备份文件"
        return try {
            contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
                ?.use { cursor ->
                    if (cursor.moveToFirst() && !cursor.isNull(0)) cursor.getString(0) else fallback
                }
                ?: fallback
        } catch (error: Exception) {
            fallback
        }
    }

    private fun handleBackupUri(uri: Uri) {
        val label = queryDisplayName(uri)
        update {
            it.copy(
                importState = ImportUi(reading = true, fileName = label),
                passwordDialogVisible = false,
                passwordError = null,
                importSheetVisible = false,
            )
        }
        ioExecutor.execute {
            val bytes = try {
                contentResolver.openInputStream(uri)?.use { stream -> stream.readBytes() }
            } catch (error: Exception) {
                Log.d(TAG, "读取导入文件失败", error)
                null
            }
            runOnUiThread {
                if (bytes == null || bytes.isEmpty()) {
                    update { it.copy(importState = ImportUi(error = "无法读取所选文件，请重新选择")) }
                    return@runOnUiThread
                }
                val format = try {
                    StratumImporter.detectFormat(bytes)
                } catch (error: Exception) {
                    StratumFormat.UNKNOWN
                }
                when (format) {
                    StratumFormat.STRONG, StratumFormat.LEGACY -> {
                        pendingBackupBytes = bytes
                        pendingBackupLabel = label
                        update {
                            it.copy(
                                importState = ImportUi(fileName = label, format = format),
                                passwordDialogVisible = true,
                                passwordError = null,
                            )
                        }
                    }

                    else -> startImport(bytes, label, format, null)
                }
            }
        }
    }

    private fun submitPassword(password: String) {
        val bytes = pendingBackupBytes ?: return
        val label = pendingBackupLabel
        update { it.copy(passwordDialogVisible = false, passwordError = null) }
        startImport(bytes, label, StratumImporter.detectFormat(bytes), password)
    }

    private fun startImport(bytes: ByteArray, label: String, format: StratumFormat, password: String?) {
        update {
            it.copy(
                importState = ImportUi(parsing = true, fileName = label, format = format),
                passwordError = null,
            )
        }
        ioExecutor.execute {
            try {
                val result = StratumImporter.import(bytes, password, System.currentTimeMillis())
                runOnUiThread {
                    update {
                        it.copy(
                            importState = ImportUi(fileName = label, format = result.format, result = result),
                            passwordDialogVisible = false,
                            passwordError = null,
                        )
                    }
                }
            } catch (error: StratumPasswordException) {
                runOnUiThread {
                    update {
                        it.copy(
                            importState = ImportUi(fileName = label, format = format),
                            passwordDialogVisible = true,
                            passwordError = error.message,
                        )
                    }
                }
            } catch (error: StratumImportException) {
                runOnUiThread {
                    update {
                        it.copy(
                            importState = ImportUi(fileName = label, format = format, error = error.message),
                            passwordDialogVisible = false,
                            lastEvent = error.message ?: "导入失败",
                        )
                    }
                }
            } catch (error: Exception) {
                runOnUiThread {
                    update {
                        it.copy(
                            importState = ImportUi(fileName = label, format = format, error = "解析失败：" + (error.message ?: "未知错误")),
                            lastEvent = "解析失败",
                        )
                    }
                }
            }
        }
    }

    private fun importOtpAuthList(text: String) {
        try {
            val parsed = OtpAuthParser.parseList(text, System.currentTimeMillis())
            val skipped = parsed.skipped.map { skip ->
                StratumSkip(
                    issuer = "",
                    accountName = skip.uri.take(48),
                    code = skip.code,
                    reason = skip.reason,
                    lineNumber = skip.lineNumber,
                )
            }
            val result = StratumImportResult(
                format = StratumFormat.URI_LIST,
                accounts = parsed.accounts,
                skipped = skipped,
            )
            update {
                it.copy(
                    otpAuthDialogVisible = false,
                    editorError = null,
                    importState = ImportUi(
                        fileName = "otpauth 链接",
                        format = StratumFormat.URI_LIST,
                        result = result,
                    ),
                )
            }
        } catch (error: IllegalArgumentException) {
            update {
                it.copy(
                    otpAuthDialogVisible = false,
                    editorError = error.message,
                    lastEvent = error.message ?: "otpauth 解析失败",
                )
            }
        }
    }

    private fun applyImport(mode: ImportMode) {
        val result = uiState.importState.result ?: return
        val summary = AccountMerge.merge(uiState.accounts, result.accounts, mode, result.skipped)
        repository.saveAll(summary.accounts)
        pendingBackupBytes = null
        pendingBackupLabel = ""
        val message = "导入完成：新增 " + summary.added.size + " · 更新 " + summary.updated.size +
            " · 跳过 " + summary.skipped.size
        update {
            it.copy(
                accounts = summary.accounts,
                importState = ImportUi(),
                passwordDialogVisible = false,
                passwordError = null,
                lastEvent = message,
            )
        }
        trySyncAfterChange()
    }

    // ------------------------------------------------------------------ 账号编辑

    private fun saveDraft() {
        val result = uiState.draft.validate(System.currentTimeMillis())
        val account = result.account
        if (account == null) {
            update { it.copy(editorError = result.errorMessage ?: "账号信息不完整") }
            return
        }
        val existing = uiState.draft.id
        val accounts = if (existing == null) {
            uiState.accounts + account
        } else {
            uiState.accounts.map { current -> if (current.id == existing) account else current }
        }
        repository.saveAll(accounts)
        update {
            it.copy(
                accounts = accounts,
                editorVisible = false,
                editorError = null,
                draft = AccountDraft(category = DEFAULT_CATEGORY),
                lastEvent = if (existing == null) "已添加账号" else "已保存修改",
            )
        }
        trySyncAfterChange()
    }

    private fun deleteAccount(account: WristKeyAccount) {
        val accounts = uiState.accounts.filterNot { it.id == account.id }
        repository.saveAll(accounts)
        update {
            it.copy(
                accounts = accounts,
                detailAccountId = null,
                lastEvent = "已删除 " + account.displayTitle,
            )
        }
        trySyncAfterChange()
    }

    private fun clearAccounts() {
        repository.saveAll(emptyList())
        update { it.copy(accounts = emptyList(), detailAccountId = null, lastEvent = "已清空全部账号") }
        trySyncAfterChange()
    }

    // ------------------------------------------------------------------ 同步

    private fun syncNow() {
        ackReceived = false
        mainHandler.removeCallbacks(syncWatchdog)
        update { it.copy(sync = it.sync.copy(ackHint = "", lastAck = "")) }
        controller.sync(uiState.accounts)
    }

    private fun trySyncAfterChange() {
        val sync = uiState.sync
        if (sync.hasConnectedDevice && sync.hasDeviceManagerPermission) {
            syncNow()
        } else {
            update { it.copy(sync = it.sync.copy(syncStatus = "已保存，连接手环后自动同步")) }
        }
    }

    // ------------------------------------------------------------------ 入口图案

    private fun appendPatternShape(shape: String) {
        update { state ->
            val pattern = state.pattern
            if (pattern.saving) {
                return@update state
            }
            val current = when (pattern.stage) {
                PatternStage.ENTER -> pattern.input
                PatternStage.CONFIRM -> pattern.confirmInput
            }
            if (current.length >= PatternPin.LENGTH) {
                return@update state
            }
            val next = current + shape
            if (next.length < PatternPin.LENGTH) {
                state.copy(
                    pattern = if (pattern.stage == PatternStage.ENTER) {
                        pattern.copy(input = next, error = null)
                    } else {
                        pattern.copy(confirmInput = next, error = null)
                    },
                )
            } else if (pattern.stage == PatternStage.ENTER) {
                state.copy(
                    pattern = pattern.copy(input = next, stage = PatternStage.CONFIRM, error = null),
                )
            } else if (next == pattern.input) {
                state.copy(pattern = pattern.copy(confirmInput = next, error = null))
            } else {
                state.copy(
                    pattern = pattern.copy(
                        input = "",
                        confirmInput = "",
                        stage = PatternStage.ENTER,
                        mismatchCounter = pattern.mismatchCounter + 1,
                        error = "两次输入不一致，请重新绘制",
                    ),
                )
            }
        }
    }

    private fun undoPatternShape() {
        update { state ->
            val pattern = state.pattern
            if (pattern.saving) {
                return@update state
            }
            when (pattern.stage) {
                PatternStage.ENTER -> state.copy(
                    pattern = pattern.copy(input = pattern.input.dropLast(1), error = null),
                )

                PatternStage.CONFIRM -> {
                    if (pattern.confirmInput.isNotEmpty()) {
                        state.copy(
                            pattern = pattern.copy(confirmInput = pattern.confirmInput.dropLast(1), error = null),
                        )
                    } else {
                        state.copy(
                            pattern = pattern.copy(stage = PatternStage.ENTER, input = "", confirmInput = "", error = null),
                        )
                    }
                }
            }
        }
    }

    private fun savePattern() {
        val pattern = uiState.pattern
        if (!PatternPin.isValidPattern(pattern.input) || pattern.input != pattern.confirmInput) {
            update { it.copy(pattern = it.pattern.copy(error = "请完成两次一致的图案输入")) }
            return
        }
        update { it.copy(pattern = it.pattern.copy(saving = true, error = null)) }
        ioExecutor.execute {
            try {
                val saltHex = PatternPin.newSaltHex()
                val hashHex = PatternPin.derive(pattern.input, saltHex, PatternPin.ITERATIONS)
                runOnUiThread {
                    pinOperation = "set"
                    controller.setPin(saltHex, hashHex, PatternPin.ITERATIONS)
                    mainHandler.removeCallbacks(pinWatchdog)
                    mainHandler.postDelayed(pinWatchdog, PIN_TIMEOUT_MS)
                }
            } catch (error: Exception) {
                runOnUiThread {
                    update {
                        it.copy(
                            pattern = it.pattern.copy(saving = false, error = "图案派生失败：" + (error.message ?: "未知错误")),
                        )
                    }
                }
            }
        }
    }

    private fun disablePin() {
        pinOperation = "clear"
        mainHandler.removeCallbacks(pinWatchdog)
        mainHandler.postDelayed(pinWatchdog, PIN_TIMEOUT_MS)
        update { it.copy(lastEvent = "正在关闭入口图案…") }
        controller.clearPin()
    }

    private fun resetPatternAfterPin() {
        update {
            it.copy(
                page = AppPage.SYNC,
                pattern = PatternUi(),
                sync = it.sync,
            )
        }
    }

    // ------------------------------------------------------------------ Listener

    override fun onConnectionStateChanged(state: WearableSyncController.ConnectionState) {
        val node = state.node
        update { current ->
            current.copy(
                sync = current.sync.copy(
                    serviceStatus = if (state.serviceConnected) "服务已连接" else "服务未连接",
                    connectionStatus = state.message,
                    nodeName = node?.name ?: "未连接手环",
                    nodeId = node?.id ?: "-",
                    permissionStatus = if (state.hasDeviceManagerPermission) "已授权" else "未授权",
                    hasDeviceManagerPermission = state.hasDeviceManagerPermission,
                    wearAppInstalled = state.wearAppInstalled,
                    syncStatus = if (node == null) "连接手环后可同步" else current.sync.syncStatus,
                    pinStatus = if (node == null) PinStatus.UNKNOWN else current.sync.pinStatus,
                ),
            )
        }
        if (node != null && state.hasDeviceManagerPermission && !pinQuerySent) {
            pinQuerySent = true
            controller.queryPin()
        }
        if (node == null) {
            pinQuerySent = false
        }
    }

    override fun onSyncProgress(progress: WearableSyncController.SyncProgress) {
        update { state ->
            state.copy(
                sync = state.sync.copy(
                    sending = progress.running,
                    sent = progress.sent,
                    total = progress.total,
                    syncStatus = progress.message,
                    ackHint = if (progress.running) "" else state.sync.ackHint,
                ),
            )
        }
        if (progress.running && progress.sent == 0) {
            ackReceived = false
        }
        if (progress.finished && !progress.failed) {
            mainHandler.removeCallbacks(syncWatchdog)
            mainHandler.postDelayed(syncWatchdog, ACK_TIMEOUT_MS)
        }
        if (progress.failed) {
            mainHandler.removeCallbacks(syncWatchdog)
        }
    }

    override fun onAck(ack: com.flykhan.wristkey.protocol.SyncProtocol.Ack) {
        ackReceived = true
        mainHandler.removeCallbacks(syncWatchdog)
        val text = if (ack.ok) {
            "已确认 " + ack.received + "/" + ack.committed
        } else {
            "手环报告失败：" + (ack.error ?: "未知原因")
        }
        update { state ->
            state.copy(
                sync = state.sync.copy(lastAck = text, ackHint = "", sending = false),
                lastEvent = if (ack.ok) "手环已确认同步" else text,
            )
        }
    }

    override fun onSyncRequest(requestId: String) {
        Log.d(TAG, "手环请求重新同步: " + requestId)
        mainHandler.postDelayed({ syncNow() }, 300)
    }

    override fun onPinAck(info: com.flykhan.wristkey.protocol.SyncProtocol.PinAckInfo) {
        mainHandler.removeCallbacks(pinWatchdog)
        val operation = pinOperation
        pinOperation = ""
        if (info.ok) {
            val enabled = info.enabled ?: (operation == "set")
            update { state ->
                state.copy(
                    page = if (state.page == AppPage.PATTERN) AppPage.SYNC else state.page,
                    pattern = PatternUi(),
                    sync = state.sync.copy(
                        pinStatus = if (enabled) PinStatus.ENABLED else PinStatus.DISABLED,
                    ),
                    lastEvent = if (enabled) "入口图案已保存" else "入口图案已关闭",
                )
            }
        } else {
            val message = "入口图案操作失败：" + (info.error ?: "未知错误")
            update {
                it.copy(
                    pattern = it.pattern.copy(saving = false, error = message),
                    lastEvent = message,
                )
            }
        }
    }

    override fun onPinState(info: com.flykhan.wristkey.protocol.SyncProtocol.PinStateInfo) {
        pinOperation = ""
        update { state ->
            state.copy(
                sync = state.sync.copy(
                    pinStatus = if (info.enabled) PinStatus.ENABLED else PinStatus.DISABLED,
                ),
            )
        }
    }

    override fun onPinError(message: String) {
        mainHandler.removeCallbacks(pinWatchdog)
        pinOperation = ""
        update {
            it.copy(
                pattern = it.pattern.copy(saving = false, error = message),
                lastEvent = message,
            )
        }
    }

    companion object {
        private const val TAG = "WristKeyMain"
        private const val ACK_TIMEOUT_MS = 8_000L
        private const val PIN_TIMEOUT_MS = 8_000L
    }
}
