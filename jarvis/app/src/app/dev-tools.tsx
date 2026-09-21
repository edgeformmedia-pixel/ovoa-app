import Ionicons from "@expo/vector-icons/Ionicons";
import * as Calendar from "expo-calendar/legacy";
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
import { api } from "../lib/api";
import { useSession } from "../lib/auth";
import * as clip from "../lib/clip";
import * as ute from "../../modules/ute-ble";
import { devlog, logFail } from "../lib/devlog";
import { createFallDetector } from "../lib/fallDetector";
import {
  calibrate,
  createTwistDetector,
  describeProfile,
  gyroLive,
  spinOf,
  twistKind,
  type Sample,
  type TwistKind,
  type TwistProfiles,
} from "../lib/twist";
import { alwaysListenPref, twistProfilePref } from "../lib/voice";
import { breakdown, clearTurns, latencyTo, summary, useTurns, type TurnRecord } from "../lib/turnTimer";
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
    clip.refreshInfo().catch(logFail("dev-tools: clip.refreshInfo"));
    const timer = setInterval(() => clip.pollLive().catch(logFail("dev-tools: clip.pollLive")), 3000);
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
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(logFail("dev-tools: Haptics.notificationAsync"));
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

        <Pressable style={styles.link} onPress={() => router.push("/motion-lab")}>
          <View style={styles.linkLeft}>
            <Ionicons name="pulse" size={18} color={colors.accent} />
            <Text style={styles.itemText}>Motion lab — find the clip's motion sensor</Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
        </Pressable>

        <ClipInputs state={clipState} />

        <TurnTimings />

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
                onPress={() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle[style]).catch(logFail("dev-tools: Haptics.impactAsync"))}
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
                onPress={() => Haptics.notificationAsync(Haptics.NotificationFeedbackType[type]).catch(logFail("dev-tools: Haptics.notificationAsync"))}
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

/**
 * Where the last few spoken turns spent their seconds: the wait the user felt,
 * then each leg of it. "answer" is from the moment they stopped talking to the
 * first word out of the speaker — the only number that decides whether it feels fast.
 */
function TurnTimings() {
  const turns = useTurns();
  const recent = [...turns].reverse();
  const answered = turns
    .map((t) => latencyTo(t, "first word out loud"))
    .filter((ms): ms is number => ms !== null);
  const median = answered.length ? [...answered].sort((a, b) => a - b)[Math.floor(answered.length / 2)] : null;
  return (
    <>
      <Text style={styles.section}>Turn timings</Text>
      <Card title="Spoken turns" available={true}>
        <Row
          label="median answer"
          value={median !== null ? `${(median / 1000).toFixed(1)} s` : "—"}
          good={median !== null && median < 5000}
        />
        <Row label="turns recorded" value={String(turns.length)} />
        {recent.length === 0 && <Text style={styles.hint}>Ask something through the clip and it shows up here.</Text>}
        {recent.map((turn) => (
          <Turn key={turn.id} turn={turn} />
        ))}
        {turns.length > 0 && (
          <Pressable style={styles.button} onPress={clearTurns}>
            <Text style={styles.buttonText}>Clear</Text>
          </Pressable>
        )}
      </Card>
    </>
  );
}

