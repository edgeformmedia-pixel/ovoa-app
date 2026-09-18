import { requireOptionalNativeModule } from "expo";
import { PermissionsAndroid, Platform, type Permission } from "react-native";
import type { EventSubscription } from "expo-modules-core";

import type {
  BindResult,
  ConnectedDevice,
  DeviceStatus,
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
  bind(token: string, verify: number): Promise<BindResult>;
  getStatus(): Promise<DeviceStatus>;
  getStorageInfo(): Promise<StorageInfo>;
  startRecord(): Promise<{ sessionId: number; result: number }>;
  stopRecord(): Promise<{ sessionId: number; saved: boolean; fileSize: number }>;
  listFiles(): Promise<{ count: number; files: RecordFile[] }>;
  syncFile(sessionId: number, fileType: RecordFileType, size: number): Promise<SyncResult>;
  stopSync(): Promise<void>;
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

export const getStatus = () => native().getStatus();
export const getStorageInfo = () => native().getStorageInfo();
export const startRecord = () => native().startRecord();
export const stopRecord = () => native().stopRecord();

/** The device ignores this while recording or while in USB mode. */
export const listFiles = () => native().listFiles();

/** Downloads one recording over BLE into the app's cache directory. */
export const syncFile = (sessionId: number, fileType: RecordFileType, size: number) =>
  native().syncFile(sessionId, fileType, size);

export const stopSync = () => native().stopSync();
export const deleteFile = (sessionId: number, fileType: RecordFileType) => native().deleteFile(sessionId, fileType);

/** Subscribe to a device event. Remember to `.remove()` the subscription. */
export function addListener<K extends keyof UteBleEvents>(event: K, listener: UteBleEvents[K]): EventSubscription {
  return native().addListener(event, listener);
}
