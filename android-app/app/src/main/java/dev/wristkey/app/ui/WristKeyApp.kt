@file:OptIn(ExperimentalMaterial3Api::class)

package dev.wristkey.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.BottomSheetDefaults
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarData
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.wristkey.app.AccountDraft
import dev.wristkey.app.DEFAULT_CATEGORY
import dev.wristkey.app.MAX_ACCOUNT_NAME_LENGTH
import dev.wristkey.app.MAX_CATEGORY_LENGTH
import dev.wristkey.app.MAX_ISSUER_LENGTH
import dev.wristkey.app.MAX_PASSWORD_LENGTH
import dev.wristkey.app.OTP_TYPE_STEAM
import dev.wristkey.app.OTP_TYPE_TOTP
import dev.wristkey.app.SteamOtp
import dev.wristkey.app.SUPPORTED_ALGORITHMS
import dev.wristkey.app.stratum.StratumFormat
import dev.wristkey.app.toDraft
import dev.wristkey.app.WristKeyAccount
import dev.wristkey.app.pattern.PatternPin
import dev.wristkey.app.stratum.ImportMode
import dev.wristkey.app.ui.theme.Bg
import dev.wristkey.app.ui.theme.CodeTextStyle
import dev.wristkey.app.ui.theme.CodeTextStyleSmall
import dev.wristkey.app.ui.theme.ErrorRed
import dev.wristkey.app.ui.theme.Mint
import dev.wristkey.app.ui.theme.OutlineColor
import dev.wristkey.app.ui.theme.SteamBlue
import dev.wristkey.app.ui.theme.SurfaceDark
import dev.wristkey.app.ui.theme.SurfaceHigh
import dev.wristkey.app.ui.theme.TextDim
import dev.wristkey.app.ui.theme.TextPrimary
import dev.wristkey.app.ui.theme.Warning
import dev.wristkey.app.ui.theme.WristKeyTheme
import kotlinx.coroutines.delay

/**
 * v2.0 主界面：深色薄荷绿、3 Tab（账号 / 同步 / 设置）+ 全屏编辑器 + 入口图案设置页。
 * 所有状态来自 [AppUiState]，动作经 [AppActions] 回调给 MainActivity。
 */
@Composable
fun WristKeyApp(state: AppUiState, actions: AppActions) {
    WristKeyTheme {
        val snackbarHostState = remember { SnackbarHostState() }
        LaunchedEffect(state.lastEvent) {
            if (state.lastEvent.isNotBlank()) {
                snackbarHostState.showSnackbar(state.lastEvent)
            }
        }

        BackHandler(enabled = state.editorVisible) { actions.onEditorClose() }
        BackHandler(enabled = !state.editorVisible && state.page == AppPage.PATTERN) {
            actions.onPatternPageBack()
        }

        if (state.editorVisible) {
            Box(Modifier.fillMaxSize().background(Bg)) {
                EditorScreen(state = state, actions = actions)
                SnackbarHost(
                    hostState = snackbarHostState,
                    modifier = Modifier.align(Alignment.BottomCenter),
                ) { data -> AppSnackbar(data) }
            }
            return@WristKeyTheme
        }

        if (state.page == AppPage.PATTERN) {
            Box(Modifier.fillMaxSize().background(Bg)) {
                PatternScreen(state = state, actions = actions)
                SnackbarHost(
                    hostState = snackbarHostState,
                    modifier = Modifier.align(Alignment.BottomCenter),
                ) { data -> AppSnackbar(data) }
            }
            return@WristKeyTheme
        }

        Scaffold(
            containerColor = Bg,
            snackbarHost = {
                SnackbarHost(hostState = snackbarHostState) { data -> AppSnackbar(data) }
            },
            bottomBar = {
                NavigationBar(containerColor = SurfaceDark, tonalElevation = 0.dp) {
                    MainTab.entries.forEach { tab ->
                        NavigationBarItem(
                            selected = state.page == tab.page,
                            onClick = { actions.onPageSelected(tab.page) },
                            icon = { Icon(tab.icon, contentDescription = tab.label) },
                            label = { Text(tab.label, style = MaterialTheme.typography.labelMedium) },
                        )
                    }
                }
            },
            floatingActionButton = {
                if (state.page == AppPage.ACCOUNTS) {
                    Surface(
                        onClick = actions.onImportSheetOpen,
                        shape = RoundedCornerShape(18.dp),
                        color = Mint,
                        contentColor = Color(0xFF06201A),
                    ) {
                        Row(
                            modifier = Modifier.padding(horizontal = 20.dp, vertical = 14.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(Icons.Default.Add, contentDescription = null)
                            Spacer(Modifier.width(8.dp))
                            Text(
                                "导入",
                                style = MaterialTheme.typography.labelLarge,
                                fontWeight = FontWeight.SemiBold,
                            )
                        }
                    }
                }
            },
        ) { innerPadding ->
            Box(Modifier.fillMaxSize().padding(innerPadding)) {
                when (state.page) {
                    AppPage.ACCOUNTS -> AccountsScreen(state = state, actions = actions)
                    AppPage.SYNC -> SyncScreen(state = state, actions = actions)
                    AppPage.SETTINGS -> SettingsScreen(state = state, actions = actions)
                    AppPage.PATTERN -> Unit
                }
            }
        }

        if (state.importSheetVisible) {
            ImportEntriesSheet(actions = actions)
        }
        if (state.importState.readyForReview) {
            ImportPreviewSheet(state = state, actions = actions)
        }
        if (state.passwordDialogVisible) {
            PasswordDialog(state = state, actions = actions)
        }
        if (state.otpAuthDialogVisible) {
            OtpAuthDialog(state = state, actions = actions)
        }
        state.detailAccount?.let { account ->
            AccountDetailSheet(account = account, state = state, actions = actions)
        }
    }
}

private enum class MainTab(val page: AppPage, val label: String, val icon: ImageVector) {
    ACCOUNTS(AppPage.ACCOUNTS, "账号", Icons.Default.Lock),
    SYNC(AppPage.SYNC, "同步", Icons.Default.Refresh),
    SETTINGS(AppPage.SETTINGS, "设置", Icons.Default.Settings),
}

@Composable
private fun AppSnackbar(data: SnackbarData) {
    Snackbar(
        snackbarData = data,
        containerColor = SurfaceHigh,
        contentColor = TextPrimary,
        shape = RoundedCornerShape(14.dp),
    )
}

// ===================================================================== 账号页

@Composable
private fun AccountsScreen(state: AppUiState, actions: AppActions) {
    val now by produceState(initialValue = System.currentTimeMillis()) {
        while (true) {
            value = System.currentTimeMillis()
            delay(250)
        }
    }
    val keyboard = LocalSoftwareKeyboardController.current

    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        Column(Modifier.padding(start = 20.dp, end = 20.dp, top = 14.dp, bottom = 4.dp)) {
            Text("腕证", style = MaterialTheme.typography.headlineMedium, color = TextPrimary)
            Text(
                "离线验证码 · " + state.accountCount + " 个账号",
                style = MaterialTheme.typography.bodySmall,
                color = TextDim,
            )
            Spacer(Modifier.height(14.dp))
            OutlinedTextField(
                value = state.searchKeyword,
                onValueChange = { value ->
                    actions.onSearchChange(value)
                    if (value.isEmpty()) {
                        keyboard?.hide()
                    }
                },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                shape = RoundedCornerShape(16.dp),
                placeholder = { Text("搜索 issuer / 账号 / 分类") },
                leadingIcon = {
                    Icon(
                        Icons.Default.Search,
                        contentDescription = null,
                        tint = TextDim,
                        modifier = Modifier.size(20.dp),
                    )
                },
                colors = fieldColors(),
            )
        }

        when {
            state.accounts.isEmpty() -> EmptyAccounts(actions = actions)
            state.filteredAccounts.isEmpty() -> {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text(
                        "没有匹配的账号",
                        style = MaterialTheme.typography.bodyMedium,
                        color = TextDim,
                    )
                }
            }

            else -> LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 10.dp, bottom = 120.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                items(items = state.filteredAccounts, key = { account -> account.id }) { account ->
                    AccountCard(
                        account = account,
                        now = now,
                        onClick = { actions.onDetailOpen(account.id) },
                        modifier = Modifier.animateItem(),
                    )
                }
            }
        }
    }
}

