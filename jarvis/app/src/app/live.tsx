import * as Location from "expo-location";
import { useFocusEffect } from "expo-router";
import { Barometer, Pedometer } from "expo-sensors";
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import * as ute from "../../modules/ute-ble";
import * as clip from "../lib/clip";
import { devlog, logFail } from "../lib/devlog";
import { healthAvailable, todayHealth } from "../lib/health";
import { setLiveHeart } from "../lib/heart";
import { colors } from "../lib/theme";

// Everything the phone and the band know right now, live: heart rate from the
// band's own sensor (about once a second while this screen is open), exact
// position, altitude, the street and city, speed and heading, air pressure, and
// today's steps. Nothing here is sent anywhere; it's read on the phone.

/** The band's heart-rate test repeats a stale value while it settles; readings this early are skipped. */
const HEART_SETTLE_MS = 9_000;

type Place = { street: string | null; city: string | null; region: string | null; postal: string | null; country: string | null };

export default function Live() {
  const band = clip.useClip();
  const linked = band.phase === "connected";
  const [bpm, setBpm] = useState<{ value: number; at: number; from: "band" | "health" } | null>(null);
  const [pos, setPos] = useState<Location.LocationObject | null>(null);
  const [place, setPlace] = useState<Place | null>(null);
  const [locError, setLocError] = useState<string | null>(null);
  const [baro, setBaro] = useState<{ pressure: number; relativeAltitude?: number } | null>(null);
  const [steps, setSteps] = useState<number | null>(null);
  const lastGeocode = useRef<{ at: number; lat: number; lng: number } | null>(null);

  // Heart rate: live from the band while linked, otherwise the latest from Health.
  useFocusEffect(
    useCallback(() => {
      let stopped = false;
      const started = Date.now();
      const off = clip.onHeartRate((value) => {
        if (stopped || Date.now() - started < HEART_SETTLE_MS) return;
        setBpm({ value, at: Date.now(), from: "band" });
      });
      if (linked) {
        setLiveHeart(true);
        ute.setHeartRate("factory", true).catch((err) => devlog("err", "live heart rate: the clip didn't start", String(err)));
      } else if (healthAvailable) {
        todayHealth()
          .then((h) => h.heartRate && !stopped && setBpm({ value: h.heartRate.bpm, at: h.heartRate.at, from: "health" }))
          .catch(logFail("live: setBpm"));
      }
      return () => {
        stopped = true;
        off();
        if (linked) {
          ute.setHeartRate("factory", false).catch(logFail("live: ute.setHeartRate"));
          setLiveHeart(false);
        }
      };
    }, [linked]),
  );

  // Position, as precise as the phone can get it, with the street and city.
  useFocusEffect(
    useCallback(() => {
      let sub: Location.LocationSubscription | null = null;
      let alive = true;
      (async () => {
        const { granted } = await Location.requestForegroundPermissionsAsync();
        if (!granted) return setLocError("Location is off for OVOA. Allow it in iPhone Settings.");
        sub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 0 },
          (p) => {
            if (!alive) return;
            setPos(p);
            const last = lastGeocode.current;
            const moved = last ? Math.hypot(p.coords.latitude - last.lat, p.coords.longitude - last.lng) * 111_000 : Infinity;
            if (!last || Date.now() - last.at > 20_000 || moved > 30) {
              lastGeocode.current = { at: Date.now(), lat: p.coords.latitude, lng: p.coords.longitude };
              Location.reverseGeocodeAsync({ latitude: p.coords.latitude, longitude: p.coords.longitude })
                .then(([hit]) => {
                  if (!alive || !hit) return;
                  setPlace({
                    street: [hit.streetNumber, hit.street].filter(Boolean).join(" ") || hit.name || null,
                    city: hit.city ?? hit.subregion ?? null,
                    region: hit.region ?? null,
                    postal: hit.postalCode ?? null,
                    country: hit.country ?? null,
                  });
                })
                .catch(logFail("live: call"));
            }
          },
        );
      })().catch((err) => setLocError(String(err)));
      return () => {
        alive = false;
        sub?.remove();
      };
    }, []),
  );

  // Air pressure (and the barometer's own altitude change), and today's steps.
  useEffect(() => {
    if (Platform.OS === "web") return;
    Barometer.setUpdateInterval(1000);
    const b = Barometer.addListener(setBaro);
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    let base = 0;
    Pedometer.getStepCountAsync(midnight, new Date())
      .then((r) => {
        base = r.steps;
        setSteps(r.steps);
      })
      .catch(logFail("live: setSteps"));
    const p = Pedometer.watchStepCount((r) => setSteps(base + r.steps));
    return () => {
      b.remove();
      p.remove();
    };
  }, []);

  const c = pos?.coords;
  const age = (at: number) => {
    const s = Math.round((Date.now() - at) / 1000);
    return s < 5 ? "live" : s < 60 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={[styles.card, { alignItems: "center" }]}>
        <Text style={styles.label}>HEART RATE</Text>
        <Text style={styles.big}>{bpm ? bpm.value : "—"}</Text>
        <Text style={styles.dim}>
          {bpm
            ? `bpm · ${bpm.from === "band" ? "from the band" : "from Apple Health"} · ${age(bpm.at)}`
            : linked
              ? "Reading from the band… keep it against your skin."
              : "Link the band for live heart rate."}
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>WHERE YOU ARE</Text>
        {locError && <Text style={styles.error}>{locError}</Text>}
        <Row label="Street" value={place?.street ?? "—"} />
        <Row label="City" value={[place?.city, place?.region].filter(Boolean).join(", ") || "—"} />
        <Row label="Postcode" value={place?.postal ?? "—"} />
        <Row label="Country" value={place?.country ?? "—"} />
        <Row label="Latitude" value={c ? c.latitude.toFixed(6) : "—"} mono />
        <Row label="Longitude" value={c ? c.longitude.toFixed(6) : "—"} mono />
        <Row label="Accuracy" value={c?.accuracy != null ? `± ${c.accuracy.toFixed(0)} m` : "—"} />
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>ALTITUDE AND MOVEMENT</Text>
        <Row
          label="Altitude"
          value={c?.altitude != null ? `${c.altitude.toFixed(1)} m (${(c.altitude * 3.281).toFixed(0)} ft)` : "—"}
        />
        <Row label="Altitude accuracy" value={c?.altitudeAccuracy != null ? `± ${c.altitudeAccuracy.toFixed(0)} m` : "—"} />
        <Row label="Speed" value={c?.speed != null && c.speed >= 0 ? `${(c.speed * 3.6).toFixed(1)} km/h (${(c.speed * 2.237).toFixed(1)} mph)` : "—"} />
        <Row label="Heading" value={c?.heading != null && c.heading >= 0 ? `${c.heading.toFixed(0)}° ${compass(c.heading)}` : "—"} />
        <Row label="Air pressure" value={baro ? `${baro.pressure.toFixed(1)} hPa` : "—"} />
        <Row label="Barometer altitude change" value={baro?.relativeAltitude != null ? `${baro.relativeAltitude.toFixed(2)} m` : "—"} />
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>TODAY AND THE BAND</Text>
        <Row label="Steps today" value={steps != null ? steps.toLocaleString() : "—"} />
        <Row label="Band" value={linked ? `linked${band.device?.name ? ` · ${band.device.name}` : ""}` : "not linked"} />
        <Row label="Band battery" value={band.battery ? `${band.battery.percent}%${band.battery.charging ? " · charging" : ""}` : "—"} />
        <Row label="Band signal" value={band.rssi != null ? `${band.rssi} dBm` : "—"} />
      </View>
    </ScrollView>
  );
}

const compass = (deg: number) => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8];

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.dim}>{label}</Text>
      <Text style={[styles.value, mono && styles.mono]} selectable>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  content: { padding: 16, gap: 12, paddingBottom: 40 },
  card: { backgroundColor: colors.wash, borderColor: colors.line, borderWidth: 1, borderRadius: 16, padding: 16, gap: 6 },
  label: { color: colors.inkMute, fontSize: 12, fontWeight: "600", letterSpacing: 1, marginBottom: 4 },
  big: { color: colors.stop, fontSize: 64, fontWeight: "800", fontVariant: ["tabular-nums"] },
  dim: { color: colors.inkMute, fontSize: 13 },
  value: { color: colors.ink, fontSize: 15, flexShrink: 1, textAlign: "right" },
  mono: { fontFamily: "Menlo", fontSize: 14 },
  row: { flexDirection: "row", justifyContent: "space-between", gap: 12, paddingVertical: 3 },
  error: { color: colors.stop },
});