function Turn({ turn }: { turn: TurnRecord }) {
  const answer = latencyTo(turn, "first word out loud");
  return (
    <View style={styles.turn}>
      <Text style={[styles.turnHead, turn.error ? { color: colors.danger } : null]}>
        {new Date(turn.startedAt).toLocaleTimeString()} · {summary(turn)}
        {answer !== null ? ` · answer ${(answer / 1000).toFixed(1)} s` : ""}
      </Text>
      <Text style={styles.hint} selectable>
        {breakdown(turn) || "nothing recorded"}
      </Text>
      {!!turn.heard && (
        <Text style={styles.hint} selectable numberOfLines={2}>
          heard "{turn.heard}"
        </Text>
      )}
      {!!turn.server && (
        <Text style={styles.hint} selectable numberOfLines={3}>
          server {turn.server}
        </Text>
      )}
    </View>
  );
}

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
          label="motion source"
          value={state.motion.source ? `${state.motion.source}${state.motion.on ? "" : " (off)"}` : state.motionProblem ? "none found" : "—"}
        />
        <Row label="last sample" value={state.motion.last ? state.motion.last.join(" / ") : "—"} mono />
        {state.motion.source === "gyro3" && state.motion.last && (
          <Row label="spin |x|+|y|+|z|" value={String(spinOf(state.motion.last))} mono />
        )}
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
          Twist uses the clip's gyroscope test (gyro3), about one reading a second. Read gyro is the older command,
          which the ES100 doesn't answer (a timeout).
        </Text>
      </Card>

      <AlwaysListen />
      <CaptureEverything />

      <Card title="Clip — buzz" available={state.phase === "unavailable" ? false : true}>
        <BuzzOptions connected={connected} />
        <ServerBuzz />
      </Card>

      <Card title="Clip — heart rate" available={state.phase === "unavailable" ? false : true}>
        <HeartRateTest connected={connected} capabilities={state.capabilities} />
      </Card>

      <Card title="Shake to listen — calibrate" available={state.phase === "unavailable" ? false : true}>
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
      <Text style={styles.hint}>{result ?? "Tap one; the last one tapped is used when a shake summons the assistant."}</Text>
      <BuzzTest connected={connected} onChosen={setChosen} />
    </>
  );
}

/**
 * Always listen, kept for development only. Ambient listening was ruled out for
 * the product on 2026-09-20 (all-party consent laws), so it left Settings; the
 * switch stays here so the wake-word path can still be worked on.
 */
function AlwaysListen() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    alwaysListenPref.get().then(setOn);
    return alwaysListenPref.onChange(setOn);
  }, []);
  const toggle = (next: boolean) => {
    if (!next) return void alwaysListenPref.set(false);
    Alert.alert(
      "Always listen (development only)",
      "The microphone stays on in the background and transcribes everything it hears, including other people. This was ruled out for the product on legal grounds; use it only on your own, for testing.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Turn on", style: "destructive", onPress: () => void alwaysListenPref.set(true) },
      ],
    );
  };
  return (
    <View style={styles.toggleRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.itemText}>Always listen</Text>
        <Text style={styles.dim}>Development only. Not in Settings any more.</Text>
      </View>
      <Switch value={on} onValueChange={toggle} trackColor={{ true: colors.danger, false: colors.border }} />
    </View>
  );
}

/**
 * Keeps what Always listen overhears, instead of throwing it away, in the
 * transcripts (Journal → Transcripts). The server refuses it for any account
 * not listed as a development account.
 */