@Composable
private fun AccountCard(
    account: WristKeyAccount,
    now: Long,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val period = if (account.isSteam) SteamOtp.PERIOD else account.period
    val remaining = account.remainingSeconds(now)
    val progress = if (period <= 0) 0f else remaining.toFloat() / period.toFloat()

    Surface(
        onClick = onClick,
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(24.dp),
        color = SurfaceDark,
    ) {
        Column(Modifier.padding(horizontal = 18.dp, vertical = 16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            account.issuer.ifBlank { "未命名" },
                            style = MaterialTheme.typography.titleMedium,
                            color = TextPrimary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        if (account.isSteam) {
                            Spacer(Modifier.width(8.dp))
                            SteamTag()
                        }
                    }
                    if (account.accountName.isNotBlank()) {
                        Text(
                            account.accountName,
                            style = MaterialTheme.typography.bodySmall,
                            color = TextDim,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                Text(
                    remaining.toString() + "s",
                    style = MaterialTheme.typography.bodySmall,
                    color = TextDim,
                    fontFamily = FontFamily.Monospace,
                )
            }
            Spacer(Modifier.height(8.dp))
            Text(
                account.currentCode(now),
                style = CodeTextStyle,
                color = Mint,
                maxLines = 1,
            )
            Spacer(Modifier.height(12.dp))
            LinearProgressIndicator(
                progress = { progress.coerceIn(0f, 1f) },
                modifier = Modifier.fillMaxWidth().height(3.dp).clip(RoundedCornerShape(3.dp)),
                color = Mint,
                trackColor = OutlineColor,
            )
        }
    }
}

@Composable
private fun SteamTag() {
    Surface(color = SteamBlue.copy(alpha = 0.16f), shape = RoundedCornerShape(6.dp)) {
        Text(
            "STEAM",
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
            style = MaterialTheme.typography.labelMedium,
            color = SteamBlue,
            fontSize = 10.sp,
        )
    }
}

@Composable
private fun EmptyAccounts(actions: AppActions) {
    Column(
        modifier = Modifier.fillMaxSize().padding(horizontal = 32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Surface(shape = CircleShape, color = SurfaceHigh, modifier = Modifier.size(84.dp)) {
            Box(contentAlignment = Alignment.Center) {
                Icon(
                    Icons.Default.Lock,
                    contentDescription = null,
                    tint = Mint,
                    modifier = Modifier.size(34.dp),
                )
            }
        }
        Spacer(Modifier.height(20.dp))
        Text("还没有账号", style = MaterialTheme.typography.titleLarge, color = TextPrimary)
        Spacer(Modifier.height(8.dp))
        Text(
            "从 Stratum 备份或 Bitwarden 导出导入，\n也可以手动添加或粘贴 otpauth 链接。",
            style = MaterialTheme.typography.bodyMedium,
            color = TextDim,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(22.dp))
        Button(
            onClick = actions.onImportSheetOpen,
            shape = RoundedCornerShape(16.dp),
            modifier = Modifier.fillMaxWidth(0.7f).height(50.dp),
        ) {
            Text("导入备份")
        }
        Spacer(Modifier.height(120.dp))
    }
}

@Composable
private fun fieldColors() = OutlinedTextFieldDefaults.colors(
    focusedBorderColor = Mint,
    unfocusedBorderColor = OutlineColor,
    focusedContainerColor = SurfaceDark,
    unfocusedContainerColor = SurfaceDark,
    focusedTextColor = TextPrimary,
    unfocusedTextColor = TextPrimary,
    cursorColor = Mint,
    focusedPlaceholderColor = TextDim,
    unfocusedPlaceholderColor = TextDim,
    focusedLabelColor = Mint,
    unfocusedLabelColor = TextDim,
    errorBorderColor = ErrorRed,
)

// ===================================================================== 导入弹层与对话框

@Composable
private fun ImportEntriesSheet(actions: AppActions) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = actions.onImportSheetDismiss,
        sheetState = sheetState,
        containerColor = SurfaceDark,
        dragHandle = { BottomSheetDefaults.DragHandle(color = OutlineColor) },
    ) {
        Column(
            Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, bottom = 28.dp),
        ) {
            Text("导入账号", style = MaterialTheme.typography.titleLarge, color = TextPrimary)
            Spacer(Modifier.height(4.dp))
            Text(
                "选择一种来源，导入后可以先预览再决定合并方式。",
                style = MaterialTheme.typography.bodySmall,
                color = TextDim,
            )
            Spacer(Modifier.height(16.dp))
            ImportEntry(
                title = "Stratum 备份",
                subtitle = "加密或明文的 .stratum / .json 文件",
                onClick = actions.onPickBackup,
            )
            Spacer(Modifier.height(10.dp))
            ImportEntry(
                title = "Bitwarden 导出",
                subtitle = "未加密的 JSON 导出文件",
                onClick = actions.onPickBackup,
            )
            Spacer(Modifier.height(10.dp))
            ImportEntry(
                title = "otpauth 链接",
                subtitle = "粘贴一条或多条 otpauth:// 链接",
                onClick = actions.onOtpAuthDialogOpen,
            )
            Spacer(Modifier.height(10.dp))
            ImportEntry(
                title = "手动添加",
                subtitle = "手工填写 issuer、账号与 secret",
                onClick = actions.onManualAdd,
            )
        }
    }
}

