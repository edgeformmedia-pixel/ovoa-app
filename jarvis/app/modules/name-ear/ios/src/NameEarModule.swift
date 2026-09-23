import AVFoundation
import ExpoModulesCore
import Speech

// The phone's own ear.
//
// Until this existed, the orb streamed every second of microphone audio to
// Deepgram for as long as it was on, and the phone decided afterwards which
// words were for the assistant. On the heaviest day that was 380 minutes
// streamed for 62 minutes of actual requests: 70% of what OVOA cost to run,
// spent transcribing a room. This module turns that around. It owns the
// microphone and runs Apple's speech recognition over the audio on the phone
// itself (never Apple's servers).
//
// Since 2026-09-23 its words are the only way the app hears speech: the turn's
// text is taken from onWord (lib/liveListen.ts, lib/earWords.ts), and no audio
// leaves the phone at all. The audio hand-over below (setSending, onAudio, the
// ring of the last few seconds) is what fed the old Deepgram stream; the app no
// longer exposes or calls it (modules/name-ear/index.ts), and starts the ear
// with preRollSeconds 0, so the ring keeps nothing.
//
// Two recognisers, by iOS version:
//   iOS 26 and later: SpeechAnalyzer with a SpeechTranscriber. On-device only
//     by construction; the model is downloaded once by the system and shared.
//   Earlier: SFSpeechRecognizer with requiresOnDeviceRecognition, the name as
//     a contextual string. If the device cannot recognise on its own, this
//     module refuses to start rather than quietly using the network, and says
//     so: the app then keeps listening for the name off, and a turn the
//     person starts uses Apple's own recogniser instead (lib/liveListen.ts).
//
// The recogniser's words never leave this process except as an "onWord" event
// to JavaScript, which spots the name in them and, once the person is talking
// to OVOA, sends the words of their request as text. It logs none of them.
//
// When iOS stops the engine (a call, Siri, a headset plugged in), the ear says
// so at once: "stopped", with the cause, and isRunning goes false. Until
// 2026-09-23 isRunning stayed true from start() to stop(), so a halted ear
// looked alive and the app only noticed from five seconds without a level
// report. restartEngine brings the microphone back without rebuilding the
// recogniser, and so does start() on an ear that has halted. Where the iPhone
// can (iOS 18.2 and later, some 2024 and later models), the input has the
// phone's own speaker cancelled out of it, so a reply playing aloud isn't
// heard back as the person talking.
//
// Written in the same shape as modules/ute-ble: plain-English errors through
// GenericException, events with sendEvent, nothing on the JS thread that can
// wait. Audio conversion follows expo-audio's AudioStream.swift (with the
// project's own patch to it), which is known to work on this app's builds.

/// Expo drops the message of `promise.reject(code, message)`; this keeps it.
final class NameEarException: GenericException<String> {
  override var reason: String { param }
}

public class NameEarModule: Module {
  private var ear: NameEar?

  public func definition() -> ModuleDefinition {
    Name("NameEar")

    Events("onName", "onWord", "onAudio", "onState", "onLevel")

    /// Whether this phone can hear its name on its own, and how.
    AsyncFunction("availability") { () -> [String: Any] in
      return NameEar.availability()
    }

    /// Starts the microphone and the recogniser. Resolves with which recogniser
    /// is in use; rejects with a sentence when it can't (no permission, no
    /// on-device recognition, the app is off screen).
    AsyncFunction("start") { (options: [String: Any], promise: Promise) in
      let settings = NameEar.Settings(
        name: (options["name"] as? String) ?? "OVOA",
        preRollSeconds: (options["preRollSeconds"] as? Double) ?? 4,
        echoCancel: (options["echoCancel"] as? Bool) ?? true,
        mayReactivate: (options["mayReactivate"] as? Bool) ?? false
      )
      guard let current = self.ear else {
        self.startNew(settings, promise: promise)
        return
      }
      current.name = settings.name
      if current.isRunning {
        promise.resolve(current.describe())
        return
      }
      guard current.ready else {
        // Its start never finished (it failed, or is still waiting on iOS):
        // begin again from nothing rather than leave the old one behind.
        current.stop()
        self.ear = nil
        self.startNew(settings, promise: promise)
        return
      }
      // Halted after a start that finished (an interruption, a lost
      // microphone): the light way, as restartEngine. Until 2026-09-23 this
      // stopped the ear and built a new one, and liveListen.ts holdEar comes
      // here whenever isRunning is false: the model asked for again, a new
      // transcriber, and the old ear's interruption watcher gone with it, so a
      // start during a call failed with '!pri' and left no ear at all to come
      // back by itself when the call ended.
      current.restart { error in
        guard let error else {
          promise.resolve(current.describe())
          return
        }
        // iOS refusing the session would refuse a new ear the same way, so this
        // one is kept, and still comes back by itself when the interruption
        // ends. One stopped or replaced while it waited is left as it is.
        if NameEar.refusedByIOS(error) || self.ear !== current {
          promise.reject(NameEarException(NameEar.explain(error)))
          return
        }
        // Something wrong with this ear itself (a tap that wouldn't go on): a new one.
        current.stop()
        self.ear = nil
        self.startNew(settings, promise: promise)
      }
    }.runOnQueue(.main)

    AsyncFunction("stop") {
      self.ear?.stop()
      self.ear = nil
    }.runOnQueue(.main)

    /// The microphone again, keeping the recogniser: a new engine and tap, the
    /// session reactivated, but no model check and no new transcriber, so the
    /// transcript carries on. For an ear that stopped ("stopped" on onState) or
    /// went quiet. Rejects when there's no ear, or iOS still refuses.
    AsyncFunction("restartEngine") { (promise: Promise) in
      guard let ear = self.ear else {
        promise.reject(NameEarException("The phone's ear isn't started, so there's nothing to restart."))
        return
      }
      ear.restart { error in
        if let error {
          promise.reject(NameEarException(NameEar.explain(error)))
        } else {
          promise.resolve(ear.describe())
        }
      }
    }.runOnQueue(.main)

    /// On: hand over the audio kept so far, then everything from now on. Off: stop handing it over.
    AsyncFunction("setSending") { (on: Bool) in
      self.ear?.setSending(on)
    }

    /// Only while the engine is running: false through an interruption, a lost microphone or a restart.
    Function("isRunning") { () -> Bool in
      return self.ear?.isRunning ?? false
    }

    Function("isSending") { () -> Bool in
      return self.ear?.sending ?? false
    }

    OnDestroy {
      self.ear?.stop()
      self.ear = nil
    }
  }

