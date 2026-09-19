import AVFoundation

/// Turns an ES100 recording into a WAV the phone can play.
///
/// The clip stores bare opus packets back to back, each padded to a fixed size:
/// 40 bytes for mono and 80 for stereo, 20 ms of 16 kHz audio apiece (from the
/// vendor demo's HKOpusManager). There is no container, so each packet is fed to
/// iOS's own opus decoder one at a time.
enum OpusWav {
  struct Result {
    let channels: Int
    let sampleRate: Int
    let seconds: Double
    /// Packets that would not decode and were replaced with silence.
    let badPackets: Int
  }

  enum Failure: LocalizedError {
    case empty
    case unsupported(String)

    var errorDescription: String? {
      switch self {
      case .empty: return "The recording is empty."
      case .unsupported(let why): return why
      }
    }
  }

  private static let packetMs = 20

  static func decode(_ data: Data, to url: URL) throws -> Result {
    guard data.count >= 2 else { throw Failure.empty }
    if data.starts(with: Array("OggS".utf8)) {
      throw Failure.unsupported("This recording is already Ogg Opus; it has no fixed packet layout to decode.")
    }

    // Opus TOC byte, bit 2: stereo.
    let stereo = data[data.startIndex] & 0x04 != 0
    let channels = stereo ? 2 : 1
    let packetSize = stereo ? 80 : 40

    // 16 kHz is the clip's native rate; 48 kHz is the rate every opus decoder must support.
    for sampleRate in [16_000, 48_000] {
      if let result = try? decode(data, channels: channels, packetSize: packetSize, sampleRate: sampleRate, to: url) {
        return result
      }
    }
    throw Failure.unsupported("iOS could not decode the clip's opus audio.")
  }

  private static func decode(
    _ data: Data, channels: Int, packetSize: Int, sampleRate: Int, to url: URL
  ) throws -> Result {
    let framesPerPacket = sampleRate * packetMs / 1000
    var input = AudioStreamBasicDescription(
      mSampleRate: Double(sampleRate),
      mFormatID: kAudioFormatOpus,
      mFormatFlags: 0,
      mBytesPerPacket: 0,
      mFramesPerPacket: UInt32(framesPerPacket),
      mBytesPerFrame: 0,
      mChannelsPerFrame: UInt32(channels),
      mBitsPerChannel: 0,
      mReserved: 0
    )
    guard
      let inFormat = AVAudioFormat(streamDescription: &input),
      let outFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: Double(sampleRate), channels: AVAudioChannelCount(channels),
        interleaved: true),
      let converter = AVAudioConverter(from: inFormat, to: outFormat),
      // A code-3 opus packet may carry up to 120 ms.
      let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: AVAudioFrameCount(framesPerPacket * 6))
    else {
      throw Failure.unsupported("No opus decoder for \(sampleRate) Hz.")
    }
    let packet = AVAudioCompressedBuffer(format: inFormat, packetCapacity: 1, maximumPacketSize: packetSize)

    let silence = Data(count: framesPerPacket * channels * 2)
    var pcm = Data()
    pcm.reserveCapacity(data.count / packetSize * silence.count)
    var decoded = 0
    var bad = 0

    var offset = data.startIndex
    while offset + packetSize <= data.endIndex {
      let chunk = data[offset..<offset + packetSize]
      offset += packetSize

      // Unwritten space at the end of a file is zeros; that is silence, not a packet.
      if chunk.allSatisfy({ $0 == 0 }) {
        pcm.append(silence)
        continue
      }

      chunk.withUnsafeBytes { bytes in
        packet.data.copyMemory(from: bytes.baseAddress!, byteCount: packetSize)
      }
      packet.byteLength = UInt32(packetSize)
      packet.packetCount = 1
      packet.packetDescriptions?.pointee = AudioStreamPacketDescription(
        mStartOffset: 0, mVariableFramesInPacket: 0, mDataByteSize: UInt32(packetSize))

      out.frameLength = 0
      var fed = false
      var error: NSError?
      let status = converter.convert(to: out, error: &error) { _, inputStatus in
        if fed {
          inputStatus.pointee = .noDataNow
          return nil
        }
        fed = true
        inputStatus.pointee = .haveData
        return packet
      }

      if status == .error {
        bad += 1
        pcm.append(silence)
        converter.reset()
        continue
      }
      if out.frameLength > 0, let samples = out.int16ChannelData?[0] {
        pcm.append(UnsafeBufferPointer(start: samples, count: Int(out.frameLength) * channels))
        decoded += 1
      }
    }

    // Nothing decoded at all: this decoder setup doesn't work, let the caller try another.
    guard decoded > 0 else { throw Failure.unsupported("No packet decoded at \(sampleRate) Hz.") }

    try wav(pcm: pcm, sampleRate: sampleRate, channels: channels).write(to: url, options: .atomic)
    let seconds = Double(pcm.count) / Double(sampleRate * channels * 2)
    return Result(channels: channels, sampleRate: sampleRate, seconds: seconds, badPackets: bad)
  }

  /// A 44-byte RIFF header in front of 16-bit PCM.
  private static func wav(pcm: Data, sampleRate: Int, channels: Int) -> Data {
    var header = Data()
    func append<T: FixedWidthInteger>(_ value: T) {
      withUnsafeBytes(of: value.littleEndian) { header.append(contentsOf: $0) }
    }
    let byteRate = sampleRate * channels * 2
    header.append(contentsOf: Array("RIFF".utf8))
    append(UInt32(36 + pcm.count))
    header.append(contentsOf: Array("WAVEfmt ".utf8))
    append(UInt32(16))
    append(UInt16(1))  // PCM
    append(UInt16(channels))
    append(UInt32(sampleRate))
    append(UInt32(byteRate))
    append(UInt16(channels * 2))
    append(UInt16(16))
    header.append(contentsOf: Array("data".utf8))
    append(UInt32(pcm.count))
    return header + pcm
  }
}