@Composable
private fun ImportEntry(title: String, subtitle: String, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(18.dp),
        color = SurfaceHigh,
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleMedium, color = TextPrimary)
                Text(subtitle, style = MaterialTheme.typography.bodySmall, color = TextDim)
            }
            Icon(
                Icons.Default.KeyboardArrowDown,
                contentDescription = null,
                tint = Mint,
                modifier = Modifier.size(20.dp),
            )
        }
    }
}

@Composable
private fun ImportPreviewSheet(state: AppUiState, actions: AppActions) {
    val importState = state.importState
    val result = importState.result ?: return
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = actions.onImportDiscard,
        sheetState = sheetState,
        containerColor = SurfaceDark,
        dragHandle = { BottomSheetDefaults.DragHandle(color = OutlineColor) },
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(start = 20.dp, end = 20.dp, bottom = 28.dp)
                .verticalScroll(rememberScrollState()),
        ) {
            Text("导入预览", style = MaterialTheme.typography.titleLarge, color = TextPrimary)
            Spacer(Modifier.height(4.dp))
            Text(
                importFormatLabel(importState.format) + " · " + importState.fileName,
                style = MaterialTheme.typography.bodySmall,
                color = TextDim,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.height(16.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                StatCell("可导入", result.accounts.size.toString(), Mint, Modifier.weight(1f))
                StatCell("跳过", result.skipped.size.toString(), Warning, Modifier.weight(1f))
                StatCell("现有", state.accountCount.toString(), TextPrimary, Modifier.weight(1f))
            }
            if (importState.error != null) {
                Spacer(Modifier.height(12.dp))
                Text(importState.error, style = MaterialTheme.typography.bodySmall, color = ErrorRed)
            }
            if (result.skipped.isNotEmpty()) {
                Spacer(Modifier.height(14.dp))
                Text("跳过项", style = MaterialTheme.typography.labelLarge, color = Warning)
                Spacer(Modifier.height(6.dp))
                result.skipped.take(6).forEach { skip ->
                    val label = skip.issuer.ifBlank { "未命名" } + " · " +
                        skip.accountName.ifBlank { "-" } + "：" + skip.reason
                    Text(
                        label,
                        style = MaterialTheme.typography.bodySmall,
                        color = TextDim,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Spacer(Modifier.height(2.dp))
                }
                if (result.skipped.size > 6) {
                    Text(
                        "等共 " + result.skipped.size + " 项",
                        style = MaterialTheme.typography.bodySmall,
                        color = TextDim,
                    )
                }
            }
            Spacer(Modifier.height(18.dp))
            Button(
                onClick = { actions.onImportApply(ImportMode.MERGE) },
                modifier = Modifier.fillMaxWidth().height(50.dp),
                shape = RoundedCornerShape(16.dp),
            ) {
                Text("合并导入（同 secret 覆盖）")
            }
            Spacer(Modifier.height(10.dp))
            OutlinedButton(
                onClick = { actions.onImportApply(ImportMode.REPLACE) },
                modifier = Modifier.fillMaxWidth().height(50.dp),
                shape = RoundedCornerShape(16.dp),
                border = BorderStroke(1.dp, OutlineColor),
            ) {
                Text("全量替换现有账号", color = TextPrimary)
            }
            Spacer(Modifier.height(6.dp))
            TextButton(
                onClick = actions.onImportDiscard,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("取消", color = TextDim)
            }
        }
    }
}

@Composable
private fun StatCell(label: String, value: String, color: Color, modifier: Modifier = Modifier) {
    Surface(modifier = modifier, shape = RoundedCornerShape(16.dp), color = SurfaceHigh) {
        Column(Modifier.padding(vertical = 12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(value, style = MaterialTheme.typography.titleLarge, color = color)
            Text(label, style = MaterialTheme.typography.bodySmall, color = TextDim)
        }
    }
}

private fun importFormatLabel(format: StratumFormat?): String = when (format) {
    StratumFormat.STRONG, StratumFormat.LEGACY -> "Stratum 加密备份"
    StratumFormat.PLAIN_JSON -> "Stratum 明文备份"
    StratumFormat.URI_LIST -> "otpauth 链接列表"
    StratumFormat.BITWARDEN -> "Bitwarden 导出"
    StratumFormat.BITWARDEN_ENCRYPTED -> "Bitwarden 加密导出"
    StratumFormat.HTML -> "HTML 导出（不支持）"
    StratumFormat.UNKNOWN, null -> "未知格式"
}

@Composable
private fun PasswordDialog(state: AppUiState, actions: AppActions) {
    var password by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = actions.onPasswordDismiss,
        containerColor = SurfaceDark,
        title = { Text("输入备份密码", color = TextPrimary) },
        text = {
            Column {
                Text(
                    "加密的 Stratum 备份需要密码才能解密，密码只在本次导入过程中使用，不会保存。",
                    style = MaterialTheme.typography.bodySmall,
                    color = TextDim,
                )
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    label = { Text("密码") },
                    visualTransformation = PasswordVisualTransformation(),
                    colors = fieldColors(),
                )
                if (state.passwordError != null) {
                    Spacer(Modifier.height(8.dp))
                    Text(state.passwordError, style = MaterialTheme.typography.bodySmall, color = ErrorRed)
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { actions.onPasswordSubmit(password) }) {
                Text("解密", color = Mint)
            }
        },
        dismissButton = {
            TextButton(onClick = actions.onPasswordDismiss) {
                Text("取消", color = TextDim)
            }
        },
    )
}

@Composable
private fun OtpAuthDialog(state: AppUiState, actions: AppActions) {
    var text by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = actions.onOtpAuthDialogDismiss,
        containerColor = SurfaceDark,
        title = { Text("粘贴 otpauth 链接", color = TextPrimary) },
        text = {
            Column {
                Text(
                    "支持每行一条 otpauth://totp/...，Steam 链接会自动识别。",
                    style = MaterialTheme.typography.bodySmall,
                    color = TextDim,
                )
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    modifier = Modifier.fillMaxWidth().height(140.dp),
                    label = { Text("otpauth 链接") },
                    maxLines = 8,
                    colors = fieldColors(),
                )
                if (state.editorError != null) {
                    Spacer(Modifier.height(8.dp))
                    Text(state.editorError, style = MaterialTheme.typography.bodySmall, color = ErrorRed)
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { actions.onOtpAuthSubmit(text) }) {
                Text("解析", color = Mint)
            }
        },
        dismissButton = {
            TextButton(onClick = actions.onOtpAuthDialogDismiss) {
                Text("取消", color = TextDim)
            }
        },
    )
}


// ===================================================================== 账号详情

