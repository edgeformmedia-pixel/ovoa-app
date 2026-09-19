/** Codec the device stores a recording in. AVO and opus are what the ES100 emits. */
export enum RecordFileType {
  AVO = 0, // opus, stereo
  Opus = 1, // opus, mono
  MP3 = 2,
  SBC = 3,
  PCM = 4,
  WAV = 5,
}

/** UTERecordStateType. */
export enum RecordState {
  Unknown = 0,
  Idle = 1,
  Recording = 2,
  Playing = 3,
  USBConnected = 4,
  WiFi = 5,
  FOTA = 6,
  FactoryTest = 7,
}

export type UteDevice = {
  /** MAC address, or the advertised name when the SDK reports no address. */
  id: string;
  name: string;
  address: string;
  rssi: number;
  /** Android only: the advertisement looks like UTE firmware (the vendor demo's own filter). */
  likelyUte?: boolean;
};

export type ConnectionChange = {
  /** Raw UTEDevicesStatus: -1 pairing failed, 0 connected, 1 disconnected, 2 error, 3 timeout, 4 connecting, 5 disconnecting. */
  status: number;
  connected: boolean;
  error?: string;
};

export type BluetoothState = {
  /** Raw UTEBluetoothStatus: 0 on, 1 off, 2 resetting, 3 unsupported, 4 unauthorized, 5 unknown. */
  state: number;
  poweredOn: boolean;
};

export type ConnectedDevice = {
  /** The same id scans report, so it can be saved and reconnected to later. iOS only. */
  id?: string;
  name: string;
  address: string;
  model: string;
  firmware: string;
  serialNumber: string;
  /** False means this firmware does not speak the recording protocol. Null on Android, which doesn't report it. */
  hasAIRecording: boolean | null;
  /** Supports live streaming rather than only file sync. Null on Android. */
  hasAIRecordRealTime: boolean | null;
};

/** iOS fills every field; Android's pairing call only reports `bound`. */
export type BindResult = {
  ssn: string | null;
  bound: boolean;
  /** 0 ok, 1 token mismatch, 2 busy recording, 3 user refused, 4 app must verify. */
  refuseCause: number | null;
  /** 0 normal, 1 mixed. */
  micMode: number | null;
};

/** Android has no status query: state is always Unknown there and `recording` reflects only what the app started. */
export type DeviceStatus = {
  state: RecordState;
  recording: boolean;
  usbConnected: boolean | null;
  privacyMode: boolean | null;
  /** Raw state of the clip's button, as the firmware reports it. iOS only. */
  keyState?: number;
  /** 0 normal, 1 mixed. iOS only. */
  micMode?: number;
};

export type BatteryInfo = {
  percent: number;
  charging: boolean;
  full: boolean;
  low: boolean;
};

/** One recording format the clip can produce. */
export type EncodingFormat = {
  type: RecordFileType;
  channels: number;
  sampleRate: number;
  bits: number;
  bitRate: number;
};

/** startRecord's `result`. */
export enum StartRecordResult {
  Started = 0,
  StorageFull = 1,
  USBMode = 2,
  HardwareError = 3,
  AlreadyRecording = 4,
  WiFiMode = 5,
  Stopped = 6,
  Unknown = 10,
}

/** Something the clip reported on its own. */
export type InputEvent = {
  /**
   * battery: percent; voiceButton: AI/voice button state 1-7; voiceData: bytes of opus the button
   * captured; offWrist: the wear state the clip reported (watches send it when taken off).
   */
  kind: "battery" | "voiceButton" | "voiceData" | "offWrist";
  value: number;
  detail?: string;
};

/** The device's answer to the post-connect pairing handshake. */
export type PairingChange = {
  paired: boolean;
  /** iOS: what happened, for the log. */
  message?: string;
};

export type StorageInfo = {
  totalKB: number;
  freeKB: number;
  /** Bytes of storage one second of recording consumes. */
  bytesPerSecond: number;
  full: boolean;
};

export type RecordFile = {
  /** Also the filename on the device. */
  sessionId: number;
  size: number;
  type: RecordFileType;
};

export type SyncProgress = {
  sessionId: number;
  received: number;
  total: number;
  completed: boolean;
};

