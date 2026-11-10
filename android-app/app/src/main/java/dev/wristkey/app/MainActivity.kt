package dev.wristkey.app

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.wristkey.app.protocol.SyncProtocol
import dev.wristkey.app.stratum.AccountMerge
import dev.wristkey.app.stratum.ImportMode
import dev.wristkey.app.stratum.StratumFormat
import dev.wristkey.app.stratum.StratumImportException
import dev.wristkey.app.stratum.StratumImporter
import dev.wristkey.app.stratum.StratumPasswordException
import dev.wristkey.app.sync.WearableSyncController
import dev.wristkey.app.ui.AppActions
import dev.wristkey.app.ui.AppPage
import dev.wristkey.app.ui.AppUiState
import dev.wristkey.app.ui.ImportUi
import dev.wristkey.app.ui.WristKeyApp
import dev.wristkey.app.ui.theme.WristKeyTheme
import java.util.concurrent.Executors

class MainActivity : ComponentActivity() {

    private lateinit var repository: AccountRepository
    private lateinit var syncController: WearableSyncController
    private val ioExecutor = Executors.newSingleThreadExecutor()

    private var uiState by mutableStateOf(AppUiState())

    /** 加密备份的原始字节只保存在内存中（用户选择密码前），导入/取消后清空。 */
    private var pendingBackupBytes: ByteArray? = null

    private val importDocumentLauncher = registerForActivityResult(
        ActivityResultContracts.OpenDocument(),
    ) { uri ->
        if (uri == null) {
            updateUi { it.copy(lastEvent = "已取消选择文件") }
        } else {
            handleBackupUri(uri)
        }
    }

    private val syncListener = object : WearableSyncController.Listener {
        override fun onConnectionStateChanged(state: WearableSyncController.ConnectionState) {
            runOnUiThread {
                updateUi {
                    it.copy(
                        sync = it.sync.copy(
                            serviceStatus = if (state.serviceConnected) "服务已连接" else "服务未连接",
                            connectionStatus = if (state.node != null) "已连接" else state.message,
                            nodeName = state.node?.name?.takeIf { name -> name.isNotBlank() } ?: "未连接手环",
                            nodeId = state.node?.id ?: "-",
                            permissionStatus = when {
                                state.node == null -> "未连接手环"
                                state.hasDeviceManagerPermission -> "已授权设备管理"
                                else -> "未授权设备管理"
                            },
                            hasDeviceManagerPermission = state.hasDeviceManagerPermission,
                            wearAppInstalled = state.wearAppInstalled,
                            syncStatus = when {
                                state.node == null -> "连接手环后可同步"
                                state.hasDeviceManagerPermission -> "可同步 ${it.accounts.size} 个账号"
                                else -> "同步需要先授权设备管理权限"
                            },
                        ),
                        lastEvent = state.message,
                    )
                }
            }
        }

        override fun onSyncProgress(progress: WearableSyncController.SyncProgress) {
            runOnUiThread {
                updateUi {
                    it.copy(
                        sync = it.sync.copy(
                            sending = progress.running,
                            sent = progress.sent,
                            total = progress.total,
                            syncStatus = progress.message,
                        ),
                        lastEvent = if (progress.finished) progress.message else it.lastEvent,
                    )
                }
            }
        }

        override fun onAck(ack: SyncProtocol.Ack) {
            runOnUiThread {
                val message = if (ack.ok) {
                    "已确认：手环已提交 ${ack.committed} 个账号"
                } else {
                    "手环拒绝：${ack.error ?: "未知原因"}"
                }
                updateUi {
                    it.copy(
                        sync = it.sync.copy(syncStatus = message, lastAck = message, sending = false),
                        lastEvent = message,
                    )
                }
            }
        }

        override fun onSyncRequest(requestId: String) {
            runOnUiThread {
                updateUi { it.copy(lastEvent = "手环请求重新同步（$requestId）") }
                val sync = uiState.sync
                if (sync.hasConnectedDevice && sync.hasDeviceManagerPermission) {
                    syncController.sync(uiState.accounts)
                } else {
                    updateUi { it.copy(lastEvent = "手环请求重新同步（$requestId），但未连接/未授权，已忽略") }
                }
            }
        }
    }