  /// A new ear from nothing: the recogniser built (on iOS 26 the model asked
  /// for), the session set up and watched, the engine started. On the main queue.
  private func startNew(_ settings: NameEar.Settings, promise: Promise) {
    let ear = NameEar(settings)
    // emit, not sendEvent: only the typed emitter turns a NativeArrayBuffer
    // into a JavaScript ArrayBuffer. Through sendEvent the audio arrives as undefined.
    ear.onEvent = { [weak self] event, payload in
      self?.emit(event: event, payload: payload)
    }
    self.ear = ear
    ear.start { error in
      if let error {
        // Only this start's own ear: a later start may already have replaced it.
        if self.ear === ear { self.ear = nil }
        promise.reject(NameEarException(error))
      } else {
        promise.resolve(ear.describe())
      }
    }
  }
}

/// Spots the assistant's name in what the recogniser heard, the way the app's
/// turnGate.ts does: any word (or two run together, for "O V O A") within one
/// letter of the name, once the punctuation and case are gone.
struct NameMatcher {
  private let target: String
  private let allowed: Int

  init(_ name: String) {
    let clean = NameMatcher.clean(name).replacingOccurrences(of: " ", with: "")
    target = clean
    allowed = clean.count >= 4 ? 1 : 0
  }

  static func clean(_ s: String) -> String {
    let lowered = s.lowercased().folding(options: .diacriticInsensitive, locale: nil)
    return String(lowered.unicodeScalars.map { CharacterSet.alphanumerics.contains($0) || $0 == " " ? Character($0) : Character(" ") })
      .trimmingCharacters(in: .whitespaces)
  }

  /// How many times the name is said in `text`. A recogniser's transcript grows
  /// as the person keeps talking, so "is the name in it" would stay true for a
  /// minute after one mention; one more mention than before is what counts.
  func count(_ text: String) -> Int {
    guard target.count >= 3 else { return 0 }
    // "O.V.O.A." and "o v o a" become "ovoa".
    let words = NameMatcher.clean(text).split(separator: " ").map(String.init).filter { !$0.isEmpty }
    var found = 0
    var i = 0
    while i < words.count {
      if isName(words[i]) {
        found += 1
      } else if i + 1 < words.count, isName(words[i] + words[i + 1]) {
        found += 1
        i += 1
      } else if words[i].count == 1 {
        // Single letters run together ("o v o a").
        var run = words[i]
        var j = i + 1
        while j < words.count, words[j].count == 1, run.count < target.count { run += words[j]; j += 1 }
        if run.count >= 3, isName(run) {
          found += 1
          i = j - 1
        }
      }
      i += 1
    }
    return found
  }

  private func isName(_ word: String) -> Bool {
    return abs(word.count - target.count) <= allowed && NameMatcher.distance(word, target) <= allowed
  }

  private static func distance(_ a: String, _ b: String) -> Int {
    let x = Array(a), y = Array(b)
    if x.isEmpty { return y.count }
    if y.isEmpty { return x.count }
    var row = Array(0...y.count)
    for i in 1...x.count {
      var prev = row[0]
      row[0] = i
      for j in 1...y.count {
        let cur = row[j]
        row[j] = min(row[j] + 1, row[j - 1] + 1, prev + (x[i - 1] == y[j - 1] ? 0 : 1))
        prev = cur
      }
    }
    return row[y.count]
  }
}