@Composable
private fun AccountDetailSheet(account: WristKeyAccount, state: AppUiState, actions: AppActions) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var revealed by remember(account.id) { mutableStateOf(false) }
    var confirmDelete by remember(account.id) { mutableStateOf(false) }
    val now by produceState(initialValue = System.currentTimeMillis()) {
        while (true) {
            value = System.currentTimeMillis()
            delay(250)
        }
    }

    LaunchedEffect(revealed) {
        if (revealed) {
            delay(10_000)
            revealed = false
        }
    }

    ModalBottomSheet(
        onDismissRequest = actions.onDetailClose,
        sheetState = sheetState,
        containerColor = SurfaceDark,
        dragHandle = { BottomSheetDefaults.DragHandle(color = OutlineColor) },
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(start = 20.dp, end = 20.dp, bottom = 28.dp)
                .verticalScroll(rememberScrollState()),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(
                        account.displayTitle,
                        style = MaterialTheme.typography.titleLarge,
                        color = TextPrimary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        account.categoryLabel + " · " + if (account.isSteam) "Steam Guard" else "TOTP",
                        style = MaterialTheme.typography.bodySmall,
                        color = TextDim,
                    )
                }
                IconButton(onClick = actions.onDetailClose) {
                    Icon(Icons.Default.Close, contentDescription = "关闭", tint = TextDim)
                }
            }
            Spacer(Modifier.height(14.dp))
            DetailField(
                label = "用户名",
                value = account.accountName.ifBlank { "未填写" },
                dim = account.accountName.isBlank(),
            ) { actions.onCopy(account.accountName) }

            Spacer(Modifier.height(10.dp))
            DetailField(
                label = "密码",
                value = when {
                    account.password.isEmpty() -> "未保存"
                    revealed -> account.password
                    else -> "••••••••"
                },
                dim = account.password.isEmpty(),
                onClick = if (account.password.isEmpty()) null else ({ revealed = !revealed }),
            ) { if (account.password.isNotEmpty()) actions.onCopy(account.password) }
            if (revealed) {
                Text(
                    "10s 后自动隐藏",
                    style = MaterialTheme.typography.bodySmall,
                    color = TextDim,
                    modifier = Modifier.padding(start = 4.dp, top = 4.dp),
                )
            }

            Spacer(Modifier.height(20.dp))
            Surface(shape = RoundedCornerShape(20.dp), color = SurfaceHigh, modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(18.dp)) {
                    Text("验证码", style = MaterialTheme.typography.bodySmall, color = TextDim)
                    Spacer(Modifier.height(6.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(account.currentCode(now), style = CodeTextStyleSmall, color = Mint)
                        Spacer(Modifier.weight(1f))
                        Text(
                            account.remainingSeconds(now).toString() + "s",
                            style = MaterialTheme.typography.bodySmall,
                            color = TextDim,
                            fontFamily = FontFamily.Monospace,
                        )
                        Spacer(Modifier.width(6.dp))
                        IconButton(onClick = { actions.onCopy(account.currentCode(now)) }) {
                            Icon(Icons.Default.Add, contentDescription = "复制验证码", tint = Mint)
                        }
                    }
                    LinearProgressIndicator(
                        progress = {
                            val period = if (account.isSteam) 30 else account.period
                            if (period <= 0) 0f else account.remainingSeconds(now).toFloat() / period.toFloat()
                        },
                        modifier = Modifier.fillMaxWidth().height(3.dp).clip(RoundedCornerShape(3.dp)),
                        color = Mint,
                        trackColor = OutlineColor,
                    )
                }
            }

            Spacer(Modifier.height(18.dp))
            Button(
                onClick = { actions.onEditorOpen(account) },
                modifier = Modifier.fillMaxWidth().height(50.dp),
                shape = RoundedCornerShape(16.dp),
            ) {
                Text("编辑")
            }
            Spacer(Modifier.height(10.dp))
            OutlinedButton(
                onClick = { confirmDelete = true },
                modifier = Modifier.fillMaxWidth().height(50.dp),
                shape = RoundedCornerShape(16.dp),
                border = BorderStroke(1.dp, ErrorRed.copy(alpha = 0.5f)),
            ) {
                Text("删除", color = ErrorRed)
            }
        }
    }

    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            containerColor = SurfaceDark,
            title = { Text("删除账号？", color = TextPrimary) },
            text = {
                Text(
                    "将从手机中删除「" + account.displayTitle + "」，下次同步也会从手环移除。",
                    style = MaterialTheme.typography.bodyMedium,
                    color = TextDim,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmDelete = false
                    actions.onDeleteAccount(account)
                }) {
                    Text("删除", color = ErrorRed)
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmDelete = false }) {
                    Text("取消", color = TextDim)
                }
            },
        )
    }
}

@Composable
private fun DetailField(
    label: String,
    value: String,
    dim: Boolean = false,
    onClick: (() -> Unit)? = null,
    onCopy: () -> Unit,
) {
    val contentColor = if (dim) TextDim else TextPrimary
    Surface(
        onClick = onClick ?: {},
        enabled = onClick != null,
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(18.dp),
        color = SurfaceHigh,
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(label, style = MaterialTheme.typography.bodySmall, color = TextDim)
                Spacer(Modifier.height(2.dp))
                Text(
                    value,
                    style = MaterialTheme.typography.bodyLarge,
                    color = contentColor,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            TextButton(onClick = onCopy, enabled = !dim) {
                Text(
                    "复制",
                    style = MaterialTheme.typography.labelLarge,
                    color = if (dim) TextDim else Mint,
                )
            }
        }
    }
}

// ===================================================================== 全屏编辑器