function CaptureEverything() {
  const { token, user, setUser } = useSession();
  const on = !!user?.settings.captureEverything;
  const toggle = async (next: boolean) => {
    try {
      setUser((await api.updateMe(token, { captureEverything: next })).user);
    } catch (err) {
      Alert.alert("Capture everything", err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <View style={styles.toggleRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.itemText}>Capture everything</Text>
        <Text style={styles.dim}>Keep background speech in the transcripts (needs Always listen). Development accounts only.</Text>
      </View>
      <Switch value={on} onValueChange={toggle} trackColor={{ true: colors.danger, false: colors.border }} />
    </View>
  );
}

/**
 * The whole path a reminder takes: the server decides band or notification, sends
 * a push, and the app buzzes. With the band linked this should vibrate; without
 * it, a notification should appear.
 */
function ServerBuzz() {
  const { token } = useSession();
  const [result, setResult] = useState<string | null>(null);
  return (
    <>
      <View style={styles.row}>
        <Pressable
          style={styles.button}
          onPress={async () => {
            setResult("sending…");
            try {
              const r = await api.buzzTest(token);
              setResult(r.reached ? `sent as a ${r.via === "band" ? "silent push for the band" : "notification"}` : "no phone registered for push");
            } catch (err) {
              setResult(err instanceof Error ? err.message : String(err));
            }
          }}
        >
          <Text style={styles.buttonText}>Buzz through the server</Text>
        </Pressable>
      </View>
      {result && <Text style={styles.hint}>{result}</Text>}
    </>
  );
}

/** The clip freezes when commands come too fast, so each option gets this long on its own. */
const BUZZ_TEST_GAP_S = 30;

type BuzzVerdict = { option: clip.BuzzOption; sent: boolean; felt: boolean };

/**
 * Which buzz actually reaches the wrist. The log can only say whether the clip
 * answered, and option 1 often vibrates without answering while another can answer
 * without vibrating, so the only honest test is to fire each one and ask. Every
 * option waits its turn, so the whole test takes about a minute and a half.
 */
function BuzzTest({ connected, onChosen }: { connected: boolean; onChosen: (option: clip.BuzzOption) => void }) {
  const [running, setRunning] = useState(false);
  const [current, setCurrent] = useState<{ option: clip.BuzzOption; sent: boolean } | null>(null);
  const [countdown, setCountdown] = useState(0);
  const [verdicts, setVerdicts] = useState<BuzzVerdict[]>([]);
  const answer = useRef<((felt: boolean) => void) | null>(null);
  const cancelled = useRef(false);

  useEffect(() => () => void (cancelled.current = true), []);

  const run = async () => {
    cancelled.current = false;
    setRunning(true);
    setVerdicts([]);
    const found: BuzzVerdict[] = [];
    for (const { option } of BUZZ_OPTIONS) {
      if (found.length) {
        for (let s = BUZZ_TEST_GAP_S; s > 0 && !cancelled.current; s--) {
          setCountdown(s);
          await wait(1000);
        }
        setCountdown(0);
      }
      if (cancelled.current) break;
      const sent = await clip.buzz(1, option);
      setCurrent({ option, sent });
      const felt = await new Promise<boolean>((resolve) => (answer.current = resolve));
      answer.current = null;
      setCurrent(null);
      found.push({ option, sent, felt });
      setVerdicts([...found]);
      devlog("ble", `buzz test: option ${option} ${sent ? "sent" : "failed"}, felt: ${felt ? "yes" : "no"}`);
    }
    setRunning(false);
    // The first one felt wins. A felt one that also answered is better still, since
    // a timeout costs the command queue its full wait on every buzz.
    const best = found.find((v) => v.felt && v.sent) ?? found.find((v) => v.felt);
    if (best) {
      clip.setBuzzOption(best.option);
      onChosen(best.option);
      devlog("ble", `buzz test: using option ${best.option} from now on`);
    } else if (found.length === BUZZ_OPTIONS.length) {
      devlog("err", "buzz test: none of the three options was felt");
    }
  };

  const stop = () => {
    cancelled.current = true;
    answer.current?.(false);
  };

  const best = verdicts.find((v) => v.felt && v.sent) ?? verdicts.find((v) => v.felt);
  return (
    <>
      <View style={styles.row}>
        <Pressable style={styles.button} disabled={!connected && !running} onPress={running ? stop : run}>
          <Text style={styles.buttonText}>{running ? "Stop buzz test" : "Run buzz test (≈90 s)"}</Text>
        </Pressable>
      </View>
      {!!countdown && <Text style={styles.hint}>Next buzz in {countdown} s — keep the clip on your wrist.</Text>}
      {current && (
        <>
          <Text style={styles.hint}>
            Option {current.option} {current.sent ? "was sent" : "failed to send"}. Did you feel it?
          </Text>
          <View style={styles.row}>
            <Pressable style={styles.button} onPress={() => answer.current?.(true)}>
              <Text style={styles.buttonText}>Felt it</Text>
            </Pressable>
            <Pressable style={styles.button} onPress={() => answer.current?.(false)}>
              <Text style={styles.buttonText}>Nothing</Text>
            </Pressable>
          </View>
        </>
      )}
      {verdicts.map((v) => (
        <Row
          key={v.option}
          label={`option ${v.option}`}
          value={`${v.sent ? "answered" : "no answer"} · ${v.felt ? "felt" : "not felt"}`}
          good={v.felt}
        />
      ))}
      {!running && verdicts.length === BUZZ_OPTIONS.length && (
        <Text style={styles.hint}>
          {best ? `Option ${best.option} is now used for every buzz.` : "None of them was felt. Check the clip is on and charged."}
        </Text>
      )}
    </>
  );
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Each method gets this long to produce a reading; optical sensors take 10-20 s to settle. */
const HEART_LISTEN_S = 30;
/** Quiet time between commands, so the clip isn't sent them back to back. */
const HEART_GAP_MS = 3000;
const HEART_STEPS: { method: ute.HeartRateMethod; label: string }[] = [
  { method: "factory", label: "factory heart-rate test" },
  { method: "measure", label: "one-off measurement" },
];

type HeartVerdict = { method: ute.HeartRateMethod; answered: boolean; readings: number[]; worn: number | null };

/**
 * Does the ES100 have a heart-rate sensor? Its firmware claims the factory heart-rate and
 * blood-oxygen tests (isSupportHeartRateTest), but it also claimed an LED test the clip ignored,
 * so the claim proves nothing. This tries the factory test, then a one-off measurement, and logs
 * every raw packet (device_logs, "heart probe") so a silent clip can be told from a zero reading.
 */
function HeartRateTest({ connected, capabilities }: { connected: boolean; capabilities: Record<string, boolean> | null }) {
  const [running, setRunning] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [latest, setLatest] = useState<string | null>(null);
  const [verdicts, setVerdicts] = useState<HeartVerdict[]>([]);
  const cancelled = useRef(false);

  useEffect(() => () => void (cancelled.current = true), []);

  const run = async () => {
    cancelled.current = false;
    setRunning(true);
    setVerdicts([]);
    setLatest(null);
    const flags = Object.fromEntries(
      Object.entries(capabilities ?? {}).filter(([name]) => /hrm|heart|health|blood|oxygen|spo2/i.test(name)),
    );
    devlog("ble", "heart probe: flags", JSON.stringify(flags));
    let current: HeartVerdict | null = null;
    const found: HeartVerdict[] = [];
    try {
      await clip.beginProbe(
        {
          onMotion: () => {},
          onLog: (line) => {
            if (/App (receive|send)/.test(line)) devlog("ble", "heart probe: packet", line);
          },
          onInput: (input) => {
            if (input.kind !== "heartRate" && input.kind !== "spo2") return;
            setLatest(`${input.value} (${input.detail ?? ""})`);
            if (current && input.value > 0) current.readings.push(input.value);
          },
        },
        "heart probe",
      );
      for (const { method, label } of HEART_STEPS) {
        if (cancelled.current) break;
        current = { method, answered: false, readings: [], worn: null };
        setStep(`Starting the ${label}…`);
        try {
          const reply = await ute.setHeartRate(method, true);
          current.answered = true;
          current.worn = reply.worn ?? null;
          devlog("ble", `heart probe: ${method} on answered`, JSON.stringify(reply));
        } catch (err) {
          devlog("err", `heart probe: ${method} on failed`, err instanceof Error ? err.message : String(err));
        }
        for (let s = HEART_LISTEN_S; s > 0 && !cancelled.current; s--) {
          setStep(`${label}: listening ${s} s — keep the clip against your skin and stay still`);
          await wait(1000);
        }
        if (method !== "measure") await ute.setHeartRate(method, false).catch(logFail("dev-tools: ute.setHeartRate"));
        devlog("ble", `heart probe: ${method} done`, JSON.stringify(current));
        found.push(current);
        setVerdicts([...found]);
        await wait(HEART_GAP_MS);
      }
    } catch (err) {
      Alert.alert("Heart rate test", err instanceof Error ? err.message : String(err));
    } finally {
      await clip.endProbe();
      setStep(null);
      setRunning(false);
    }
    const got = found.filter((v) => v.readings.length);
    devlog(
      got.length ? "ble" : "err",
      got.length
        ? `heart probe: readings from ${got.map((v) => `${v.method} (${v.readings.join(", ")})`).join("; ")}`
        : "heart probe: no heart-rate reading from any method",
    );
  };

  return (
    <>
      <View style={styles.row}>
        <Pressable
          style={styles.button}
          disabled={!connected && !running}
          onPress={running ? () => void (cancelled.current = true) : run}
        >
          <Text style={styles.buttonText}>{running ? "Stop heart rate test" : "Test heart rate (≈70 s)"}</Text>
        </Pressable>
      </View>
      {step && <Text style={styles.hint}>{step}</Text>}
      {latest && <Text style={styles.hint}>Last from the clip: {latest}</Text>}
      {verdicts.map((v) => (
        <Row
          key={v.method}
          label={v.method}
          value={`${v.answered ? "answered" : "no answer"} · ${v.readings.length ? `${v.readings.at(-1)} bpm` : "no reading"}${v.worn != null ? ` · worn ${v.worn}` : ""}`}
          good={v.readings.length > 0}
        />
      ))}
    </>
  );
}

// The ES100's gyroscope sends about one reading a second, so each phase is long enough for a few.
/** Before resting: time to put the phone down (or in the other hand) and let the arm settle. */
const SETTLE_S = 3;
const REST_MS = 5000;
const TWIST_MS = 5000;
/** Readings this soon after the cue are left out of a twist: the user hasn't started yet. */
const REACTION_MS = 700;
const TWISTS = 3;
const TEST_MS = 30_000;

const describeSaved = (p: TwistProfiles) => {
  const saved = [p.spin, p.tilt].filter((x) => !!x).map((x) => describeProfile(x));
  return saved.length ? `saved — ${saved.join("; ")}` : null;
};

const describeReading = (source: string, v: number[]) =>
  source === "gyro3"
    ? `spin ${spinOf(v)}${gyroLive(v) ? "" : " (test off)"} · ${v.slice(0, 3).join(" / ")}`
    : `${v.slice(0, 3).join(" / ")} · |${v[3] ?? "?"}|`;

/** Readings for the log: x/y/z, and for the gyroscope the spin too (as a fourth value). */
const logReadings = (kind: TwistKind | null, samples: Sample[]) =>
  samples.map((s) => (kind === "spin" ? [...s.v.slice(0, 3), spinOf(s.v)] : s.v.slice(0, 3)));

/**
 * Calibrate: settle, hold still 5 s, then three times: hold still, twist back and forth when the
 * phone buzzes; learns what still and a twist look like on the clip's motion sensor. Test: runs the
 * saved detector on live readings for 30 s and uploads them, for tuning.
 */
function TwistCalibration({ connected, problem }: { connected: boolean; problem: string | null }) {
  const [step, setStep] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [testLeft, setTestLeft] = useState(0);
  const [reading, setReading] = useState<string | null>(null);
  const [hits, setHits] = useState<string[]>([]);
  const stopTest = useRef<(() => void) | null>(null);

  useEffect(() => {
    twistProfilePref.get().then((p) => setResult(describeSaved(p)));
    return () => stopTest.current?.();
  }, []);

  /** Waits for motion to stream (the caller is subscribed); returns where it comes from. */
  const findMotion = async () => {
    const source = await clip.waitForMotion(30_000);
    const kind = twistKind(source);
    if (source && kind) return { kind, source };
    const { motionProblem, recording } = clip.getClipState();
    if (recording) throw new Error("The clip is recording. Stop it first: motion waits while it records.");
    throw new Error(motionProblem ?? "The clip sent no motion data.");
  };

  const run = async () => {
    let bucket: Sample[] = [];
    const off = clip.subscribeMotion((samples) => bucket.push(...samples));
    twistProfilePref.calibrating = true;
    setResult(null);
    let kind: TwistKind | null = null;
    const rest: Sample[] = [];
    const twists: Sample[][] = [];
    try {
      setStep("Finding the clip's motion sensor…");
      const found = await findMotion();
      kind = found.kind;
      const source = found.source;
      for (let s = SETTLE_S; s > 0; s--) {
        setStep(`Put the phone down or in your other hand, and rest your forearm on a table or your leg… ${s}`);
        await wait(1000);
      }
      setStep("Hold your wrist completely still…");
      bucket = [];
      await wait(REST_MS);
      rest.push(...bucket);
      for (let i = 1; i <= TWISTS; i++) {
        setStep(`Hold still… (${i}/${TWISTS})`);
        await wait(2000);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(logFail("dev-tools: Haptics.notificationAsync"));
        setStep(`Shake your wrist hard, back and forth, now! (${i}/${TWISTS})`);
        await wait(REACTION_MS);
        bucket = [];
        await wait(TWIST_MS - REACTION_MS);
        twists.push(bucket);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(logFail("dev-tools: Haptics.impactAsync"));
      }
      const { profile, note } = calibrate(kind, rest, twists);
      await twistProfilePref.set(profile);
      setResult(`saved — ${describeProfile(profile)}${note ? `\n${note}` : ""}`);
      devlog(
        "ble",
        "twist calibrated",
        JSON.stringify({ source, profile, note, rest: logReadings(kind, rest), twists: twists.map((t) => logReadings(kind, t)) }),
      );
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      setResult(`failed: ${why}`);
      devlog(
        "err",
        "twist calibration failed",
        JSON.stringify({ why, rest: logReadings(kind, rest), twists: twists.map((t) => logReadings(kind, t)) }),
      );
    } finally {
      twistProfilePref.calibrating = false;
      off();
      setStep(null);
    }
  };

  const test = async () => {
    // Counts as running from the tap, so a second tap can't start another.
    setTestLeft(TEST_MS / 1000);
    const profiles = await twistProfilePref.get();
    if (!profiles.spin && !profiles.tilt) {
      setTestLeft(0);
      return setResult("Calibrate first.");
    }
    const detectors = new Map<TwistKind, (s: Sample) => void>();
    const began = Date.now();
    // Everything the test saw, uploaded at the end for tuning: [ms since start, x, y, z(, spin)].
    const readings: number[][] = [];
    const detected: { ms: number; why: string }[] = [];
    let seen: string | null = null;
    setHits([]);
    setReading("waiting for motion…");
    // The assistant's own detector stays out of it while testing.
    twistProfilePref.calibrating = true;
    const off = clip.subscribeMotion((samples, source) => {
      seen = source;
      const kind = twistKind(source);
      const profile = kind && profiles[kind];
      if (!kind || !profile) return setReading(`${source}: not calibrated for this sensor`);
      let detect = detectors.get(kind);
      if (!detect) {
        detect = createTwistDetector(profile, (why) => {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(logFail("dev-tools: Haptics.notificationAsync"));
          setHits((h) => [`${new Date().toLocaleTimeString()}  ${why}`, ...h].slice(0, 6));
          detected.push({ ms: Date.now() - began, why });
        });
        detectors.set(kind, detect);
      }
      for (const s of samples) {
        setReading(describeReading(source, s.v));
        readings.push([Math.round((s.t - began) / 100) * 100, ...logReadings(kind, [s])[0]]);
        detect(s);
      }
    });
    if (!clip.getClipState().motion.on) clip.retryMotion();
    const timer = setInterval(() => {
      const left = Math.ceil((TEST_MS - (Date.now() - began)) / 1000);
      if (left > 0) setTestLeft(left);
      else finish();
    }, 500);
    const finish = () => {
      clearInterval(timer);
      off();
      twistProfilePref.calibrating = false;
      stopTest.current = null;
      setTestLeft(0);
      devlog(
        "ble",
        `twist test: ${detected.length} detected in ${Math.round((Date.now() - began) / 1000)} s`,
        JSON.stringify({ source: seen, profiles, detected, readings }),
      );
    };
    stopTest.current = finish;
  };

  const idle = connected && !step && !testLeft;
  return (
    <>
      {problem && <Text style={styles.hint}>No motion data from this clip right now ({problem}); its button summons the assistant instead.</Text>}
      <Text style={styles.hint}>
        The twist: hold your wrist still for a moment, then twist it back and forth for about 2 s. Calibration asks for
        that three times, after 5 s of resting your forearm on a table or your leg. The test uploads what it saw.
      </Text>
      <View style={styles.row}>
        <Pressable style={styles.button} disabled={!idle} onPress={run}>
          <Text style={styles.buttonText}>{step ?? "Calibrate shake"}</Text>
        </Pressable>
        <Pressable style={styles.button} disabled={!idle && !testLeft} onPress={() => (testLeft ? stopTest.current?.() : test())}>
          <Text style={styles.buttonText}>{testLeft ? `Stop test (${testLeft} s)` : "Test shake (30 s)"}</Text>
        </Pressable>
      </View>
      {!!testLeft && <Row label="reading" value={reading ?? "—"} mono />}
      {hits.map((hit, i) => (
        <Row key={i} label="twist" value={hit} mono />
      ))}
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
  turn: { paddingVertical: 6, borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth, gap: 2 },
  turnHead: { color: colors.text, fontSize: 13, fontWeight: "600" },
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