/// The microphone, the recogniser, and the few seconds of audio kept ready.
final class NameEar {
  /// What JavaScript's start() asked for.
  struct Settings {
    let name: String
    let preRollSeconds: Double
    /// Ask iOS for echo-cancelled input where the phone has it. On unless JavaScript turns it off.
    let echoCancel: Bool
    /// Nothing in the app is playing, so the session may be turned off and on
    /// once to have echo cancellation applied (reactivateForEchoCancel). Off
    /// unless JavaScript says so: only it knows what expo-audio is playing.
    let mayReactivate: Bool
  }

  var name: String {
    didSet { matcher = NameMatcher(name) }
  }
  let preRollSeconds: Double
  let echoCancel: Bool
  let mayReactivate: Bool
  var onEvent: ((String, [String: Any]) -> Void)?
  /// True only while the engine runs. A plain flag, set on the main thread,
  /// because JavaScript reads it from its own thread (Function "isRunning").
  private(set) var isRunning = false
  /// Its start finished: the recogniser is built and the session watched. A
  /// start() for this ear once it has halted restarts the engine and nothing
  /// more (the module's start).
  private(set) var ready = false
  /// Why iOS threw when echo-cancelled input was asked for, so describe() can
  /// tell "threw" apart from "took the preference and declined".
  private var echoCancelError: String?
  /// This ear turned the session off and on so iOS would apply echo cancellation.
  private var echoReactivated = false
  /// An ear in this process already has: once per launch at most.
  private static var echoReactivatedThisLaunch = false
  /// stop() was called. The recogniser's callbacks and the session watchers
  /// check it, and a start or restart still waiting on iOS gives up at its next
  /// step rather than open the microphone for an ear nobody holds.
  private var stopped = false
  private(set) var sending = false
  private(set) var engineKind = "none"

  /// Every piece of audio, and every event, goes through this one queue, so the
  /// pre-roll is always handed over before the live audio that follows it.
  private let queue = DispatchQueue(label: "ovoa.name-ear")
  private var matcher: NameMatcher
  private var audioEngine: AVAudioEngine?
  private var converter: AVAudioConverter?
  /// 16 kHz, 16-bit, mono: what the loudness is measured on (and what the old Deepgram stream was sent).
  private let targetFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!
  /// The last preRollSeconds of converted audio.
  private var ring = Data()
  private var ringCap: Int { Int(preRollSeconds * 16_000 * 2) }
  private var lastLevelAt: TimeInterval = 0
  private var lastWords = ""
  /// Mentions of the name in the transcript so far, so a growing transcript wakes once per mention.
  private var namesHeard = 0
  /// The audio session's watchers, for the life of the ear.
  private var observers: [NSObjectProtocol] = []
  /// The current engine's own watcher: each engine gets a new one (runEngine).
  private var engineObserver: NSObjectProtocol?

  // iOS before 26. The request is swapped on the main thread and read on the
  // audio thread, so it goes through a lock rather than a bare property.
  private var recognizer: SFSpeechRecognizer?
  private let requestLock = NSLock()
  private var request: SFSpeechAudioBufferRecognitionRequest? {
    get { requestLock.lock(); defer { requestLock.unlock() }; return storedRequest }
    set { requestLock.lock(); defer { requestLock.unlock() }; storedRequest = newValue }
  }
  private var storedRequest: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var taskStartedAt: Date?
  /// Which recognition task is the current one. A retired task's last callbacks
  /// (cancelling it produces one) carry an older number and are ignored, which
  /// is what stops "retire, callback, retire again" from running forever.
  private var taskGeneration = 0
  /// Apple stops recognition tasks after about a minute; a fresh one starts before that.
  private let taskLifetime: TimeInterval = 50
  // iOS 26 and later. Typed loosely so the class compiles on older SDK targets.
  private var analyzer: AnyObject?

  init(_ settings: Settings) {
    self.name = settings.name
    self.preRollSeconds = settings.preRollSeconds
    self.echoCancel = settings.echoCancel
    self.mayReactivate = settings.mayReactivate
    self.matcher = NameMatcher(settings.name)
  }

