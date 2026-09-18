import ExpoModulesCore
import UTEBluetoothRYApi

/// UTEBluetoothMgr holds its delegate weakly, so the module owns this object.
/// The SDK headers carry no nullability annotations, so arguments arrive as
/// implicitly unwrapped optionals — if the compiler rejects a signature here,
/// match it against the generated Swift interface.
private final class UteBleDelegate: NSObject, UTEBluetoothDelegate {
  var onDiscover: ((UTEModelDevice) -> Void)?
  var onDeviceStatus: ((UTEDevicesStatus, Error?) -> Void)?
  var onBluetoothStatus: ((UTEBluetoothStatus) -> Void)?
  var onClip: ((Data) -> Void)?

  func uteDiscoverDevices(_ model: UTEModelDevice!) {
    guard let model else { return }
    onDiscover?(model)
  }

  func uteDevicesStatus(_ status: UTEDevicesStatus, error: Error!, userInfo info: [AnyHashable: Any]!) {
    onDeviceStatus?(status, error)
  }

  func uteBluetoothStatus(_ status: UTEBluetoothStatus) {
    onBluetoothStatus?(status)
  }

  func uteDeviceRecordingClip(_ data: Data!, error: Error!) {
    guard let data else { return }
    onClip?(data)
  }
}

public class UteBleModule: Module {
  private let bleDelegate = UteBleDelegate()

  /// connectDevice: wants the discovered UTEModelDevice back rather than an id,
  /// so scan results are kept here and addressed by MAC.
  private var discovered: [String: UTEModelDevice] = [:]

  private var syncPromise: Promise?
  private var syncFileExtension = "opus"
  private var notificationsRegistered = false

  private var mgr: UTEBluetoothMgr { UTEBluetoothMgr.sharedInstance() }
  private var recordMgr: UTERecordMgr { UTEDeviceMgr.sharedInstance().recordMgr }

