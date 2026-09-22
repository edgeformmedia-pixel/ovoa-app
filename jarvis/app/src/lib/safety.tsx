import * as Haptics from "expo-haptics";
import { useOptionalContext, useProviderLog } from "./context";
import { devlog, logFail } from "./devlog";
import * as Location from "expo-location";
import { Accelerometer } from "expo-sensors";
import * as SMS from "expo-sms";
import { createContext, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, Linking, Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { api, type Contact } from "./api";
import { useSession } from "./auth";
import { buzzPattern } from "./buzz";
import { createFallDetector } from "./fallDetector";
import { createSpeaker } from "./voice";
import { colors } from "./theme";

const FALL_COUNTDOWN_S = 30;
export const EMERGENCY_NUMBER = "911";

type Kind = "fall" | "sos";
export type DetectorStatus = "off" | "starting" | "on" | "unavailable" | "denied";

type SafetyState = {
  contacts: Contact[] | null;
  setContacts: (contacts: Contact[]) => void;
  /** Starts the "are you OK?" countdown (fall) or alerts immediately (sos). */
  trigger: (kind: Kind) => void;
  detectorStatus: DetectorStatus;
};

const SafetyContext = createContext<SafetyState | null>(null);

/**
 * What useSafety gives a screen with no provider above it. `trigger` shouting
 * into the log is the point: a Safety tab that throws can't call for help
 * either, so a live screen that records the failure beats a dead one.
 */
const NO_SAFETY: SafetyState = {
  contacts: null,
  setContacts: () => {},
  trigger: (kind) => devlog("err", `safety: ${kind} with no SafetyProvider — nobody was alerted`),
  detectorStatus: "off",
};

export function useSafety() {
  return useOptionalContext(SafetyContext, "useSafety", NO_SAFETY);
}

async function currentLocation() {
  try {
    const { granted } = await Location.requestForegroundPermissionsAsync();
    if (!granted) return null;
    const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
    return { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
  } catch {
    return null;
  }
}

export function SafetyProvider({ children }: { children: ReactNode }) {
  const { token, user } = useSession();
  useProviderLog("safety");
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [pending, setPending] = useState<Kind | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(FALL_COUNTDOWN_S);
  const [detectorStatus, setDetectorStatus] = useState<DetectorStatus>("off");
  const contactsRef = useRef<Contact[]>([]);
  contactsRef.current = contacts ?? [];

  useEffect(() => {
    api.contacts(token).then((r) => setContacts(r.contacts)).catch(() => setContacts([]));
  }, [token]);

  const alertContacts = useCallback(
    async (kind: Kind) => {
      setPending(null);
      const location = await currentLocation();
      api.logSafetyEvent(token, { kind, status: "alerted", ...location }).catch(logFail("safety: api.logSafetyEvent"));

      const list = contactsRef.current;
      const name = user?.name ?? "Your contact";
      const what = kind === "fall" ? "may have fallen and did not respond" : "pressed their SOS button";
      const where = location
        ? ` Location: https://maps.apple.com/?ll=${location.latitude},${location.longitude}`
        : "";
      const message = `EMERGENCY: ${name} ${what}. Please check on them now.${where}`;

      if (list.length && (await SMS.isAvailableAsync())) {
        // iOS never sends silently: this opens Messages and the user must tap Send.
        await SMS.sendSMSAsync(list.map((c) => c.phone), message);
      } else {
        Alert.alert(
          "No emergency contacts",
          `Add contacts in the Safety tab. Call ${EMERGENCY_NUMBER} if you need help.`,
          [
            { text: "Close", style: "cancel" },
            { text: `Call ${EMERGENCY_NUMBER}`, onPress: () => Linking.openURL(`tel:${EMERGENCY_NUMBER}`) },
          ],
        );
      }
    },
    [token, user?.name],
  );

  const trigger = useCallback(
    (kind: Kind) => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(logFail("safety: Haptics.notificationAsync"));
      if (kind === "sos") {
        void alertContacts("sos");
        return;
      }
      setSecondsLeft(FALL_COUNTDOWN_S);
      setPending("fall");
      // The wrist and the speaker too (F33): a fall is exactly when the phone may be out of reach.
      void buzzPattern("urgent", "Did you fall? Open OVOA and tap I'm OK.");
      createSpeaker(token)
        .speak(`Are you OK? If I don't hear from you in ${FALL_COUNTDOWN_S} seconds, I'll text your emergency contacts.`)
        .catch(logFail("safety: speak"));
    },
    [alertContacts, token],
  );

  // Countdown with a buzz every second so it is noticed.
  useEffect(() => {
    if (pending !== "fall") return;
    if (secondsLeft <= 0) {
      void alertContacts("fall");
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(logFail("safety: Haptics.impactAsync"));
    const t = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [pending, secondsLeft, alertContacts]);

  const imOk = () => {
    setPending(null);
    api.logSafetyEvent(token, { kind: "fall", status: "ok" }).catch(logFail("safety: api.logSafetyEvent"));
  };

  // Fall detection runs while the app is open (Expo Go cannot run it in the background).
  const enabled = !!user?.settings.fallDetection;
  useEffect(() => {
    if (!enabled) {
      setDetectorStatus("off");
      return;
    }
    setDetectorStatus("starting");
    let sub: { remove: () => void } | undefined;
    let cancelled = false;
    (async () => {
      if (Platform.OS === "web" || !(await Accelerometer.isAvailableAsync())) {
        if (!cancelled) setDetectorStatus("unavailable");
        return;
      }
      const { granted } = await Accelerometer.requestPermissionsAsync();
      if (cancelled) return;
      if (!granted) {
        setDetectorStatus("denied");
        return;
      }
      const detect = createFallDetector(() => trigger("fall"));
      Accelerometer.setUpdateInterval(20);
      sub = Accelerometer.addListener((s) => detect(s, Date.now()));
      setDetectorStatus("on");
    })();
    return () => {
      cancelled = true;
      sub?.remove();
    };
  }, [enabled, trigger]);

  return (
    <SafetyContext.Provider value={{ contacts, setContacts, trigger, detectorStatus }}>
      {children}
      <Modal visible={pending === "fall"} animationType="fade" transparent={false}>
        <View style={styles.modal}>
          <Text style={styles.heading}>Did you fall?</Text>
          <Text style={styles.body}>
            {contactsRef.current.length
              ? "If you don't respond, we'll open a message to your emergency contacts with your location."
              : "You have no emergency contacts yet."}
          </Text>
          <Text style={styles.count}>{secondsLeft}</Text>
          <Pressable style={[styles.btn, styles.okBtn]} onPress={imOk}>
            <Text style={styles.okText}>I'm OK</Text>
          </Pressable>
          <Pressable style={[styles.btn, styles.helpBtn]} onPress={() => alertContacts("fall")}>
            <Text style={styles.helpText}>Alert my contacts now</Text>
          </Pressable>
          <Pressable
            style={[styles.btn, styles.callBtn]}
            onPress={() => {
              setPending(null);
              Linking.openURL(`tel:${EMERGENCY_NUMBER}`);
            }}
          >
            <Text style={styles.helpText}>Call {EMERGENCY_NUMBER}</Text>
          </Pressable>
        </View>
      </Modal>
    </SafetyContext.Provider>
  );
}

const styles = StyleSheet.create({
  modal: {
    flex: 1,
    backgroundColor: "#2a0509",
    alignItems: "center",
    justifyContent: "center",
    padding: 28,
    gap: 16,
  },
  heading: { color: "#fff", fontSize: 34, fontWeight: "800" },
  body: { color: "#ffd5d9", fontSize: 16, textAlign: "center", lineHeight: 22 },
  count: { color: "#fff", fontSize: 96, fontWeight: "800", marginVertical: 8, fontVariant: ["tabular-nums"] },
  btn: { alignSelf: "stretch", borderRadius: 16, paddingVertical: 18, alignItems: "center" },
  okBtn: { backgroundColor: "#fff" },
  okText: { color: "#2a0509", fontSize: 20, fontWeight: "800" },
  helpBtn: { backgroundColor: colors.stop },
  callBtn: { backgroundColor: "transparent", borderWidth: 2, borderColor: colors.stop },
  helpText: { color: "#fff", fontSize: 17, fontWeight: "700" },
});