@Composable
private fun EditorScreen(state: AppUiState, actions: AppActions) {
    val draft = state.draft
    var advancedOpen by remember(draft.id) { mutableStateOf(false) }
    var secretVisible by remember(draft.id) { mutableStateOf(false) }
    var passwordVisible by remember(draft.id) { mutableStateOf(false) }
    var otpLink by remember(draft.id) { mutableStateOf("") }
    var otpError by remember(draft.id) { mutableStateOf<String?>(null) }

    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = actions.onEditorClose) {
                Icon(Icons.Default.ArrowBack, contentDescription = "返回", tint = TextPrimary)
            }
            Text(
                if (draft.isEditing) "编辑账号" else "新增账号",
                style = MaterialTheme.typography.titleLarge,
                color = TextPrimary,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = actions.onSaveDraft) {
                Text("保存", color = Mint, fontWeight = FontWeight.SemiBold)
            }
        }

        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp),
        ) {
            if (!draft.isEditing) {
                Text("从 otpauth 链接填充", style = MaterialTheme.typography.labelLarge, color = TextDim)
                Spacer(Modifier.height(6.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(
                        value = otpLink,
                        onValueChange = {
                            otpLink = it
                            otpError = null
                        },
                        modifier = Modifier.weight(1f),
                        singleLine = true,
                        placeholder = { Text("otpauth://totp/...") },
                        colors = fieldColors(),
                    )
                    Spacer(Modifier.width(8.dp))
                    TextButton(onClick = {
                        try {
                            val parsed = dev.wristkey.app.OtpAuthParser.parse(
                                otpLink,
                                System.currentTimeMillis(),
                            )
                            actions.onDraftChange(parsed.toDraft())
                            otpLink = ""
                            otpError = null
                        } catch (exception: dev.wristkey.app.OtpAuthParseException) {
                            otpError = exception.message
                        } catch (exception: IllegalArgumentException) {
                            otpError = exception.message
                        }
                    }) {
                        Text("解析", color = Mint)
                    }
                }
                if (otpError != null) {
                    Text(otpError!!, style = MaterialTheme.typography.bodySmall, color = ErrorRed)
                }
                Spacer(Modifier.height(14.dp))
            }

            LabeledField("服务（issuer）") {
                OutlinedTextField(
                    value = draft.issuer,
                    onValueChange = { value ->
                        actions.onDraftChange(draft.copy(issuer = value.take(MAX_ISSUER_LENGTH)))
                    },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    placeholder = { Text("例如 GitHub") },
                    colors = fieldColors(),
                )
            }
            LabeledField("账号（accountName）") {
                OutlinedTextField(
                    value = draft.accountName,
                    onValueChange = { value ->
                        actions.onDraftChange(draft.copy(accountName = value.take(MAX_ACCOUNT_NAME_LENGTH)))
                    },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    placeholder = { Text("例如 user@example.com") },
                    colors = fieldColors(),
                )
            }
            LabeledField("密码（可选）") {
                OutlinedTextField(
                    value = draft.password,
                    onValueChange = { value ->
                        actions.onDraftChange(draft.copy(password = value.take(MAX_PASSWORD_LENGTH)))
                    },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    placeholder = { Text("保存到手机，同步到手环供查看") },
                    visualTransformation = if (passwordVisible) {
                        VisualTransformation.None
                    } else {
                        PasswordVisualTransformation()
                    },
                    trailingIcon = {
                        TextButton(onClick = { passwordVisible = !passwordVisible }) {
                            Text(if (passwordVisible) "隐藏" else "显示", color = Mint)
                        }
                    },
                    colors = fieldColors(),
                )
            }
            LabeledField("Secret（Base32）") {
                OutlinedTextField(
                    value = draft.secret,
                    onValueChange = { value -> actions.onDraftChange(draft.copy(secret = value)) },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    placeholder = { Text("JBSWY3DPEHPK3PXP") },
                    visualTransformation = if (secretVisible) {
                        VisualTransformation.None
                    } else {
                        MaskedTransformation()
                    },
                    trailingIcon = {
                        TextButton(onClick = { secretVisible = !secretVisible }) {
                            Text(if (secretVisible) "隐藏" else "显示", color = Mint)
                        }
                    },
                    colors = fieldColors(),
                )
            }

            LabeledField("类型") {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    TypeChip(
                        label = "TOTP",
                        selected = draft.otpType == OTP_TYPE_TOTP,
                        onClick = {
                            actions.onDraftChange(
                                draft.copy(otpType = OTP_TYPE_TOTP, digits = "6", period = "30"),
                            )
                        },
                    )
                    TypeChip(
                        label = "Steam",
                        selected = draft.otpType == OTP_TYPE_STEAM,
                        onClick = {
                            actions.onDraftChange(
                                draft.copy(
                                    otpType = OTP_TYPE_STEAM,
                                    algorithm = "SHA1",
                                    digits = "5",
                                    period = "30",
                                ),
                            )
                        },
                    )
                }
            }

            Spacer(Modifier.height(6.dp))
            Surface(
                onClick = { advancedOpen = !advancedOpen },
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(16.dp),
                color = SurfaceHigh,
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("高级参数", style = MaterialTheme.typography.bodyLarge, color = TextPrimary)
                    Spacer(Modifier.weight(1f))
                    Icon(
                        if (advancedOpen) Icons.Default.KeyboardArrowUp else Icons.Default.KeyboardArrowDown,
                        contentDescription = null,
                        tint = TextDim,
                    )
                }
            }
            if (advancedOpen) {
                Spacer(Modifier.height(10.dp))
                LabeledField("算法") {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        SUPPORTED_ALGORITHMS.forEach { algorithm ->
                            TypeChip(
                                label = algorithm,
                                selected = draft.algorithm == algorithm,
                                onClick = { actions.onDraftChange(draft.copy(algorithm = algorithm)) },
                            )
                        }
                    }
                }
                LabeledField("位数") {
                    OutlinedTextField(
                        value = draft.digits,
                        onValueChange = { value ->
                            actions.onDraftChange(draft.copy(digits = value.filter { it.isDigit() }.take(2)))
                        },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        placeholder = { Text("6") },
                        colors = fieldColors(),
                    )
                }
                LabeledField("周期（秒）") {
                    OutlinedTextField(
                        value = draft.period,
                        onValueChange = { value ->
                            actions.onDraftChange(draft.copy(period = value.filter { it.isDigit() }.take(3)))
                        },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        placeholder = { Text("30") },
                        colors = fieldColors(),
                    )
                }
            }
            LabeledField("分类") {
                OutlinedTextField(
                    value = draft.category,
                    onValueChange = { value ->
                        actions.onDraftChange(draft.copy(category = value.take(MAX_CATEGORY_LENGTH)))
                    },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    placeholder = { Text("默认分类：" + DEFAULT_CATEGORY) },
                    colors = fieldColors(),
                )
            }

            if (state.editorError != null) {
                Text(
                    state.editorError,
                    style = MaterialTheme.typography.bodySmall,
                    color = ErrorRed,
                    modifier = Modifier.padding(vertical = 8.dp),
                )
            }
            Spacer(Modifier.height(28.dp))
        }
    }
}

@Composable
private fun LabeledField(label: String, content: @Composable () -> Unit) {
    Text(label, style = MaterialTheme.typography.bodySmall, color = TextDim)
    Spacer(Modifier.height(6.dp))
    content()
    Spacer(Modifier.height(14.dp))
}

@Composable
private fun TypeChip(label: String, selected: Boolean, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(12.dp),
        color = if (selected) Mint.copy(alpha = 0.16f) else SurfaceHigh,
        border = if (selected) BorderStroke(1.dp, Mint) else null,
    ) {
        Text(
            label,
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
            style = MaterialTheme.typography.labelLarge,
            color = if (selected) Mint else TextDim,
        )
    }
}

private class MaskedTransformation : VisualTransformation {
    override fun filter(text: AnnotatedString): TransformedText {
        val masked = "•".repeat(text.text.length.coerceAtLeast(0))
        return TransformedText(
            AnnotatedString(masked),
            OffsetMapping.Identity,
        )
    }
}


// ===================================================================== 同步页

