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
      let name = (options["name"] as? String) ?? "OVOA"
      let preRoll = (options["preRollSeconds"] as? Double) ?? 4
      if let running = self.ear, running.isRunning {
        running.name = name
        promise.resolve(running.describe())
        return
      }
      let ear = NameEar(name: name, preRollSeconds: preRoll)
      // emit, not sendEvent: only the typed emitter turns a NativeArrayBuffer
      // into a JavaScript ArrayBuffer. Through sendEvent the audio arrives as undefined.
      ear.onEvent = { [weak self] event, payload in
        self?.emit(event: event, payload: payload)
      }
      self.ear = ear
      ear.start { error in
        if let error {
          self.ear = nil
          promise.reject(NameEarException(error))
        } else {
          promise.resolve(ear.describe())
        }
      }
    }.runOnQueue(.main)

    AsyncFunction("stop") {
      self.ear?.stop()
      self.ear = nil
    }.runOnQueue(.main)

    /// On: hand over the audio kept so far, then everything from now on. Off: stop handing it over.
    AsyncFunction("setSending") { (on: Bool) in
      self.ear?.setSending(on)
    }

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
  var name: String {
    didSet { matcher = NameMatcher(name) }
  }
  let preRollSeconds: Double
  var onEvent: ((String, [String: Any]) -> Void)?
  private(set) var isRunning = false
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
  private var observers: [NSObjectProtocol] = []

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

  init(name: String, preRollSeconds: Double) {
    self.name = name
    self.preRollSeconds = preRollSeconds
    self.matcher = NameMatcher(name)
  }

  func describe() -> [String: Any] {
    return ["engine": engineKind, "onDevice": true, "sampleRate": 16_000, "preRollSeconds": preRollSeconds]
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
      DispatchQueue.main.async {
        guard status == .authorized else {
          completion("Speech recognition isn't allowed for OVOA. Turn it on in Settings > OVOA to let it hear its name.")
          return
        }
        self.recognizer = recognizer
        do {
          try self.startEngine()
          self.engineKind = "sfspeech"
          self.beginRecognitionTask()
          self.isRunning = true
          self.emit("onState", ["state": "listening", "engine": "sfspeech"])
          completion(nil)
        } catch {
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
        try self.startEngine()
        self.analyzer = box
        self.engineKind = "analyzer"
        try await box.start()
        self.isRunning = true
        self.emit("onState", ["state": "listening", "engine": "analyzer"])
        completion(nil)
      } catch {
        self.stop()
        completion(NameEar.explain(error))
      }
    }
  }

  private static func explain(_ error: Error) -> String {
    if let ns = error as NSError?, ns.domain == NSOSStatusErrorDomain, ns.code == 560_557_684 {
      return "iOS won't open the microphone while OVOA is off screen. Open the app and try again."
    }
    return "Couldn't start listening: \(error.localizedDescription)"
  }

  /// The audio session and engine, shared with the rest of the app: play-and-record and
  /// mixable, so replies play while the microphone runs (expo-audio's stream does the same).
  private func startEngine() throws {
    let session = AVAudioSession.sharedInstance()
#if compiler(>=6.2) // Xcode 26
    try session.setCategory(.playAndRecord, mode: .default, options: [.mixWithOthers, .defaultToSpeaker, .allowBluetoothHFP])
#else
    try session.setCategory(.playAndRecord, mode: .default, options: [.mixWithOthers, .defaultToSpeaker, .allowBluetooth])
#endif
    try session.setPreferredSampleRate(16_000)
    try session.setActive(true)

    let engine = AVAudioEngine()
    try installTap(on: engine)
    audioEngine = engine
    try engine.start()
    watchSession()
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

  func stop() {
    isRunning = false
    for o in observers { NotificationCenter.default.removeObserver(o) }
    observers = []
    audioEngine?.inputNode.removeTap(onBus: 0)
    audioEngine?.stop()
    audioEngine = nil
    converter = nil
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
    emit("onState", ["state": "stopped"])
  }

  /// A phone call, another app's audio: the engine stops. Start it again when
  /// the interruption ends, and say so either way.
  private func watchSession() {
    let center = NotificationCenter.default
    observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
      guard let self, self.isRunning else { return }
      let type = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init)
      if type == .ended {
        do {
          try AVAudioSession.sharedInstance().setActive(true)
          try self.audioEngine?.start()
          self.emit("onState", ["state": "listening", "engine": self.engineKind, "after": "interruption"])
        } catch {
          self.emit("onState", ["state": "error", "reason": NameEar.explain(error)])
        }
      } else {
        self.emit("onState", ["state": "interrupted"])
      }
    })
    observers.append(center.addObserver(forName: .AVAudioEngineConfigurationChange, object: audioEngine, queue: .main) { [weak self] _ in
      guard let self, self.isRunning, let engine = self.audioEngine, !engine.isRunning else { return }
      do {
        try self.installTap(on: engine)
        try engine.start()
      } catch {
        self.emit("onState", ["state": "error", "reason": NameEar.explain(error)])
      }
    })
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
      guard let self, self.isRunning, generation == self.taskGeneration else { return }
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
          guard let self, self.isRunning, self.engineKind == "sfspeech", generation == self.taskGeneration else { return }
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
    if converter == nil { converter = AVAudioConverter(from: buffer.format, to: format) }
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