  /// What start and restartEngine resolve with, and what each "listening" carries.
  /// sampleRate is the rate of the audio handed over (always 16 kHz);
  /// sessionSampleRate is the rate iOS actually runs the session at (16 kHz is
  /// only asked for). echoCancelled: iOS is taking the phone's own speaker out
  /// of the microphone's audio right now, which a headset turns off again.
  func describe() -> [String: Any] {
    let session = AVAudioSession.sharedInstance()
    var out: [String: Any] = [
      "engine": engineKind,
      "onDevice": true,
      "sampleRate": 16_000,
      "preRollSeconds": preRollSeconds,
      "running": isRunning,
      "sessionSampleRate": session.sampleRate,
      "echoCancelAvailable": false,
      "echoCancelled": false,
      "echoCancelReactivated": echoReactivated,
    ]
    if #available(iOS 18.2, *) {
      out["echoCancelAvailable"] = session.isEchoCancelledInputAvailable
      out["echoCancelled"] = session.isEchoCancelledInputEnabled
    }
    if let echoCancelError { out["echoCancelError"] = echoCancelError }
    return out
  }

  /// What this phone can do, before anything is started.
  static func availability() -> [String: Any] {
    if #available(iOS 26.0, *) {
      if SpeechTranscriber.isAvailable {
        return ["available": true, "engine": "analyzer"]
      }
    }
    let locale = NameEar.locale()
    guard let recognizer = SFSpeechRecognizer(locale: locale) else {
      return ["available": false, "engine": "none", "reason": "This iPhone has no speech recognition for \(locale.identifier)."]
    }
    if !recognizer.supportsOnDeviceRecognition {
      return ["available": false, "engine": "none", "reason": "This iPhone can only recognise speech through Apple's servers, which OVOA doesn't use."]
    }
    return ["available": true, "engine": "sfspeech"]
  }

  /// English, in the user's own variety when their phone is set to one.
  static func locale() -> Locale {
    let current = Locale.current
    if current.identifier.lowercased().hasPrefix("en") { return current }
    return Locale(identifier: "en-US")
  }

  // MARK: - Starting and stopping

  func start(completion: @escaping (String?) -> Void) {
    if #available(iOS 26.0, *), SpeechTranscriber.isAvailable {
      startAnalyzer(completion: completion)
      return
    }
    let locale = NameEar.locale()
    guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.supportsOnDeviceRecognition else {
      completion("This iPhone can't recognise speech on its own, so OVOA can't listen for its name here.")
      return
    }
    SFSpeechRecognizer.requestAuthorization { status in
      Task { @MainActor in
        guard status == .authorized else {
          completion("Speech recognition isn't allowed for OVOA. Turn it on in Settings > OVOA to let it hear its name.")
          return
        }
        self.recognizer = recognizer
        do {
          try await self.startEngine()
          self.engineKind = "sfspeech"
          self.beginRecognitionTask()
          self.ready = true
          self.emitListening(after: nil)
          completion(nil)
        } catch {
          self.stop()
          completion(NameEar.explain(error))
        }
      }
    }
  }

  @available(iOS 26.0, *)
  private func startAnalyzer(completion: @escaping (String?) -> Void) {
    let box = Analyzer26()
    Task { @MainActor in
      do {
        self.emit("onState", ["state": "preparing"])
        try await box.prepare(
          locale: NameEar.locale(),
          onText: { [weak self] text, isFinal in self?.heard(text, isFinal: isFinal) },
          onDownloading: { [weak self] in self?.emit("onState", ["state": "downloading"]) }
        )
        // Held from here, so a failure below, or a stop() while this waits, stops it too.
        self.analyzer = box
        self.engineKind = "analyzer"
        try await self.startEngine()
        try await box.start()
        try self.checkNotStopped()
        self.ready = true
        self.emitListening(after: nil)
        completion(nil)
      } catch {
        self.stop()
        completion(NameEar.explain(error))
      }
    }
  }

  /// AVAudioSession.ErrorCode.cannotInterruptOthers ('!int'): iOS won't open the microphone for an app off screen.
  private static let cannotInterruptOthers = 560_557_684
  /// AVAudioSession.ErrorCode.insufficientPriority ('!pri'): another audio session outranks this one
  /// (a call, Siri, another app recording). Not "off screen": it happens on screen too.
  private static let insufficientPriority = 561_017_449

  /// iOS refused the audio session itself ('!pri' or '!int'): a new ear would
  /// ask the same question and get the same answer.
  static func refusedByIOS(_ error: Error) -> Bool {
    let ns = error as NSError
    return ns.domain == NSOSStatusErrorDomain && (ns.code == insufficientPriority || ns.code == cannotInterruptOthers)
  }

  /// A sentence for JavaScript. iOS's own codes are named, with the number,
  /// because the app matches on them (lib/liveListen.ts looks for "off screen",
  /// lib/foreground.ts for the number).
  static func explain(_ error: Error) -> String {
    if let mine = error as? NameEarException { return mine.reason }
    let ns = error as NSError
    if ns.domain == NSOSStatusErrorDomain, ns.code == cannotInterruptOthers {
      return "iOS won't open the microphone while OVOA is off screen ('!int', OSStatus \(ns.code)). Open the app and try again."
    }
    if ns.domain == NSOSStatusErrorDomain, ns.code == insufficientPriority {
      return "Another audio session outranks OVOA's ('!pri', OSStatus \(ns.code)): a call, Siri or another app recording. Try again when it's done."
    }
    return "Couldn't start listening: \(error.localizedDescription) (\(ns.domain) \(ns.code))"
  }

  /// Play-and-record and mixable, so replies play while the microphone runs (expo-audio's stream does the same).
