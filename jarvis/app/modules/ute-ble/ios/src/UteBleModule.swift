import ExpoModulesCore

/// Expo drops the message of `promise.reject(code, message)` ("undefined reason"),
/// so every failure goes through this, which keeps it.
final class UteException: GenericException<String> {
  override var reason: String { param }
}

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
      "onPairingChange", // The post-connect handshake on both platforms.
      "onBluetoothState",
      "onRecordStart",
      "onRecordStop",
      "onSyncProgress",
      "onClipData",
      "onInput",
      "onMotion",
      "onLog"
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
      self.bridge.onPairing = { [weak self] paired, message in
        self?.sendEvent("onPairingChange", ["paired": paired, "message": message])
      }
      self.bridge.onLog = { [weak self] line in
        self?.sendEvent("onLog", ["message": line])
      }
      self.bridge.onInput = { [weak self] input in
        self?.sendEvent("onInput", input)
      }
      self.bridge.onMotion = { [weak self] source, samples in
        self?.sendEvent("onMotion", ["source": source, "samples": samples])
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
      self.bridge.onSyncProgress = { [weak self] sessionId, received, total in
        self?.sendEvent("onSyncProgress", [
          "sessionId": sessionId,
          "received": received,
          "total": total,
          "completed": false,
        ])
      }
      self.bridge.onSyncFinished = { [weak self] sessionId, data, error in
        self?.finishSync(sessionId: sessionId, data: data, error: error)
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
        throw UteException("UnknownDevice: the clip \(id) hasn't been seen by a scan yet. Scan again.")
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

    /// Every `has…` capability flag the connected clip reports.
    AsyncFunction("capabilities") { () -> [String: Bool] in
      self.bridge.capabilities().mapValues { $0.boolValue }
    }
    .runOnQueue(.main)

    AsyncFunction("bind") { (token: String, verify: Int, promise: Promise) in
      self.bridge.bind(token: token, verify: verify) { errorCode, result in
        Self.settle(promise, errorCode, result, "appBindRecordDevice")
      }
    }

    AsyncFunction("getStatus") { (promise: Promise) in
      self.bridge.getStatus { errorCode, result in
        Self.settle(promise, errorCode, result, "getRecordStatus")
      }
    }

    AsyncFunction("getStorageInfo") { (promise: Promise) in
      self.bridge.getStorageInfo { errorCode, result in
        Self.settle(promise, errorCode, result, "getStorageCapacityInfo")
      }
    }

    AsyncFunction("getBattery") { (promise: Promise) in
      self.bridge.getBattery { errorCode, result in
        Self.settle(promise, errorCode, result, "getBatteryInfo")
      }
    }

    AsyncFunction("getRssi") { (promise: Promise) in
      self.bridge.getRssi { errorCode, result in
        Self.settle(promise, errorCode, result, "readDeviceRSSI")
      }
    }
    .runOnQueue(.main)

    AsyncFunction("getEncodingConfig") { (promise: Promise) in
      self.bridge.getEncodingConfig { errorCode, result in
        Self.settle(promise, errorCode, result, "getRecordEncodingConfiguration")
      }
    }

    AsyncFunction("probeSensors") { (promise: Promise) in
      self.bridge.probeSensors { errorCode, result in
        Self.settle(promise, errorCode, result, "checkFactoryFuntion")
      }
    }
    .runOnQueue(.main)

    AsyncFunction("readGyro") { (promise: Promise) in
      self.bridge.readGyro { errorCode, result in
        Self.settle(promise, errorCode, result, "factoryReadGyroData")
      }
    }
    .runOnQueue(.main)

    AsyncFunction("setMotionStream") { (on: Bool, promise: Promise) in
      self.bridge.setMotionStream(on: on) { errorCode in
        if errorCode == 408 {
          promise.reject(UteException("MotionUnsupported: the clip didn't answer sendGameStatus; this firmware likely has no motion stream."))
          return
        }
        guard errorCode == 0 else {
          promise.reject(UteException("sendGameStatus failed: \(Self.describe(errorCode))."))
          return
        }
        promise.resolve(nil)
      }
    }
    .runOnQueue(.main)

    AsyncFunction("setMotionSource") { (source: String, on: Bool, intervalMs: Int, promise: Promise) in
      self.bridge.setMotionSource(source, on: on, intervalMs: intervalMs) { errorCode in
        if errorCode == 408 {
          promise.reject(UteException("MotionUnsupported: the clip didn't answer (\(source))."))
          return
        }
        guard errorCode == 0 else {
          promise.reject(UteException("Motion source \(source) failed: \(Self.describe(errorCode))."))
          return
        }
        promise.resolve(nil)
      }
    }
    .runOnQueue(.main)

    AsyncFunction("readActivity") { (promise: Promise) in
      self.bridge.readActivity { errorCode, result in
        Self.settle(promise, errorCode, result, "getCurrentDayTotalWorkoutData")
      }
    }
    .runOnQueue(.main)

    /// Forward every SDK log line (raw packets included) as onLog, not only during a connect.
    AsyncFunction("setSdkLogging") { (on: Bool) in
      self.bridge.sdkLogging = on
    }
    .runOnQueue(.main)

    AsyncFunction("probeWearFunctions") { (promise: Promise) in
      self.bridge.probeWearFunctions { errorCode, result in
        Self.settle(promise, errorCode, result, "factoryReadFunction")
      }
    }
    .runOnQueue(.main)

    AsyncFunction("buzz") { (count: Int, option: Int, promise: Promise) in
      self.bridge.buzz(count: count, option: option) { errorCode, result in
        Self.settle(promise, errorCode, result, "buzz option \(option)")
      }
    }
    .runOnQueue(.main)

    AsyncFunction("startRecord") { (promise: Promise) in
      self.bridge.startRecord { errorCode, result in
        Self.settle(promise, errorCode, result, "startRecord")
      }
    }

    AsyncFunction("pauseRecord") { (sessionId: Int, promise: Promise) in
      self.bridge.pauseRecord(sessionId: sessionId) { errorCode, result in
        Self.settle(promise, errorCode, result, "pauseRecord")
      }
    }

    AsyncFunction("resumeRecord") { (sessionId: Int, promise: Promise) in
      self.bridge.resumeRecord(sessionId: sessionId) { errorCode, result in
        Self.settle(promise, errorCode, result, "resumeRecord")
      }
    }

    AsyncFunction("stopRecord") { (promise: Promise) in
      self.bridge.stopRecord { errorCode, result in
        Self.settle(promise, errorCode, result, "stopRecord")
      }
    }

    AsyncFunction("listFiles") { (promise: Promise) in
      self.bridge.listFiles { errorCode, result in
        Self.settle(promise, errorCode, result, "getRecordFileList")
      }
    }

    /// Pulls one recording over BLE into Documents/recordings, decodes it to WAV,
    /// and resolves with both paths.
    AsyncFunction("syncFile") { (sessionId: Int, fileType: Int, size: Int, promise: Promise) in
      if self.syncPromise != nil {
        promise.reject(UteException("SyncBusy: another download from the clip is still running."))
        return
      }
      guard let ext = Self.fileExtension(for: fileType) else {
        promise.reject(UteException("BadFileType: unknown file type \(fileType)."))
        return
      }
      self.syncPromise = promise
      self.syncFileExtension = ext

      self.bridge.syncFile(sessionId: sessionId, fileType: fileType, size: size) { errorCode, result in
        // result != 0: 1 filesystem error, 2 missing, 3 interrupted. No data follows.
        guard errorCode == 0, result == 0 else {
          let why = [1: "the clip's file system failed", 2: "the file isn't on the clip", 3: "the file is damaged"][result]
          self.syncPromise?.reject(
            UteException("SyncRefused: \(why ?? "the clip refused the download") (error \(errorCode), result \(result)).")
          )
          self.syncPromise = nil
          return
        }
      }
    }
    .runOnQueue(.main)

    AsyncFunction("stopSync") { (promise: Promise) in
      self.bridge.stopSync { _ in
        promise.resolve(nil)
      }
    }
    .runOnQueue(.main)

    /// Decodes a raw clip file (already on the phone) to WAV next to it.
    AsyncFunction("decodeFile") { (path: String) -> [String: Any] in
      let source = URL(fileURLWithPath: path)
      let data = try Data(contentsOf: source)
      return try Self.decodeToWav(data, next: source)
    }

    AsyncFunction("deleteFile") { (sessionId: Int, fileType: Int, promise: Promise) in
      guard Self.fileExtension(for: fileType) != nil else {
        promise.reject(UteException("BadFileType: unknown file type \(fileType)."))
        return
      }
      self.bridge.deleteFile(sessionId: sessionId, fileType: fileType) { errorCode, result in
        guard errorCode == 0, result == 0 else {
          let why = [1: "it is recording", 2: "the file is starred", 3: "it is playing", 4: "it is in USB mode"][result]
          promise.reject(UteException("DeleteFailed: the clip can't delete now\(why.map { " — \($0)" } ?? "") (error \(errorCode), result \(result))."))
          return
        }
        promise.resolve(true)
      }
    }
  }

  private static func settle(_ promise: Promise, _ errorCode: Int, _ result: [String: Any]?, _ call: String) {
    guard errorCode == 0, let result else {
      promise.reject(UteException("\(call) failed: \(describe(errorCode))."))
      return
    }
    promise.resolve(result)
  }

  /// UTEDeviceError values that can actually come back from the record calls.
  private static func describe(_ code: Int) -> String {
    switch code {
    case -1000: return "the clip is not connected"
    case -999: return "the reply was corrupted (CRC)"
    case -996: return "the clip's Bluetooth service isn't ready yet — wait a moment after connecting"
    case -601: return "the clip sent an empty reply"
    case -600: return "this firmware doesn't support that command"
    case -2: return "the clip refused"
    case 408: return "the clip didn't answer in time"
    default: return "error \(code)"
    }
  }

  private func finishSync(sessionId: Int, data: Data, error: String?) {
    guard let promise = syncPromise else { return }
    syncPromise = nil
    if let error {
      promise.reject(UteException("SyncFailed: \(error)."))
      return
    }
    let ext = syncFileExtension

    // Decoding a long recording takes a moment; keep it off the main thread.
    DispatchQueue.global(qos: .userInitiated).async {
      do {
        let dir = try Self.recordingsDirectory()
        let raw = dir.appendingPathComponent("\(sessionId).\(ext)")
        try data.write(to: raw, options: .atomic)

        var result: [String: Any] = [
          "sessionId": sessionId,
          "path": raw.path,
          "uri": raw.absoluteString,
          "bytes": data.count,
        ]
        do {
          result.merge(try Self.decodeToWav(data, next: raw)) { _, new in new }
        } catch {
          // Keep the raw file; the app can still show it and retry decoding later.
          result["decodeError"] = error.localizedDescription
        }
        promise.resolve(result)
      } catch {
        promise.reject(UteException("WriteFailed: \(error.localizedDescription)"))
      }
    }
  }

  private static func decodeToWav(_ data: Data, next source: URL) throws -> [String: Any] {
    let wav = source.deletingPathExtension().appendingPathExtension("wav")
    let decoded = try OpusWav.decode(data, to: wav)
    return [
      "wavPath": wav.path,
      "wavUri": wav.absoluteString,
      "seconds": decoded.seconds,
      "channels": decoded.channels,
      "sampleRate": decoded.sampleRate,
      "badPackets": decoded.badPackets,
    ]
  }

  /// Documents/recordings — the same place the app's Record tab keeps its list.
  private static func recordingsDirectory() throws -> URL {
    let dir = try FileManager.default
      .url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
      .appendingPathComponent("recordings", isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
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
