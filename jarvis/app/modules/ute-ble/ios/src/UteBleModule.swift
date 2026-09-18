import ExpoModulesCore

// Every vendor SDK call lives in UteBleBridge.m; this file only speaks Foundation types.
public class UteBleModule: Module {
  private let bridge = UteBleBridge.shared

  private var syncPromise: Promise?
  private var syncFileExtension = "opus"

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

    // The SDK touches CoreBluetooth on setup, so it stays on main.
    AsyncFunction("initialize") { () -> String in
      self.bridge.onDeviceFound = { [weak self] device in
        self?.sendEvent("onDeviceFound", device)
      }
      self.bridge.onConnectionChange = { [weak self] status, connected, error in
        self?.sendEvent("onConnectionChange", [
          "status": status,
          "connected": connected,
          "error": error as Any,
        ])
      }
      self.bridge.onBluetoothState = { [weak self] state, poweredOn in
        self?.sendEvent("onBluetoothState", ["state": state, "poweredOn": poweredOn])
      }
      self.bridge.onClip = { [weak self] data in
        self?.sendEvent("onClipData", ["bytes": data.count, "base64": data.base64EncodedString()])
      }
      self.bridge.onRecordStart = { [weak self] info in
        self?.sendEvent("onRecordStart", info)
      }
      self.bridge.onRecordStop = { [weak self] info in
        self?.sendEvent("onRecordStop", info)
      }
      self.bridge.onSyncProgress = { [weak self] completed, sessionId, size, data in
        guard let self else { return }
        self.sendEvent("onSyncProgress", [
          "sessionId": sessionId,
          "received": data?.count ?? 0,
          "total": size,
          "completed": completed,
        ])
        if completed, let data {
          self.finishSync(sessionId: sessionId, data: data)
        }
      }
      self.bridge.onSyncComplete = { [weak self] sessionId in
        // Fires after the data callback; only settles transfers that produced no data.
        self?.finishSync(sessionId: sessionId, data: Data())
      }
      return self.bridge.setUp()
    }
    .runOnQueue(.main)

    AsyncFunction("startScan") {
      self.bridge.startScan()
    }
    .runOnQueue(.main)

    AsyncFunction("stopScan") {
      self.bridge.stopScan()
    }
    .runOnQueue(.main)

    AsyncFunction("connect") { (id: String) in
      guard self.bridge.connect(deviceId: id) else {
        throw Exception(name: "UnknownDevice", description: "No scanned device with id " + id + ". Scan again.")
      }
    }
    .runOnQueue(.main)

    AsyncFunction("disconnect") { () -> Bool in
      self.bridge.disconnect()
    }
    .runOnQueue(.main)

    AsyncFunction("isConnected") { () -> Bool in
      self.bridge.isConnected()
    }

    /// hasAIRecording says whether this firmware speaks the recording protocol at all.
    AsyncFunction("connectedDevice") { () -> [String: Any]? in
      self.bridge.connectedDevice()
    }

    AsyncFunction("bind") { (token: String, verify: Int, promise: Promise) in
      self.bridge.bind(token: token, verify: verify) { errorCode, result in
        Self.settle(promise, errorCode, result, "BindFailed", "appBindRecordDevice")
      }
    }

    AsyncFunction("getStatus") { (promise: Promise) in
      self.bridge.getStatus { errorCode, result in
        Self.settle(promise, errorCode, result, "StatusFailed", "getRecordStatus")
      }
    }

    AsyncFunction("getStorageInfo") { (promise: Promise) in
      self.bridge.getStorageInfo { errorCode, result in
        Self.settle(promise, errorCode, result, "StorageFailed", "getStorageCapacityInfo")
      }
    }

    AsyncFunction("startRecord") { (promise: Promise) in
      self.bridge.startRecord { errorCode, result in
        Self.settle(promise, errorCode, result, "StartRecordFailed", "startRecord")
      }
    }

    AsyncFunction("stopRecord") { (promise: Promise) in
      self.bridge.stopRecord { errorCode, result in
        Self.settle(promise, errorCode, result, "StopRecordFailed", "stopRecord")
      }
    }

    AsyncFunction("listFiles") { (promise: Promise) in
      self.bridge.listFiles { errorCode, result in
        Self.settle(promise, errorCode, result, "ListFailed", "getRecordFileList")
      }
    }

    /// Pulls one recording over BLE into the cache directory and resolves with its path.
    AsyncFunction("syncFile") { (sessionId: Int, fileType: Int, size: Int, promise: Promise) in
      if self.syncPromise != nil {
        promise.reject("SyncBusy", "A sync is already running.")
        return
      }
      guard let ext = Self.fileExtension(for: fileType) else {
        promise.reject("BadFileType", "Unknown file type \(fileType)")
        return
      }
      self.syncPromise = promise
      self.syncFileExtension = ext

      self.bridge.syncFile(sessionId: sessionId, fileType: fileType, size: size) { errorCode, result in
        // result != 0: 1 filesystem error, 2 missing, 3 interrupted. No data follows.
        guard errorCode == 0, result == 0 else {
          self.syncPromise?.reject("SyncRefused", "syncRecordData error=\(errorCode) result=\(result)")
          self.syncPromise = nil
          return
        }
      }
    }

    AsyncFunction("stopSync") { (promise: Promise) in
      self.bridge.stopSync { _ in
        self.syncPromise?.reject("SyncStopped", "Sync cancelled.")
        self.syncPromise = nil
        promise.resolve(nil)
      }
    }

    AsyncFunction("deleteFile") { (sessionId: Int, fileType: Int, promise: Promise) in
      guard Self.fileExtension(for: fileType) != nil else {
        promise.reject("BadFileType", "Unknown file type \(fileType)")
        return
      }
      self.bridge.deleteFile(sessionId: sessionId, fileType: fileType) { errorCode, result in
        guard errorCode == 0, result == 0 else {
          promise.reject("DeleteFailed", "deleteRecordFile error=\(errorCode) result=\(result)")
          return
        }
        promise.resolve(true)
      }
    }
  }

  private static func settle(
    _ promise: Promise, _ errorCode: Int, _ result: [String: Any]?, _ code: String, _ call: String
  ) {
    guard errorCode == 0, let result else {
      promise.reject(code, "\(call) returned \(errorCode)")
      return
    }
    promise.resolve(result)
  }

  private func finishSync(sessionId: Int, data: Data) {
    guard let promise = syncPromise else { return }
    syncPromise = nil

    do {
      let dir = try FileManager.default
        .url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        .appendingPathComponent("ute-recordings", isDirectory: true)
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

      let url = dir.appendingPathComponent("\(sessionId).\(syncFileExtension)")
      try data.write(to: url, options: .atomic)
      promise.resolve([
        "sessionId": sessionId,
        "path": url.path,
        "uri": url.absoluteString,
        "bytes": data.count,
      ])
    } catch {
      promise.reject("WriteFailed", error.localizedDescription)
    }
  }

  /// UTERecordingFileType raw values from UTERecordMgr.h.
  private static func fileExtension(for fileType: Int) -> String? {
    switch fileType {
    case 0: return "avo"
    case 1: return "opus"
    case 2: return "mp3"
    case 3: return "sbc"
    case 4: return "pcm"
    case 5: return "wav"
    default: return nil
    }
  }
}