#if compiler(>=6.2) // Xcode 26
  private static let sessionOptions: AVAudioSession.CategoryOptions = [.mixWithOthers, .defaultToSpeaker, .allowBluetoothHFP]
#else
  private static let sessionOptions: AVAudioSession.CategoryOptions = [.mixWithOthers, .defaultToSpeaker, .allowBluetooth]
#endif

  /// The session and a running engine, the first time. The session's watchers are set up here, once.
  @MainActor
  private func startEngine() async throws {
    try checkNotStopped()
    try configureSession()
    try await activate()
    try await reactivateForEchoCancel()
    try checkNotStopped()
    try runEngine()
    watchSession()
  }

  /// Play-and-record in the default mode, set only when something else
  /// (expo-audio's audio mode) has changed it, so a restart does no more than it
  /// must. Then echo-cancelled input, which needs that category and mode, asked
  /// for before activating (describe() reports what iOS decided). Only a
  /// preference: a phone without it, or an iOS that won't take it, still
  /// listens, just with the reply's echo left in.
  private func configureSession() throws {
    let session = AVAudioSession.sharedInstance()
    if session.category != .playAndRecord || session.mode != .default || session.categoryOptions != NameEar.sessionOptions {
      try session.setCategory(.playAndRecord, mode: .default, options: NameEar.sessionOptions)
    }
    try session.setPreferredSampleRate(16_000)
    if #available(iOS 18.2, *), session.isEchoCancelledInputAvailable, session.prefersEchoCancelledInput != echoCancel {
      do {
        try session.setPrefersEchoCancelledInput(echoCancel)
        echoCancelError = nil
      } catch {
        let ns = error as NSError
        echoCancelError = "\(error.localizedDescription) (\(ns.domain) \(ns.code))"
      }
    }
  }

  /**
   * Apple's page for setPrefersEchoCancelledInput only says whether iOS took it
   * can be read "after an audio session goes active", and the session here is
   * usually active before the ear asks: stop() leaves it on, and so does every
   * expo-audio player (keepAudioSessionActive). If iOS applies it only on
   * activation, the preference would wait for the app's next launch, and the
   * reply would go on being heard as the person ("Give me a second. just fine",
   * messages, 2026-09-23). So, once per launch at most: when it's asked for and
   * iOS still says it's off on the built-in microphone and speaker (where a
   * headset isn't the reason), the session is turned off and on again before
   * the engine starts. Only when JavaScript says nothing in the app is playing
   * (mayReactivate), because turning the session off stops every player in the
   * app, the alarm's keep-awake loop included (lib/nag.ts). Unproven until a
   * device log shows echoCancelled after echoCancelReactivated.
   */
  @MainActor
  private func reactivateForEchoCancel() async throws {
    guard mayReactivate, echoCancel, !NameEar.echoReactivatedThisLaunch else { return }
    guard #available(iOS 18.2, *) else { return }
    let session = AVAudioSession.sharedInstance()
    guard session.isEchoCancelledInputAvailable, session.prefersEchoCancelledInput, !session.isEchoCancelledInputEnabled else { return }
    let route = session.currentRoute
    guard route.inputs.contains(where: { $0.portType == .builtInMic }),
          route.outputs.contains(where: { $0.portType == .builtInSpeaker }) else { return }
    NameEar.echoReactivatedThisLaunch = true
    echoReactivated = true
    // With something still playing this stops it and throws isBusy, but the
    // session is off either way (setActive(_:options:)), so the error changes nothing.
    try? session.setActive(false)
    try await activate()
  }

  /// setActive(true), tried again 200, 400 and 800 ms later while iOS answers
  /// '!pri': another session outranks OVOA's for a moment (Siri finishing, a
  /// call hanging up). Until 2026-09-23 one '!pri' failed the whole start, and
  /// the ear stayed deaf until the app's next try, seconds later.
  @MainActor
  private func activate() async throws {
    let session = AVAudioSession.sharedInstance()
    for waitMs in [200, 400, 800] as [UInt64] {
      do {
        try session.setActive(true)
        return
      } catch let error as NSError where error.domain == NSOSStatusErrorDomain && error.code == NameEar.insufficientPriority {
        try await Task.sleep(nanoseconds: waitMs * 1_000_000)
      }
    }
    try session.setActive(true)
  }

  /// A new engine, tapped for the microphone as it is now, watched, and
  /// started. Whatever engine came before is dropped first, so two restarts
  /// that overlap can't leave two taps feeding the recogniser. A new engine
  /// rather than the old one started again: after iOS restarts its audio
  /// system, the old one is no use.
  private func runEngine() throws {
    dropEngine()
    let engine = AVAudioEngine()
    try installTap(on: engine)
    audioEngine = engine
    watchEngine(engine)
    try engine.start()
    isRunning = true
  }

  /**
   * The tap and the converter, built for the microphone's format right now.
   * Done again after a route change (headphones in, Bluetooth out): the
   * hardware format can change with it, and a tap built for the old one
   * delivers nothing.
   */
  private func installTap(on engine: AVAudioEngine) throws {
    let input = engine.inputNode
    input.removeTap(onBus: 0)
    let hardware = input.outputFormat(forBus: 0)
    guard hardware.sampleRate > 0 else {
      throw NameEarException("The microphone reported no audio format. Is another app using it?")
    }
    converter = hardware.sampleRate == 16_000 && hardware.channelCount == 1 && hardware.commonFormat == .pcmFormatInt16
      ? nil
      : AVAudioConverter(from: hardware, to: targetFormat)

    // About a tenth of a second per buffer, the same as expo-audio.
    let frames = AVAudioFrameCount(hardware.sampleRate * 0.1)
    input.installTap(onBus: 0, bufferSize: frames, format: hardware) { [weak self] buffer, _ in
      self?.tapped(buffer)
    }
  }

  /// The engine, its tap and its watcher, gone. The audio session is left as it is.
  private func dropEngine() {
    isRunning = false
    if let observer = engineObserver { NotificationCenter.default.removeObserver(observer) }
    engineObserver = nil
    audioEngine?.inputNode.removeTap(onBus: 0)
    audioEngine?.stop()
    audioEngine = nil
    converter = nil
  }

  /// For restartEngine, and start() on an ear that has halted: the microphone
  /// again, the recogniser kept. The error as iOS gave it, so the module can
  /// tell iOS refusing the session from anything else (refusedByIOS).
  func restart(completion: @escaping (Error?) -> Void) {
    Task { @MainActor in
      do {
        try await self.restartEngine()
        self.emitListening(after: "restart")
        completion(nil)
      } catch {
        completion(error)
      }
    }
  }

  /// A new engine and tap, the session set up and activated again, and nothing
  /// else: no model check, no new transcriber (SpeechAnalyzer or the SFSpeech
  /// task carries on, and the transcript with it), no setCategory unless
  /// something changed it. Much less than a stop() and start().
  @MainActor
  private func restartEngine() async throws {
    try checkNotStopped()
    dropEngine()
    try configureSession()
    try await activate()
    try checkNotStopped()
    try runEngine()
  }

  private func checkNotStopped() throws {
    if stopped { throw NameEarException("Listening was stopped while it was starting.") }
  }

  func stop() {
    let wasStopped = stopped
    stopped = true
    for o in observers { NotificationCenter.default.removeObserver(o) }
    observers = []
    dropEngine()
    endRecognitionTask()
    if #available(iOS 26.0, *), let box = analyzer as? Analyzer26 {
      box.stop()
    }
    analyzer = nil
    queue.sync {
      sending = false
      ring.removeAll(keepingCapacity: false)
    }
    // The session stays active on purpose: deactivating it here cut off a reply
    // that was playing (the same lesson as expo-audio's patch).
    // Said once: a start that fails stops itself, and the module's stop() may follow.
    if !wasStopped { emit("onState", ["state": "stopped"]) }
  }

  /// The engine stopped without being asked. JavaScript hears it at once:
  /// "stopped" with the cause and a sentence, where a stop() it asked for has
  /// neither, so it can restartEngine rather than wait out five seconds without
  /// a level report.
  private func halt(_ cause: String, _ reason: String) {
    isRunning = false
    emit("onState", ["state": "stopped", "cause": cause, "reason": reason])
  }

  /// "listening", with describe()'s fields: the session's real rate, and whether the echo is cancelled.
  private func emitListening(after: String?) {
    var payload = describe()
    payload["state"] = "listening"
    if let after { payload["after"] = after }
    emit("onState", payload)
  }

  /// Interruptions (a call, Siri, an alarm, another app) and iOS restarting its
  /// audio system both stop the engine; JavaScript is told as it happens. When
  /// an interruption ends, the ear starts again by itself.
  private func watchSession() {
    let center = NotificationCenter.default
    observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
      guard let self, !self.stopped else { return }
      let type = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init)
      if type == .began {
        self.halt("interruption", "iOS interrupted the microphone (a call, Siri, an alarm or another app).")
      } else if type == .ended, !self.isRunning {
        // Not running yet: JavaScript hasn't already restarted it.
        Task { @MainActor in
          do {
            try await self.restartEngine()
            self.emitListening(after: "interruption")
          } catch {
            // Still stopped, as "stopped" said when the interruption began.
            guard !self.stopped else { return }
            self.emit("onState", ["state": "error", "reason": NameEar.explain(error)])
          }
        }
      }
    })
    observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
      guard let self, !self.stopped else { return }
      // Every audio object is dead, and the session's category went with them:
      // restartEngine builds a new engine and sets the category again.
      self.halt("reset", "iOS restarted its audio system.")
    })
  }

  /// iOS stops an engine itself when the hardware changes under it (headphones
  /// in, Bluetooth out). The tap is rebuilt for the microphone's new format and
  /// the engine started again; when that fails the ear has stopped, and says so.
  private func watchEngine(_ engine: AVAudioEngine) {
    engineObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self, weak engine] _ in
      guard let self, !self.stopped, let engine, engine === self.audioEngine, !engine.isRunning else { return }
      self.isRunning = false
      do {
        try self.installTap(on: engine)
        try engine.start()
        self.isRunning = true
        self.emitListening(after: "route")
      } catch {
        self.halt("route", NameEar.explain(error))
      }
    }
  }

  // MARK: - Audio

  /// On the audio thread: convert, then hand everything to the queue.
  private func tapped(_ buffer: AVAudioPCMBuffer) {
    // The recogniser takes the microphone's own format.
    if let request { request.append(buffer) }
    if #available(iOS 26.0, *), let box = analyzer as? Analyzer26 {
      box.feed(buffer)
    }
    guard let data = convert(buffer) else { return }
    queue.async { [weak self] in self?.handle(data) }
  }

  /// The buffer as 16 kHz 16-bit mono bytes, converting only when the microphone differs.
  private func convert(_ buffer: AVAudioPCMBuffer) -> Data? {
    guard buffer.frameLength > 0 else { return nil }
    let source: AVAudioPCMBuffer
    if let converter {
      let capacity = AVAudioFrameCount(Double(buffer.frameLength) * 16_000 / buffer.format.sampleRate) + 1
      guard let out = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else { return nil }
      var error: NSError?
      var consumed = false
      converter.convert(to: out, error: &error) { _, status in
        if consumed {
          status.pointee = .noDataNow
          return nil
        }
        consumed = true
        status.pointee = .haveData
        return buffer
      }
      if error != nil || out.frameLength == 0 { return nil }
      source = out
    } else {
      source = buffer
    }
    guard let samples = source.int16ChannelData else { return nil }
    return Data(bytes: samples[0], count: Int(source.frameLength) * MemoryLayout<Int16>.size)
  }

  /// On the queue: keep it, measure it, and send it on when a request is under way.
  private func handle(_ data: Data) {
    ring.append(data)
    if ring.count > ringCap { ring.removeFirst(ring.count - ringCap) }
    let now = Date().timeIntervalSince1970
    if now - lastLevelAt >= 0.2 {
      lastLevelAt = now
      emit("onLevel", ["dbfs": NameEar.level(of: data)])
    }
    if sending { emitAudio(data, preRoll: false) }
  }

  func setSending(_ on: Bool) {
    queue.async { [weak self] in
      guard let self, self.sending != on else { return }
      self.sending = on
      if on, !self.ring.isEmpty {
        // What was said just before the name, and the name itself.
        self.emitAudio(self.ring, preRoll: true)
      }
    }
  }

  private func emitAudio(_ data: Data, preRoll: Bool) {
    // An ArrayBuffer on the JavaScript side, the same way expo-audio's stream hands its buffers over.
    guard let buffer = try? NativeArrayBuffer.copy(data: data) else { return }
    emit("onAudio", ["data": buffer, "preRoll": preRoll, "sampleRate": 16_000])
  }

  /// Rough loudness in dBFS, for the orb's halo. Every fourth sample is plenty.
  private static func level(of data: Data) -> Double {
    return data.withUnsafeBytes { raw -> Double in
      let samples = raw.bindMemory(to: Int16.self)
      guard !samples.isEmpty else { return -160 }
      var sum = 0.0
      var n = 0
      var i = 0
      while i < samples.count {
        let s = Double(samples[i])
        sum += s * s
        n += 1
        i += 4
      }
      let rms = (sum / Double(max(n, 1))).squareRoot() / 32768
      return rms > 0 ? 20 * log10(rms) : -160
    }
  }

  // MARK: - Words

  /// What the recogniser heard so far. The name is looked for here; the words
  /// go to JavaScript for its own, wider, matching, and nowhere else.
  private func heard(_ text: String, isFinal: Bool) {
    queue.async { [weak self] in
      guard let self else { return }
      // A final with the same words as the last volatile result still goes on:
      // it is what tells JavaScript the stretch is settled (lib/earWords.ts).
      if text == self.lastWords, !isFinal { return }
      // A shorter transcript is a new stretch of speech: the count starts over.
      if text.count < self.lastWords.count { self.namesHeard = 0 }
      self.lastWords = text
      self.emit("onWord", ["text": text, "isFinal": isFinal])
      let heard = self.matcher.count(text)
      if heard > self.namesHeard {
        self.emit("onName", ["at": Int(Date().timeIntervalSince1970 * 1000)])
      }
      self.namesHeard = heard
    }
  }

  private func emit(_ event: String, _ payload: [String: Any]) {
    onEvent?(event, payload)
  }

  // MARK: - SFSpeechRecognizer (iOS before 26)

  /// On the main thread only.
  private func beginRecognitionTask() {
    guard let recognizer else { return }
    taskGeneration += 1
    let generation = taskGeneration
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    request.requiresOnDeviceRecognition = true
    request.contextualStrings = [name, "OVOA"]
    request.taskHint = .dictation
    // Full stops and question marks: the app ends a request on them (lib/turnGate.ts).
    if #available(iOS 16.0, *) {
      request.addsPunctuation = true
    }
    self.request = request
    taskStartedAt = Date()
    task = recognizer.recognitionTask(with: request) { [weak self] result, error in
      // !stopped rather than isRunning: through an interruption the task is
      // kept, so the restarted engine feeds the same transcript.
      guard let self, !self.stopped, generation == self.taskGeneration else { return }
      if let result {
        self.heard(result.bestTranscription.formattedString, isFinal: result.isFinal)
      }
      let ended = error != nil || result?.isFinal == true
      let old = Date().timeIntervalSince(self.taskStartedAt ?? Date()) > self.taskLifetime
      if ended || old {
        // A task ends on its own (a pause, the one-minute limit) or is retired
        // before Apple retires it; either way a new one takes over so the ear
        // is never closed for long. Only the current task may do this: the
        // retired one's own last callback arrives a moment later and must not.
        // After a pause or a retirement the next task starts straight away, so
        // the first word after the pause isn't fed to a finished request; after
        // an error it waits a moment, so a run of errors can't loop tightly.
        let delay: TimeInterval = error == nil ? 0 : 0.2
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
          guard let self, !self.stopped, self.engineKind == "sfspeech", generation == self.taskGeneration else { return }
          self.endRecognitionTask()
          self.beginRecognitionTask()
        }
      }
    }
  }

  private func endRecognitionTask() {
    let ending = request
    let endingTask = task
    request = nil
    task = nil
    ending?.endAudio()
    endingTask?.cancel()
  }
}

