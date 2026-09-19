import Ionicons from "@expo/vector-icons/Ionicons";
import * as Calendar from "expo-calendar";
import * as Contacts from "expo-contacts";
import * as Haptics from "expo-haptics";
import * as Location from "expo-location";
import { useRouter } from "expo-router";
import {
  Accelerometer,
  Barometer,
  DeviceMotion,
  Gyroscope,
  Magnetometer,
  Pedometer,
} from "expo-sensors";
import type { EventSubscription } from "expo-modules-core";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as clip from "../lib/clip";
import { devlog } from "../lib/devlog";
import { createFallDetector } from "../lib/fallDetector";
import { calibrate, type Sample } from "../lib/twist";
import { twistProfilePref } from "../lib/voice";
import { colors } from "../lib/theme";

// Live readouts for every sensor and permission the app touches. Reachable from
// Settings; meant for checking hardware on a real device, not for shipping users.

const HZ = 10;
const INTERVAL_MS = 1000 / HZ;

type Sensor = {
  isAvailableAsync(): Promise<boolean>;
  setUpdateInterval(ms: number): void;
  addListener(listener: (data: any) => void): EventSubscription;
};

/** Subscribes while `on` is true, and reports whether the hardware exists at all. */
function useSensor<T>(sensor: Sensor, on: boolean) {
  const [data, setData] = useState<T | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    sensor
      .isAvailableAsync()
      .then((ok) => !cancelled && setAvailable(ok))
      .catch(() => !cancelled && setAvailable(false));
    return () => {
      cancelled = true;
    };
  }, [sensor]);

  useEffect(() => {
    if (!on) return;
    sensor.setUpdateInterval(INTERVAL_MS);
    const sub = sensor.addListener((next) => setData(next as T));
    return () => sub.remove();
  }, [sensor, on]);

  return { data, available };
}

const n = (value: number | undefined, digits = 2) => (value === undefined ? "—" : value.toFixed(digits));

