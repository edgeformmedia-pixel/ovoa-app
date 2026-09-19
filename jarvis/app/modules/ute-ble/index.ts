import { requireOptionalNativeModule } from "expo";
import { PermissionsAndroid, Platform, type Permission } from "react-native";
import type { EventSubscription } from "expo-modules-core";

import type {
  BatteryInfo,
  BindResult,
  ConnectedDevice,
  DecodeResult,
  DeviceStatus,
  EncodingFormat,
  GyroReading,
  MotionSource,
  SensorSupport,
  RecordFile,
  RecordFileType,
  StorageInfo,
  SyncResult,
  UteBleEvents,
} from "./src/UteBle.types";

export * from "./src/UteBle.types";

/**
 * The ES100 recording clip. The UTE SDK (a vendored iOS framework / Android .aar)
 * only exists in a development build of OVOA — Expo Go cannot load it.
 */

type UteBleNativeModule = {
  /** Starts the SDK. Returns its version string. Call once, before anything else. */
  initialize(): Promise<string>;
  startScan(): Promise<void>;
  stopScan(): Promise<void>;
  connect(id: string): Promise<void>;
  disconnect(): Promise<boolean>;
  isConnected(): Promise<boolean>;
  connectedDevice(): Promise<ConnectedDevice | null>;
  capabilities(): Promise<Record<string, boolean>>;
  bind(token: string, verify: number): Promise<BindResult>;
  getStatus(): Promise<DeviceStatus>;
  getStorageInfo(): Promise<StorageInfo>;
  getBattery(): Promise<BatteryInfo>;
  getRssi(): Promise<{ rssi: number }>;
  getEncodingConfig(): Promise<{ formats: EncodingFormat[] }>;
  probeSensors(): Promise<SensorSupport>;
  readGyro(): Promise<GyroReading>;
  setMotionStream(on: boolean): Promise<void>;
  buzz(count: number, option: number): Promise<{ option: number }>;
  setLight(on: boolean, colors: number): Promise<{ on: boolean; colors: number }>;
  setMotionSource(source: MotionSource, on: boolean, intervalMs: number): Promise<void>;
  readActivity(): Promise<{ totals: string; calories: number }>;
  setSdkLogging(on: boolean): Promise<void>;
  probeWearFunctions(): Promise<{ functions: { type: number; value: number }[] }>;
  startRecord(): Promise<{ sessionId: number; result: number }>;
  pauseRecord(sessionId: number): Promise<{ sessionId: number; result: number }>;
  resumeRecord(sessionId: number): Promise<{ sessionId: number; result: number }>;
  stopRecord(): Promise<{ sessionId: number; saved: boolean; fileSize: number }>;
  listFiles(): Promise<{ count: number; files: RecordFile[] }>;
  syncFile(sessionId: number, fileType: RecordFileType, size: number): Promise<SyncResult>;
  stopSync(): Promise<void>;
  decodeFile(path: string): Promise<DecodeResult>;
  deleteFile(sessionId: number, fileType: RecordFileType): Promise<boolean>;
  addListener<K extends keyof UteBleEvents>(event: K, listener: UteBleEvents[K]): EventSubscription;
};

// requireOptional rather than require: in Expo Go this is null instead of a throw.
const UteBle = requireOptionalNativeModule<UteBleNativeModule>("UteBle");

/** True when the SDK is actually linked in — a development build on iOS or Android. */
export const uteAvailable = UteBle !== null;

function native(): UteBleNativeModule {
  if (!UteBle) {
    throw new Error("The ES100 needs the installed OVOA app (a development build), not Expo Go.");
  }
  return UteBle;
}

export const initialize = () => native().initialize();

/**
 * Android asks at runtime. 12+ needs the Bluetooth permissions (CONNECT is also
 * what lets us read device names during a scan); older versions need location.
 */
async function ensureBluetoothPermission() {
  if (Platform.OS !== "android") return;
  const p = PermissionsAndroid.PERMISSIONS;
  const wanted = (
    Number(Platform.Version) >= 31
      ? [p.BLUETOOTH_SCAN, p.BLUETOOTH_CONNECT, p.ACCESS_FINE_LOCATION]
      : [p.ACCESS_FINE_LOCATION]
  ) as Permission[];
  const result = await PermissionsAndroid.requestMultiple(wanted);
  const denied = wanted.filter((perm) => result[perm] !== PermissionsAndroid.RESULTS.GRANTED);
  if (denied.length) {
    throw new Error(`Bluetooth needs these permissions: ${denied.map((d) => d.split(".").pop()).join(", ")}`);
  }
}

