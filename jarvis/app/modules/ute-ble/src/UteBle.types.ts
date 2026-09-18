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
};

/** Android only: the device's answer to the post-connect pairing handshake. */
export type PairingChange = {
  paired: boolean;
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
  /** Absolute path in the app's cache directory. */
  path: string;
  uri: string;
  bytes: number;
};

export type RecordStartEvent = {
  sessionId: number;
  /** True when the button on the device started it rather than the app. */
  startedByDevice: boolean;
  scene: number;
};

export type RecordStopEvent = {
  sessionId: number;
  saved: boolean;
  fileSize: number;
};

/** Live audio from the recording-clip channel, base64 encoded. */
export type ClipDataEvent = {
  bytes: number;
  base64: string;
};

export type UteBleEvents = {
  onDeviceFound: (device: UteDevice) => void;
  onConnectionChange: (change: ConnectionChange) => void;
  onPairingChange: (change: PairingChange) => void;
  onBluetoothState: (state: BluetoothState) => void;
  onRecordStart: (event: RecordStartEvent) => void;
  onRecordStop: (event: RecordStopEvent) => void;
  onSyncProgress: (progress: SyncProgress) => void;
  onClipData: (data: ClipDataEvent) => void;
};