export type SyncResult = {
  sessionId: number;
  /** The raw file as the clip stores it, in Documents/recordings. */
  path: string;
  uri: string;
  bytes: number;
  /** The playable WAV next to it. Missing when decoding failed (see decodeError). */
  wavPath?: string;
  wavUri?: string;
  seconds?: number;
  channels?: number;
  sampleRate?: number;
  /** Packets that wouldn't decode and became silence. */
  badPackets?: number;
  decodeError?: string;
};

export type DecodeResult = Required<Pick<SyncResult, "wavPath" | "wavUri" | "seconds" | "channels" | "sampleRate" | "badPackets">>;

export type RecordStartEvent = {
  sessionId: number;
  /** True when the button on the device started it rather than the app. */
  startedByDevice: boolean;
  scene: number;
};

export type RecordStopEvent = {
  sessionId: number;
  /** iOS only. */
  startedByDevice?: boolean;
  saved: boolean;
  fileSize: number;
};

/** Live audio from the recording-clip channel, base64 encoded. */
export type ClipDataEvent = {
  bytes: number;
  base64: string;
};

/** Which sensor self-tests the firmware claims to support. `all`: every factory-test flag, by name. */
export type SensorSupport = {
  accelerometer: boolean;
  gyroscope: boolean;
  button: boolean;
  motor: boolean;
  all?: Record<string, boolean>;
};

export type GyroReading = { range: number; x: number; y: number; z: number };

/**
 * Where motion comes from.
 * - "gyro3": the gyroscope test. One "on" and the ES100 sends a reading about once a second until it
 *   disconnects ("off" only stops the SDK handing them over). Twist to listen's default.
 * - "gsensorToggle": the watch accelerometer test, closed and reopened 50 ms later every interval;
 *   "gsensorGap": the same with 200 ms between close and open; "gsensor": reopened every interval
 *   without closing; "gsensorOnce": opened once. The ES100 answered one reading per open.
 * - "game": the motion-sensing game stream; "wear6"/"wear3": the wearables' accelerometer test;
 *   "gyro": the older gyroscope read, polled; "frame": the live health frame (steps). None of these
 *   sent anything on the ES100 (motion probe, 2026-09-19).
 */
export type MotionSource =
  | "game"
  | "wear6"
  | "wear3"
  | "gsensor"
  | "gsensorOnce"
  | "gsensorToggle"
  | "gsensorGap"
  | "gyro"
  | "gyro3"
  | "frame";

/**
 * One motion sample, by source:
 * - gyro3: [x, y, z, state, result]. x, y, z: angular rate, signed (-128…127; the bridge decodes the
 *   0-255 the SDK hands over). Units unknown: |x|+|y|+|z| stayed under about 50 on a still wrist
 *   (110 on a restless one) and reached 150-265 while twisting. state: 1 on, 0 off (then all zeros);
 *   result: 1 when an axis is non-zero.
 * - gsensor*: [x, y, z, magnitude, range]. Acceleration, signed, about 128 per g on range 4 (±4 g);
 *   magnitude = √(x² + y² + z²), about 124 at rest (the SDK's own "speed" repeats z, so it's recomputed).
 * - game: [x, y, speed, xThrow, yThrow, speedThrow]; wear6: [x, y, z, angle]; wear3: [x, y, z];
 *   gyro: [x, y, z, range]; frame: [step, calorie, distance, heart rate]. Units unknown.
 */
export type MotionSample = number[];

export type UteBleEvents = {
  onDeviceFound: (device: UteDevice) => void;
  onConnectionChange: (change: ConnectionChange) => void;
  onPairingChange: (change: PairingChange) => void;
  onBluetoothState: (state: BluetoothState) => void;
  onRecordStart: (event: RecordStartEvent) => void;
  onRecordStop: (event: RecordStopEvent) => void;
  onSyncProgress: (progress: SyncProgress) => void;
  onClipData: (data: ClipDataEvent) => void;
  /** iOS only: battery changes and the voice button. */
  onInput: (event: InputEvent) => void;
  /** iOS only: batches from the motion stream, while it is on. */
  onMotion: (event: { source: MotionSource; samples: MotionSample[] }) => void;
  /** iOS only: vendor SDK log lines while a connect is in flight, or all of them while setSdkLogging is on. */
  onLog: (event: { message: string }) => void;
};
