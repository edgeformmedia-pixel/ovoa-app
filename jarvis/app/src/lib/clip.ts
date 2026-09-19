import { useSyncExternalStore } from "react";
import { Alert } from "react-native";
import * as ute from "../../modules/ute-ble";
import { devlog } from "./devlog";
import { addRecording, hasClipSession } from "./recordings";
import { storage } from "./storage";
import { spreadBatch, type Sample } from "./twist";

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
    say(`sdk: ${line.trim()}`);
  });

  ute.addListener("onRecordStart", (event) => {
    say(`recording started (${event.startedByDevice ? "clip button" : "app"}) #${event.sessionId}`);
    set({
      recording: { sessionId: event.sessionId, startedAt: Date.now(), paused: false, byDevice: event.startedByDevice },
    });
    if (event.startedByDevice) {
      noteInput("Clip button", "started recording");
      if (pressUsed("record")) discardButtonRecording(event.sessionId);
    }
  });

  ute.addListener("onRecordStop", (event) => {
    say(`recording stopped #${event.sessionId}, ${event.fileSize} bytes${event.saved ? "" : " (not saved)"}`);
    set({ recording: null });
    if (appStopping) return;
    noteInput("Clip button", "stopped recording");
    // Stopped on the clip itself: bring it over like one the app stopped.
    if (event.saved !== false && event.fileSize > 0) {
      setTimeout(() => importSession(event.sessionId, event.fileSize).catch(() => {}), 1000);
    }
  });

  ute.addListener("onMotion", ({ source, samples }) => onMotionBatch(source ?? "game", samples));

  ute.addListener("onSyncProgress", (p) => set({ download: { sessionId: p.sessionId, received: p.received, total: p.total } }));

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
    } else {
      noteInput("Voice audio", `${input.value} bytes (${input.detail ?? ""})`);
    }
    say(`input ${input.kind} ${input.value}${input.detail ? ` ${input.detail}` : ""}`);
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
  say(`connected to ${device?.name || "clip"}`);
  if (device?.id) {
    await storage.set(SAVED_DEVICE, device.id).catch(() => {});
    set({ savedDeviceId: device.id });
  }
  // The clip needs a moment after pairing before it answers record commands.
  setTimeout(() => {
    refreshInfo()
      .catch(() => {})
      // The iOS SDK has no "stream ended" event: restart the stream after every (re)connect.
      .then(() => ensureMotion("connected"));
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
      ute.stopScan().catch(() => {});
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
    ute.stopScan().catch(() => {});
    if (state.phase === "scanning") set({ phase: "idle" });
  }, 10_000);
}

export async function connect(id: string) {
  ensureStarted();
  if (state.phase === "connecting" || state.phase === "pairing" || state.phase === "connected") return;
  userDisconnected = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  set({ phase: "connecting", problem: null });
  await storage.set(SAVED_DEVICE, id).catch(() => {});
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
    await ute.stopScan().catch(() => {});
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
    ute.disconnect().catch(() => {});
    set({ phase: "idle", problem: "The clip didn't finish connecting. Tap Connect to try again." });
  }, CONNECT_TIMEOUT_MS);
}

/** Connects to the remembered clip, if there is one. */
export function autoConnect() {
  if (userDisconnected || !state.savedDeviceId || state.phase !== "idle" || state.bluetoothOn === false) return;
  connect(state.savedDeviceId).catch(() => {});
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
  await ute.disconnect().catch(() => {});
  set({ phase: "idle", device: null, recording: null, motion: { ...state.motion, on: false } });
}

/** Disconnects and stops remembering the clip. */
export async function forget() {
  await disconnect();
  await storage.remove(SAVED_DEVICE).catch(() => {});
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
    // Phase 0 of twist-to-listen: what motion data this firmware claims to have.
    const wear = await attempt("wearable functions", ute.probeWearFunctions);
    const flags = ["hasGame", "hasGlasses", "hasEarphone", "hasNoScreen", "hasButtonWakeUpVoice", "hasVoiceAssistant", "hasChatGPT", "hasWearingHands", "hasAIRecording", "hasAIRecordRealTime"];
    devlog(
      "ble",
      "twist probe",
      JSON.stringify({
        sensors,
        wearFunctions: wear?.functions ?? null,
        ...Object.fromEntries(flags.map((f) => [f, state.capabilities?.[f] ?? null])),
      }),
    );
  }
}