export default function DevTools() {
  const router = useRouter();
  const [motionOn, setMotionOn] = useState(true);
  const clipState = clip.useClip();

  // The clip only reports some values when asked.
  useEffect(() => {
    if (clipState.phase !== "connected") return;
    clip.refreshInfo().catch(() => {});
    const timer = setInterval(() => clip.pollLive().catch(() => {}), 3000);
    return () => clearInterval(timer);
  }, [clipState.phase]);

  const accelerometer = useSensor<{ x: number; y: number; z: number }>(Accelerometer, motionOn);
  const gyroscope = useSensor<{ x: number; y: number; z: number }>(Gyroscope, motionOn);
  const magnetometer = useSensor<{ x: number; y: number; z: number }>(Magnetometer, motionOn);
  const barometer = useSensor<{ pressure: number; relativeAltitude?: number }>(Barometer, motionOn);
  const deviceMotion = useSensor<{
    rotation?: { alpha: number; beta: number; gamma: number };
    orientation?: number;
  }>(DeviceMotion, motionOn);

  const [steps, setSteps] = useState<number | null>(null);
  const [stepsAvailable, setStepsAvailable] = useState<boolean | null>(null);
  const [location, setLocation] = useState<Location.LocationObject | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<Record<string, string>>({});
  const [falls, setFalls] = useState(0);
  const [lastFall, setLastFall] = useState<string | null>(null);

  // Live step counter.
  useEffect(() => {
    let sub: EventSubscription | undefined;
    Pedometer.isAvailableAsync()
      .then(async (ok) => {
        setStepsAvailable(ok);
        if (!ok) return;
        const { granted } = await Pedometer.requestPermissionsAsync();
        if (!granted) return;
        sub = Pedometer.watchStepCount((result) => setSteps(result.steps));
      })
      .catch(() => setStepsAvailable(false));
    return () => sub?.remove();
  }, []);

  // Runs the real fall detector against live accelerometer samples, so the
  // thresholds in fallDetector.ts can be checked by actually dropping the phone.
  const detector = useRef(
    createFallDetector(() => {
      setFalls((count) => count + 1);
      setLastFall(new Date().toLocaleTimeString());
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    }),
  );

  useEffect(() => {
    if (!motionOn) return;
    Accelerometer.setUpdateInterval(20); // the detector wants ~50 Hz
    const sub = Accelerometer.addListener((sample) => detector.current(sample, Date.now()));
    return () => sub.remove();
  }, [motionOn]);

  const checkPermissions = useCallback(async () => {
    const next: Record<string, string> = {};
    const record = async (label: string, get: () => Promise<{ status: string }>) => {
      try {
        next[label] = (await get()).status;
      } catch (err) {
        next[label] = err instanceof Error ? err.message : "error";
      }
    };
    await Promise.all([
      record("Location", Location.getForegroundPermissionsAsync),
      record("Contacts", Contacts.getPermissionsAsync),
      record("Calendar", Calendar.getCalendarPermissionsAsync),
      record("Reminders", Calendar.getRemindersPermissionsAsync),
      record("Motion", Pedometer.getPermissionsAsync),
    ]);
    setPermissions(next);
  }, []);

  useEffect(() => {
    checkPermissions();
  }, [checkPermissions]);

  const fix = async () => {
    setLocationError(null);
    try {
      const { granted } = await Location.requestForegroundPermissionsAsync();
      if (!granted) return setLocationError("Permission denied");
      setLocation(await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }));
      checkPermissions();
    } catch (err) {
      setLocationError(err instanceof Error ? err.message : String(err));
    }
  };

  const g = accelerometer.data
    ? Math.sqrt(accelerometer.data.x ** 2 + accelerometer.data.y ** 2 + accelerometer.data.z ** 2)
    : undefined;

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.title}>Dev tools</Text>
        <Text style={styles.dim}>
          {Platform.OS} {Platform.Version} · sensors at {HZ} Hz
        </Text>

        <Pressable style={styles.link} onPress={() => router.push("/es100")}>
          <View style={styles.linkLeft}>
            <Ionicons name="bluetooth" size={18} color={colors.accent} />
            <Text style={styles.itemText}>ES100 recorder</Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
        </Pressable>

        <ClipInputs state={clipState} />

        <Text style={styles.section}>Phone</Text>

        <View style={styles.toggleRow}>
          <Text style={styles.itemText}>Motion sensors</Text>
          <Switch
            value={motionOn}
            onValueChange={setMotionOn}
            trackColor={{ true: colors.accentDim, false: colors.surfaceHigh }}
            thumbColor={motionOn ? colors.accent : colors.textDim}
          />
        </View>

        <Card title="Accelerometer" unit="g" available={accelerometer.available}>
          <Axis label="x" value={accelerometer.data?.x} />
          <Axis label="y" value={accelerometer.data?.y} />
          <Axis label="z" value={accelerometer.data?.z} />
          <Axis label="magnitude" value={g} />
        </Card>

        <Card title="Gyroscope" unit="rad/s" available={gyroscope.available}>
          <Axis label="x" value={gyroscope.data?.x} />
          <Axis label="y" value={gyroscope.data?.y} />
          <Axis label="z" value={gyroscope.data?.z} />
        </Card>

        <Card title="Magnetometer" unit="µT" available={magnetometer.available}>
          <Axis label="x" value={magnetometer.data?.x} />
          <Axis label="y" value={magnetometer.data?.y} />
          <Axis label="z" value={magnetometer.data?.z} />
        </Card>

        <Card title="Device motion" unit="degrees" available={deviceMotion.available}>
          <Axis label="alpha" value={deviceMotion.data?.rotation?.alpha} />
          <Axis label="beta" value={deviceMotion.data?.rotation?.beta} />
          <Axis label="gamma" value={deviceMotion.data?.rotation?.gamma} />
          <Axis label="orientation" value={deviceMotion.data?.orientation} digits={0} />
        </Card>

        <Card title="Barometer" unit="hPa" available={barometer.available}>
          <Axis label="pressure" value={barometer.data?.pressure} />
          <Axis label="rel. altitude" value={barometer.data?.relativeAltitude} />
        </Card>

        <Card title="Pedometer" unit="steps" available={stepsAvailable}>
          <Axis label="since open" value={steps ?? undefined} digits={0} />
        </Card>

        <Card title="Fall detector" available={accelerometer.available}>
          <Axis label="falls seen" value={falls} digits={0} />
          <Row label="last" value={lastFall ?? "—"} />
          <Text style={styles.hint}>
            Drop the phone onto something soft: free fall, impact, then lying still for 1.5 s.
          </Text>
        </Card>

        <Card title="Location" available={true}>
          <Row label="lat" value={location ? location.coords.latitude.toFixed(5) : "—"} />
          <Row label="lon" value={location ? location.coords.longitude.toFixed(5) : "—"} />
          <Row label="accuracy" value={location ? `${n(location.coords.accuracy ?? undefined, 0)} m` : "—"} />
          <Row label="speed" value={location ? `${n(location.coords.speed ?? undefined)} m/s` : "—"} />
          {locationError && <Text style={styles.error}>{locationError}</Text>}
          <Pressable style={styles.button} onPress={fix}>
            <Text style={styles.buttonText}>Get a fix</Text>
          </Pressable>
        </Card>

        <Card title="Haptics" available={Platform.OS !== "web"}>
          <View style={styles.row}>
            {(["Light", "Medium", "Heavy"] as const).map((style) => (
              <Pressable
                key={style}
                style={styles.button}
                onPress={() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle[style]).catch(() => {})}
              >
                <Text style={styles.buttonText}>{style}</Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.row}>
            {(["Success", "Warning", "Error"] as const).map((type) => (
              <Pressable
                key={type}
                style={styles.button}
                onPress={() => Haptics.notificationAsync(Haptics.NotificationFeedbackType[type]).catch(() => {})}
              >
                <Text style={styles.buttonText}>{type}</Text>
              </Pressable>
            ))}
          </View>
        </Card>

        <Card title="Permissions" available={true}>
          {Object.entries(permissions).map(([label, status]) => (
            <Row key={label} label={label} value={status} good={status === "granted"} />
          ))}
          <Pressable style={styles.button} onPress={checkPermissions}>
            <Text style={styles.buttonText}>Re-check</Text>
          </Pressable>
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

const yesNo = (value: boolean | null | undefined) => (value === undefined || value === null ? "—" : value ? "yes" : "no");

/** Everything the ES100 reports: live values, its own events, and the features its firmware claims. */
function ClipInputs({ state }: { state: clip.ClipState }) {
  const connected = state.phase === "connected";
  const supported = Object.entries(state.capabilities ?? {})
    .filter(([, on]) => on)
    .map(([name]) => name.replace(/^has/, ""))
    .sort();
  const motion = supported.filter((name) => /sensor|gyro|motion|accel|posture|wear/i.test(name));
  return (
    <>
      <Text style={styles.section}>ES100 clip</Text>
      <Card title="Clip — live" available={state.phase === "unavailable" ? false : true}>
        <Row label="connection" value={state.phase} good={connected} />
        <Row
          label="battery"
          value={
            state.battery
              ? `${state.battery.percent}%${state.battery.charging ? " · charging" : state.battery.full ? " · full" : ""}${state.battery.low ? " · low" : ""}`
              : "—"
          }
        />
        <Row label="signal" value={state.rssi !== null ? `${state.rssi} dBm` : "—"} mono />
        <Row label="recording" value={state.recording ? (state.recording.paused ? "paused" : "yes") : connected ? "no" : "—"} />
        <Row label="record state" value={state.status ? String(state.status.state) : "—"} mono />
        <Row label="button (key state)" value={state.status?.keyState !== undefined ? String(state.status.keyState) : "—"} mono />
        <Row label="privacy mode" value={yesNo(state.status?.privacyMode)} />
        <Row label="USB mode" value={yesNo(state.status?.usbConnected)} />
        <Row label="mic mode" value={state.status?.micMode !== undefined ? (state.status.micMode ? "mixed" : "normal") : "—"} />
        <Row
          label="storage"
          value={
            state.storageInfo
              ? `${Math.round(state.storageInfo.freeKB / 1024)} / ${Math.round(state.storageInfo.totalKB / 1024)} MB free`
              : "—"
          }
        />
        {state.formats?.map((f, i) => (
          <Row key={i} label={`format ${f.type}`} value={`${f.channels} ch · ${f.sampleRate} Hz · ${f.bitRate} bps`} mono />
        ))}
      </Card>

      <Card title="Clip — motion" available={state.phase === "unavailable" ? false : true}>
        <Row label="accelerometer (firmware)" value={yesNo(state.sensors?.accelerometer)} />
        <Row label="gyroscope (firmware)" value={yesNo(state.sensors?.gyroscope)} />
        <Row label="motion-stream flag (hasGame)" value={yesNo(state.capabilities?.hasGame)} />
        <Row label="gyro x / y / z" value={state.gyro ? `${state.gyro.x} / ${state.gyro.y} / ${state.gyro.z}` : "—"} mono />
        <Row
          label="stream x / y / speed"
          value={state.motion.last ? `${state.motion.last[0]} / ${state.motion.last[1]} / ${state.motion.last[2]}` : "—"}
          mono
        />
        <Row label="stream samples" value={String(state.motion.count)} mono />
        <View style={styles.row}>
          <Pressable
            style={styles.button}
            disabled={!connected}
            onPress={() => clip.readGyro().catch((err) => Alert.alert("Gyro", err instanceof Error ? err.message : String(err)))}
          >
            <Text style={styles.buttonText}>Read gyro</Text>
          </Pressable>
          <Pressable
            style={styles.button}
            disabled={!connected}
            onPress={() =>
              clip
                .setMotionStream(!state.motion.on)
                .catch((err) => Alert.alert("Motion stream", err instanceof Error ? err.message : String(err)))
            }
          >
            <Text style={styles.buttonText}>{state.motion.on ? "Stop motion stream" : "Start motion stream"}</Text>
          </Pressable>
        </View>
        <Text style={styles.hint}>
          The SDK is shared with watches, so these may not exist on the ES100. A timeout here means the firmware has no such sensor.
        </Text>
      </Card>

      <Card title="Clip — buzz" available={state.phase === "unavailable" ? false : true}>
        <BuzzOptions connected={connected} />
      </Card>

      <Card title="Twist to listen — calibrate" available={state.phase === "unavailable" ? false : true}>
        <TwistCalibration connected={connected} problem={state.motionProblem} />
      </Card>

      <Card title="Clip — events" available={state.phase === "unavailable" ? false : true}>
        {state.inputs.length === 0 && (
          <Text style={styles.dim}>Press the clip's button, plug it in, or record with it; what it reports shows up here.</Text>
        )}
        {state.inputs.slice(0, 12).map((input, i) => (
          <Row key={i} label={`${new Date(input.time).toLocaleTimeString()} ${input.label}`} value={input.value} />
        ))}
      </Card>

      <Card title="Clip — firmware features" available={state.phase === "unavailable" ? false : true}>
        {!state.capabilities ? (
          <Text style={styles.dim}>Connect the clip to read what it supports.</Text>
        ) : (
          <>
            <Row label="motion sensor flags" value={motion.length ? motion.join(", ") : "none"} />
            <Text style={styles.hint}>
              {supported.length} of {Object.keys(state.capabilities).length} flags on: {supported.join(", ")}
            </Text>
          </>
        )}
      </Card>
    </>
  );
}

const BUZZ_OPTIONS: { option: clip.BuzzOption; label: string }[] = [
  { option: 1, label: "1 · find device" },
  { option: 2, label: "2 · vibration" },
  { option: 3, label: "3 · motor test" },
];

/** Tries each way of making the clip vibrate; the one tapped last is what twist-to-listen uses. */
function BuzzOptions({ connected }: { connected: boolean }) {
  const [chosen, setChosen] = useState(clip.getBuzzOption());
  const [result, setResult] = useState<string | null>(null);
  return (
    <>
      <View style={styles.row}>
        {BUZZ_OPTIONS.map(({ option, label }) => (
          <Pressable
            key={option}
            style={[styles.button, chosen === option && { borderColor: colors.accent, borderWidth: 1 }]}
            disabled={!connected}
            onPress={async () => {
              clip.setBuzzOption(option);
              setChosen(option);
              const ok = await clip.buzz(1, option);
              setResult(`option ${option}: ${ok ? "sent — did it vibrate?" : "failed (see log)"}`);
            }}
          >
            <Text style={styles.buttonText}>{label}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={styles.hint}>{result ?? "Tap one; the last one tapped is used when a twist summons the assistant."}</Text>
    </>
  );
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 3 s of rest, then 3 twists: learns which motion value a counter-clockwise twist moves. */
function TwistCalibration({ connected, problem }: { connected: boolean; problem: string | null }) {
  const [step, setStep] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    twistProfilePref.get().then((p) => p && setResult(`saved: value ${p.axis}, direction ${p.sign}, threshold ${p.threshold.toFixed(1)}`));
  }, []);

  const run = async () => {
    let bucket: Sample[] = [];
    const off = clip.subscribeMotion((samples) => bucket.push(...samples));
    twistProfilePref.calibrating = true;
    setResult(null);
    try {
      setStep("Getting the motion stream going…");
      await wait(2000);
      setStep("Hold your wrist still…");
      bucket = [];
      await wait(3000);
      const rest = bucket;
      const twists: Sample[][] = [];
      for (let i = 1; i <= 3; i++) {
        setStep(`Get ready… (${i}/3)`);
        await wait(1200);
        setStep(`Twist counter-clockwise now! (${i}/3)`);
        clip.buzz(1);
        bucket = [];
        await wait(1500);
        twists.push(bucket);
      }
      const profile = calibrate(rest, twists);
      await twistProfilePref.set(profile);
      setResult(`saved: value ${profile.axis}, direction ${profile.sign}, threshold ${profile.threshold.toFixed(1)}`);
      devlog("ble", "twist calibrated", JSON.stringify({ profile, rest: rest.length, twists: twists.map((t) => t.length) }));
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      setResult(`failed: ${why}`);
      devlog("err", "twist calibration failed", why);
    } finally {
      twistProfilePref.calibrating = false;
      off();
      setStep(null);
    }
  };

  return (
    <>
      {problem && <Text style={styles.hint}>No motion data from this clip ({problem}); its button summons the assistant instead.</Text>}
      <Pressable style={styles.button} disabled={!connected || !!step} onPress={run}>
        <Text style={styles.buttonText}>{step ?? "Calibrate twist"}</Text>
      </Pressable>
      {result && <Text style={styles.hint}>{result}</Text>}
    </>
  );
}

function Card({
  title,
  unit,
  available,
  children,
}: {
  title: string;
  unit?: string;
  available: boolean | null;
  children: ReactNode;
}) {
  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Text style={styles.cardTitle}>{title}</Text>
        <Text style={styles.dim}>{available === null ? "checking…" : available ? (unit ?? "") : "unavailable"}</Text>
      </View>
      {available === false ? <Text style={styles.dim}>No hardware on this device.</Text> : children}
    </View>
  );
}

function Axis({ label, value, digits = 2 }: { label: string; value: number | undefined; digits?: number }) {
  return <Row label={label} value={n(value, digits)} mono />;
}

function Row({ label, value, mono, good }: { label: string; value: string; mono?: boolean; good?: boolean }) {
  return (
    <View style={styles.dataRow}>
      <Text style={styles.dim}>{label}</Text>
      <Text style={[styles.value, mono && styles.mono, good && styles.good]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  body: { padding: 20, gap: 10, paddingBottom: 48 },
  title: { color: colors.text, fontSize: 26, fontWeight: "600" },
  section: { color: colors.text, fontSize: 17, fontWeight: "600", marginTop: 16 },
  dim: { color: colors.textDim, fontSize: 13 },
  hint: { color: colors.textDim, fontSize: 12, marginTop: 6, lineHeight: 17 },
  error: { color: colors.danger, fontSize: 12, marginTop: 6 },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    gap: 4,
    marginTop: 8,
  },
  cardHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6 },
  cardTitle: { color: colors.text, fontSize: 15, fontWeight: "600" },
  dataRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 2 },
  value: { color: colors.text, fontSize: 14 },
  mono: { fontFamily: "Menlo", fontSize: 13 },
  good: { color: colors.success },
  row: { flexDirection: "row", gap: 8, flexWrap: "wrap", marginTop: 8 },
  toggleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginTop: 8,
  },
  link: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginTop: 12,
  },
  linkLeft: { flexDirection: "row", alignItems: "center", gap: 10 },
  itemText: { color: colors.text, fontSize: 15 },
  button: {
    backgroundColor: colors.accentDim,
    borderRadius: 10,
    paddingVertical: 9,
    paddingHorizontal: 14,
    alignSelf: "flex-start",
    marginTop: 8,
  },
  buttonText: { color: colors.accent, fontWeight: "600", fontSize: 13 },
});
