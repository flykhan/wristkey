package dev.wristkey.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import dev.wristkey.app.AccountDraft
import dev.wristkey.app.DEFAULT_ALGORITHM
import dev.wristkey.app.SUPPORTED_ALGORITHMS
import dev.wristkey.app.Totp
import dev.wristkey.app.WristKeyAccount
import dev.wristkey.app.stratum.ImportMode
import dev.wristkey.app.stratum.ImportSummary
import dev.wristkey.app.stratum.StratumFormat
import dev.wristkey.app.stratum.StratumImportResult
import dev.wristkey.app.stratum.StratumSkip
import kotlinx.coroutines.delay

/** 页面事件集合（Activity 注入）。 */
data class AppActions(
    val onPageSelected: (AppPage) -> Unit,
    val onRefreshConnection: () -> Unit,
    val onRequestPermission: () -> Unit,
    val onLaunchWearApp: () -> Unit,
    val onSyncAll: () -> Unit,
    val onImportRequest: () -> Unit,
    val onPasswordSubmit: (String) -> Unit,
    val onPasswordDismiss: () -> Unit,
    val onApplyImport: (ImportMode) -> Unit,
    val onDiscardImport: () -> Unit,
    val onSearchChange: (String) -> Unit,
    val onDraftChange: (AccountDraft) -> Unit,
    val onSaveDraft: () -> Unit,
    val onClearDraft: () -> Unit,
    val onEditAccount: (WristKeyAccount) -> Unit,
    val onDeleteAccount: (WristKeyAccount) -> Unit,
    val onParseOtpAuth: (String) -> Unit,
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WristKeyApp(state: AppUiState, actions: AppActions) {
    Scaffold(
        modifier = Modifier.fillMaxSize(),
        topBar = {
            CenterAlignedTopAppBar(
                title = {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(APP_TITLE)
                        Text(state.page.pageTitle, style = MaterialTheme.typography.labelMedium)
                    }
                },
                actions = {
                    TextButton(onClick = actions.onImportRequest) {
                        Text("导入")
                    }
                },
            )
        },
        bottomBar = {
            NavigationBar {
                AppPage.entries.forEach { page ->
                    NavigationBarItem(
                        selected = page == state.page,
                        onClick = { actions.onPageSelected(page) },
                        icon = { Text(page.navLabel.take(1)) },
                        label = { Text(page.navLabel) },
                    )
                }
            }
        },
    ) { innerPadding ->
        val modifier = Modifier
            .fillMaxSize()
            .padding(innerPadding)
            .safeDrawingPadding()

        when (state.page) {
            AppPage.HOME -> HomeScreen(state, actions, modifier)
            AppPage.ACCOUNTS -> AccountsScreen(state, actions, modifier)
            AppPage.ABOUT -> AboutScreen(modifier)
        }
    }

    if (state.passwordDialogVisible) {
        PasswordDialog(state, actions)
    }
}

// ------------------------------------------------------------------ 首页

@Composable
private fun HomeScreen(state: AppUiState, actions: AppActions, modifier: Modifier) {
    Column(
        modifier = modifier
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        IntroCard(
            title = "腕证 · WristKey",
            summary = "从 Stratum 备份导入 OTP，经小米穿戴服务同步到小米手环；手环本地离线计算验证码。",
        )
        ImportCard(state, actions)
        SyncStatusCard(state, actions)
        Card(modifier = Modifier.fillMaxWidth()) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text("最近事件", style = MaterialTheme.typography.titleMedium)
                Text(state.lastEvent)
            }
        }
    }
}

@Composable
private fun ImportCard(state: AppUiState, actions: AppActions) {
    val importState = state.importState
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text("Stratum 导入", style = MaterialTheme.typography.titleMedium)
            Text("支持 .stratum（Strong 加密 / Legacy 加密 / 明文 JSON）、明文 .json、otpauth:// URI 列表 .txt。按文件内容识别，不依赖扩展名。")
            Button(
                onClick = actions.onImportRequest,
                enabled = !importState.isBusy,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("从 Stratum 导入")
            }

            if (importState.fileName.isNotBlank()) {
                Text("文件：${importState.fileName}")
            }
            importState.format?.let { format ->
                Text("识别格式：${format.label}")
            }

            if (importState.isBusy) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    CircularProgressIndicator()
                    Text(if (importState.reading) "正在读取文件…" else "正在解密 / 解析 / 映射…")
                }
            }

            importState.error?.let { error ->
                Text("导入失败：$error", color = MaterialTheme.colorScheme.error)
            }

            importState.result?.let { result ->
                ImportPreview(result, actions)
            }

            importState.summary?.let { summary ->
                ImportSummaryView(summary)
            }
        }
    }
}