/** Only the live values, for polling. */
export async function pollLive() {
  if (state.phase !== "connected") return;
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

// --- Motion for twist-to-listen -------------------------------------------
//
// The SDK has several motion sources and the ES100 supports some unknown subset
// (it ignored the game stream). They're tried in this order; the first that
// actually delivers samples is kept for as long as the clip stays connected.

const MOTION_SOURCES: ute.MotionSource[] = ["game", "wear6", "wear3", "gsensor", "gyro"];
/** How long a source gets to deliver its first samples before the next one is tried. */
const FIRST_SAMPLES_MS = 3000;
const MOTION_SILENCE_MS = 5000;

type MotionListener = (samples: Sample[]) => void;
const motionListeners = new Set<MotionListener>();
let lastBatchAt: number | null = null;
let lastRawLog = 0;
let motionStarting = false;
/** Index into MOTION_SOURCES of the source in use (or being tried). */
let sourceIndex = 0;
let activeSource: ute.MotionSource | null = null;
let watchdog: ReturnType<typeof setInterval> | null = null;

function onMotionBatch(source: ute.MotionSource, samples: ute.MotionSample[]) {
  const now = Date.now();
  const timed = spreadBatch(lastBatchAt, now, samples);
  lastBatchAt = now;
  const last = samples[samples.length - 1] ?? null;
  set({ motion: { on: true, last, count: state.motion.count + samples.length, source } });
  // Raw data for tuning the detector from device_logs, about once a second.
  if (now - lastRawLog > 1000) {
    lastRawLog = now;
    devlog("ble", "motion raw", `${source}: ${samples.length} samples: ${JSON.stringify(samples.slice(0, 4))}`);
  }
  motionListeners.forEach((l) => l(timed));
}

function motionUnavailable(why: string) {
  if (state.motionProblem) return;
  set({ motionProblem: why });
  devlog("ble", "twist: no motion data, using clip button", why);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A source must send at least this many samples in FIRST_SAMPLES_MS: one reading isn't a stream. */
const MIN_FIRST_SAMPLES = 5;

/** Waits for a steady stream: MIN_FIRST_SAMPLES samples within `ms`. */
async function streamStarted(ms: number) {
  const start = state.motion.count;
  for (let waited = 0; waited < ms; waited += 100) {
    if (state.motion.count - start >= MIN_FIRST_SAMPLES) return true;
    await sleep(100);
  }
  return state.motion.count - start >= MIN_FIRST_SAMPLES;
}

/** Starts motion if someone wants it: the source that worked, or the next one to try. */
async function ensureMotion(reason: string) {
  if (!motionListeners.size || state.phase !== "connected" || motionStarting || state.motionProblem) return;
  motionStarting = true;
  try {
    while (sourceIndex < MOTION_SOURCES.length && motionListeners.size && state.phase === "connected") {
      const source = MOTION_SOURCES[sourceIndex];
      try {
        await ute.setMotionSource(source, true);
      } catch (err) {
        say(`motion: ${source} failed — ${message(err)}`);
        sourceIndex++;
        continue;
      }
      if (await streamStarted(FIRST_SAMPLES_MS)) {
        activeSource = source;
        set({ motion: { ...state.motion, on: true, source } });
        say(`twist: motion from ${source} (${reason})`);
        // Factory sensor tests may switch the clip into its test mode, which blocks recording.
        const status = await ute.getStatus().catch(() => null);
        if (status?.state === ute.RecordState.FactoryTest) {
          devlog("ble", `twist: ${source} put the clip in factory-test mode (recording is blocked)`);
        }
        return;
      }
      say(`motion: ${source} sent fewer than ${MIN_FIRST_SAMPLES} samples in ${FIRST_SAMPLES_MS / 1000} s`);
      await ute.setMotionSource(source, false).catch(() => {});
      sourceIndex++;
    }
    if (sourceIndex >= MOTION_SOURCES.length) {
      motionUnavailable(`none of the clip's motion sources sent data (tried ${MOTION_SOURCES.join(", ")})`);
    }
  } finally {
    motionStarting = false;
  }
}

async function stopMotion() {
  const source = activeSource ?? MOTION_SOURCES[sourceIndex];
  activeSource = null;
  if (source && state.phase === "connected") {
    await ute.setMotionSource(source, false).catch(() => {});
    say(`motion: ${source} off`);
  }
  set({ motion: { ...state.motion, on: false } });
}

/** A source that went quiet (the SDK has no "stream ended" event) is started again. */
function checkMotion() {
  if (!motionListeners.size || state.phase !== "connected" || state.motionProblem || motionStarting || !activeSource) return;
  if (lastBatchAt !== null && Date.now() - lastBatchAt < MOTION_SILENCE_MS) return;
  lastBatchAt = Date.now(); // give the restart its own time
  activeSource = null;
  ensureMotion(`no samples for ${MOTION_SILENCE_MS / 1000} s`);
}

/** A new connection: try every source again (a different clip may support different ones). */
function resetMotion() {
  sourceIndex = 0;
  activeSource = null;
  lastBatchAt = null;
}

/** Timestamped motion samples while subscribed. The clip streams while anyone is subscribed. */
export function subscribeMotion(listener: MotionListener) {
  ensureStarted();
  motionListeners.add(listener);
  if (motionListeners.size === 1) {
    lastBatchAt = null;
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

/** Forget that no source worked, so the next subscriber tries them all again. */
export function retryMotion() {
  if (motionStarting) return;
  set({ motionProblem: null });
  resetMotion();
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
export function onClipButton(listener: ButtonListener) {
  buttonListeners.add(listener);
  return () => {
    buttonListeners.delete(listener);
  };
}

const pressUsed = (source: "voiceButton" | "record") => [...buttonListeners].some((l) => l(source) === true);

/** The press only meant "listen to me": stop the recording it started and delete it from the clip. */
async function discardButtonRecording(sessionId: number) {
  appStopping = true;
  try {
    await ute.stopRecord().catch(() => {});
    set({ recording: null });
    await ute.deleteFile(sessionId, storedTypes.get(sessionId) ?? ute.RecordFileType.Opus).catch(() => {});
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
  .catch(() => {});

export const getBuzzOption = () => buzzOption;

export function setBuzzOption(option: BuzzOption) {
  buzzOption = option;
  storage.set(BUZZ_OPTION, String(option)).catch(() => {});
}

/** Vibrates the clip. Never throws: a missing buzz shouldn't break listening. */
export async function buzz(count = 1, option: BuzzOption = buzzOption) {
  if (state.phase !== "connected") return false;
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
  // The vendor demo waits a beat after stopping before asking for the file.
  await new Promise((r) => setTimeout(r, 800));
  return importSession(stopped.sessionId, stopped.fileSize);
}

// --- Downloading -----------------------------------------------------------

let importing: Promise<unknown> = Promise.resolve();

/** Downloads one clip recording into the phone's list. Runs one at a time. */
export function importSession(sessionId: number, size: number) {
  const job = importing.then(() => downloadOne(sessionId, size));
  importing = job.catch(() => {});
  return job;
}

async function downloadOne(sessionId: number, size: number) {
  set({ busy: "Downloading", download: { sessionId, received: 0, total: size } });
  say(`downloading #${sessionId} (${Math.round(size / 1024)} KB)…`);
  try {
    // Opus (mono) is what the phone can decode and play; the vendor demo always asks for it.
    const result = await ute.syncFile(sessionId, ute.RecordFileType.Opus, size);
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
