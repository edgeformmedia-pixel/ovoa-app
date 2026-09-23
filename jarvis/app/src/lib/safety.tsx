import * as Haptics from "expo-haptics";
import { useOptionalContext, useProviderLog } from "./context";
import { devlog, logFail } from "./devlog";
import * as Location from "expo-location";
import * as SMS from "expo-sms";
import { createContext, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, Linking } from "react-native";
import { api, type Contact } from "./api";
import { useSession } from "./auth";

export const EMERGENCY_NUMBER = "911";

type SafetyState = {
  contacts: Contact[] | null;
  setContacts: (contacts: Contact[]) => void;
  /** The SOS button: opens a text to the emergency contacts with the location, straight away. */
  sos: () => void;
};

const SafetyContext = createContext<SafetyState | null>(null);

/**
 * What useSafety gives a screen with no provider above it. `sos` shouting
 * into the log is the point: a Safety tab that throws can't call for help
 * either, so a live screen that records the failure beats a dead one.
 */
const NO_SAFETY: SafetyState = {
  contacts: null,
  setContacts: () => {},
  sos: () => devlog("err", "safety: sos with no SafetyProvider — nobody was alerted"),
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
  const contactsRef = useRef<Contact[]>([]);
  contactsRef.current = contacts ?? [];

  useEffect(() => {
    api.contacts(token).then((r) => setContacts(r.contacts)).catch(() => setContacts([]));
  }, [token]);

  const alertContacts = useCallback(async () => {
    const location = await currentLocation();
    api.logSafetyEvent(token, { kind: "sos", status: "alerted", ...location }).catch(logFail("safety: api.logSafetyEvent"));

    const list = contactsRef.current;
    // An account from Sign in with Apple can have no name yet.
    const name = user?.name?.trim() || "Your contact";
    const where = location
      ? ` Location: https://maps.apple.com/?ll=${location.latitude},${location.longitude}`
      : "";
    const message = `EMERGENCY: ${name} pressed their SOS button. Please check on them now.${where}`;

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
  }, [token, user?.name]);

  const sos = useCallback(() => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(logFail("safety: Haptics.notificationAsync"));
    void alertContacts();
  }, [alertContacts]);

  return <SafetyContext.Provider value={{ contacts, setContacts, sos }}>{children}</SafetyContext.Provider>;
}