  public func definition() -> ModuleDefinition {
    Name("UteBle")

    Events(
      "onDeviceFound",
      "onConnectionChange",
      "onPairingChange", // Android's post-connect handshake; never sent on iOS.
      "onBluetoothState",
      "onRecordStart",
      "onRecordStop",
      "onSyncProgress",
      "onClipData"
    )

    // initUTEMgr touches CoreBluetooth, so it stays on main.
    AsyncFunction("initialize") { () -> String in
      self.bleDelegate.onDiscover = { [weak self] model in
        guard let self else { return }
        let id = model.address ?? model.name ?? ""
        guard !id.isEmpty else { return }
        self.discovered[id] = model
        self.sendEvent("onDeviceFound", [
          "id": id,
          "name": model.name ?? "",
          "address": model.address ?? "",
          "rssi": model.rssi,
        ])
      }

      self.bleDelegate.onDeviceStatus = { [weak self] status, error in
        self?.sendEvent("onConnectionChange", [
          "status": status.rawValue,
          "connected": status == .connected,
          "error": error?.localizedDescription as Any,
        ])
      }

      self.bleDelegate.onBluetoothStatus = { [weak self] status in
        self?.sendEvent("onBluetoothState", [
          "state": status.rawValue,
          "poweredOn": status == .open,
        ])
      }

      self.bleDelegate.onClip = { [weak self] data in
        self?.sendEvent("onClipData", [
          "bytes": data.count,
          "base64": data.base64EncodedString(),
        ])
      }

      self.mgr.initUTEMgr()
      self.mgr.delegate = self.bleDelegate
      self.registerRecordNotifications()
      return self.mgr.sdkVersion()
    }
    .runOnQueue(.main)

    AsyncFunction("startScan") {
      self.discovered.removeAll()
      self.mgr.startScanDevices()
    }
    .runOnQueue(.main)

    AsyncFunction("stopScan") {
      self.mgr.stopScanDevices()
    }
    .runOnQueue(.main)

    AsyncFunction("connect") { (id: String) in
      guard let model = self.discovered[id] else {
        throw Exception(name: "UnknownDevice", description: "No scanned device with id " + id + ". Scan again.")
      }
      self.mgr.connectDevice(model)
    }
    .runOnQueue(.main)

    AsyncFunction("disconnect") { () -> Bool in
      guard let model = self.mgr.connnectModel else { return false }
      return self.mgr.disconnectDevices(model)
    }
    .runOnQueue(.main)

    AsyncFunction("isConnected") { () -> Bool in
      self.mgr.connectStatus == .connected
    }

    /// The connected device, or nil. hasAIRecording is the flag that says this
    /// firmware actually speaks the recording protocol — if it is false, none of
    /// the record calls below will work no matter how well the BLE link is.
    AsyncFunction("connectedDevice") { () -> [String: Any]? in
      guard let model = self.mgr.connnectModel, self.mgr.connectStatus == .connected else { return nil }
      return [
        "name": model.name ?? "",
        "address": model.address ?? "",
        "model": model.model ?? "",
        "firmware": model.systemVersion ?? "",
        "serialNumber": model.serialNumber ?? "",
        "hasAIRecording": model.hasAIRecording,
        "hasAIRecordRealTime": model.hasAIRecordRealTime,
      ]
    }

    // MARK: - Pairing

    /// osType 1 = iOS. The token is the shared secret the device stores; the
    /// same one has to come back on every reconnect or the handshake is refused.
    AsyncFunction("bind") { (token: String, verify: Int, promise: Promise) in
      self.recordMgr.appBindRecordDevice(1, bleVersion: 0, verify: verify, token: token) { errorCode, model in
        guard errorCode == 0, let model else {
          promise.reject("BindFailed", "appBindRecordDevice returned \(errorCode)")
          return
        }
        promise.resolve([
          "ssn": model.ssn ?? "",
          "bound": model.binded == 1,
          "refuseCause": model.refuse_cause,
          "micMode": model.mic_mode,
        ])
      }
    }

    // MARK: - Device state

    AsyncFunction("getStatus") { (promise: Promise) in
      self.recordMgr.getRecordStatusBlock { errorCode, model in
        guard errorCode == 0, let model else {
          promise.reject("StatusFailed", "getRecordStatus returned \(errorCode)")
          return
        }
        promise.resolve([
          "state": model.state.rawValue,
          "recording": model.state == .recording,
          "usbConnected": model.udisk == 1,
          "privacyMode": model.privacy == 1,
        ])
      }
    }

    AsyncFunction("getStorageInfo") { (promise: Promise) in
      self.recordMgr.getStorageCapacityInfoBlock { errorCode, model in
        guard errorCode == 0, let model else {
          promise.reject("StorageFailed", "getStorageCapacityInfo returned \(errorCode)")
          return
        }
        promise.resolve([
          "totalKB": model.total,
          "freeKB": model.free,
          "bytesPerSecond": model.rec_size_ps,
          "full": model.no_free_size == 1,
        ])
      }
    }

    // MARK: - Recording

    AsyncFunction("startRecord") { (promise: Promise) in
      // type 1 = normal recording; 2 is simultaneous-translation mode.
      self.recordMgr.startRecord(1) { errorCode, model in
        guard errorCode == 0, let model else {
          promise.reject("StartRecordFailed", "startRecord returned \(errorCode)")
          return
        }
        promise.resolve(["sessionId": model.sessionID, "result": model.reslut.rawValue])
      }
    }

    AsyncFunction("stopRecord") { (promise: Promise) in
      self.recordMgr.stopRecordBlock { errorCode, model in
        guard errorCode == 0, let model else {
          promise.reject("StopRecordFailed", "stopRecord returned \(errorCode)")
          return
        }
        promise.resolve([
          "sessionId": model.sessionID,
          "saved": model.file_exist == 1,
          "fileSize": model.file_size,
        ])
      }
    }

    // MARK: - Files

    /// The device ignores this while it is recording or in USB mode.
    AsyncFunction("listFiles") { (promise: Promise) in
      self.recordMgr.getRecordFileList(0, startSession: 0, onlyOne: 0) { errorCode, model in
        guard errorCode == 0, let model else {
          promise.reject("ListFailed", "getRecordFileList returned \(errorCode)")
          return
        }
        let files = (model.fileArray ?? []).map { file in
          [
            // fileName is the sessionID, as an integer.
            "sessionId": file.fileName,
            "size": file.fileSize,
            "type": file.type.rawValue,
          ]
        }
        promise.resolve(["count": model.count, "files": files])
      }
    }

    /// Pulls one recording down over BLE and writes it into the cache directory.
    /// Resolves with the local path once the device reports the transfer done.
    AsyncFunction("syncFile") { (sessionId: Int, fileType: Int, size: Int, promise: Promise) in
      if self.syncPromise != nil {
        promise.reject("SyncBusy", "A sync is already running.")
        return
      }
      guard let type = UTERecordingFileType(rawValue: fileType) else {
        promise.reject("BadFileType", "Unknown file type \(fileType)")
        return
      }

      self.syncPromise = promise
      self.syncFileExtension = Self.fileExtension(for: type)

      self.recordMgr.syncRecordData(sessionId, startIndex: 0, endIndex: size, fileType: type) { errorCode, _, result in
        // result != 0 means the device refused: 1 filesystem error, 2 missing,
        // 3 interrupted. No data callback will follow, so settle it here.
        guard errorCode == 0, result == 0 else {
          self.syncPromise?.reject("SyncRefused", "syncRecordData error=\(errorCode) result=\(result)")
          self.syncPromise = nil
          return
        }
      }
    }

    AsyncFunction("stopSync") { (promise: Promise) in
      self.recordMgr.stopSyncRecordDataBlock { _ in
        self.syncPromise?.reject("SyncStopped", "Sync cancelled.")
        self.syncPromise = nil
        promise.resolve(nil)
      }
    }

    AsyncFunction("deleteFile") { (sessionId: Int, fileType: Int, promise: Promise) in
      guard let type = UTERecordingFileType(rawValue: fileType) else {
        promise.reject("BadFileType", "Unknown file type \(fileType)")
        return
      }
      self.recordMgr.deletelRecordFile(sessionId, fileType: type) { errorCode, _, result in
        guard errorCode == 0, result == 0 else {
          promise.reject("DeleteFailed", "deleteRecordFile error=\(errorCode) result=\(result)")
          return
        }
        promise.resolve(true)
      }
    }
  }

