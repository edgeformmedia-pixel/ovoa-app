import { useSyncExternalStore } from "react";
import { Alert } from "react-native";
import * as ute from "../../modules/ute-ble";
import { devlog, logFail } from "./devlog";
import { addRecording, hasClipSession, type Recording } from "./recordings";
import { storage } from "./storage";
import { mark as markTurn } from "./turnTimer";
import { gyroLive, motionAfterBuzz, spinOf, spreadBatch, twistKind, type Sample } from "./twist";

// The ES100 clip, shared by the Record tab and the ES100 debug screen: one
// connection, remembered and re-established on its own, plus recording and
// downloading into the phone's recordings list.

export type ClipPhase = "unavailable" | "starting" | "idle" | "scanning" | "connecting" | "pairing" | "connected";

export type ClipInput = { time: number; label: string; value: string };

export type ClipState = {
  phase: ClipPhase;
  sdkVersion: string | null;
  bluetoothOn: boolean | null;
  devices: ute.UteDevice[];
  device: ute.ConnectedDevice | null;
  savedDeviceId: string | null;
  /** Plain-language reason the last attempt failed, with what to do about it. */
  problem: string | null;
  recording: { sessionId: number; startedAt: number; paused: boolean; byDevice: boolean } | null;
  download: { sessionId: number; received: number; total: number } | null;
  busy: string | null;
  battery: ute.BatteryInfo | null;
  rssi: number | null;
  status: ute.DeviceStatus | null;
  storageInfo: ute.StorageInfo | null;
  capabilities: Record<string, boolean> | null;
  formats: ute.EncodingFormat[] | null;
  sensors: ute.SensorSupport | null;
  gyro: ute.GyroReading | null;
  motion: { on: boolean; last: ute.MotionSample | null; count: number; source?: ute.MotionSource };
  /** Why twist-to-listen can't get motion data from this clip (it falls back to the button), or null. */
  motionProblem: string | null;
  /** Things the clip reported on its own, newest first. */
  inputs: ClipInput[];
  log: string[];
};

const SAVED_DEVICE = "es100.deviceId";
const CONNECT_TIMEOUT_MS = 40_000;
const FIND_TIMEOUT_MS = 12_000;
const RECONNECT_DELAYS_MS = [3_000, 10_000, 30_000];

let state: ClipState = {
  phase: ute.uteAvailable ? "starting" : "unavailable",
  sdkVersion: null,
  bluetoothOn: null,
  devices: [],
  device: null,
  savedDeviceId: null,
  problem: null,
  recording: null,
  download: null,
  busy: null,
  battery: null,
  rssi: null,
  status: null,
  storageInfo: null,
  capabilities: null,
  formats: null,
  sensors: null,
  gyro: null,
  motion: { on: false, last: null, count: 0 },
  motionProblem: null,
  inputs: [],
  log: [],
};

const listeners = new Set<() => void>();