@Composable
private fun SyncScreen(state: AppUiState, actions: AppActions) {
    val sync = state.sync
    var confirmDisablePin by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        Column(Modifier.padding(start = 20.dp, end = 20.dp, top = 14.dp)) {
            Text("同步", style = MaterialTheme.typography.headlineMedium, color = TextPrimary)
            Text(
                "通过小米穿戴服务把账号发送到手环",
                style = MaterialTheme.typography.bodySmall,
                color = TextDim,
            )
            Spacer(Modifier.height(16.dp))
        }

        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp),
        ) {
            Surface(shape = RoundedCornerShape(24.dp), color = SurfaceDark, modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(18.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(
                                sync.nodeName,
                                style = MaterialTheme.typography.titleMedium,
                                color = TextPrimary,
                            )
                            Text(
                                if (sync.hasConnectedDevice) sync.nodeId else "尚未连接手环",
                                style = MaterialTheme.typography.bodySmall,
                                color = TextDim,
                            )
                        }
                        IconButton(onClick = actions.onRefreshConnection) {
                            Icon(Icons.Default.Refresh, contentDescription = "刷新", tint = TextDim)
                        }
                    }
                    Spacer(Modifier.height(12.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        StatusPill(
                            label = "服务",
                            detail = if (sync.serviceStatus.contains("已连接")) "已连接" else "未连接",
                            ok = sync.hasConnectedDevice || sync.serviceStatus.contains("已连接"),
                            modifier = Modifier.weight(1f),
                            onClick = actions.onRefreshConnection,
                        )
                        StatusPill(
                            label = "连接",
                            detail = if (sync.hasConnectedDevice) "已连接" else "未连接",
                            ok = sync.hasConnectedDevice,
                            modifier = Modifier.weight(1f),
                            onClick = actions.onRefreshConnection,
                        )
                        StatusPill(
                            label = "权限",
                            detail = if (sync.hasDeviceManagerPermission) "已授权" else "未授权",
                            ok = sync.hasDeviceManagerPermission,
                            modifier = Modifier.weight(1f),
                            onClick = actions.onRequestPermission,
                        )
                        StatusPill(
                            label = "手环应用",
                            detail = when (sync.wearAppInstalled) {
                                true -> "已安装"
                                false -> "未安装"
                                null -> "未知"
                            },
                            ok = sync.wearAppInstalled == true,
                            modifier = Modifier.weight(1f),
                            onClick = actions.onRefreshConnection,
                        )
                    }
                    Spacer(Modifier.height(16.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        OutlinedButton(
                            onClick = actions.onRequestPermission,
                            modifier = Modifier.weight(1f).height(46.dp),
                            shape = RoundedCornerShape(14.dp),
                            border = BorderStroke(1.dp, OutlineColor),
                        ) {
                            Text("授权", color = TextPrimary)
                        }
                        OutlinedButton(
                            onClick = actions.onLaunchWearApp,
                            modifier = Modifier.weight(1f).height(46.dp),
                            shape = RoundedCornerShape(14.dp),
                            border = BorderStroke(1.dp, OutlineColor),
                        ) {
                            Text("打开手环", color = TextPrimary)
                        }
                    }
                    Spacer(Modifier.height(10.dp))
                    if (sync.sending) {
                        Column {
                            Text(
                                "正在发送 " + sync.sent + "/" + sync.total,
                                style = MaterialTheme.typography.bodySmall,
                                color = TextDim,
                            )
                            Spacer(Modifier.height(8.dp))
                            LinearProgressIndicator(
                                progress = {
                                    if (sync.total <= 0) {
                                        0f
                                    } else {
                                        sync.sent.toFloat() / sync.total.toFloat()
                                    }
                                },
                                modifier = Modifier.fillMaxWidth().height(4.dp)
                                    .clip(RoundedCornerShape(4.dp)),
                                color = Mint,
                                trackColor = OutlineColor,
                            )
                            Spacer(Modifier.height(8.dp))
                            Text(sync.syncStatus, style = MaterialTheme.typography.bodySmall, color = TextDim)
                        }
                    } else {
                        Button(
                            onClick = actions.onSyncAll,
                            modifier = Modifier.fillMaxWidth().height(50.dp),
                            shape = RoundedCornerShape(16.dp),
                        ) {
                            Text("立即同步")
                        }
                        Spacer(Modifier.height(8.dp))
                        Text(
                            sync.syncStatus,
                            style = MaterialTheme.typography.bodySmall,
                            color = TextDim,
                        )
                    }
                    if (sync.lastAck.isNotBlank()) {
                        Spacer(Modifier.height(6.dp))
                        Text(
                            "上次确认：" + sync.lastAck,
                            style = MaterialTheme.typography.bodySmall,
                            color = Mint,
                        )
                    }
                    if (sync.ackHint.isNotBlank()) {
                        Spacer(Modifier.height(8.dp))
                        Surface(shape = RoundedCornerShape(12.dp), color = Warning.copy(alpha = 0.12f)) {
                            Text(
                                sync.ackHint,
                                modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                                style = MaterialTheme.typography.bodySmall,
                                color = Warning,
                            )
                        }
                    }
                }
            }

            Spacer(Modifier.height(14.dp))
            Surface(shape = RoundedCornerShape(24.dp), color = SurfaceDark, modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(18.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(
                                "入口图案",
                                style = MaterialTheme.typography.titleMedium,
                                color = TextPrimary,
                            )
                            Text(
                                when (sync.pinStatus) {
                                    PinStatus.ENABLED -> "已开启 · 打开手环应用需输入图案"
                                    PinStatus.DISABLED -> "未开启"
                                    PinStatus.UNKNOWN -> "连接手环后可查询状态"
                                },
                                style = MaterialTheme.typography.bodySmall,
                                color = when (sync.pinStatus) {
                                    PinStatus.ENABLED -> Mint
                                    PinStatus.DISABLED -> TextDim
                                    PinStatus.UNKNOWN -> TextDim
                                },
                            )
                        }
                        val dotColor = when (sync.pinStatus) {
                            PinStatus.ENABLED -> Mint
                            PinStatus.DISABLED -> TextDim
                            PinStatus.UNKNOWN -> Warning
                        }
                        Surface(color = dotColor.copy(alpha = 0.16f), shape = RoundedCornerShape(8.dp)) {
                            Text(
                                when (sync.pinStatus) {
                                    PinStatus.ENABLED -> "已开启"
                                    PinStatus.DISABLED -> "已关闭"
                                    PinStatus.UNKNOWN -> "未知"
                                },
                                modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
                                style = MaterialTheme.typography.labelMedium,
                                color = dotColor,
                            )
                        }
                    }
                    Spacer(Modifier.height(14.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Button(
                            onClick = actions.onPatternPageOpen,
                            modifier = Modifier.weight(1f).height(46.dp),
                            shape = RoundedCornerShape(14.dp),
                        ) {
                            Text(if (sync.pinStatus == PinStatus.ENABLED) "修改图案" else "设置入口图案")
                        }
                        if (sync.pinStatus == PinStatus.ENABLED) {
                            OutlinedButton(
                                onClick = { confirmDisablePin = true },
                                modifier = Modifier.weight(1f).height(46.dp),
                                shape = RoundedCornerShape(14.dp),
                                border = BorderStroke(1.dp, ErrorRed.copy(alpha = 0.5f)),
                            ) {
                                Text("关闭入口密码", color = ErrorRed)
                            }
                        } else {
                            OutlinedButton(
                                onClick = actions.onPinQuery,
                                modifier = Modifier.weight(1f).height(46.dp),
                                shape = RoundedCornerShape(14.dp),
                                border = BorderStroke(1.dp, OutlineColor),
                            ) {
                                Text("查询状态", color = TextPrimary)
                            }
                        }
                    }
                }
            }
            Spacer(Modifier.height(24.dp))
        }
    }
    if (confirmDisablePin) {
        AlertDialog(
            onDismissRequest = { confirmDisablePin = false },
            containerColor = SurfaceDark,
            title = { Text("关闭入口密码？", color = TextPrimary) },
            text = {
                Text(
                    "关闭后打开手环应用不再需要绘制图案，手环上的入口图案会被删除。",
                    color = TextDim,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmDisablePin = false
                    actions.onPinDisable()
                }) { Text("关闭", color = ErrorRed) }
            },
            dismissButton = {
                TextButton(onClick = { confirmDisablePin = false }) { Text("取消", color = TextDim) }
            },
        )
    }
}