  // MARK: - Helpers

  private func registerRecordNotifications() {
    guard !notificationsRegistered else { return }
    notificationsRegistered = true

    recordMgr.onNotifyStartRecordBlock { [weak self] _, model in
      guard let model else { return }
      self?.sendEvent("onRecordStart", [
        "sessionId": model.sessionID,
        // type 1 = the device's own button started it, 2 = the app did.
        "startedByDevice": model.type == 1,
        "scene": model.scene.rawValue,
      ])
    }

    recordMgr.onNotifyStopRecordBlock { [weak self] _, model in
      guard let model else { return }
      self?.sendEvent("onRecordStop", [
        "sessionId": model.sessionID,
        "saved": model.file_exist == 1,
        "fileSize": model.file_size,
      ])
    }

    recordMgr.onNotifySyncRecordDataBlock { [weak self] isCompleted, sessionID, size, _, completeData in
      guard let self else { return }
      self.sendEvent("onSyncProgress", [
        "sessionId": sessionID,
        "received": completeData?.count ?? 0,
        "total": size,
        "completed": isCompleted,
      ])
      guard isCompleted, let data = completeData else { return }
      self.finishSync(sessionID: sessionID, data: data)
    }

    recordMgr.onNotifySyncRecordDataCompleteBlock { [weak self] sessionID in
      // Fires after the data block. If that already resolved the promise this is
      // a no-op; it is here so an empty transfer still settles.
      guard let self, self.syncPromise != nil else { return }
      self.finishSync(sessionID: sessionID, data: Data())
    }
  }

  private func finishSync(sessionID: NSInteger, data: Data) {
    guard let promise = syncPromise else { return }
    syncPromise = nil

    do {
      let dir = try FileManager.default
        .url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        .appendingPathComponent("ute-recordings", isDirectory: true)
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

      let url = dir.appendingPathComponent("\(sessionID).\(syncFileExtension)")
      try data.write(to: url, options: .atomic)
      promise.resolve([
        "sessionId": sessionID,
        "path": url.path,
        "uri": url.absoluteString,
        "bytes": data.count,
      ])
    } catch {
      promise.reject("WriteFailed", error.localizedDescription)
    }
  }

  private static func fileExtension(for type: UTERecordingFileType) -> String {
    // Raw values from UTERecordMgr.h; the Swift names of these cases vary between Xcode versions.
    switch type.rawValue {
    case 0: return "avo"
    case 1: return "opus"
    case 2: return "mp3"
    case 3: return "sbc"
    case 4: return "pcm"
    case 5: return "wav"
    default: return "bin"
    }
  }
}