function set(patch: Partial<ClipState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export const getClipState = () => state;

export function useClip() {
  ensureStarted();
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** Whether a clip is paired (remembered), without re-rendering on every motion reading. */
export function useClipPaired() {
  ensureStarted();
  return useSyncExternalStore(subscribe, () => !!state.savedDeviceId);
}

function say(line: string) {
  devlog("ble", line);
  set({ log: [`${new Date().toLocaleTimeString()}  ${line}`, ...state.log].slice(0, 120) });
}

function noteInput(label: string, value: string) {
  set({ inputs: [{ time: Date.now(), label, value }, ...state.inputs].slice(0, 40) });
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// --- Connection -------------------------------------------------------------

let started = false;
let connectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
/** The user pressed Disconnect (or Forget): don't reconnect behind their back. */
let userDisconnected = false;
let staleBondAlerted = false;
/** Stops the app from downloading a recording it is already downloading because it pressed Stop. */
let appStopping = false;

function clearConnectTimer() {
  if (connectTimer) clearTimeout(connectTimer);
  connectTimer = null;
}

/** Starts the SDK and reconnects to the remembered clip. Safe to call repeatedly. */
export const startClip = () => ensureStarted();

function ensureStarted() {
  if (started || !ute.uteAvailable) return;
  started = true;

  ute.addListener("onDeviceFound", (device) => {
    if (state.devices.some((d) => d.id === device.id)) return;
    set({ devices: [...state.devices, device] });
    waitingFor?.(device);
  });

  ute.addListener("onConnectionChange", (change) => {
    say(`connection status ${change.status}${change.error ? ` — ${change.error}` : ""}`);
    if (change.connected) return onConnected();
    // 4 = connecting, 5 = disconnecting: still in flight.
    if (change.status === 4 || change.status === 5) return;
    clearConnectTimer();
    const wasConnected = state.phase === "connected";
    set({ phase: "idle", device: null, recording: null, rssi: null, motion: { ...state.motion, on: false } });

    if (/\(CB 1[45]\)/.test(change.error ?? "")) return staleBond();
    if (change.status === -1) {
      set({ problem: "The clip didn't confirm pairing. Press its button when it vibrates, then connect again." });
      return;
    }
    if (change.status === 3) set({ problem: "The clip didn't answer. Make sure it's on and close by." });
    if (wasConnected || change.status === 3) scheduleReconnect();
  });

  ute.addListener("onPairingChange", ({ paired, message: text }) => {
    say(text ?? (paired ? "device accepted pairing" : "device refused pairing"));
    if (!paired && text?.includes("another app")) {
      set({ problem: "The clip belongs to another app. Unbind it there (or factory-reset the clip), then connect again." });
    }
  });

  ute.addListener("onBluetoothState", ({ poweredOn, state: raw }) => {
    set({ bluetoothOn: poweredOn });
    say(`bluetooth ${poweredOn ? "on" : `off (state ${raw})`}`);
    if (poweredOn && state.phase === "idle") autoConnect();
  });

  ute.addListener("onLog", ({ message: line }) => {
    // The SDK asks the clip to confirm pairing: it vibrates and waits for its button.
    if (line.includes("SDK send pair")) set({ phase: "pairing" });
    // The probe turns on every SDK line (raw packets, many a second) and summarizes them itself.
    if (probe) return probe.onLog(line.trim());
    say(`sdk: ${line.trim()}`);
  });

  ute.addListener("onRecordStart", (event) => {
    say(`recording started (${event.startedByDevice ? "clip button" : "app"}) #${event.sessionId}`);
    set({
      recording: { sessionId: event.sessionId, startedAt: Date.now(), paused: false, byDevice: event.startedByDevice },
    });
    // Gestures (single / double click) decide what a press means; see onClipGesture.
    if (event.startedByDevice && gestureListeners.size) {
      noteInput("Clip button", "pressed");
      press("start", event.sessionId);
      return;
    }
    if (event.startedByDevice) {
      noteInput("Clip button", "started recording");
      // In band mode that recording IS the question, so it's kept and fetched when it stops.
      if (pressUsed("record") && !bandMode) discardButtonRecording(event.sessionId);
      else if (bandMode) say(`band microphone: keeping #${event.sessionId}`);
    }
  });

  ute.addListener("onRecordStop", (event) => {
    say(`recording stopped #${event.sessionId}, ${event.fileSize} bytes${event.saved ? "" : " (not saved)"}`);
    const startedByApp = state.recording?.byDevice === false;
    set({ recording: null });
    if (appStopping) return;
    if (gestureListeners.size) {
      // The second press of a double click: the clip stopped the scrap it just started.
      if (pendingPress) {
        press("stop", event.sessionId);
        return;
      }
      // A press stopped the recording the app started for a talk turn: that's "send".
      if (startedByApp) emitGesture("stop");
    }
    noteInput("Clip button", "stopped recording");
    // Stopped on the clip itself: bring it over like one the app stopped.
    if (event.saved !== false && event.fileSize > 0) {
      stoppedAt.set(event.sessionId, Date.now());
      // The clip needs a moment to close the file. Ask soon and retry rather than
      // waiting out a flat second every time.
      setTimeout(() => {
        const job = importSession(event.sessionId, event.fileSize);
        if (!bandMode) {
          job.catch(logFail("clip: importSession"));
          return;
        }
        job.then(
          (entry) => bandListeners.forEach((l) => l(entry, null)),
          (err) => bandListeners.forEach((l) => l(null, err instanceof Error ? err : new Error(String(err)))),
        );
      }, READY_DELAY_MS);
    } else if (bandMode) {
      bandListeners.forEach((l) => l(null, new Error("the clip didn't keep that recording (it may have been too short)")));
    }
  });

  ute.addListener("onMotion", ({ source, samples }) => {
    if (probe) return probe.onMotion(source ?? "game", samples);
    onMotionBatch(source ?? "game", samples);
  });

  ute.addListener("onSyncProgress", (p) => {
    const mark = transferMarks.get(p.sessionId);
    if (mark) mark.last = Date.now();
    else transferMarks.set(p.sessionId, { first: Date.now(), last: Date.now() });
    set({ download: { sessionId: p.sessionId, received: p.received, total: p.total } });
  });

  ute.addListener("onInput", (input) => {
    if (input.kind === "battery") {
      set({
        battery: {
          percent: input.value,
          charging: input.detail === "charging",
          full: input.detail === "full",
          low: input.detail === "low",
        },
      });
      noteInput("Battery", `${input.value}% · ${input.detail ?? ""}`);
    } else if (input.kind === "voiceButton") {
      const names = ["", "entered voice mode", "voice recording started", "voice recording stopped", "left voice mode", "asks to open the app", "recognition failed", "recognition ok"];
      noteInput("Voice button", names[input.value] ?? `state ${input.value}`);
      // 1 entered voice mode / 2 voice recording started: the user pressed the button to talk.
      if (input.value === 1 || input.value === 2) pressUsed("voiceButton");
    } else if (input.kind === "offWrist") {
      noteInput("Wear state", `${input.value} (${input.detail ?? ""})`);
    } else if (input.kind === "heartRate" || input.kind === "spo2") {
      noteInput(input.kind === "spo2" ? "Blood oxygen" : "Heart rate", `${input.value} (${input.detail ?? ""})`);
      if (input.kind === "heartRate" && input.value > 0) heartListeners.forEach((l) => l(input.value, input.detail ?? ""));
    } else {
      noteInput("Voice audio", `${input.value} bytes (${input.detail ?? ""})`);
    }
    say(`input ${input.kind} ${input.value}${input.detail ? ` ${input.detail}` : ""}`);
    probe?.onInput(input);
  });

  ute
    .initialize()
    .then(async (version) => {
      set({ sdkVersion: version, phase: "idle" });
      say(`SDK ${version} ready`);
      const saved = await storage.get(SAVED_DEVICE).catch(() => null);
      set({ savedDeviceId: saved });
      // Already linked (e.g. after a JS reload): pick the session back up. Both checks,
      // because a fresh launch once reported "connected" before anything had connected.
      if ((await ute.isConnected().catch(() => false)) && (await ute.connectedDevice().catch(() => null))) {
        return onConnected();
      }
      autoConnect();
    })
    .catch((err) => {
      set({ phase: "idle", problem: `The Bluetooth SDK didn't start: ${message(err)}` });
      say(`init failed — ${message(err)}`);
    });
}

function staleBond() {
  set({
    problem:
      "Your iPhone has an old pairing for the clip. Open Settings → Bluetooth, tap ⓘ next to ES100 → Forget This Device, then connect again and press the clip's button when it vibrates.",
  });
  say("iPhone's saved pairing with the clip is out of date; it must be forgotten in Settings");
  if (staleBondAlerted) return;
  staleBondAlerted = true;
  Alert.alert(
    "Forget the ES100 in Bluetooth settings",
    "Your iPhone still has an old pairing for the clip, which the clip has deleted, so iOS refuses to connect.\n\n" +
      "1. Open Settings → Bluetooth.\n" +
      "2. Tap the ⓘ next to ES100 → Forget This Device.\n" +
      "3. Come back and tap Connect.\n" +
      "4. Accept the iPhone's pairing pop-up, then press the clip's button when it vibrates.",
  );
}

async function onConnected() {
  clearConnectTimer();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectAttempt = 0;
  userDisconnected = false;
  const device = await ute.connectedDevice().catch(() => null);
  // A new connection: read what this clip supports again, and give motion another try.
  set({ phase: "connected", device, problem: null, capabilities: null, sensors: null, motionProblem: null });
  resetMotion();
  // The light's state is unknown after a reconnect; put it back once the connect-time commands are done.
  lightShown = null;
  setTimeout(() => void syncLight(), 10_000);
  say(`connected to ${device?.name || "clip"}`);
  if (device?.id) {
    await storage.set(SAVED_DEVICE, device.id).catch(logFail("clip: storage.set"));
    set({ savedDeviceId: device.id });
  }
  // The clip needs a moment after pairing before it answers record commands.
  setTimeout(() => {
    refreshInfo()
      .catch(logFail("clip: refreshInfo"))
      // The iOS SDK has no "stream ended" event: restart the stream after every (re)connect,
      // once the clip has answered what it was asked on connect.
      .then(() => {
        motionSettling = false;
        ensureMotion("connected");
      });
  }, 1500);
}

let waitingFor: ((device: ute.UteDevice) => void) | null = null;

/** Scans until `id` shows up (or the time runs out). */
function findDevice(id: string) {
  return new Promise<boolean>((resolve) => {
    if (state.devices.some((d) => d.id === id)) return resolve(true);
    const timer = setTimeout(() => finish(false), FIND_TIMEOUT_MS);
    const finish = (found: boolean) => {
      clearTimeout(timer);
      waitingFor = null;
      ute.stopScan().catch(logFail("clip: ute.stopScan"));
      resolve(found);
    };
    waitingFor = (device) => device.id === id && finish(true);
    ute.startScan().catch(() => finish(false));
  });
}

export async function scan() {
  ensureStarted();
  set({ devices: [], phase: "scanning", problem: null });
  say("scanning…");
  try {
    await ute.startScan();
  } catch (err) {
    set({ phase: "idle", problem: message(err) });
    return;
  }
  // The SDK scans until told to stop.
  setTimeout(() => {
    ute.stopScan().catch(logFail("clip: ute.stopScan"));
    if (state.phase === "scanning") set({ phase: "idle" });
  }, 10_000);
}

export async function connect(id: string) {
  ensureStarted();
  if (state.phase === "connecting" || state.phase === "pairing" || state.phase === "connected") return;
  userDisconnected = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  set({ phase: "connecting", problem: null });
  await storage.set(SAVED_DEVICE, id).catch(logFail("clip: storage.set"));
  set({ savedDeviceId: id });

  // After an app restart the SDK has forgotten every scan result; find the clip again first.
  if (!state.devices.some((d) => d.id === id)) {
    say("looking for the clip…");
    const found = await findDevice(id);
    if (!found) {
      set({ phase: "idle", problem: "Couldn't find the clip. Make sure it's on and nearby, then tap Connect." });
      scheduleReconnect();
      return;
    }
  }

  try {
    await ute.stopScan().catch(logFail("clip: ute.stopScan"));
    say(`connecting to ${state.devices.find((d) => d.id === id)?.name || id}…`);
    await ute.connect(id);
  } catch (err) {
    set({ phase: "idle", problem: message(err) });
    say(`connect failed — ${message(err)}`);
    return;
  }

  clearConnectTimer();
  connectTimer = setTimeout(() => {
    // Never cut off a pairing prompt: the clip is waiting for its button.
    if (state.phase === "pairing") {
      set({ problem: "The clip is waiting: press its button when it vibrates." });
      return;
    }
    if (state.phase !== "connecting") return;
    say(`no connection after ${CONNECT_TIMEOUT_MS / 1000} s`);
    ute.disconnect().catch(logFail("clip: ute.disconnect"));
    set({ phase: "idle", problem: "The clip didn't finish connecting. Tap Connect to try again." });
  }, CONNECT_TIMEOUT_MS);
}

/** Connects to the remembered clip, if there is one. */
export function autoConnect() {
  if (userDisconnected || !state.savedDeviceId || state.phase !== "idle" || state.bluetoothOn === false) return;
  connect(state.savedDeviceId).catch(logFail("clip: connect"));
}

function scheduleReconnect() {
  if (userDisconnected || !state.savedDeviceId) return;
  if (reconnectAttempt >= RECONNECT_DELAYS_MS.length) {
    say("gave up reconnecting on its own; tap Connect");
    return;
  }
  const delay = RECONNECT_DELAYS_MS[reconnectAttempt++];
  say(`reconnecting in ${delay / 1000} s`);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(autoConnect, delay);
}

export async function disconnect() {
  userDisconnected = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  clearConnectTimer();
  if (state.motion.on) await stopMotion();
  await ute.disconnect().catch(logFail("clip: ute.disconnect"));
  set({ phase: "idle", device: null, recording: null, motion: { ...state.motion, on: false } });
}

/** Disconnects and stops remembering the clip. */
export async function forget() {
  await disconnect();
  await storage.remove(SAVED_DEVICE).catch(logFail("clip: storage.remove"));
  set({ savedDeviceId: null });
}

// --- Reading the clip ------------------------------------------------------

const READ_TIMEOUT_MS = 6000;

async function attempt<T>(label: string, fn: () => Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer in ${READ_TIMEOUT_MS / 1000} s`)), READ_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    say(`${label} failed — ${message(err)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Reads everything the clip can tell us. Each part may fail on its own. */
export async function refreshInfo() {
  if (state.phase !== "connected") return;
  const [status, storageInfo, battery, rssi] = await Promise.all([
    attempt("status", ute.getStatus),
    attempt("storage", ute.getStorageInfo),
    attempt("battery", ute.getBattery),
    attempt("signal", ute.getRssi),
  ]);
  // Nothing answered: check the link is real before trusting "connected" any further.
  if (!status && !storageInfo && !battery && !rssi && !(await ute.isConnected().catch(() => false))) {
    say("the clip isn't actually connected; connecting again");
    set({ phase: "idle", device: null });
    autoConnect();
    return;
  }
  set({
    status: status ?? state.status,
    storageInfo: storageInfo ?? state.storageInfo,
    battery: battery ?? state.battery,
    rssi: rssi?.rssi ?? state.rssi,
  });
  if (status?.recording && !state.recording) {
    // It was already recording when we connected; stopping it still works.
    set({ recording: { sessionId: 0, startedAt: Date.now(), paused: false, byDevice: true } });
  }
  if (!state.capabilities) {
    const [capabilities, config] = await Promise.all([
      attempt("capabilities", ute.capabilities),
      attempt("formats", ute.getEncodingConfig),
    ]);
    // An empty list means the clip's details weren't read yet; leave it to retry next time.
    set({ capabilities: capabilities && Object.keys(capabilities).length ? capabilities : null, formats: config?.formats ?? null });
    const sensors = await attempt("sensor probe", ute.probeSensors);
    set({ sensors });
    if (sensors) say(`sensors: accelerometer ${sensors.accelerometer}, gyroscope ${sensors.gyroscope}, button ${sensors.button}, motor ${sensors.motor}`);
    // Phase 0 of twist-to-listen: what motion data this firmware claims to have. (The wearables'
    // function list isn't asked for any more: the ES100 never answered it, and every unanswered
    // command delays the ones after it.)
    const flags = ["hasGame", "hasGlasses", "hasEarphone", "hasNoScreen", "hasButtonWakeUpVoice", "hasVoiceAssistant", "hasChatGPT", "hasWearingHands", "hasAIRecording", "hasAIRecordRealTime"];
    devlog(
      "ble",
      "twist probe",
      JSON.stringify({
        sensors,
        ...Object.fromEntries(flags.map((f) => [f, state.capabilities?.[f] ?? null])),
      }),
    );
  }
}

/** Only the live values, for polling. */
export async function pollLive() {
  if (state.phase !== "connected" || probe) return;
  const [status, rssi] = await Promise.all([ute.getStatus().catch(() => null), ute.getRssi().catch(() => null)]);
  if (status && state.status && status.keyState !== state.status.keyState) {
    noteInput("Clip button", `key state ${state.status.keyState} → ${status.keyState}`);
  }
  set({ status: status ?? state.status, rssi: rssi?.rssi ?? state.rssi });
}

/** One gyroscope reading from the clip. */
export async function readGyro() {
  const gyro = await ute.readGyro();
  set({ gyro });
  return gyro;
}

// --- Motion probe (Dev tools → Motion lab) ----------------------------------

/** Where the clip's traffic goes while the probe runs. */
export type ProbeTap = {
  onMotion: (source: ute.MotionSource, samples: ute.MotionSample[]) => void;
  /** Every SDK log line; the raw packets are the "App receive …" ones. */
  onLog: (line: string) => void;
  onInput: (input: ute.InputEvent) => void;
};
let probe: ProbeTap | null = null;

/** Hands the clip to the probe: twist motion and status polling pause, and every SDK line goes to `tap`. */
export async function beginProbe(tap: ProbeTap, name = "motion probe") {
  if (state.phase !== "connected") throw new Error("Connect the clip first.");
  if (probe) throw new Error("The probe is already running.");
  probe = tap;
  // Let a twist source that is still being tried give up first (it checks `probe`).
  for (let waited = 0; motionStarting && waited < 10_000; waited += 100) await sleep(100);
  if (activeSource || state.motion.on) await stopMotion();
  await ute.setSdkLogging(true);
  probeName = name;
  say(`${name} started`);
}
let probeName = "motion probe";

/** Gives the clip back: twist motion starts again (trying the probe's winner first, if one was saved). */
export async function endProbe() {
  if (!probe) return;
  probe = null;
  await ute.setSdkLogging(false).catch(logFail("clip: ute.setSdkLogging"));
  say(`${probeName} finished`);
  retryMotion();
}

// --- Motion for twist-to-listen -------------------------------------------
//
// What the ES100 does (motion probes, 2026-09-19): its gyroscope test ("gyro3") sends about one
// reading a second after a single "on", until "off"; none of the SDK's other sources stream. So
// twist uses gyro3, or the probe's winner when it found something better (reading the gyroscope on
// request, or the accelerometer, if the clip answers those often), and sends the clip as few
// commands as it can: it stopped answering for 8-60 s when motion commands came several times a
// second. Nothing is sent while the clip records or transfers a file, and a polled source pauses.

type SourceSpec = {
  /** Live readings that must arrive within `firstMs` of turning it on for it to count as streaming. */
  firstReadings: number;
  firstMs: number;
  /** No live reading for this long: turn it on again. */
  silenceMs: number;
  /** How often a polled source asks the clip, unless the probe found a rate that works; 0 = it streams by itself. */
  intervalMs: number;
};

const GYRO3: SourceSpec = { firstReadings: 2, firstMs: 6000, silenceMs: 8000, intervalMs: 0 };
const GYRO3_READ: SourceSpec = { firstReadings: 3, firstMs: 6000, silenceMs: 8000, intervalMs: 1000 };
const GSENSOR: SourceSpec = { firstReadings: 3, firstMs: 6000, silenceMs: 8000, intervalMs: 1000 };
/** The sources twist can use, if the probe picks them. The rest never sent anything on the ES100 (the probe still tries some). */
const TWIST_SOURCES: Partial<Record<ute.MotionSource, SourceSpec>> = {
  gyro3: GYRO3,
  gyro3read: GYRO3_READ,
  gsensorPing: GSENSOR,
};
/** Twist won't run a polled source costing the clip more commands a second than this, however well it did in the probe. */
export const MAX_TWIST_COMMANDS_PER_SECOND = 2;
const DEFAULT_SOURCE: ute.MotionSource = "gyro3";

export const canTwistWith = (source: ute.MotionSource | null | undefined) => !!source && !!TWIST_SOURCES[source];
const specFor = (source: ute.MotionSource) => TWIST_SOURCES[source] ?? GSENSOR;

/** The motion probe's winner (Dev tools → Motion lab): tried first, at the rate that won. */
export type PreferredMotion = { source: ute.MotionSource; intervalMs: number };
const PREFERRED_MOTION = "es100.motionSource";
let preferred: PreferredMotion | null = null;
storage
  .get(PREFERRED_MOTION)
  .then((saved) => (preferred = saved ? (JSON.parse(saved) as PreferredMotion) : null))
  .catch(logFail("clip: JSON.parse"));

export async function setPreferredMotion(value: PreferredMotion | null) {
  preferred = value;
  if (value) await storage.set(PREFERRED_MOTION, JSON.stringify(value)).catch(logFail("clip: JSON.stringify"));
  else await storage.remove(PREFERRED_MOTION).catch(logFail("clip: storage.remove"));
}

function motionSources(): ute.MotionSource[] {
  const first = preferred && canTwistWith(preferred.source) ? preferred.source : null;
  return first && first !== DEFAULT_SOURCE ? [first, DEFAULT_SOURCE] : [DEFAULT_SOURCE];
}

const intervalFor = (source: ute.MotionSource) =>
  preferred?.source === source && preferred.intervalMs > 0 ? preferred.intervalMs : specFor(source).intervalMs;

/** Re-arming a quiet source, and retrying when none worked, wait this long (by attempts so far). */
const RETRY_DELAYS_MS = [0, 20_000, 60_000, 120_000, 300_000];
const retryDelay = (attempts: number) => RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length - 1)];
/** "On" resent this many times without a live reading: the source has stopped. */
const MAX_REARMS = 3;
/** Raw batches logged after each "on", for tuning the detector from device_logs. */
const RAW_BATCHES = 5;
const SUMMARY_MS = 5 * 60_000;
/** While a polled source is in use, how often the clip is checked for still answering. */
const HEALTH_MS = 60_000;

type MotionListener = (samples: Sample[], source: ute.MotionSource) => void;
const motionListeners = new Set<MotionListener>();
let motionStarting = false;
/** Set on connect until the clip has answered what it's asked on connect; motion waits for it. */
let motionSettling = false;
/** Index into motionSources() of the next source to try. */
let sourceIndex = 0;
/** The source being tried, then the one in use. */
let trying: ute.MotionSource | null = null;
let activeSource: ute.MotionSource | null = null;
let watchdog: ReturnType<typeof setInterval> | null = null;
let lastBatchAt: number | null = null;
let lastLiveAt = 0;
let liveCount = 0;
/** When "on" was last sent. */
let armedAt = 0;
/** "On" resent since the last live reading. */
let rearms = 0;
/** Times in a row that no source streamed. */
let failures = 0;
/** A source put the clip in factory-test mode (which blocks recording): no motion until it reconnects. */
let blocked = false;
let healthAt = 0;
let healthMisses = 0;
let healthChecking = false;
/** A polled source turned off while the clip was busy, to turn back on once it's free. */
let pausedForBusy: ute.MotionSource | null = null;
let rawLogged = 0;
let summary = { since: 0, readings: 0, live: 0, strays: 0, spins: [] as number[] };

/** A reading with data in it (the gyroscope test sends state 0 and zeros while it's off). */
const isLive = (source: ute.MotionSource, v: ute.MotionSample) => (twistKind(source) === "spin" ? gyroLive(v) : true);
/** It sends the clip commands all the time (the gyroscope test streams by itself after its "on"). */
const isPolled = (source: ute.MotionSource) => intervalFor(source) > 0;

function onMotionBatch(source: ute.MotionSource, samples: ute.MotionSample[]) {
  // A source that was turned off can still answer late (the g-sensor did): that isn't this stream.
  if (source !== activeSource && source !== trying) {
    summary.strays += samples.length;
    return;
  }
  const now = Date.now();
  const timed = spreadBatch(lastBatchAt, now, samples);
  lastBatchAt = now;
  const live = samples.filter((v) => isLive(source, v));
  if (live.length) {
    lastLiveAt = now;
    liveCount += live.length;
    rearms = 0;
    if (buzzedAt) {
      say(`twist: motion back ${now - buzzedAt} ms after the buzz`);
      buzzedAt = 0;
    }
  }
  const last = samples[samples.length - 1] ?? null;
  set({ motion: { ...state.motion, last, count: state.motion.count + samples.length, source } });
  noteMotion(source, samples, live);
  if (live.length && source === activeSource && state.motionProblem && !blocked) {
    set({ motionProblem: null });
    say(`twist: motion from ${source} is back`);
  }
  motionListeners.forEach((l) => l(timed, source));
}

/** Raw readings right after each "on", then a summary every few minutes, for tuning from device_logs. */
function noteMotion(source: ute.MotionSource, samples: ute.MotionSample[], live: ute.MotionSample[]) {
  if (rawLogged < RAW_BATCHES) {
    rawLogged++;
    devlog("ble", "motion raw", `${source}: ${JSON.stringify(samples.slice(0, 4))}`);
  }
  summary.readings += samples.length;
  summary.live += live.length;
  if (twistKind(source) === "spin") summary.spins.push(...live.map(spinOf));
}

function summarizeMotion(now: number) {
  if (now - summary.since < SUMMARY_MS) return;
  if (summary.since) {
    devlog(
      "ble",
      `twist: ${summary.live} live motion readings in ${Math.round((now - summary.since) / 60_000)} min (${activeSource ?? "no source"})`,
      JSON.stringify({
        source: activeSource,
        readings: summary.readings,
        live: summary.live,
        strays: summary.strays,
        // The biggest twist-like readings: what the detector's thresholds are up against.
        topSpins: [...summary.spins].sort((a, b) => b - a).slice(0, 8),
        rearms,
        problem: state.motionProblem,
      }),
    );
  }
  summary = { since: now, readings: 0, live: 0, strays: 0, spins: [] };
}

function motionUnavailable(why: string) {
  if (state.motionProblem === why) return;
  const first = !state.motionProblem;
  set({ motionProblem: why });
  devlog("ble", first ? "twist: no motion data, using clip button" : "twist: still no motion data", why);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const motionWanted = () => motionListeners.size > 0 && state.phase === "connected" && !probe;
/** Recording, downloading, or a record command in flight: motion commands wait until it's done. */
const clipBusy = () => !!state.busy || !!state.download || !!state.recording;

/** Waits for `firstReadings` live readings within `firstMs`. */
async function streamStarted(spec: SourceSpec) {
  const start = liveCount;
  for (let waited = 0; waited < spec.firstMs && motionWanted(); waited += 100) {
    if (liveCount - start >= spec.firstReadings) return true;
    await sleep(100);
  }
  return liveCount - start >= spec.firstReadings;
}

/** Starts motion if someone wants it: the first source that streams (the probe's winner, then gyro3). */
async function ensureMotion(reason: string) {
  if (!motionWanted() || motionStarting || motionSettling || activeSource || blocked || clipBusy()) return;
  motionStarting = true;
  const sources = motionSources();
  try {
    while (sourceIndex < sources.length) {
      const source = sources[sourceIndex];
      const spec = specFor(source);
      trying = source;
      armedAt = Date.now();
      rawLogged = 0;
      let started = false;
      let error: string | null = null;
      try {
        await ute.setMotionSource(source, true, intervalFor(source));
        started = await streamStarted(spec);
      } catch (err) {
        error = message(err);
      }
      trying = null;
      if (started && motionWanted()) {
        activate(source, reason);
        return;
      }
      // Given up on it, or nobody wants motion any more: turn it off either way.
      await ute.setMotionSource(source, false).catch(logFail("clip: ute.setMotionSource"));
      if (!motionWanted()) return;
      say(error ? `motion: ${source} failed — ${error}` : `motion: ${source} sent fewer than ${spec.firstReadings} readings in ${spec.firstMs / 1000} s`);
      sourceIndex++;
    }
    failures++;
    sourceIndex = 0;
    motionUnavailable(`no motion from the clip (tried ${sources.join(", ")}); trying again in ${retryDelay(failures) / 1000} s`);
  } finally {
    trying = null;
    motionStarting = false;
  }
}

function activate(source: ute.MotionSource, reason: string) {
  activeSource = source;
  rearms = 0;
  failures = 0;
  healthMisses = 0;
  lastLiveAt = healthAt = Date.now();
  set({ motion: { ...state.motion, on: true, source }, motionProblem: null });
  say(`twist: motion from ${source} (${reason})`);
  checkRecordState(source).catch(logFail("clip: checkRecordState"));
}

/** gyro3 and the g-sensor are factory tests: make sure one didn't put the clip in its test mode, which blocks recording. */
async function checkRecordState(source: ute.MotionSource) {
  const status = await attempt("status after motion on", ute.getStatus);
  if (status) set({ status });
  if (status?.state !== ute.RecordState.FactoryTest || activeSource !== source) return;
  blocked = true;
  devlog("err", `twist: ${source} put the clip in factory-test mode, which blocks recording; motion is off until it reconnects`);
  await stopMotion();
  motionUnavailable(`${source} put the clip in factory-test mode (recording blocked); disconnect and reconnect the clip`);
}

/**
 * A polled source (the g-sensor) sends the clip commands all the time, and too many left it unable
 * to answer anything, recording included. So the clip is asked for its status now and then; two
 * misses in a row drop the source for the gyroscope test, and the probe's pick is forgotten.
 */
async function checkClipHealth(source: ute.MotionSource) {
  healthAt = Date.now();
  const status = await attempt("status (motion health check)", ute.getStatus);
  if (activeSource !== source) return;
  if (status) {
    healthMisses = 0;
    set({ status });
    return;
  }
  if (++healthMisses < 2) return;
  devlog("err", `twist: the clip stopped answering while ${source} polled it; using ${DEFAULT_SOURCE} instead`);
  activeSource = null;
  set({ motion: { ...state.motion, on: false } });
  await ute.setMotionSource(source, false).catch(logFail("clip: ute.setMotionSource"));
  await setPreferredMotion(null);
  sourceIndex = 0;
  failures = 0;
}

async function stopMotion() {
  const source = activeSource;
  activeSource = null;
  pausedForBusy = null;
  buzzedAt = 0;
  set({ motion: { ...state.motion, on: false } });
  if (source && state.phase === "connected") {
    await ute.setMotionSource(source, false).catch(logFail("clip: ute.setMotionSource"));
    say(`motion: ${source} off`);
  }
}

/**
 * Once a second while someone wants motion. The SDK has no "stream ended" event, so a source that
 * goes quiet is turned on again, and when none streamed they're tried again; both spaced out.
 */
function checkMotion() {
  if (!motionWanted() || motionStarting || motionSettling || blocked) return;
  const now = Date.now();
  summarizeMotion(now);
  if (clipBusy()) {
    // A polled source keeps sending commands: it pauses while the clip records or transfers.
    if (activeSource && isPolled(activeSource) && !pausedForBusy) {
      pausedForBusy = activeSource;
      ute.setMotionSource(activeSource, false).catch(logFail("clip: ute.setMotionSource"));
      say(`motion: ${activeSource} paused while the clip is busy`);
    }
    return;
  }
  if (pausedForBusy) {
    const paused = pausedForBusy;
    pausedForBusy = null;
    if (activeSource === paused) {
      armedAt = now;
      rearms = 0;
      say(`motion: ${paused} back on`);
      ute.setMotionSource(paused, true, intervalFor(paused)).catch((err) => say(`motion: ${paused} failed — ${message(err)}`));
    }
    return;
  }
  if (!activeSource) {
    // Not started yet (the clip was busy), or nothing streamed last time.
    if (now - armedAt >= retryDelay(failures)) ensureMotion(failures ? "trying again" : "clip free");
    return;
  }
  const source = activeSource;
  if (intervalFor(source) > 0 && now - healthAt >= HEALTH_MS && !healthChecking) {
    healthChecking = true;
    checkClipHealth(source)
      .catch(logFail("clip: checkClipHealth"))
      .finally(() => (healthChecking = false));
  }
  const quiet = now - Math.max(lastLiveAt, armedAt);
  if (quiet < specFor(source).silenceMs || now - armedAt < retryDelay(rearms)) return;
  armedAt = now;
  if (rearms >= MAX_REARMS) {
    say(`twist: ${source} stopped sending motion`);
    activeSource = null;
    set({ motion: { ...state.motion, on: false } });
    ute.setMotionSource(source, false).catch(logFail("clip: ute.setMotionSource"));
    failures++;
    sourceIndex = 0;
    motionUnavailable(`the clip stopped sending motion (${source}); trying again in ${retryDelay(failures) / 1000} s`);
    return;
  }
  rearms++;
  rawLogged = 0;
  say(`twist: no motion from ${source} for ${Math.round(quiet / 1000)} s; turning it on again`);
  ute.setMotionSource(source, true, intervalFor(source)).catch((err) => say(`motion: ${source} failed — ${message(err)}`));
}

/** A new connection: every source gets another chance, once the clip has settled. */
function resetMotion() {
  motionSettling = true;
  sourceIndex = 0;
  activeSource = null;
  pausedForBusy = null;
  trying = null;
  lastBatchAt = null;
  lastLiveAt = 0;
  armedAt = 0;
  buzzedAt = 0;
  rearms = 0;
  failures = 0;
  blocked = false;
}

/** Motion is streaming right now, so a twist would be seen. When it isn't, the clip's button stands in. */
export function motionLive() {
  return (
    !!activeSource &&
    state.phase === "connected" &&
    !state.motionProblem &&
    Date.now() - lastLiveAt < specFor(activeSource).silenceMs
  );
}

/** Timestamped motion readings, and their source, while subscribed. The clip streams while anyone is. */
export function subscribeMotion(listener: MotionListener) {
  ensureStarted();
  motionListeners.add(listener);
  if (motionListeners.size === 1) {
    lastBatchAt = null;
    summary = { since: Date.now(), readings: 0, live: 0, strays: 0, spins: [] };
    watchdog = setInterval(checkMotion, 1000);
    ensureMotion("twist on");
  }
  return () => {
    motionListeners.delete(listener);
    if (motionListeners.size) return;
    if (watchdog) clearInterval(watchdog);
    watchdog = null;
    stopMotion();
  };
}

/** Forget that no source worked (or put the clip in test mode) and look again now. */
export function retryMotion() {
  if (motionStarting) return;
  set({ motionProblem: null });
  sourceIndex = 0;
  failures = 0;
  armedAt = 0;
  blocked = false;
  ensureMotion("retry");
}

/**
 * For a subscriber that needs motion now (calibration): retries if it had given up, and waits up to
 * `ms` for a source to stream. Null when the attempt failed or the clip stayed busy.
 */
export async function waitForMotion(ms: number) {
  if (!activeSource) retryMotion();
  for (let waited = 0; waited < ms && !activeSource; waited += 250) {
    // An attempt that ended without motion (an attempt still running may yet succeed).
    if (!motionStarting && state.motionProblem) return null;
    await sleep(250);
  }
  return activeSource;
}

let manualMotion: (() => void) | null = null;

/** The Inputs screen's Start/Stop motion button: finds a working source like twist does. */
export async function setMotionStream(on: boolean) {
  if (on && !manualMotion) {
    retryMotion();
    manualMotion = subscribeMotion(() => {});
  } else if (!on && manualMotion) {
    manualMotion();
    manualMotion = null;
  }
}

/** The clip's button was pressed to talk (voice button, or a recording started on the clip). */
type ButtonListener = (source: "voiceButton" | "record") => boolean | void;
const buttonListeners = new Set<ButtonListener>();

/** A listener that returns true has used the press: a recording it started is thrown away. */
/**
 * Band mode: the clip's own microphone answers questions. A press of its button starts a recording
 * on the clip and the next press stops it, so that recording is kept (not discarded as a summon)
 * and handed to the listeners once it has been fetched.
 */
let bandMode = false;

export function setBandMode(on: boolean) {
  bandMode = on;
}

type BandListener = (entry: Recording | null, err: Error | null) => void;
const bandListeners = new Set<BandListener>();

/** Called with the clip's finished recording, ready to transcribe. */
export function onBandRecording(listener: BandListener) {
  bandListeners.add(listener);
  return () => {
    bandListeners.delete(listener);
  };
}

export function onClipButton(listener: ButtonListener) {
  buttonListeners.add(listener);
  return () => {
    buttonListeners.delete(listener);
  };
}

const pressUsed = (source: "voiceButton" | "record") => [...buttonListeners].some((l) => l(source) === true);

// --- Gestures: single and double click -------------------------------------
//
// The clip starts recording on one press and stops on the next, but on the
// device the second press of a quick double click shows up either as "recording
// stopped" or as a fresh "recording started" (the first one having been cut
// short), and up to ~2 s after the first. So any press from the clip within
// DOUBLE_CLICK_MS of a first one makes a double click, whichever way it's
// reported; a press with nothing after it is a single click. Every scrap it
// recorded is thrown away. A press while the app is recording for a talk turn
// stops that recording, which is "send" (and the recording is kept: it's the
// question).

export type ClipGesture = "single" | "double" | "stop";
const gestureListeners = new Set<(g: ClipGesture) => void>();
/** How long after one press a second still makes it a double click (seen: ~2 s apart on the device). */
const DOUBLE_CLICK_MS = 2500;
let pendingPress: { sessionId: number; at: number; timer: ReturnType<typeof setTimeout> } | null = null;
let lastPressAt = 0;

/** Listening turns single and double clicks into gestures. Returns an unsubscribe. */
export function onClipGesture(listener: (g: ClipGesture) => void) {
  gestureListeners.add(listener);
  return () => void gestureListeners.delete(listener);
}

function emitGesture(g: ClipGesture) {
  devlog("voice", `clip: ${g === "double" ? "double click" : g === "single" ? "single click" : "press (send)"}`);
  gestureListeners.forEach((l) => {
    try {
      l(g);
    } catch (err) {
      devlog("err", `clip gesture handler threw on ${g}`, err instanceof Error ? err.message : String(err));
    }
  });
}

/** One press from the clip, reported as a recording starting or stopping. */
function press(kind: "start" | "stop", sessionId: number) {
  const now = Date.now();
  const since = lastPressAt ? now - lastPressAt : null;
  lastPressAt = now;
  const first = pendingPress;
  devlog(
    "voice",
    `clip press: ${kind} #${sessionId}, ${since === null ? "first press" : `${since} ms since the last`}, ` +
      (first ? `pending #${first.sessionId} (${now - first.at} ms ago) → double click` : "nothing pending → waiting for a second"),
  );
  if (first) {
    clearTimeout(first.timer);
    pendingPress = null;
    const deleteScrap = (id: number) =>
      ute.deleteFile(id, storedTypes.get(id) ?? ute.RecordFileType.Opus).catch(logFail(`clip: delete scrap #${id}`));
    // A second "started" means a new scrap is recording: stop it and delete both.
    if (kind === "start") void discardButtonRecording(sessionId).then(() => deleteScrap(first.sessionId));
    else {
      void deleteScrap(sessionId);
      if (first.sessionId !== sessionId) void deleteScrap(first.sessionId);
    }
    emitGesture("double");
    return;
  }
  if (kind === "stop") {
    // A stop with no press before it (the start went unreported): count it as a first press.
    devlog("voice", `clip press: stop #${sessionId} with nothing pending, treating it as the first press`);
  }
  pendingPress = {
    sessionId,
    at: now,
    timer: setTimeout(() => {
      pendingPress = null;
      devlog("voice", `clip press: no second press within ${DOUBLE_CLICK_MS} ms → single click (#${sessionId})`);
      // Just one press: nothing to keep.
      if (kind === "start") void discardButtonRecording(sessionId);
      emitGesture("single");
    }, DOUBLE_CLICK_MS),
  };
}

/** The press only meant "listen to me": stop the recording it started and delete it from the clip. */
async function discardButtonRecording(sessionId: number) {
  appStopping = true;
  try {
    await ute.stopRecord().catch(logFail("clip: ute.stopRecord"));
    set({ recording: null });
    await ute.deleteFile(sessionId, storedTypes.get(sessionId) ?? ute.RecordFileType.Opus).catch(logFail("clip: storedTypes.get"));
    say(`discarded the recording the button started (#${sessionId}); it was used to call the assistant`);
  } finally {
    setTimeout(() => (appStopping = false), 3000);
  }
}

// --- Buzz ------------------------------------------------------------------

const BUZZ_OPTION = "ovoa.buzzOption";
/** 1: "find my device" on/off, 2: factoryVibration, 3: factory motor test. */
export type BuzzOption = 1 | 2 | 3;
let buzzOption: BuzzOption = 1;
storage
  .get(BUZZ_OPTION)
  .then((v) => {
    if (v === "1" || v === "2" || v === "3") buzzOption = Number(v) as BuzzOption;
  })
  .catch(logFail("clip: Number"));

export const getBuzzOption = () => buzzOption;

export function setBuzzOption(option: BuzzOption) {
  buzzOption = option;
  storage.set(BUZZ_OPTION, String(option)).catch(logFail("clip: storage.set"));
}

let afterBuzz: ReturnType<typeof setTimeout> | null = null;
/** When the last buzz started, until a live reading comes: how long it left twist blind goes in the log. */
let buzzedAt = 0;

/** A buzz can leave the gyroscope test off, so it's turned on once more afterwards (see motionAfterBuzz). */
function keepMotionThroughBuzz(option: BuzzOption, count: number) {
  const source = activeSource;
  if (!source || twistKind(source) !== "spin" || !motionWanted()) return;
  const started = Date.now();
  buzzedAt = started;
  // Restart the watchdog's silence clock so it doesn't turn the source on too, and this isn't a re-arm.
  armedAt = started;
  const { afterMs, always } = motionAfterBuzz(option, count);
  // A second buzz meanwhile replaces the first one's turn-on: never more than one per buzz.
  if (afterBuzz) clearTimeout(afterBuzz);
  afterBuzz = setTimeout(() => {
    afterBuzz = null;
    if (activeSource !== source || !motionWanted() || motionStarting || clipBusy()) return;
    if (!always && lastLiveAt > started) return;
    armedAt = Date.now();
    say(`twist: turning ${source} on again after buzz option ${option}`);
    ute.setMotionSource(source, true, intervalFor(source)).catch((err) => say(`motion: ${source} failed — ${message(err)}`));
  }, afterMs);
}

type HeartListener = (bpm: number, detail: string) => void;
const heartListeners = new Set<HeartListener>();

/** Heart-rate readings from the clip's own sensor, however they were asked for. Returns an unsubscribe. */
export function onHeartRate(listener: HeartListener) {
  heartListeners.add(listener);
  return () => void heartListeners.delete(listener);
}

/** Whether the clip is free for a quick command: linked, and not recording, downloading or being probed. */
export const clipIdle = () => state.phase === "connected" && !state.recording && !state.download && !state.busy && !probe;

/** When the clip was last asked to vibrate, by anything. The buzz queue (buzz.ts) spaces itself from this. */
let lastBuzz = 0;
export const lastBuzzAt = () => lastBuzz;

/** The app's own linked flag. The vendor SDK's connect status says "connected" by default and can't be trusted. */
export const isLinked = () => state.phase === "connected";

/** Called when the clip links or unlinks. Returns an unsubscribe. */
export function onLinkChange(listener: (linked: boolean) => void) {
  let was = isLinked();
  return subscribe(() => {
    const now = isLinked();
    if (now !== was) {
      was = now;
      listener(now);
    }
  });
}

/** Vibrates the clip. Never throws: a missing buzz shouldn't break listening. */
export async function buzz(count = 1, option: BuzzOption = buzzOption) {
  if (state.phase !== "connected") return false;
  lastBuzz = Date.now();
  keepMotionThroughBuzz(option, count);
  try {
    await ute.buzz(count, option);
    say(`buzz option ${option} fired (×${count})`);
    return true;
  } catch (err) {
    // It often vibrates without answering: a timeout isn't a failure.
    if (/didn't answer in time/.test(message(err))) {
      say(`buzz option ${option} sent (×${count}), no reply from the clip`);
      return true;
    }
    say(`buzz option ${option} failed — ${message(err)}`);
    return false;
  }
}

// --- Listening light --------------------------------------------------------

/**
 * The clip's light on while OVOA listens, off when it stops, via the watch's three-color LED test (no
 * color choice; untested on the ES100). If the clip refuses it, the light is left alone for this session. Only the latest wish is sent,
 * never more than one command every LIGHT_GAP_MS: command floods freeze the clip.
 */
const LIGHT_GAP_MS = 1500;
// The green command (colors 2) never answered and never lit on the phone (build 33, device_logs
// 5019-5086): the ES100 ignores the wearables' LED command. So only the LED test is tried.
let lightColors: number | null = 0; // 0: the LED test; null: it doesn't work either
let lightWanted = false;
let lightShown: boolean | null = null;
let lightBusy = false;
let lightLastAt = 0;

export function setListeningLight(on: boolean) {
  lightWanted = on;
  void syncLight();
}

async function syncLight() {
  if (lightBusy || lightColors === null) return;
  if (state.phase !== "connected") {
    lightShown = null; // unknown after a reconnect
    return;
  }
  if (lightShown === lightWanted) return;
  const wait = lightLastAt + LIGHT_GAP_MS - Date.now();
  if (wait > 0) {
    setTimeout(() => void syncLight(), wait);
    return;
  }
  lightBusy = true;
  const on = lightWanted;
  const colors = lightColors;
  lightLastAt = Date.now();
  try {
    await ute.setLight(on, colors);
    lightShown = on;
    say(`light: ${on ? (colors ? "green" : "LED test") + " on" : "off"}`);
  } catch (err) {
    // No answer: the command may still have worked, like the buzz. Only a refusal switches over.
    if (/didn't answer in time/.test(message(err))) {
      lightShown = on;
      say(`light: ${on ? "on" : "off"} sent (${colors ? "green" : "LED test"}), no reply from the clip`);
    } else {
      lightColors = colors ? 0 : null;
      lightShown = null;
      say(`light: ${colors ? "green" : "LED test"} failed — ${message(err)}${colors ? "; trying the LED test" : "; giving up"}`);
    }
  } finally {
    lightBusy = false;
  }
  if (lightShown !== lightWanted) void syncLight();
}

// --- Recording -------------------------------------------------------------

async function busy<T>(label: string, fn: () => Promise<T>) {
  set({ busy: label });
  try {
    return await fn();
  } catch (err) {
    say(`${label} failed — ${message(err)}`);
    throw err;
  } finally {
    set({ busy: null });
  }
}

const startProblems: Record<number, string> = {
  [ute.StartRecordResult.StorageFull]: "The clip's storage is full. Import and delete some recordings first.",
  [ute.StartRecordResult.USBMode]: "The clip is in USB mode. Unplug it and try again.",
  [ute.StartRecordResult.HardwareError]: "The clip reported a hardware error.",
  [ute.StartRecordResult.WiFiMode]: "The clip is in Wi-Fi mode. Turn that off on the clip first.",
  [ute.StartRecordResult.Stopped]: "The clip says recording is stopped. Try again.",
  [ute.StartRecordResult.Unknown]: "The clip couldn't start recording.",
};

export function startRecording() {
  return busy("Start recording", async () => {
    const started = await ute.startRecord();
    if (started.result === ute.StartRecordResult.AlreadyRecording) {
      say("the clip was already recording");
    } else if (started.result !== ute.StartRecordResult.Started) {
      // Twist's motion source is a factory test: note it, in case that's what the clip objected to.
      if (activeSource) devlog("err", `recording refused (result ${started.result}) while twist motion (${activeSource}) was on`);
      throw new Error(startProblems[started.result] ?? `The clip couldn't start recording (result ${started.result}).`);
    }
    say(`recording #${started.sessionId}`);
    set({ recording: { sessionId: started.sessionId, startedAt: Date.now(), paused: false, byDevice: false } });
  });
}

export function pauseRecording() {
  const rec = state.recording;
  if (!rec) return Promise.resolve();
  return busy("Pause", async () => {
    const res = await ute.pauseRecord(rec.sessionId);
    if (res.result !== 0 && res.result !== 1) throw new Error(`The clip couldn't pause (result ${res.result}).`);
    set({ recording: { ...rec, paused: true } });
  });
}

export function resumeRecording() {
  const rec = state.recording;
  if (!rec) return Promise.resolve();
  return busy("Resume", async () => {
    const res = await ute.resumeRecord(rec.sessionId);
    if (res.result !== 0 && res.result !== ute.StartRecordResult.AlreadyRecording) {
      throw new Error(startProblems[res.result] ?? `The clip couldn't resume (result ${res.result}).`);
    }
    set({ recording: { ...rec, paused: false } });
  });
}

/** Stops recording and brings the file over to the phone. */
export async function stopRecording() {
  appStopping = true;
  let stopped: Awaited<ReturnType<typeof ute.stopRecord>>;
  try {
    stopped = await busy("Stop recording", () => ute.stopRecord());
  } finally {
    // The clip's own stop notification may arrive just after the reply.
    setTimeout(() => (appStopping = false), 3000);
  }
  set({ recording: null });
  say(`stopped #${stopped.sessionId}: ${stopped.fileSize} bytes${stopped.saved ? "" : ", not saved"}`);
  if (!stopped.saved || stopped.fileSize <= 0) throw new Error("The clip didn't keep that recording (it may have been too short).");
  // The clip needs a moment to close the file; downloadOne retries if it wasn't ready.
  stoppedAt.set(stopped.sessionId, Date.now());
  await new Promise((r) => setTimeout(r, READY_DELAY_MS));
  return importSession(stopped.sessionId, stopped.fileSize);
}

// --- Downloading -----------------------------------------------------------

let importing: Promise<unknown> = Promise.resolve();

/** How long to let the clip close the file before asking for it. */
const READY_DELAY_MS = 150;
/** When the clip said it stopped, so the wait before the first byte is measurable. */
const stoppedAt = new Map<number, number>();
/** First and last sync-progress tick, which separates BLE time from decode time. */
const transferMarks = new Map<number, { first: number; last: number }>();

/** Downloads one clip recording into the phone's list. Runs one at a time. */
export function importSession(sessionId: number, size: number) {
  const job = importing.then(() => downloadOne(sessionId, size));
  importing = job.catch(logFail("clip: downloadOne"));
  return job;
}

async function downloadOne(sessionId: number, size: number) {
  set({ busy: "Downloading", download: { sessionId, received: 0, total: size } });
  const stopGap = stoppedAt.get(sessionId);
  stoppedAt.delete(sessionId);
  say(`downloading #${sessionId} (${Math.round(size / 1024)} KB)…${stopGap ? ` ${Date.now() - stopGap} ms after stop` : ""}`);
  const asked = Date.now();
  try {
    // Opus (mono) is what the phone can decode and play; the vendor demo always asks for it.
    // We ask sooner than the vendor demo does, so a clip that wasn't ready gets one retry.
    let result = await ute.syncFile(sessionId, ute.RecordFileType.Opus, size).catch((err) => err as Error);
    if (result instanceof Error || result.bytes <= 0) {
      say(`nothing came back — retrying once (${result instanceof Error ? result.message : "0 bytes"})`);
      transferMarks.delete(sessionId);
      await new Promise((r) => setTimeout(r, 600));
      result = await ute.syncFile(sessionId, ute.RecordFileType.Opus, size);
    }
    const marks = transferMarks.get(sessionId);
    transferMarks.delete(sessionId);
    // The open turn, if this is a band question, gets the Bluetooth leg on its bill.
    markTurn(
      "fetch from the clip",
      marks
        ? `${Math.round(result.bytes / 1024)} KB, ${Math.round((result.bytes / Math.max(1, marks.last - marks.first)) * 1000)} B/s, ${Date.now() - marks.last} ms decode`
        : `${Math.round(result.bytes / 1024)} KB`,
    );
    if (marks) {
      // Everything after the last byte arrived is decode + disk, not Bluetooth.
      say(
        `#${sessionId} timing: ${marks.first - asked} ms to first byte, ` +
          `${marks.last - marks.first} ms transfer (${Math.round(result.bytes / Math.max(1, marks.last - marks.first) * 1000)} B/s), ` +
          `${Date.now() - marks.last} ms decode`,
      );
    }
    if (result.bytes < size) say(`only got ${result.bytes} of ${size} bytes; keeping what arrived`);
    if (result.decodeError) say(`couldn't make it playable — ${result.decodeError}`);
    else say(`saved #${sessionId}: ${result.seconds?.toFixed(1)} s${result.badPackets ? `, ${result.badPackets} bad packets` : ""}`);
    return addRecording({
      source: "clip",
      sessionId,
      // The session id is the clip's start time in unix seconds, when its clock was set.
      createdAt: sessionId > 1_500_000_000 ? sessionId * 1000 : Date.now(),
      seconds: result.seconds,
      wavUri: result.wavUri,
      rawUri: result.uri,
      bytes: result.bytes,
      decodeError: result.decodeError,
    });
  } finally {
    set({ busy: null, download: null });
  }
}

/** Downloads every recording on the clip that isn't on the phone yet. */
export function importAll() {
  return busy("Checking the clip", async () => {
    const { files } = await ute.listFiles();
    files.forEach((f) => storedTypes.set(f.sessionId, f.type));
    const fresh = files.filter((f) => f.size > 0 && !hasClipSession(f.sessionId));
    say(`${files.length} on the clip, ${fresh.length} new`);
    return fresh;
  }).then(async (fresh) => {
    for (const file of fresh) await importSession(file.sessionId, file.size);
    return fresh.length;
  });
}

/** The clip lists each file with the format it stores it in; deleting wants that format back. */
const storedTypes = new Map<number, ute.RecordFileType>();

export function deleteFromClip(sessionId: number) {
  const type = storedTypes.get(sessionId) ?? ute.RecordFileType.Opus;
  return busy("Delete from clip", () => ute.deleteFile(sessionId, type));
}