    private val actions: AppActions by lazy {
        AppActions(
            onPageSelected = { page -> updateUi { it.copy(page = page) } },
            onRefreshConnection = { syncController.refresh() },
            onRequestPermission = { syncController.requestDeviceManagerPermission() },
            onLaunchWearApp = { syncController.launchWearApp() },
            onSyncAll = { syncController.sync(uiState.accounts) },
            onImportRequest = { importDocumentLauncher.launch(arrayOf("*/*")) },
            onPasswordSubmit = ::submitPassword,
            onPasswordDismiss = ::dismissPassword,
            onApplyImport = ::applyImport,
            onDiscardImport = ::discardImport,
            onSearchChange = { value -> updateUi { it.copy(searchKeyword = value) } },
            onDraftChange = { draft -> updateUi { it.copy(draft = draft, editorError = null) } },
            onSaveDraft = ::saveDraft,
            onClearDraft = { updateUi { it.copy(draft = AccountDraft(), editorError = null) } },
            onEditAccount = ::editAccount,
            onDeleteAccount = ::deleteAccount,
            onParseOtpAuth = ::parseOtpAuth,
        )
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        repository = AccountRepository(getSharedPreferences(AccountRepository.PREFERENCES_NAME, MODE_PRIVATE))
        uiState = uiState.copy(accounts = repository.loadAll())
        syncController = WearableSyncController(this, syncListener)

        setContent {
            WristKeyTheme {
                WristKeyApp(state = uiState, actions = actions)
            }
        }

        syncController.start()
        handleLaunchIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleLaunchIntent(intent)
    }

    override fun onDestroy() {
        syncController.stop()
        ioExecutor.shutdown()
        super.onDestroy()
    }

    // ------------------------------------------------------------ 文件接收

    /** 支持系统分享（ACTION_SEND）与直接打开（ACTION_VIEW）传入的备份文件。 */
    private fun handleLaunchIntent(intent: Intent?) {
        val uri = extractBackupUri(intent) ?: return
        handleBackupUri(uri)
    }

    @Suppress("DEPRECATION")
    private fun extractBackupUri(intent: Intent?): Uri? {
        if (intent == null) {
            return null
        }
        return when (intent.action) {
            Intent.ACTION_SEND -> intent.getParcelableExtra(Intent.EXTRA_STREAM) as? Uri
            Intent.ACTION_VIEW -> intent.data
            else -> null
        }
    }

    private fun handleBackupUri(uri: Uri) {
        val fileName = queryDisplayName(uri)
        updateUi {
            it.copy(
                page = AppPage.HOME,
                importState = ImportUi(fileName = fileName, reading = true),
                passwordDialogVisible = false,
                passwordError = null,
                pendingImportLabel = fileName,
                lastEvent = "正在读取备份文件：$fileName",
            )
        }
        ioExecutor.execute {
            val bytes = runCatching {
                contentResolver.openInputStream(uri)?.use { input -> input.readBytes() }
            }.getOrNull()
            runOnUiThread {
                if (bytes == null || bytes.isEmpty()) {
                    updateUi {
                        it.copy(
                            importState = it.importState.copy(reading = false, error = "无法读取文件或文件为空"),
                            lastEvent = "读取备份文件失败",
                        )
                    }
                    return@runOnUiThread
                }
                pendingBackupBytes = bytes
                val format = runCatching { StratumImporter.detectFormat(bytes) }
                    .getOrDefault(StratumFormat.UNKNOWN)
                updateUi { it.copy(importState = it.importState.copy(reading = false, format = format)) }
                when (format) {
                    StratumFormat.STRONG, StratumFormat.LEGACY -> {
                        updateUi {
                            it.copy(
                                passwordDialogVisible = true,
                                passwordError = null,
                                lastEvent = "备份已加密（${format.name}），请输入密码",
                            )
                        }
                    }

                    else -> parseBackup(bytes, null)
                }
            }
        }
    }

