package com.flykhan.wristkey.sync

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.xiaomi.xms.wearable.Wearable
import com.xiaomi.xms.wearable.auth.AuthApi
import com.xiaomi.xms.wearable.auth.Permission
import com.xiaomi.xms.wearable.exception.AppNotInstalledException
import com.xiaomi.xms.wearable.exception.DeviceDisconnectedException
import com.xiaomi.xms.wearable.exception.PermissionDeniedException
import com.xiaomi.xms.wearable.exception.SignatureVerifyFailedException
import com.xiaomi.xms.wearable.message.MessageApi
import com.xiaomi.xms.wearable.message.OnMessageReceivedListener
import com.xiaomi.xms.wearable.node.Node
import com.xiaomi.xms.wearable.node.NodeApi
import com.xiaomi.xms.wearable.service.OnServiceConnectionListener
import com.xiaomi.xms.wearable.service.ServiceApi
import com.flykhan.wristkey.WristKeyAccount
import com.flykhan.wristkey.protocol.SyncProtocol

/**
 * 小米穿戴服务（xms-wearable-lib 1.4）连接管理与协议 v3 发送。
 *
 * - 发送：begin → account×N → commit，每条调用 `MessageApi.sendMessage(nodeId, bytes)`；
 *   任一步失败即中止，保留手机端账号数据不变。
 * - 入口图案（v3）：setPin（只发派生值）/ clearPin / queryPin。
 * - 接收：`MessageApi.addListener(nodeId, OnMessageReceivedListener)` 接收手环 ack / 重新同步请求 /
 *   pin_ack / pin_state。
 */
