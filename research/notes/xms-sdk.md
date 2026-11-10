# xms-wearable-lib 1.4（小米穿戴服务 SDK）API 调研

> 对象：`research/mfa_android/app/libs/xms-wearable-lib_1.4_release.aar`（参考实现 BandOTP Android 使用同一 AAR）。
> 方法：`unzip` 解 AAR → 解 `classes.jar` → 自写 class 文件解析器读取 public 方法/字段/泛型签名（等价 `javap -public`；本机无 JDK）。
> 标注：**[已验证]** = AAR 字节码/字符串直接得出；**[已验证-二手]** = 参考实现使用经验；**[未验证]** = 需真机确认。

## 0. TL;DR

- SDK 包名 `com.xiaomi.xms.wearable`；AAR 内 class 文件 major 51（Java 7），R8 混淆过；`minSdkVersion 19`、`targetSdkVersion 30`；`<queries>` 声明 `com.xiaomi.wearable`、`com.mi.health`。**[已验证]**
- 能力齐全：设备发现（NodeApi）、权限（AuthApi，`DEVICE_MANAGER`/`NOTIFY`）、发消息（`MessageApi.sendMessage(nodeId, byte[])`）、**收消息（`MessageApi.addListener(nodeId, OnMessageReceivedListener)`）**、启动手环快应用、数据通道（query/subscribe）。**[已验证]**
- **可以收手环 ack**：`addListener` 提供 `onMessageReceived(String nodeId, byte[] data)` 回调，参考实现只是没用它（只发不收）。协议 v2 的 ack 有 SDK 层面的可行性。**[已验证 API；真机未验证]**
- 消息大小：SDK 内**没有**显式大小检查；底层走 Binder/AIDL（`I(String,[B,IMessageCallback)V`），Binder 事务上限约 1MB 属于硬上限，但实际穿戴服务/手环通道上限更小且未知。**协议按每包 <1 KB 设计是安全做法**；不要单条发全量快照。**[已验证-无 SDK 检查；具体上限未验证]**
- 对 10 Pro 兼容性：AAR 与设备型号无关（手机侧服务），BandOTP/BandTOTP 均用 1.4 且声称支持手环 9/10/10 Pro；签名不一致时会返回 `RESULT_SIGNATURE_VERIFY_FAILED`。**[已验证-二手]**

## 1. AAR 基本信息（命令可复核）

```bash
unzip -l research/mfa_android/app/libs/xms-wearable-lib_1.4_release.aar
#   aidl/com/xiaomi/xms/wearable/{notify,node,auth}/*.aidl
#   classes.jar  AndroidManifest.xml  R.txt  proguard.txt
unzip -p .../xms-wearable-lib_1.4_release.aar AndroidManifest.xml
```

```xml
<manifest package="com.xiaomi.xms.wearable">
  <uses-sdk android:minSdkVersion="19" android:targetSdkVersion="30" />
  <queries>
    <package android:name="com.xiaomi.wearable" />
    <package android:name="com.mi.health" />
  </queries>
</manifest>
```
→ 依赖手机已安装"小米运动健康"（`com.mi.health`）或旧版"小米穿戴"（`com.xiaomi.wearable`）。**[已验证]**

AAR 元数据：`aarFormatVersion=1.0`、`aarMetadataVersion=1.0`（无 minCompileSdk 限制）；`proguard.txt` 为空（无额外 keep 规则；若开 minify 需自行 keep `com.xiaomi.xms.wearable.**`）。**[已验证]**

## 2. 公共 API 签名（自 class 文件解析）

### 2.1 入口 `com.xiaomi.xms.wearable.Wearable`
```java
public final class Wearable {
  public static ServiceApi  getServiceApi(Context);
  public static AuthApi     getAuthApi(Context);
  public static NodeApi     getNodeApi(Context);
  public static MessageApi  getMessageApi(Context);
  public static NotifyApi   getNotifyApi(Context);
}
```
**[已验证]**

### 2.2 设备发现 `com.xiaomi.xms.wearable.node.NodeApi`
```java
public final class NodeApi {
  public Task<List<Node>>        getConnectedNodes();                    // 泛型签名 Task<List<Node>>
  public Task<Boolean>           isWearAppInstalled(String nodeId);      // 手环端快应用是否已安装
  public Task<Void>              launchWearApp(String nodeId, String path);
  public Task<DataQueryResult>   query(String nodeId, DataItem);
  public Task<Void>              subscribe(String nodeId, DataItem, OnDataChangedListener);
  public Task<Void>              unsubscribe(String nodeId, DataItem);
}
```
- `launchWearApp` 第二参数为手环页面路径：BandOTP 用 `"/home"`，BandTOTP 用 `"pages/index"`；本项目建议先用 `"pages/index"`（与 router entry 一致），两条写法都需真机确认。**[未验证]**
- `Node` 是 `Parcelable`，字段 `public String id`、`public String name`。**[已验证]**