@Composable
private fun ImportPreview(result: StratumImportResult, actions: AppActions) {
    HorizontalDivider()
    Text(
        "解析完成：可导入 ${result.importedCount} 个，跳过 ${result.skippedCount} 个",
        style = MaterialTheme.typography.titleSmall,
    )
    Text("合并：同一 secret 覆盖已有条目，保留未导入项；全量替换：清空手机端账号后导入本次结果。")
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(onClick = { actions.onApplyImport(ImportMode.MERGE) }) {
            Text("合并导入")
        }
        OutlinedButton(onClick = { actions.onApplyImport(ImportMode.REPLACE) }) {
            Text("全量替换")
        }
        TextButton(onClick = actions.onDiscardImport) {
            Text("取消")
        }
    }
    SkipList(result.skipped)
}

@Composable
private fun ImportSummaryView(summary: ImportSummary) {
    HorizontalDivider()
    Text("导入结果", style = MaterialTheme.typography.titleSmall)
    Text(
        "新增 ${summary.added.size} / 更新 ${summary.updated.size} / 跳过 ${summary.skipped.size} / 错误 ${summary.errors.size}",
    )
    if (summary.errors.isNotEmpty()) {
        summary.errors.forEach { error -> Text("• $error", color = MaterialTheme.colorScheme.error) }
    }
    SkipList(summary.skipped)
}

@Composable
private fun SkipList(skipped: List<StratumSkip>) {
    if (skipped.isEmpty()) {
        return
    }
    Text("跳过明细（${skipped.size}）", style = MaterialTheme.typography.titleSmall)
    skipped.forEach { skip ->
        Text("• ${skip.displayTitle}：${skip.reason}")
    }
}

@Composable
private fun SyncStatusCard(state: AppUiState, actions: AppActions) {
    val sync = state.sync
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text("同步状态（协议 v2）", style = MaterialTheme.typography.titleMedium)
            Text("设备：${sync.nodeName}")
            Text("Node ID：${sync.nodeId}")
            Text("穿戴服务：${sync.serviceStatus}")
            Text("连接：${sync.connectionStatus}")
            Text("权限：${sync.permissionStatus}")
            Text("手环应用：${sync.wearAppInstalled?.let { if (it) "已安装" else "未安装" } ?: "未知"}")
            Text("同步：${sync.syncStatus}")
            if (sync.lastAck.isNotBlank()) {
                Text("上次确认：${sync.lastAck}")
            }
            if (sync.sending && sync.total > 0) {
                LinearProgressIndicator(
                    progress = { sync.sent.toFloat() / sync.total.toFloat() },
                    modifier = Modifier.fillMaxWidth(),
                )
                Text("已发送 ${sync.sent} / ${sync.total} 条消息")
            }
            Button(
                onClick = actions.onRefreshConnection,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("刷新连接")
            }
            OutlinedButton(
                onClick = actions.onRequestPermission,
                enabled = sync.hasConnectedDevice,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("申请设备管理权限")
            }
            OutlinedButton(
                onClick = actions.onLaunchWearApp,
                enabled = sync.hasConnectedDevice,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("打开手环应用")
            }
            OutlinedButton(
                onClick = actions.onSyncAll,
                enabled = sync.hasConnectedDevice && sync.hasDeviceManagerPermission && !sync.sending,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("立即同步全部账号")
            }
            Text("同步为全量替换：手环收到 commit 后整体替换账号快照；未连接时只更新手机端数据。")
        }
    }
}

// ------------------------------------------------------------------ 账号页

@Composable
private fun AccountsScreen(state: AppUiState, actions: AppActions, modifier: Modifier) {
    var nowMillis by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(1_000L)
            nowMillis = System.currentTimeMillis()
        }
    }

    Column(
        modifier = modifier
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        IntroCard(
            title = "账号列表",
            summary = "共 ${state.accounts.size} 个账号。列表只显示脱敏 secret；手机端验证码仅用于核对，手环离线计算。",
        )
        OutlinedTextField(
            value = state.searchKeyword,
            onValueChange = actions.onSearchChange,
            label = { Text("按分类 / Issuer / 账号搜索") },
            modifier = Modifier.fillMaxWidth(),
        )
        AccountEditorCard(state, actions)

        if (state.categories.isEmpty()) {
            Text("暂无账号：点击「从 Stratum 导入」或在下方手动新增。")
        } else {
            state.categories.forEach { (category, accounts) ->
                Text(category, style = MaterialTheme.typography.titleMedium)
                accounts.forEach { account ->
                    AccountItem(account, nowMillis, actions)
                }
            }
        }
    }
}