export async function startScan() {
  await ensureBluetoothPermission();
  return native().startScan();
}

export const stopScan = () => native().stopScan();

export async function connect(id: string) {
  await ensureBluetoothPermission();
  return native().connect(id);
}

export const disconnect = () => native().disconnect();
export const isConnected = () => native().isConnected();

/** Null when nothing is connected. Check `hasAIRecording` before recording. */
export const connectedDevice = () => native().connectedDevice();

/**
 * Handshakes with the recorder. The vendor's own flow calls this with no
 * arguments: verify 0 and an empty token, which asks the device to identify
 * itself and reports whether it is already bound. A token is only supplied when
 * the device asks to be re-verified (verify 1), and then it has to be the same
 * token it was given originally or it answers with refuseCause 1.
 */
export const bind = (token = "", verify = 0) => native().bind(token, verify);

/** Every `has…` capability flag the connected clip reports, by name. iOS only. */
export const capabilities = () => native().capabilities();

export const getStatus = () => native().getStatus();
export const getStorageInfo = () => native().getStorageInfo();
/** iOS only. */
export const getBattery = () => native().getBattery();
/** Signal strength of the live link, in dBm. iOS only. */
export const getRssi = () => native().getRssi();
/** The formats the clip records in. iOS only. */
export const getEncodingConfig = () => native().getEncodingConfig();

/** Which sensor self-tests (accelerometer, gyroscope…) the firmware claims. Times out if unsupported. iOS only. */
export const probeSensors = () => native().probeSensors();
/** One gyroscope reading through the factory command. Times out if the firmware has none. iOS only. */
export const readGyro = () => native().readGyro();
/** Turns the clip's motion stream on or off; samples arrive as onMotion events. iOS only. */
export const setMotionStream = (on: boolean) => native().setMotionStream(on);
/**
 * Vibrates the clip. option 1: "find my device" on then off, 2: factoryVibration (the clip
 * never replies), 3: the factory motor test. Which one the ES100 honours is unknown. iOS only.
 */
export const buzz = (count = 1, option = 1) => native().buzz(count, option);
/** Turns the clip's light on or off. colors: 1 red, 2 green, 4 blue (add them to mix); 0 = the three-color LED test (no color choice). Untested on the ES100. iOS only. */
export const setLight = (on: boolean, colors = 2) => native().setLight(on, colors);
/**
 * Turns one of the SDK's motion sources on or off; samples arrive as onMotion events. Polled
 * sources ask the clip again every `intervalMs`. iOS only.
 */
export const setMotionSource = (source: MotionSource, on: boolean, intervalMs = 100) =>
  native().setMotionSource(source, on, intervalMs);
/** Today's activity totals as the SDK describes them (text), for spotting step changes. iOS only. */
export const readActivity = () => native().readActivity();
/** Forward every SDK log line (raw packets included) as onLog, not only during a connect. iOS only. */
export const setSdkLogging = (on: boolean) => native().setSdkLogging(on);
/** Factory functions a wearable reports (type 7 = 3-axis accelerometer, 9 = 6-axis). Times out on other devices. iOS only. */
export const probeWearFunctions = () => native().probeWearFunctions();

/** Resolves even when the clip declines; check `result` (StartRecordResult). */
export const startRecord = () => native().startRecord();
/** iOS only. */
export const pauseRecord = (sessionId: number) => native().pauseRecord(sessionId);
/** iOS only. */
export const resumeRecord = (sessionId: number) => native().resumeRecord(sessionId);
export const stopRecord = () => native().stopRecord();

/** The device ignores this while recording or while in USB mode. */
export const listFiles = () => native().listFiles();

/**
 * Downloads one recording over BLE into Documents/recordings and, on iOS, decodes
 * it to a WAV next to it. Always pass RecordFileType.Opus for something playable.
 */
export const syncFile = (sessionId: number, fileType: RecordFileType, size: number) =>
  native().syncFile(sessionId, fileType, size);

export const stopSync = () => native().stopSync();
/** Decodes a raw clip file already on the phone to a WAV next to it. iOS only. */
export const decodeFile = (path: string) => native().decodeFile(path);
export const deleteFile = (sessionId: number, fileType: RecordFileType) => native().deleteFile(sessionId, fileType);

/** Subscribe to a device event. Remember to `.remove()` the subscription. */
export function addListener<K extends keyof UteBleEvents>(event: K, listener: UteBleEvents[K]): EventSubscription {
  return native().addListener(event, listener);
}