### 2.3 授权 `com.xiaomi.xms.wearable.auth.AuthApi` + `Permission`
```java
public final class AuthApi {
  public Task<Boolean>      checkPermission(String nodeId, Permission permission);
  public Task<boolean[]>    checkPermissions(String nodeId, Permission[] permissions);
  public Task<Permission[]> requestPermission(String nodeId, Permission[] permissions);
}

public final class Permission implements Parcelable {
  public static final Permission DEVICE_MANAGER;   // 发消息/管理手环应用所需
  public static final Permission NOTIFY;           // 通知推送
  public String getName();
}
```
参考实现流程：`checkPermissions(node.id, arrayOf(Permission.DEVICE_MANAGER))` → 返回 `boolean[]`，取 `firstOrNull() == true`；未授权时 `requestPermission(node.id, arrayOf(Permission.DEVICE_MANAGER))`。**[已验证-源码：mfa_android/MainActivity.kt；BandTOTP 同]**

### 2.4 消息 `com.xiaomi.xms.wearable.message.MessageApi`
```java
public final class MessageApi {
  public Task<Void> sendMessage(String nodeId, byte[] data);
  public Task<Void> addListener(String nodeId, OnMessageReceivedListener listener);   // 收手环→手机消息
  public Task<Void> removeListener(String nodeId);
}

public interface OnMessageReceivedListener {           // 同名 AIDL：IMessageListener
  void onMessageReceived(String nodeId, byte[] data);
}
```
- 发送：`messageApi.sendMessage(node.id, json.toByteArray(Charsets.UTF_8))`，`Task<Void>`，`addOnSuccessListener/addOnFailureListener`。**[已验证-源码 + 字节码]**
- 接收（ack 用）：`addListener(nodeId, listener)`；AAR 内同时存在 `IMessageCallback.onMessageSent(Status)`（发送回执）。**参考实现未调用 addListener，本项目的 ack 接收需要自行验证**。**[API 已验证 / 真机未验证]**
- 注意：`addListener` 注册的是"该 nodeId 上来自手环快应用的消息"；手机端包名/签名与手环快应用不一致时，服务会以 `RESULT_SIGNATURE_VERIFY_FAILED` 失败（这正是社区 "fingerprint verify failed" 的来源）。**[已验证-字符串 + 二手反馈]**

### 2.5 服务连接 `com.xiaomi.xms.wearable.service.ServiceApi`
```java
public final class ServiceApi {
  public Task<Integer> getServiceApiLevel();
  public void registerServiceConnectionListener(OnServiceConnectionListener);
  public void unregisterServiceConnectionListener(OnServiceConnectionListener);
}
public interface OnServiceConnectionListener { void onServiceConnected(); void onServiceDisconnected(); }
```
用途：判断穿戴服务是否已绑定、服务断开时更新 UI。**[已验证]**

### 2.6 状态与异常（对故障提示很重要）
`Status` 常量 **[已验证]**：
`RESULT_SUCCESS`、`RESULT_CANCELLED`、`RESULT_TIMEOUT`、`RESULT_INTERRUPTED`、`RESULT_DISCONNECTED`、`RESULT_PACKAGE_NOT_INSTALLED`、`RESULT_SIGNATURE_VERIFY_FAILED`、`RESULT_PERMISSION_DENIED`、`RESULT_APP_NOT_INSTALLED`；`isSuccess()`、`getCode()`。

`ExceptionUtil.convertStatusToException(Status)` 映射（异常消息字符串来自字节码）**[已验证]**：
| Status | 异常 | message |
| --- | --- | --- |
| RESULT_DISCONNECTED | `DeviceDisconnectedException` | "device disconnected" |
| RESULT_PERMISSION_DENIED | `PermissionDeniedException` | "permission denied" |
| RESULT_PACKAGE_NOT_INSTALLED / RESULT_APP_NOT_INSTALLED | `AppNotInstalledException` | "app not installed" |
| RESULT_SIGNATURE_VERIFY_FAILED | `SignatureVerifyFailedException` | "fingerprint verify failed" |

→ 建议手机端 UI 对 `SignatureVerifyFailedException` 提示"证书/包名不一致，请用同一签名重装两端"，对 `AppNotInstalledException` 提示"请先在手表安装腕证"。

