package expo.modules.uteble

import android.bluetooth.BluetoothGattCharacteristic
import android.content.Context
import android.util.Base64
import com.yc.nadalsdk.ble.open.UteBleClient
import com.yc.nadalsdk.ble.open.UteBleConnection
import com.yc.nadalsdk.ble.open.UteBleDevice
import com.yc.nadalsdk.bean.DevicePairedState
import com.yc.nadalsdk.bean.HonorAccountConfig
import com.yc.nadalsdk.bean.Notify
import com.yc.nadalsdk.bean.RegionLockConfig
import com.yc.nadalsdk.bean.recorder.AudioRecordStopInfo
import com.yc.nadalsdk.bean.recorder.DeviceStorageInfo
import com.yc.nadalsdk.bean.recorder.RequestAudioRecordFileInfo
import com.yc.nadalsdk.bean.recorder.RequestDeleteAudioRecordFileInfo
import com.yc.nadalsdk.bean.recorder.RequestSyncAudioRecordFileInfo
import com.yc.nadalsdk.bean.recorder.SyncAudioDataInfo
import com.yc.nadalsdk.constants.NotifyType
import com.yc.nadalsdk.constants.recorder.DeleteFileResult
import com.yc.nadalsdk.constants.recorder.FileStatusConstants
import com.yc.nadalsdk.listener.BleConnectStateListener
import com.yc.nadalsdk.listener.ClipDeviceWriteListener
import com.yc.nadalsdk.listener.DeviceNotifyListener
import com.yc.nadalsdk.scan.UteScanCallback
import com.yc.nadalsdk.scan.UteScanDevice
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors

// Same JS surface as ios/src/UteBleModule.swift. The Android SDK differs in
// three ways that shape this file: its calls are synchronous (so they must stay
// off the main thread), session ids are strings, and the device expects the
// app to answer a pairing notify and a region-lock request after connecting.

private class NotInitialized : CodedException("Call initialize() before anything else.")

private class SdkFailed(call: String, code: Int) : CodedException("$call returned error $code")

class UteBleModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private var client: UteBleClient? = null

  private val connection: UteBleConnection
    get() = client?.uteBleConnection ?: throw NotInitialized()

  // Replies to device-initiated requests arrive on the SDK's callback thread;
  // calling back into the synchronous SDK from there risks blocking it.
  private val replies = Executors.newSingleThreadExecutor()

  private var syncPromise: Promise? = null
  private var syncSessionId = 0L
  private var syncTotal = 0L
  private var syncExtension = "opus"

  // The SDK has no status query on Android, so this tracks what the app did.
  private var recording = false

  override fun definition() = ModuleDefinition {
    Name("UteBle")

    Events(
      "onDeviceFound",
      "onConnectionChange",
      "onPairingChange",
      "onBluetoothState",
      "onRecordStart",
      "onRecordStop",
      "onSyncProgress",
      "onClipData"
    )

    AsyncFunction("initialize") {
      val c = UteBleClient.initialize(context.applicationContext)
      // Matches the vendor demo's Application setup.
      c.setSupportUserIdPair(true)
      // Listeners have to be in place before connect() is ever called.
      c.uteBleConnection.setConnectStateListener(connectStateListener)
      c.uteBleConnection.setDeviceNotifyListener(notifyListener)
      c.uteBleConnection.setClipDeviceWriteListener(clipListener)
      client = c
      sendEvent("onBluetoothState", mapOf("state" to if (c.isBluetoothEnable) 0 else 1, "poweredOn" to c.isBluetoothEnable))
      "1.3.5-android"
    }

    AsyncFunction("startScan") {
      val c = client ?: throw NotInitialized()
      c.cancelScan()
      val started = c.scanDevice(object : UteScanCallback {
        override fun onScanning(device: UteScanDevice) = emitDevice(device)
        override fun onScanComplete(devices: MutableList<UteScanDevice>) = Unit
        override fun onScanFailed(errorCode: Int) {
          sendEvent("onBluetoothState", mapOf("state" to errorCode, "poweredOn" to c.isBluetoothEnable))
        }
      }, 10_000L)
      if (!started) throw CodedException("Scan didn't start. Is Bluetooth on and permission granted?")
    }

    AsyncFunction("stopScan") {
      client?.cancelScan()
    }

    // Android connects by MAC address directly; no scan result object needed.
    AsyncFunction("connect") { id: String ->
      val c = client ?: throw NotInitialized()
      c.cancelScan()
      c.connect(id)
      Unit
    }

    AsyncFunction("disconnect") {
      val c = client ?: return@AsyncFunction false
      val wasConnected = c.isConnected
      c.disconnect()
      wasConnected
    }

    AsyncFunction("isConnected") {
      client?.isConnected ?: false
    }

    // The Android SDK exposes no firmware capability flags, so the recording
    // support fields are null (unknown) rather than guessed.
    AsyncFunction("connectedDevice") {
      val c = client ?: return@AsyncFunction null
      if (!c.isConnected) return@AsyncFunction null
      mapOf(
        "name" to (c.deviceName ?: ""),
        "address" to (c.deviceAddress ?: ""),
        "model" to "",
        "firmware" to "",
        "serialNumber" to "",
        "hasAIRecording" to null,
        "hasAIRecordRealTime" to null,
      )
    }

    // There is no recorder bind on Android; the demo's "request pairing" is the
    // equivalent handshake. token/verify are iOS-only and ignored here.
    AsyncFunction("bind") { _: String, _: Int ->
      val response = connection.requestDevicePairing(1)
      if (!response.isSuccess) throw SdkFailed("requestDevicePairing", response.errorCode)
      val bound = response.data?.pairedState == DevicePairedState.STATE_CONNECTED
      mapOf("ssn" to null, "bound" to bound, "refuseCause" to null, "micMode" to null)
    }

    AsyncFunction("getStatus") {
      mapOf(
        "state" to 0, // Unknown: no status query exists in the Android SDK.
        "recording" to recording,
        "usbConnected" to null,
        "privacyMode" to null,
      )
    }

    AsyncFunction("getStorageInfo") {
      val response = connection.deviceStorageInfo
      val info = response.data
      if (!response.isSuccess || info == null) throw SdkFailed("getDeviceStorageInfo", response.errorCode)
      mapOf(
        "totalKB" to info.total,
        "freeKB" to info.free,
        "bytesPerSecond" to info.recSizePs,
        "full" to (info.freeSizeState == DeviceStorageInfo.NO_FREE_SPACE),
      )
    }

    AsyncFunction("startRecord") {
      val response = connection.appStartAudioRecord()
      val info = response.data
      if (!response.isSuccess || info == null) throw SdkFailed("appStartAudioRecord", response.errorCode)
      recording = info.result == 0
      mapOf("sessionId" to sessionNumber(info.sessionId), "result" to info.result)
    }

    AsyncFunction("stopRecord") {
      val response = connection.appStopAudioRecord()
      val info = response.data
      if (!response.isSuccess || info == null) throw SdkFailed("appStopAudioRecord", response.errorCode)
      recording = false
      mapOf(
        "sessionId" to sessionNumber(info.sessionId),
        "saved" to (info.fileExist == AudioRecordStopInfo.SAVED),
        "fileSize" to info.fileSize,
      )
    }

    // uid 1 / start 0 / only_one 0: the iOS docs say "fill with 0"; the Android
    // demo's only_one = 1 looks like it limits the reply to a single file.
    AsyncFunction("listFiles") {
      val response = connection.queryAudioRecordFileLists(RequestAudioRecordFileInfo(1L, 0L, 0L))
      val info = response.data
      if (!response.isSuccess || info == null) throw SdkFailed("queryAudioRecordFileLists", response.errorCode)
      val files = (info.audioRecordFiles ?: emptyList()).map { file ->
        mapOf(
          "sessionId" to sessionNumber(file.sessionId),
          "size" to file.fileSize,
          "type" to file.fileType,
        )
      }
      mapOf("count" to info.count, "files" to files)
    }

    // One request for the whole file. The SDK accumulates the packets itself
    // and hands over the complete file in AI_RECORDER_SYNC_ALL_DATA_NOTIFY;
    // per-packet progress arrives as AI_RECORDER_SYNCING_ALL_DATA_NOTIFY.
    AsyncFunction("syncFile") { sessionId: Long, fileType: Int, size: Long, promise: Promise ->
      if (syncPromise != null) {
        promise.reject("SyncBusy", "A sync is already running.", null)
        return@AsyncFunction
      }
      syncPromise = promise
      syncSessionId = sessionId
      syncTotal = size
      syncExtension = fileExtension(fileType)

      val request = RequestSyncAudioRecordFileInfo().apply {
        setSessionId(sessionId.toString())
        setFileType(fileType)
        setStart(0L)
        setEnd(size)
        setRealSync(false)
      }
      val response = try {
        connection.syncAudioRecordFile(request)
      } catch (e: Exception) {
        failSync("SyncFailed", e.message ?: "syncAudioRecordFile threw")
        return@AsyncFunction
      }
      val status = response.data?.fileStatus
      if (!response.isSuccess || status != FileStatusConstants.FILE_STATUS_OK) {
        // 1 filesystem error, 2 missing, 3 interrupted. No data will follow.
        failSync("SyncRefused", "syncAudioRecordFile error=${response.errorCode} status=$status")
      }
    }

    AsyncFunction("stopSync") {
      connection.stopSyncAudioRecordFile()
      failSync("SyncStopped", "Sync cancelled.")
    }

    AsyncFunction("deleteFile") { sessionId: Long, fileType: Int ->
      val request = RequestDeleteAudioRecordFileInfo().apply {
        setSessionId(sessionId.toString())
        setFileType(fileType)
      }
      val response = connection.deleteAudioRecordFile(request)
      val result = response.data?.result
      if (!response.isSuccess || result != DeleteFileResult.DELETE_SUCCESS) {
        throw CodedException("deleteAudioRecordFile error=${response.errorCode} result=$result")
      }
      true
    }

    OnDestroy {
      replies.shutdown()
    }
  }

  // MARK: - Listeners

  private val connectStateListener = BleConnectStateListener { status ->
    when (status) {
      // Codes normalised to the iOS UTEDevicesStatus values the JS types document.
      BleConnectStateListener.STATE_CONNECTED -> emitConnection(0, true)
      BleConnectStateListener.STATE_DISCONNECTED -> {
        recording = false
        emitConnection(1, false)
      }
      BleConnectStateListener.STATE_CONNECTING -> emitConnection(4, false)
      // The device asks for a region right after connecting; the demo answers
      // "inside region" every time.
      BleConnectStateListener.STATE_SET_REGION_LOCK -> replies.execute {
        runCatching { connection.setRegionLockConfig(RegionLockConfig(RegionLockConfig.INSIDE_REGION)) }
      }
    }
  }

  private val notifyListener = DeviceNotifyListener { _: UteBleDevice, notify: Notify ->
    when (notify.type) {
      NotifyType.DEVICE_PAIRED_STATE_NOTIFY -> onPairedState(notify.data as? DevicePairedState)

      NotifyType.AI_RECORDER_SYNCING_ALL_DATA_NOTIFY -> {
        val data = notify.data as? SyncAudioDataInfo ?: return@DeviceNotifyListener
        sendEvent("onSyncProgress", mapOf(
          "sessionId" to syncSessionId,
          "received" to data.position,
          "total" to syncTotal,
          "completed" to false,
        ))
      }

      NotifyType.AI_RECORDER_SYNC_ALL_DATA_NOTIFY -> {
        val data = notify.data as? SyncAudioDataInfo ?: return@DeviceNotifyListener
        finishSync(data.syncAudioData ?: ByteArray(0))
      }

      NotifyType.AI_RECORDER_ABORT_SYNC_DATA_NOTIFY -> {
        val received = (notify.data as? SyncAudioDataInfo)?.syncAudioData?.size ?: 0
        failSync("SyncAborted", "The device aborted the transfer after $received bytes.")
      }
    }
  }

  private val clipListener = object : ClipDeviceWriteListener {
    override fun onClipDeviceWrite(characteristic: BluetoothGattCharacteristic, status: Int) = Unit

    @Suppress("DEPRECATION") // getValue() is the only accessor on the SDK's callback.
    override fun onClipDeviceNotify(characteristic: BluetoothGattCharacteristic) {
      val bytes = characteristic.value ?: return
      sendEvent("onClipData", mapOf(
        "bytes" to bytes.size,
        "base64" to Base64.encodeToString(bytes, Base64.NO_WRAP),
      ))
    }
  }

  /**
   * The demo's handshake: when the device reports it is paired, it expects the
   * app to send a stable user id; anything else and the demo disconnects.
   */
  private fun onPairedState(state: DevicePairedState?) {
    val paired = state?.pairedState == DevicePairedState.STATE_CONNECTED
    sendEvent("onPairingChange", mapOf("paired" to paired))
    replies.execute {
      runCatching {
        if (paired) {
          connection.setHonorAccount(HonorAccountConfig().apply { currentHuid = userId() })
        } else {
          client?.disconnect()
        }
      }
    }
  }

  // MARK: - Helpers

  private fun emitDevice(device: UteScanDevice) {
    val bt = device.device ?: return
    // Reading the name throws without BLUETOOTH_CONNECT on Android 12+.
    val name = runCatching { bt.name }.getOrNull()
    if (name.isNullOrEmpty()) return // the demo drops unnamed devices too

    val record = device.scanRecord ?: ByteArray(0)
    val hex = record.joinToString(" ") { "%02X".format(it) }
    // The demo's own filter: UTE firmware advertises 55 55 (or 3A 55 for
    // glasses); the recording clip's name starts with "Tic".
    val likelyUte = hex.contains("55 55") || hex.contains("3A 55") ||
      name.startsWith("AT") || name.startsWith("Tic")

    sendEvent("onDeviceFound", mapOf(
      "id" to bt.address,
      "name" to name,
      "address" to bt.address,
      "rssi" to device.rssi,
      "likelyUte" to likelyUte,
    ))
  }

  private fun emitConnection(status: Int, connected: Boolean) {
    sendEvent("onConnectionChange", mapOf("status" to status, "connected" to connected, "error" to null))
  }

  private fun finishSync(data: ByteArray) {
    val promise = syncPromise ?: return
    syncPromise = null
    try {
      val dir = File(context.cacheDir, "ute-recordings").apply { mkdirs() }
      val file = File(dir, "$syncSessionId.$syncExtension")
      file.writeBytes(data)
      sendEvent("onSyncProgress", mapOf(
        "sessionId" to syncSessionId,
        "received" to data.size,
        "total" to syncTotal,
        "completed" to true,
      ))
      promise.resolve(mapOf(
        "sessionId" to syncSessionId,
        "path" to file.absolutePath,
        "uri" to "file://${file.absolutePath}",
        "bytes" to data.size,
      ))
    } catch (e: Exception) {
      promise.reject("WriteFailed", e.message, e)
    }
  }

  private fun failSync(code: String, message: String) {
    val promise = syncPromise ?: return
    syncPromise = null
    promise.reject(code, message, null)
  }

  private fun userId(): String {
    val prefs = context.getSharedPreferences("ute-ble", Context.MODE_PRIVATE)
    return prefs.getString("userId", null) ?: UUID.randomUUID().toString().replace("-", "").also {
      prefs.edit().putString("userId", it).apply()
    }
  }

  // Session ids are numeric strings on Android; JS gets them as numbers, the
  // same as iOS.
  private fun sessionNumber(id: String?): Long = id?.toLongOrNull() ?: 0L

  private fun fileExtension(type: Int) = when (type) {
    0 -> "avo"
    1 -> "opus"
    2 -> "mp3"
    3 -> "sbc"
    4 -> "pcm"
    5 -> "wav"
    else -> "bin"
  }
}