@Composable
private fun AccountItem(account: WristKeyAccount, nowMillis: Long, actions: AppActions) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(account.displayTitle, style = MaterialTheme.typography.titleMedium)
            Text(
                "分类：${account.categoryLabel} · " + if (account.isSteam) {
                    "Steam Guard（5 位字母数字 · 30s）"
                } else {
                    "${account.algorithm} · ${account.digits} 位 · ${account.period}s"
                },
            )
            Text("Secret：${account.maskedSecret}")
            val code = runCatching { account.currentCode(nowMillis) }.getOrNull()
            if (code != null) {
                val remaining = account.remainingSeconds(nowMillis)
                val codeLabel = if (account.isSteam) "Steam Guard 验证码" else "当前验证码"
                Text("$codeLabel：$code（剩余 ${remaining}s）", style = MaterialTheme.typography.titleLarge)
            }
            Text("更新：${account.updatedAtLabel}", style = MaterialTheme.typography.bodySmall)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = { actions.onEditAccount(account) }) {
                    Text("修改")
                }
                TextButton(onClick = { actions.onDeleteAccount(account) }) {
                    Text("删除")
                }
            }
        }
    }
}

@Composable
private fun AccountEditorCard(state: AppUiState, actions: AppActions) {
    val draft = state.draft
    var otpAuthInput by remember { mutableStateOf("") }

    Card(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(if (draft.isEditing) "修改账号" else "手动新增账号", style = MaterialTheme.typography.titleMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = otpAuthInput,
                    onValueChange = { otpAuthInput = it },
                    label = { Text("粘贴 otpauth:// 链接（可选）") },
                    modifier = Modifier.weight(1f),
                )
                TextButton(
                    onClick = { actions.onParseOtpAuth(otpAuthInput) },
                    enabled = otpAuthInput.isNotBlank(),
                ) {
                    Text("解析")
                }
            }
            OutlinedTextField(
                value = draft.category,
                onValueChange = { actions.onDraftChange(draft.copy(category = it)) },
                label = { Text("分类（默认：默认分类）") },
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = draft.issuer,
                onValueChange = { actions.onDraftChange(draft.copy(issuer = it)) },
                label = { Text("Issuer，例如 GitHub") },
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = draft.accountName,
                onValueChange = { actions.onDraftChange(draft.copy(accountName = it)) },
                label = { Text("账号，例如 dev@example.com") },
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = draft.secret,
                onValueChange = { actions.onDraftChange(draft.copy(secret = it)) },
                label = { Text("Base32 Secret") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii),
                modifier = Modifier.fillMaxWidth(),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = draft.digits,
                    onValueChange = { actions.onDraftChange(draft.copy(digits = it)) },
                    label = { Text("位数 6-10") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    modifier = Modifier.weight(1f),
                )
                OutlinedTextField(
                    value = draft.period,
                    onValueChange = { actions.onDraftChange(draft.copy(period = it)) },
                    label = { Text("周期 5-300s") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    modifier = Modifier.weight(1f),
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                SUPPORTED_ALGORITHMS.forEach { algorithm ->
                    FilterChip(
                        selected = draft.algorithm.equals(algorithm, ignoreCase = true),
                        enabled = !draft.isSteam,
                        onClick = { actions.onDraftChange(draft.copy(algorithm = algorithm)) },
                        label = { Text(algorithm) },
                    )
                }
            }
            if (draft.isSteam) {
                Text("Steam Guard：固定 5 位字母数字、30 秒、SHA1（位数/周期/算法输入会被忽略）。")
            }
            state.editorError?.let { error ->
                Text(error, color = MaterialTheme.colorScheme.error)
            }
            Button(onClick = actions.onSaveDraft, modifier = Modifier.fillMaxWidth()) {
                Text(if (draft.isEditing) "保存修改并同步" else "保存并同步")
            }
            OutlinedButton(onClick = actions.onClearDraft, modifier = Modifier.fillMaxWidth()) {
                Text("清空表单")
            }
        }
    }
}