// MARK: - SpeechAnalyzer (iOS 26 and later)

/// Apple's on-device transcriber, fed the microphone's buffers in the format it
/// asks for. Its model is fetched by the system the first time and kept there.
@available(iOS 26.0, *)
final class Analyzer26 {
  private var transcriber: SpeechTranscriber?
  private var analyzer: SpeechAnalyzer?
  private var input: AsyncStream<AnalyzerInput>.Continuation?
  private var format: AVAudioFormat?
  private var converter: AVAudioConverter?
  private var reading: Task<Void, Never>?

  func prepare(locale: Locale, onText: @escaping (String, Bool) -> Void, onDownloading: @escaping () -> Void) async throws {
    let chosen = await SpeechTranscriber.supportedLocale(equivalentTo: locale) ?? Locale(identifier: "en-US")
    // Progressive: results as they form, so the name is spotted the moment it is said.
    let transcriber = SpeechTranscriber(locale: chosen, preset: .progressiveTranscription)
    self.transcriber = transcriber
    if let download = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
      onDownloading()
      try await download.downloadAndInstall()
    }
    format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])
    analyzer = SpeechAnalyzer(modules: [transcriber], options: nil)
    reading = Task {
      do {
        for try await result in transcriber.results {
          onText(String(result.text.characters), result.isFinal)
        }
      } catch {
        // The session ended; stop() has or will clean up.
      }
    }
  }

  func start() async throws {
    guard let analyzer else { throw NameEarException("The transcriber wasn't prepared.") }
    let (stream, continuation) = AsyncStream.makeStream(of: AnalyzerInput.self)
    input = continuation
    try await analyzer.start(inputSequence: stream)
  }

  /// From the audio thread: converted to the analyzer's format when it asked for one.
  func feed(_ buffer: AVAudioPCMBuffer) {
    guard let input else { return }
    guard let format, format != buffer.format else {
      input.yield(AnalyzerInput(buffer: buffer))
      return
    }
    // Built for the buffers arriving now: after a restart or a route change the
    // microphone's format can differ, and a converter built for the old one
    // can't be trusted with the new buffers (the transcriber would go deaf
    // while the engine, and its level reports, carried on).
    if converter?.inputFormat != buffer.format { converter = AVAudioConverter(from: buffer.format, to: format) }
    guard let converter else {
      input.yield(AnalyzerInput(buffer: buffer))
      return
    }
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * format.sampleRate / buffer.format.sampleRate) + 1
    guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return }
    var error: NSError?
    var consumed = false
    converter.convert(to: out, error: &error) { _, status in
      if consumed {
        status.pointee = .noDataNow
        return nil
      }
      consumed = true
      status.pointee = .haveData
      return buffer
    }
    if error == nil, out.frameLength > 0 { input.yield(AnalyzerInput(buffer: out)) }
  }

  func stop() {
    input?.finish()
    input = nil
    reading?.cancel()
    reading = nil
    if let analyzer {
      Task { try? await analyzer.finalizeAndFinishThroughEndOfInput() }
    }
    analyzer = nil
    transcriber = nil
  }
}