class WearableSyncController(
    context: Context,
    private val listener: Listener,
) {

    interface Listener {
        fun onConnectionStateChanged(state: ConnectionState)

        fun onSyncProgress(progress: SyncProgress)

        fun onAck(ack: SyncProtocol.Ack)

        fun onSyncRequest(requestId: String)

        /** `mfa_pin_ack`（v3）：设置/关闭入口图案的结果。 */
        fun onPinAck(info: SyncProtocol.PinAckInfo)

        /** `mfa_pin_state`（v3）：查询结果或手环端主动广播。 */
        fun onPinState(info: SyncProtocol.PinStateInfo)

        /** 入口图案消息发送失败（未连接/未授权/xms 异常）。 */
        fun onPinError(message: String)
    }

    data class ConnectionState(
        val serviceConnected: Boolean,
        val node: Node?,
        val hasDeviceManagerPermission: Boolean,
        val wearAppInstalled: Boolean?,
        val message: String,
    )

    data class SyncProgress(
        val running: Boolean,
        val sent: Int,
        val total: Int,
        val message: String,
        val finished: Boolean = false,
        val failed: Boolean = false,
    )

    private val appContext = context.applicationContext
    private val nodeApi: NodeApi = Wearable.getNodeApi(appContext)
    private val serviceApi: ServiceApi = Wearable.getServiceApi(appContext)
    private val authApi: AuthApi = Wearable.getAuthApi(appContext)
    private val messageApi: MessageApi = Wearable.getMessageApi(appContext)

    private var node: Node? = null
    private var serviceConnected = false
    private var hasDeviceManagerPermission = false
    private var wearAppInstalled: Boolean? = null
    private var listenerNodeId: String? = null
    private var syncing = false
    private var currentSyncId: String? = null

    private val mainHandler = Handler(Looper.getMainLooper())

    /** 进行中的入口图案操作（set/clear）；为空表示没有待确认的操作。 */
    private var pendingPinOperation: String? = null
    private var pendingPinMessage: String? = null
    private var pinAttempts = 0
    private var pinTimeout: Runnable? = null

    private val incomingListener = OnMessageReceivedListener { _, bytes ->
        handleIncoming(bytes)
    }

    private val serviceConnectionListener = object : OnServiceConnectionListener {
        override fun onServiceConnected() {
            serviceConnected = true
            publishConnection("服务已连接")
            refresh()
        }

        override fun onServiceDisconnected() {
            serviceConnected = false
            node = null
            hasDeviceManagerPermission = false
            wearAppInstalled = null
            detachMessageListener()
            if (pendingPinOperation != null) {
                failPinOperation("手环连接已断开，请重新连接后重试")
            } else {
                cancelPinOperation()
            }
            publishConnection("服务已断开")
        }
    }

    fun start() {
        serviceApi.registerServiceConnectionListener(serviceConnectionListener)
        refresh()
    }

    fun stop() {
        runCatching { serviceApi.unregisterServiceConnectionListener(serviceConnectionListener) }
        cancelPinOperation()
        detachMessageListener()
    }

    fun refresh() {
        nodeApi.connectedNodes
            .addOnSuccessListener { nodes ->
                val connected = nodes?.firstOrNull()
                node = connected
                if (connected == null) {
                    hasDeviceManagerPermission = false
                    wearAppInstalled = null
                    detachMessageListener()
                    publishConnection("未发现已连接设备")
                } else {
                    refreshPermission(connected)
                    refreshWearAppInstalled(connected)
                }
            }
            .addOnFailureListener { error ->
                node = null
                publishConnection("连接查询失败：${describeError(error)}")
            }
    }

    fun requestDeviceManagerPermission() {
        val connected = node ?: run {
            publishConnection("未连接手环")
            return
        }
        authApi.requestPermission(connected.id, Permission.DEVICE_MANAGER)
            .addOnSuccessListener { permissions ->
                hasDeviceManagerPermission = permissions?.any { it == Permission.DEVICE_MANAGER } == true
                if (hasDeviceManagerPermission) {
                    attachMessageListener(connected)
                }
                publishConnection(if (hasDeviceManagerPermission) "已授权设备管理" else "未获得设备管理权限")
            }
            .addOnFailureListener { error ->
                hasDeviceManagerPermission = false
                publishConnection("权限申请失败：${describeError(error)}")
            }
    }

    fun launchWearApp() {
        val connected = node ?: run {
            publishConnection("未连接手环")
            return
        }
        nodeApi.launchWearApp(connected.id, WEAR_APP_HOME_PATH)
            .addOnSuccessListener {
                publishConnection("已请求打开手环应用")
            }
            .addOnFailureListener { error ->
                publishConnection("打开手环应用失败：${describeError(error)}")
            }
    }

    /** 入口图案（v3）：只把派生结果（salt/hash/iterations）发给手环，不发送图案明文。 */
    fun setPin(saltHex: String, hashHex: String, iterations: Int = SyncProtocol.PIN_ITERATIONS) {
        val connected = node
        if (connected == null) {
            listener.onPinError("未连接手环，无法设置入口图案")
            return
        }
        if (!hasDeviceManagerPermission) {
            listener.onPinError("未授权设备管理权限，无法设置入口图案")
            return
        }
        beginPinOperation(connected, PIN_OPERATION_SET, SyncProtocol.buildPinSet(saltHex, hashHex, iterations))
    }

    /** 关闭入口图案（v3）。 */
    fun clearPin() {
        val connected = node
        if (connected == null) {
            listener.onPinError("未连接手环，无法关闭入口图案")
            return
        }
        if (!hasDeviceManagerPermission) {
            listener.onPinError("未授权设备管理权限，无法关闭入口图案")
            return
        }
        beginPinOperation(connected, PIN_OPERATION_CLEAR, SyncProtocol.buildPinClear())
    }

    /** 连接上手环后查询入口图案状态（v3）；结果经 [Listener.onPinState] 返回。 */
    fun queryPin() {
        val connected = node ?: return
        if (!hasDeviceManagerPermission) {
            return
        }
        sendPinMessage(connected, SyncProtocol.buildPinQuery())
    }

    private fun sendPinMessage(connected: Node, message: String) {
        messageApi.sendMessage(connected.id, message.toByteArray(Charsets.UTF_8))
            .addOnSuccessListener {
                Log.d(TAG, "已发送入口图案查询消息")
            }
            .addOnFailureListener { error ->
                listener.onPinError("发送失败：" + describeError(error))
            }
    }

    /**
     * 入口图案可靠性（v2.2）：先拉起手环应用并等待其切到前台，再发送 pin_set / pin_clear；
     * 发送失败或 2.5 秒内没有 pin_ack 时自动重发，最多 3 次（约 10 秒）。
     */
    private fun beginPinOperation(connected: Node, operation: String, message: String) {
        cancelPinOperation()
        pendingPinOperation = operation
        pendingPinMessage = message
        pinAttempts = 0
        if (wearAppInstalled != false) {
            nodeApi.launchWearApp(connected.id, WEAR_APP_HOME_PATH)
                .addOnFailureListener { error ->
                    Log.d(TAG, "打开手环应用失败（继续发送入口图案）：" + describeError(error))
                }
        }
        // 手环应用从后台切到前台需要时间，等它在前台后再发。
        mainHandler.postDelayed({ sendPinAttempt() }, LAUNCH_DELAY_MS)
    }

    private fun sendPinAttempt() {
        val operation = pendingPinOperation ?: return
        val message = pendingPinMessage ?: return
        val connected = node
        if (connected == null) {
            failPinOperation("未连接手环，无法" + pinOperationLabel(operation))
            return
        }
        pinAttempts += 1
        messageApi.sendMessage(connected.id, message.toByteArray(Charsets.UTF_8))
            .addOnSuccessListener {
                Log.d(TAG, "已发送入口图案消息（第 " + pinAttempts + " 次）")
                armPinTimeout()
            }
            .addOnFailureListener { error ->
                Log.d(TAG, "发送入口图案消息失败：" + describeError(error))
                if (pinAttempts < MAX_PIN_ATTEMPTS) {
                    mainHandler.postDelayed({ sendPinAttempt() }, PIN_RETRY_INTERVAL_MS)
                } else {
                    failPinOperation("发送失败：" + describeError(error))
                }
            }
    }

    private fun armPinTimeout() {
        cancelPinTimeout()
        val runnable = Runnable { onPinTimeout() }
        pinTimeout = runnable
        mainHandler.postDelayed(runnable, PIN_RETRY_INTERVAL_MS)
    }

    private fun onPinTimeout() {
        pinTimeout = null
        if (pendingPinOperation == null) {
            return
        }
        if (pinAttempts < MAX_PIN_ATTEMPTS) {
            Log.d(TAG, "入口图案未收到 pin_ack，第 " + pinAttempts + " 次重试")
            sendPinAttempt()
        } else {
            failPinOperation(PIN_TIMEOUT_MESSAGE)
        }
    }

    private fun failPinOperation(message: String) {
        cancelPinOperation()
        listener.onPinError(message)
    }

    private fun cancelPinOperation() {
        pendingPinOperation = null
        pendingPinMessage = null
        pinAttempts = 0
        cancelPinTimeout()
    }

    private fun cancelPinTimeout() {
        pinTimeout?.let { mainHandler.removeCallbacks(it) }
        pinTimeout = null
    }

    private fun pinOperationLabel(operation: String): String = when (operation) {
        PIN_OPERATION_SET -> "设置入口图案"
        PIN_OPERATION_CLEAR -> "关闭入口图案"
        else -> "操作入口图案"
    }

    /** 全量替换语义：把当前账号列表整体发送给手环（协议 v3，全量替换）。 */
    fun sync(accounts: List<WristKeyAccount>) {
        val connected = node
        if (connected == null) {
            listener.onSyncProgress(
                SyncProgress(false, 0, 0, "未连接手环，无法同步", finished = true, failed = true),
            )
            return
        }
        if (!hasDeviceManagerPermission) {
            listener.onSyncProgress(
                SyncProgress(false, 0, 0, "未授权设备管理权限，请先申请权限", finished = true, failed = true),
            )
            return
        }
        if (syncing) {
            listener.onSyncProgress(
                SyncProgress(false, 0, 0, "正在同步中，请稍候", finished = true, failed = true),
            )
            return
        }

        // 无验证码账号（secret 为空）无法在协议里编码，只保留在手机端。
        val syncable = SyncProtocol.syncableAccounts(accounts)
        val missingOtp = SyncProtocol.noOtpCount(accounts)
        val session = SyncProtocol.buildSession(syncable)
        currentSyncId = session.syncId
        syncing = true
        attachMessageListener(connected)
        val startMessage = if (missingOtp > 0) {
            "开始同步 " + syncable.size + " 个账号（协议 v3）…（另有 " + missingOtp + " 个无验证码账号仅手机可见）"
        } else {
            "开始同步 " + syncable.size + " 个账号（协议 v3）…"
        }
        listener.onSyncProgress(
            SyncProgress(
                running = true,
                sent = 0,
                total = session.messages.size,
                message = startMessage,
            ),
        )
        sendAt(connected, session, 0)
    }

    private fun sendAt(
        connected: Node,
        session: SyncProtocol.SyncSession,
        index: Int,
        retriesLeft: Int = SEND_RETRY_COUNT,
    ) {
        if (!syncing) {
            return
        }
        if (index >= session.messages.size) {
            syncing = false
            listener.onSyncProgress(
                SyncProgress(
                    running = false,
                    sent = session.messages.size,
                    total = session.messages.size,
                    message = "已发送（等待手环确认 ack；手环可离线使用）",
                    finished = true,
                ),
            )
            return
        }
        val bytes = session.messages[index].toByteArray(Charsets.UTF_8)
        messageApi.sendMessage(connected.id, bytes)
            .addOnSuccessListener {
                val sent = index + 1
                listener.onSyncProgress(
                    SyncProgress(
                        running = true,
                        sent = sent,
                        total = session.messages.size,
                        message = describeStep(index, session.messages.size, sent, session.messages.size),
                    ),
                )
                sendAt(connected, session, sent)
            }
            .addOnFailureListener { error ->
                if (!syncing) {
                    return@addOnFailureListener
                }
                if (retriesLeft > 0) {
                    Log.d(TAG, "第 " + (index + 1) + " 条消息发送失败，重试：" + describeError(error))
                    mainHandler.postDelayed(
                        { sendAt(connected, session, index, retriesLeft - 1) },
                        SEND_RETRY_DELAY_MS,
                    )
                } else {
                    syncing = false
                    listener.onSyncProgress(
                        SyncProgress(
                            running = false,
                            sent = index,
                            total = session.messages.size,
                            message = "同步失败：" + describeError(error) + "（已重试 " + SEND_RETRY_COUNT + " 次）",
                            finished = true,
                            failed = true,
                        ),
                    )
                }
            }
    }

    private fun describeStep(index: Int, total: Int, sent: Int, totalSent: Int): String {
        val kind = when {
            index == 0 -> "mfa_sync_begin"
            index == total - 1 -> "mfa_sync_commit"
            else -> "mfa_sync_account #$index"
        }
        return "发送中 $sent/$total：$kind"
    }

    private fun handleIncoming(bytes: ByteArray) {
        if (bytes.isEmpty()) {
            return
        }
        val raw = String(bytes, Charsets.UTF_8)
        when (val incoming = SyncProtocol.parseIncoming(raw)) {
            is SyncProtocol.Incoming.Ack -> {
                if (currentSyncId != null && incoming.ack.syncId == currentSyncId) {
                    syncing = false
                    listener.onAck(incoming.ack)
                } else {
                    // 上一轮同步迟到的 ack：只记录，不影响当前状态。
                    listener.onAck(incoming.ack)
                }
            }

            is SyncProtocol.Incoming.Request -> listener.onSyncRequest(incoming.request.requestId)
            is SyncProtocol.Incoming.PinAck -> {
                if (pendingPinOperation == null) {
                    // 上一轮操作的迟到 ack：不覆盖当前 UI 状态。
                    Log.d(TAG, "忽略迟到的 pin_ack")
                } else {
                    cancelPinOperation()
                    listener.onPinAck(incoming.info)
                }
            }

            is SyncProtocol.Incoming.PinState -> {
                if (pendingPinOperation != null) {
                    Log.d(TAG, "入口图案操作进行中，忽略 pin_state")
                } else {
                    listener.onPinState(incoming.info)
                }
            }
            is SyncProtocol.Incoming.Ignored -> Log.d(TAG, "忽略手环消息: ${incoming.reason}")
        }
    }

    private fun refreshPermission(connected: Node) {
        authApi.checkPermissions(connected.id, arrayOf(Permission.DEVICE_MANAGER))
            .addOnSuccessListener { results ->
                hasDeviceManagerPermission = results?.firstOrNull() == true
                if (hasDeviceManagerPermission) {
                    attachMessageListener(connected)
                }
                publishConnection(if (hasDeviceManagerPermission) "已授权设备管理" else "未授权设备管理")
            }
            .addOnFailureListener { error ->
                hasDeviceManagerPermission = false
                publishConnection("权限查询失败：${describeError(error)}")
            }
    }

    private fun refreshWearAppInstalled(connected: Node) {
        nodeApi.isWearAppInstalled(connected.id)
            .addOnSuccessListener { installed ->
                wearAppInstalled = installed
                publishConnection(if (installed == true) "手环应用已安装" else "手环应用未安装")
            }
            .addOnFailureListener { error ->
                wearAppInstalled = null
                Log.d(TAG, "查询手环应用安装状态失败: ${describeError(error)}")
                publishConnection("已连接（手环应用状态未知）")
            }
    }

    private fun attachMessageListener(connected: Node) {
        if (listenerNodeId == connected.id) {
            return
        }
        detachMessageListener()
        messageApi.addListener(connected.id, incomingListener)
            .addOnSuccessListener {
                listenerNodeId = connected.id
                Log.d(TAG, "已注册手环消息监听: ${connected.id}")
            }
            .addOnFailureListener { error ->
                Log.d(TAG, "注册手环消息监听失败: ${describeError(error)}")
            }
    }

    private fun detachMessageListener() {
        val registered = listenerNodeId ?: return
        listenerNodeId = null
        runCatching { messageApi.removeListener(registered) }
    }

    private fun publishConnection(message: String) {
        listener.onConnectionStateChanged(
            ConnectionState(
                serviceConnected = serviceConnected,
                node = node,
                hasDeviceManagerPermission = hasDeviceManagerPermission,
                wearAppInstalled = wearAppInstalled,
                message = message,
            ),
        )
    }

    companion object {
        private const val TAG = "WristKeySync"
        private const val WEAR_APP_HOME_PATH = "/home"

        /** 拉起手环应用后等待其切到前台的时长。 */
        private const val LAUNCH_DELAY_MS = 1_300L

        /** 等待 pin_ack 的时间，也是无 ack 时的重发间隔。 */
        private const val PIN_RETRY_INTERVAL_MS = 2_500L

        /** pin_set / pin_clear 最多发送次数。 */
        private const val MAX_PIN_ATTEMPTS = 3

        /** 同步单条消息失败后的重试次数（v2.2）。 */
        private const val SEND_RETRY_COUNT = 2
        private const val SEND_RETRY_DELAY_MS = 400L

        private const val PIN_OPERATION_SET = "set"
        private const val PIN_OPERATION_CLEAR = "clear"

        private const val PIN_TIMEOUT_MESSAGE =
            "未收到手环确认：请保持手环腕证在前台并重试（旧版手环应用需升级）"

        /** 把 xms 异常转成可读文案（尤其签名不一致）。 */
        fun describeError(error: Throwable?): String = when (error) {
            null -> "未知错误"
            is SignatureVerifyFailedException ->
                "包名/签名校验失败：手环快应用与手机 App 的签名证书不一致。请安装用同一证书（signing/dev-release.jks）构建的 .rpk 与 APK。"
            is PermissionDeniedException -> "设备管理权限被拒绝，请先授权设备管理权限"
            is DeviceDisconnectedException -> "手环已断开连接，请重新连接后重试"
            is AppNotInstalledException -> "手环端尚未安装腕证快应用（.rpk）"
            else -> error.message?.takeIf { it.isNotBlank() } ?: error.javaClass.simpleName
        }
    }
}