@Composable
private fun StatusPill(
    label: String,
    detail: String,
    ok: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        onClick = onClick,
        modifier = modifier,
        shape = RoundedCornerShape(14.dp),
        color = if (ok) Mint.copy(alpha = 0.10f) else Warning.copy(alpha = 0.10f),
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 8.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                label,
                style = MaterialTheme.typography.bodySmall,
                color = TextDim,
                maxLines = 1,
            )
            Spacer(Modifier.height(2.dp))
            Text(
                detail,
                style = MaterialTheme.typography.labelMedium,
                color = if (ok) Mint else Warning,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

// ===================================================================== 设置页

@Composable
private fun SettingsScreen(state: AppUiState, actions: AppActions) {
    var confirmClear by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        Column(Modifier.padding(start = 20.dp, end = 20.dp, top = 14.dp)) {
            Text("设置", style = MaterialTheme.typography.headlineMedium, color = TextPrimary)
            Spacer(Modifier.height(16.dp))
        }
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp),
        ) {
            SectionTitle("数据")
            Surface(shape = RoundedCornerShape(22.dp), color = SurfaceDark, modifier = Modifier.fillMaxWidth()) {
                Column {
                    SettingRow(
                        title = "导入备份",
                        subtitle = "Stratum / Bitwarden / otpauth",
                        onClick = actions.onPickBackup,
                    )
                    HorizontalDivider()
                    SettingRow(
                        title = "账号数量",
                        subtitle = state.accountCount.toString() + " 个账号",
                        onClick = {},
                        showChevron = false,
                    )
                    HorizontalDivider()
                    SettingRow(
                        title = "清空账号",
                        subtitle = "从手机中删除全部账号，下次同步清空手环",
                        danger = true,
                        onClick = { confirmClear = true },
                    )
                }
            }

            Spacer(Modifier.height(18.dp))
            SectionTitle("安全")
            Surface(shape = RoundedCornerShape(22.dp), color = SurfaceDark, modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp)) {
                    Text(
                        "入口图案用于打开手环应用时验身，图案本身不会离开手机：手机只保存随机 salt 与 PBKDF2 派生值并发送给手环。",
                        style = MaterialTheme.typography.bodySmall,
                        color = TextDim,
                    )
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "账号密码保存在本机应用私有存储，仅通过小米穿戴服务同步到手环，请依赖系统锁屏与应用权限保护。",
                        style = MaterialTheme.typography.bodySmall,
                        color = TextDim,
                    )
                }
            }

            Spacer(Modifier.height(18.dp))
            SectionTitle("关于")
            Surface(shape = RoundedCornerShape(22.dp), color = SurfaceDark, modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp)) {
                    AboutRow("版本", state.versionName)
                    AboutRow("包名", "dev.wristkey.app")
                    Spacer(Modifier.height(8.dp))
                    Text("签名证书 SHA-256", style = MaterialTheme.typography.bodySmall, color = TextDim)
                    Text(
                        state.certFingerprint,
                        style = MaterialTheme.typography.bodySmall,
                        color = TextPrimary,
                    )
                    Spacer(Modifier.height(10.dp))
                    Text(
                        "所有验证码在手机与手环本地离线计算，不上传服务器；本项目为开源软件，按 Apache-2.0 许可发布，手环端为 Vela 快应用。",
                        style = MaterialTheme.typography.bodySmall,
                        color = TextDim,
                    )
                }
            }
            Spacer(Modifier.height(100.dp))
        }
    }

    if (confirmClear) {
        AlertDialog(
            onDismissRequest = { confirmClear = false },
            containerColor = SurfaceDark,
            title = { Text("清空全部账号？", color = TextPrimary) },
            text = {
                Text(
                    "将删除手机上的所有账号，并在下次同步时清空手环。此操作不可撤销。",
                    style = MaterialTheme.typography.bodyMedium,
                    color = TextDim,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmClear = false
                    actions.onClearAccounts()
                }) {
                    Text("清空", color = ErrorRed)
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmClear = false }) {
                    Text("取消", color = TextDim)
                }
            },
        )
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelLarge,
        color = TextDim,
        modifier = Modifier.padding(start = 4.dp, bottom = 8.dp),
    )
}

@Composable
private fun SettingRow(
    title: String,
    subtitle: String,
    onClick: () -> Unit,
    danger: Boolean = false,
    showChevron: Boolean = true,
) {
    Surface(
        onClick = onClick,
        color = SurfaceDark,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    title,
                    style = MaterialTheme.typography.bodyLarge,
                    color = if (danger) ErrorRed else TextPrimary,
                )
                Text(subtitle, style = MaterialTheme.typography.bodySmall, color = TextDim)
            }
            if (showChevron) {
                Icon(
                    Icons.Default.KeyboardArrowDown,
                    contentDescription = null,
                    tint = TextDim,
                    modifier = Modifier.size(18.dp),
                )
            }
        }
    }
}

@Composable
private fun AboutRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Text(label, style = MaterialTheme.typography.bodySmall, color = TextDim, modifier = Modifier.width(72.dp))
        Text(value, style = MaterialTheme.typography.bodySmall, color = TextPrimary)
    }
}

@Composable
private fun HorizontalDivider() {
    Box(Modifier.fillMaxWidth().height(1.dp).padding(horizontal = 16.dp).background(OutlineColor))
}


// ===================================================================== 入口图案设置页