// ------------------------------------------------------------------ 关于页

@Composable
private fun AboutScreen(modifier: Modifier) {
    Column(
        modifier = modifier
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Card(modifier = Modifier.fillMaxWidth()) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text("腕证 · WristKey", style = MaterialTheme.typography.titleMedium)
                Text("版本：1.0")
                Text("包名：dev.wristkey.app")
                Text("作用：从 Stratum 导入 TOTP，经小米穿戴服务同步到小米手环 10 Pro，手环端离线计算验证码。")
            }
        }
        Card(modifier = Modifier.fillMaxWidth()) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text("安全说明", style = MaterialTheme.typography.titleMedium)
                Text("• TOTP Secret 等同于账号凭证：手机端存储在应用私有存储中，请启用锁屏。")
                Text("• Stratum 备份密码只在本次导入时使用，不写入磁盘；解密在内存中完成。")
                Text("• 列表与详情只显示脱敏 secret；发布构建不打印 secret / 验证码。")
                Text("• 导入后建议删除或移走导出的备份文件。")
                Text("• 手环快照包含完整 secret，手环丢失后应撤销相关账号的 TOTP 并重新绑定。")
            }
        }
        Card(modifier = Modifier.fillMaxWidth()) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text("开源与许可", style = MaterialTheme.typography.titleMedium)
                Text("本项目以 Apache License 2.0 发布，保留原参考项目署名。")
                Text("手机端/手环端实现参考 BandOTP（github.com/lin945/mi_band_mfa，Apache-2.0），本实现为独立重写。")
                Text("Stratum 备份格式参考 stratumauth/app（GPL-3.0）：仅依据公开格式文档独立实现解析器，不包含其源代码；本应用不链接或分发 Stratum 代码。")
                Text("TOTP 依据 RFC 4226 / RFC 6238。")
            }
        }
        Card(modifier = Modifier.fillMaxWidth()) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text("免责声明", style = MaterialTheme.typography.titleMedium)
                Text("本应用按“现状”提供，不附带任何担保；请仅在自己信任的设备上使用，并自行承担账号安全风险。")
            }
        }
    }
}

// ------------------------------------------------------------------ 对话框

@Composable
private fun PasswordDialog(state: AppUiState, actions: AppActions) {
    var password by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = actions.onPasswordDismiss,
        title = { Text("输入备份密码") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "文件「${state.pendingImportLabel}」已加密（${state.importState.format?.label ?: "Stratum"}）。" +
                        "密码只用于本次解密，不会保存。",
                )
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it },
                    label = { Text("密码") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                    modifier = Modifier.fillMaxWidth(),
                )
                if (state.importState.parsing) {
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        CircularProgressIndicator()
                        Text("正在解密…")
                    }
                }
                state.passwordError?.let { error ->
                    Text(error, color = MaterialTheme.colorScheme.error)
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = { actions.onPasswordSubmit(password) },
                enabled = !state.importState.parsing,
            ) {
                Text("解密")
            }
        },
        dismissButton = {
            TextButton(onClick = actions.onPasswordDismiss, enabled = !state.importState.parsing) {
                Text("取消")
            }
        },
    )
}

// ------------------------------------------------------------------ 通用

@Composable
private fun IntroCard(title: String, summary: String) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            Text(summary)
        }
    }
}

private const val APP_TITLE = "腕证 WristKey"

private val StratumFormat.label: String
    get() = when (this) {
        StratumFormat.STRONG -> "Strong 加密（Argon2id + AES-256-GCM）"
        StratumFormat.LEGACY -> "Legacy 加密（PBKDF2-SHA1 + AES-256-CBC）"
        StratumFormat.PLAIN_JSON -> "明文 JSON 备份"
        StratumFormat.URI_LIST -> "otpauth:// URI 列表"
        StratumFormat.HTML -> "HTML 导出（不可导入）"
        StratumFormat.UNKNOWN -> "未知格式"
    }

private val AppPage.navLabel: String
    get() = when (this) {
        AppPage.HOME -> "首页"
        AppPage.ACCOUNTS -> "账号"
        AppPage.ABOUT -> "关于"
    }

private val AppPage.pageTitle: String
    get() = when (this) {
        AppPage.HOME -> "同步与导入"
        AppPage.ACCOUNTS -> "账号管理"
        AppPage.ABOUT -> "关于与许可"
    }