    private fun queryDisplayName(uri: Uri): String = runCatching {
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
            ?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (index >= 0) cursor.getString(index) else null
                } else {
                    null
                }
            }
    }.getOrNull() ?: uri.lastPathSegment ?: "未知文件"

    // ------------------------------------------------------------ 导入流程

    private fun submitPassword(password: String) {
        val bytes = pendingBackupBytes
        if (bytes == null) {
            updateUi { it.copy(passwordDialogVisible = false, passwordError = null) }
            return
        }
        parseBackup(bytes, password)
    }

    private fun dismissPassword() {
        pendingBackupBytes = null
        updateUi {
            it.copy(
                passwordDialogVisible = false,
                passwordError = null,
                importState = it.importState.copy(parsing = false, result = null),
                lastEvent = "已取消导入",
            )
        }
    }

    private fun parseBackup(bytes: ByteArray, password: String?) {
        updateUi {
            it.copy(
                importState = it.importState.copy(reading = false, parsing = true, error = null),
                passwordError = null,
                lastEvent = if (password == null) "正在解析备份…" else "正在解密备份…",
            )
        }
        ioExecutor.execute {
            try {
                val result = StratumImporter.import(bytes, password, System.currentTimeMillis())
                runOnUiThread {
                    updateUi {
                        it.copy(
                            importState = it.importState.copy(
                                parsing = false,
                                result = result,
                                skipped = result.skipped,
                            ),
                            passwordDialogVisible = false,
                            passwordError = null,
                            lastEvent = "解析完成：可导入 ${result.importedCount} 个，跳过 ${result.skippedCount} 个",
                        )
                    }
                }
            } catch (error: StratumPasswordException) {
                runOnUiThread {
                    updateUi {
                        it.copy(
                            importState = it.importState.copy(parsing = false),
                            passwordDialogVisible = true,
                            passwordError = error.message,
                            lastEvent = "解密失败：密码错误或文件损坏",
                        )
                    }
                }
            } catch (error: StratumImportException) {
                pendingBackupBytes = null
                runOnUiThread {
                    updateUi {
                        it.copy(
                            importState = it.importState.copy(parsing = false, error = error.message),
                            passwordDialogVisible = false,
                            lastEvent = "导入失败：${error.message}",
                        )
                    }
                }
            } catch (error: Exception) {
                pendingBackupBytes = null
                runOnUiThread {
                    updateUi {
                        it.copy(
                            importState = it.importState.copy(
                                parsing = false,
                                error = "导入失败：${error.message ?: error.javaClass.simpleName}",
                            ),
                            passwordDialogVisible = false,
                            lastEvent = "导入失败",
                        )
                    }
                }
            }
        }
    }

    private fun applyImport(mode: ImportMode) {
        val result = uiState.importState.result ?: return
        val summary = AccountMerge.merge(
            existing = uiState.accounts,
            imported = result.accounts,
            mode = mode,
            skipped = result.skipped,
        )
        repository.saveAll(summary.accounts)
        pendingBackupBytes = null
        updateUi {
            it.copy(
                accounts = summary.accounts,
                importState = it.importState.copy(
                    result = null,
                    skipped = summary.skipped,
                    summary = summary,
                ),
                passwordDialogVisible = false,
                passwordError = null,
                lastEvent = "导入完成（${mode.name}）：新增 ${summary.added.size} / 更新 ${summary.updated.size} / 跳过 ${summary.skipped.size}",
            )
        }
        trySyncAfterChange()
    }

    private fun discardImport() {
        pendingBackupBytes = null
        updateUi {
            it.copy(
                importState = ImportUi(),
                passwordDialogVisible = false,
                passwordError = null,
                lastEvent = "已取消本次导入",
            )
        }
    }

    // ------------------------------------------------------------ 账号管理

    private fun saveDraft() {
        val draft = uiState.draft
        val validation = draft.validate()
        val account = validation.account
        if (account == null) {
            updateUi { it.copy(editorError = validation.errorMessage ?: "校验失败") }
            return
        }

        val oldId = draft.id
        val next = uiState.accounts.toMutableList()
        val index = if (oldId != null) {
            next.indexOfFirst { it.id == oldId }
        } else {
            next.indexOfFirst { it.id == account.id }
        }
        if (index >= 0) {
            next[index] = account
        } else {
            next += account
        }
        repository.saveAll(next)
        updateUi {
            it.copy(
                accounts = next,
                draft = AccountDraft(),
                editorError = null,
                lastEvent = if (oldId != null) {
                    "已更新 ${account.displayTitle}"
                } else {
                    "已新增 ${account.displayTitle}"
                },
            )
        }
        trySyncAfterChange()
    }

    private fun editAccount(account: WristKeyAccount) {
        updateUi {
            it.copy(
                page = AppPage.ACCOUNTS,
                draft = account.toDraft(),
                editorError = null,
                lastEvent = "正在修改 ${account.displayTitle}",
            )
        }
    }

    private fun deleteAccount(account: WristKeyAccount) {
        val next = uiState.accounts.filterNot { it.id == account.id }
        repository.saveAll(next)
        updateUi {
            it.copy(
                accounts = next,
                draft = if (it.draft.id == account.id) AccountDraft() else it.draft,
                lastEvent = "已删除 ${account.displayTitle}",
            )
        }
        trySyncAfterChange()
    }

    private fun parseOtpAuth(raw: String) {
        try {
            val account = OtpAuthParser.parse(raw)
            updateUi {
                it.copy(
                    page = AppPage.ACCOUNTS,
                    draft = account.toDraft(),
                    editorError = null,
                    lastEvent = "已解析 otpauth 链接，请确认后保存",
                )
            }
        } catch (error: OtpAuthParseException) {
            updateUi { it.copy(editorError = error.message ?: "otpauth 解析失败") }
        } catch (error: Exception) {
            updateUi { it.copy(editorError = "otpauth 解析失败：${error.message}") }
        }
    }

    // ------------------------------------------------------------ 同步

    private fun trySyncAfterChange() {
        val sync = uiState.sync
        if (sync.hasConnectedDevice && sync.hasDeviceManagerPermission) {
            syncController.sync(uiState.accounts)
        } else {
            updateUi {
                it.copy(
                    sync = it.sync.copy(
                        syncStatus = "已保存到手机，未同步（连接手环并授权后点「立即同步全部账号」）",
                    ),
                )
            }
        }
    }

    private fun updateUi(transform: (AppUiState) -> AppUiState) {
        runOnUiThread {
            uiState = transform(uiState)
        }
    }
}
