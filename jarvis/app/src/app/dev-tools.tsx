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
import { Platform, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { createFallDetector } from "../lib/fallDetector";
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