@Composable
private fun PatternScreen(state: AppUiState, actions: AppActions) {
    val pattern = state.pattern
    val shake = remember { Animatable(0f) }
    val stage = pattern.stage
    val ready = stage == PatternStage.CONFIRM &&
        pattern.confirmInput.length == PatternPin.LENGTH &&
        pattern.input == pattern.confirmInput &&
        !pattern.saving

    LaunchedEffect(pattern.mismatchCounter) {
        if (pattern.mismatchCounter > 0) {
            repeat(3) {
                shake.animateTo(-14f, animationSpec = tween(45))
                shake.animateTo(14f, animationSpec = tween(45))
            }
            shake.animateTo(0f, animationSpec = tween(45))
        }
    }

    Column(
        Modifier.fillMaxSize().statusBarsPadding().padding(horizontal = 20.dp),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = actions.onPatternPageBack) {
                Icon(Icons.Default.ArrowBack, contentDescription = "返回", tint = TextPrimary)
            }
            Text(
                "入口图案",
                style = MaterialTheme.typography.titleLarge,
                color = TextPrimary,
                modifier = Modifier.weight(1f),
            )
        }

        Spacer(Modifier.weight(0.5f))
        Text(
            if (stage == PatternStage.ENTER) "绘制 5 位入口图案" else "再次绘制以确认",
            style = MaterialTheme.typography.titleLarge,
            color = TextPrimary,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            if (stage == PatternStage.ENTER) {
                "依次点选三角、方形或圆形，共 5 位"
            } else {
                "两次输入一致后才能保存"
            },
            style = MaterialTheme.typography.bodySmall,
            color = TextDim,
        )
        Spacer(Modifier.height(26.dp))
        Row(
            modifier = Modifier
                .offset(x = shake.value.dp)
                .fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterHorizontally),
        ) {
            repeat(PatternPin.LENGTH) { index ->
                val shape = if (index < pattern.display.length) pattern.display[index] else null
                PatternDot(shape)
            }
        }
        Spacer(Modifier.height(10.dp))
        Text(
            "已选 " + pattern.display.length + "/" + PatternPin.LENGTH,
            style = MaterialTheme.typography.bodySmall,
            color = TextDim,
            modifier = Modifier.fillMaxWidth(),
            textAlign = TextAlign.Center,
        )

        Spacer(Modifier.height(30.dp))
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(18.dp, Alignment.CenterHorizontally),
        ) {
            PatternButton(PatternPin.SHAPE_TRIANGLE[0]) { actions.onPatternInput(PatternPin.SHAPE_TRIANGLE.toString()) }
            PatternButton(PatternPin.SHAPE_SQUARE[0]) { actions.onPatternInput(PatternPin.SHAPE_SQUARE.toString()) }
            PatternButton(PatternPin.SHAPE_CIRCLE[0]) { actions.onPatternInput(PatternPin.SHAPE_CIRCLE.toString()) }
        }

        if (pattern.error != null) {
            Spacer(Modifier.height(12.dp))
            Text(
                pattern.error,
                style = MaterialTheme.typography.bodySmall,
                color = ErrorRed,
                modifier = Modifier.fillMaxWidth(),
                textAlign = TextAlign.Center,
            )
        }

        Spacer(Modifier.height(24.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedButton(
                onClick = actions.onPatternUndo,
                modifier = Modifier.weight(1f).height(48.dp),
                shape = RoundedCornerShape(16.dp),
                border = BorderStroke(1.dp, OutlineColor),
            ) {
                Text("撤销", color = TextPrimary)
            }
            OutlinedButton(
                onClick = actions.onPatternReset,
                modifier = Modifier.weight(1f).height(48.dp),
                shape = RoundedCornerShape(16.dp),
                border = BorderStroke(1.dp, OutlineColor),
            ) {
                Text("重来", color = TextPrimary)
            }
        }
        Spacer(Modifier.height(10.dp))
        Button(
            onClick = actions.onPatternSave,
            enabled = ready,
            modifier = Modifier.fillMaxWidth().height(50.dp),
            shape = RoundedCornerShape(16.dp),
        ) {
            if (pattern.saving) {
                CircularProgressIndicator(
                    modifier = Modifier.size(20.dp),
                    strokeWidth = 2.dp,
                    color = Color(0xFF06201A),
                )
                Spacer(Modifier.width(10.dp))
            }
            Text(if (pattern.saving) "正在保存…" else "保存入口图案")
        }
        Spacer(Modifier.weight(1f))
        Text(
            "手环只保存图案的派生值（PBKDF2），不会保存图案本身；忘记图案需要在手环上重置。",
            style = MaterialTheme.typography.bodySmall,
            color = TextDim,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().padding(bottom = 20.dp),
        )
    }
}

@Composable
private fun PatternDot(shape: Char?) {
    val color = when (shape) {
        'T' -> Mint
        'S' -> SteamBlue
        'C' -> Warning
        else -> null
    }
    Box(
        modifier = Modifier
            .size(46.dp)
            .clip(CircleShape)
            .background(if (color == null) SurfaceHigh else color.copy(alpha = 0.14f)),
        contentAlignment = Alignment.Center,
    ) {
        if (shape != null && color != null) {
            PatternShapeGlyph(shape = shape, color = color, size = 20.dp)
        } else {
            Box(
                Modifier
                    .size(8.dp)
                    .clip(CircleShape)
                    .background(OutlineColor),
            )
        }
    }
}

@Composable
private fun PatternButton(shape: Char, onClick: () -> Unit) {
    val color = when (shape) {
        'T' -> Mint
        'S' -> SteamBlue
        else -> Warning
    }
    Surface(
        onClick = onClick,
        shape = CircleShape,
        color = SurfaceHigh,
        modifier = Modifier.size(78.dp),
    ) {
        Box(contentAlignment = Alignment.Center) {
            PatternShapeGlyph(shape = shape, color = color, size = 34.dp)
        }
    }
}

@Composable
private fun PatternShapeGlyph(shape: Char, color: Color, size: androidx.compose.ui.unit.Dp) {
    androidx.compose.foundation.Canvas(Modifier.size(size)) {
        val width = this.size.width
        val height = this.size.height
        when (shape) {
            'T' -> {
                val path = Path()
                path.moveTo(width / 2f, height * 0.12f)
                path.lineTo(width * 0.92f, height * 0.86f)
                path.lineTo(width * 0.08f, height * 0.86f)
                path.close()
                drawPath(path, color)
            }

            'S' -> {
                val side = width * 0.74f
                drawRoundRect(
                    color = color,
                    topLeft = Offset((width - side) / 2f, (height - side) / 2f),
                    size = Size(side, side),
                    cornerRadius = CornerRadius(side * 0.12f, side * 0.12f),
                )
            }

            else -> {
                drawCircle(color = color, radius = width * 0.40f, center = Offset(width / 2f, height / 2f))
            }
        }
    }
}