### 2.7 其它
- `NotifyApi.sendNotify(String, String, String) : Task<Status>`（通知）；本项目不需要。
- 数据通道 `DataItem/DataQueryResult/DataSubscribeResult`、`query/subscribe/unsubscribe` 可作消息的替代方案（更适合结构化数据，但 API 更重）。**[已验证]**
- AIDL 目录：`aidl/com/xiaomi/xms/wearable/{notify,node,auth}/*.aidl` 可见 `Node.aidl`、`DataItem.aidl`、`Permission.aidl`、`Status.aidl`、`NotificationData.aidl`。**[已验证]**

## 3. 集成方式（参考实现）

```kotlin
// app/build.gradle.kts
implementation(files("libs/xms-wearable-lib_1.4_release.aar"))
```

```kotlin
val nodeApi    = Wearable.getNodeApi(context)
val authApi    = Wearable.getAuthApi(context)
val messageApi = Wearable.getMessageApi(context)
val serviceApi = Wearable.getServiceApi(context)
serviceApi.registerServiceConnectionListener(object : OnServiceConnectionListener {
    override fun onServiceConnected() { /* 刷新设备/权限 */ }
    override fun onServiceDisconnected() { /* 清空 node */ }
})

nodeApi.connectedNodes.addOnSuccessListener { nodes ->
    val node = nodes.firstOrNull() ?: return@addOnSuccessListener
    authApi.requestPermission(node.id, arrayOf(Permission.DEVICE_MANAGER))
        .addOnSuccessListener { granted -> /* granted.contains(Permission.DEVICE_MANAGER) */ }
}

// 发送一条协议消息
messageApi.sendMessage(node.id, json.toByteArray(Charsets.UTF_8))
    .addOnSuccessListener { /* 已交给服务 */ }
    .addOnFailureListener { e -> /* e.message 可能是 "fingerprint verify failed" */ }

// 接收手环 ack（本项目新增）
messageApi.addListener(node.id, object : OnMessageReceivedListener {
    override fun onMessageReceived(nodeId: String, data: ByteArray) {
        val json = String(data, Charsets.UTF_8)
    }
})
```

## 4. 线程 / 生命周期 / 限制

- `Task` 提供 `addOnSuccessListener(Executor, OnSuccessListener)` / `addOnFailureListener(Executor, ...)` 两个重载 → 默认回调线程由实现决定（参考实现直接更新 Compose state，说明默认回到主线程或可安全更新）。**[未验证-默认调度]**
- `Task` 还提供 `isComplete/isSuccessful/isCanceled/getResult()/getResult(Class)/getException()`。**[已验证]**
- 消息发送是异步 `Task`，无排队/重试保证 → 协议层自己做重试与进度。
- **未在 SDK 中发现消息大小检查或线程数限制**（AIDL 直接是 `byte[]`）；限制应来自穿戴服务/手环通道。**[未验证-具体上限]**
- 手机端需在运行时申请 `BLUETOOTH` 权限（参考 BandTOTP 的做法），SDK manifest 未声明。**[已验证-参考实现 / 是否必需未验证]**
- 建议不开启 R8/minify 或添加 keep 规则，避免 AIDL/task 回调被裁剪。**[未验证]**

## 5. 对手环 10 Pro 的兼容性判断

- 该 SDK 是**手机侧**服务 API，与手环型号解耦；实际通信由"小米运动健康 + 穿戴服务 + BLE"完成。**[已验证-架构]**
- BandOTP Android（同一 AAR 1.4）与 BandOTP 手环端在小米手环 9/9 Pro/10/10 Pro 上可用；BandTOTP Android 同 AAR 亦支持 10 Pro 资源（AstroBox `xmb10p` 条目）。**[已验证-二手]**
- 结论：**10 Pro 兼容性风险低**；风险集中在"两端证书/包名一致"和"10 Pro 上快应用本身能否运行"，不在 SDK。**[推断]**

## 6. 待真机验证

- [ ] `addListener` 能否收到手环 `connect.send` 的 ack（重点）
- [ ] 单条消息实际可用上限（建议实测 1KB/4KB/16KB/64KB）
- [ ] `launchWearApp` 的 path 取值（`pages/index` vs `/home`）
- [ ] 未授权 `DEVICE_MANAGER` 时 `sendMessage` 的失败类型（`PermissionDeniedException`？）
- [ ] Android 13+ 是否需要 `BLUETOOTH_CONNECT` 运行时权限
- [ ] 10 Pro 上 `isWearAppInstalled` 返回值与包名关系
