import * as Haptics from "expo-haptics";
import * as SMS from "expo-sms";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Linking, StyleSheet, Text, View } from "react-native";
import { api, type TextingState } from "../lib/api";
import { logFail } from "../lib/devlog";
import { colors, space, type } from "../lib/theme";
import { Btn } from "./ui";

/** How often, and for how long, it looks for their text once Messages has it. */
const POLL_MS = 2_500;
const WAIT_MS = 3 * 60_000;

/** "+15865550100" as "+1 (586) 555-0100"; anything else as it is. */
export function formatPhone(phone: string) {
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(phone);
  return us ? `+1 (${us[1]}) ${us[2]}-${us[3]}` : phone;
}

/**
 * Text OVOA from Messages (api/src/texting.ts, docs/texting.md): the same
 * OVOA, with the same memories, lists, reminders, apps and Google, answering
 * by text. Linking is one text: the server makes a code, this puts it in a
 * message to OVOA's number, they tap Send, and the number the text came from
 * is theirs. Hidden until the server has its Sendblue keys.
 */
export function TextingSetup({ token, assistantName }: { token: string; assistantName: string }) {
  const [state, setState] = useState<TextingState | null>(null);
  const [busy, setBusy] = useState(false);
  // While waiting for their text: when it started, and the link it's waiting on.
  const [waiting, setWaiting] = useState<{ since: number; before: number | null; number: string; body: string } | null>(null);
  const [missed, setMissed] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    api
      .texting(token)
      .then((s) => alive.current && setState(s))
      .catch(logFail("TextingSetup: api.texting"));
    return () => {
      alive.current = false;
    };
  }, [token]);

  // Looks for the link their text made, until it's there or WAIT_MS have gone.
  useEffect(() => {
    if (!waiting) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const look = async () => {
      if (stopped) return;
      try {
        const s = await api.texting(token);
        if (stopped) return;
        if (s.linked && s.linked.linkedAt !== waiting.before) {
          setState(s);
          setWaiting(null);
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(logFail("TextingSetup: haptics"));
          return;
        }
      } catch {
        // No signal for a moment: look again.
      }
      if (Date.now() - waiting.since > WAIT_MS) {
        setWaiting(null);
        setMissed(true);
        return;
      }
      timer = setTimeout(look, POLL_MS);
    };
    timer = setTimeout(look, POLL_MS);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [waiting, token]);

  /** Opens the text with the code in it: in the app when it can, in Messages when it can't. */
  const compose = useCallback(async (number: string, body: string) => {
    if (await SMS.isAvailableAsync()) {
      const { result } = await SMS.sendSMSAsync([number], body);
      return result !== "cancelled";
    }
    await Linking.openURL(`sms:${number}&body=${encodeURIComponent(body)}`);
    return true;
  }, []);

  const link = async () => {
    setBusy(true);
    setMissed(false);
    try {
      const r = await api.textingLink(token);
      const before = state?.linked?.linkedAt ?? null;
      if (await compose(r.number, r.body)) setWaiting({ since: Date.now(), before, number: r.number, body: r.body });
    } catch (err) {
      Alert.alert("Couldn't start linking", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const unlink = () =>
    Alert.alert("Unlink this number?", `Texts from it won't reach ${assistantName} any more. You can link it again here.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Unlink",
        style: "destructive",
        onPress: async () => {
          try {
            await api.textingUnlink(token);
            setState((s) => (s ? { ...s, linked: null } : s));
          } catch (err) {
            Alert.alert("Couldn't unlink", err instanceof Error ? err.message : String(err));
          }
        },
      },
    ]);

  if (!state?.available || !state.number) return null;
  const number = state.number;

  return (
    <View style={{ gap: 10 }}>
      <Text style={styles.sub}>Text {assistantName}</Text>
      {state.linked ? (
        <>
          <Text style={styles.meta}>
            Linked to {formatPhone(state.linked.phone)}. Text {formatPhone(number)} from Messages, like texting a friend: it's
            the same {assistantName}, with what it remembers from here, your reminders, notes, lists and apps, and your Google
            account.
          </Text>
          <Btn label={`Text ${assistantName}`} onPress={() => void Linking.openURL(`sms:${number}`)} style={styles.left} />
          <Btn label="Unlink this number" kind="quiet" onPress={unlink} style={styles.left} />
        </>
      ) : waiting ? (
        <>
          <Text style={styles.meta}>
            Send the text that opened: it has a code in it that proves the number is yours. This checks for it for three
            minutes.
          </Text>
          <View style={styles.row}>
            <ActivityIndicator color={colors.now} />
            <Text style={styles.label}>Waiting for your text…</Text>
          </View>
          <Btn label="Open the text again" onPress={() => void compose(waiting.number, waiting.body).catch(logFail("TextingSetup: compose"))} style={styles.left} />
          <Btn label="Cancel" kind="quiet" onPress={() => setWaiting(null)} style={styles.left} />
        </>
      ) : (
        <>
          <Text style={styles.meta}>
            Text {assistantName} from Messages, like texting a friend. It's the same {assistantName}: it remembers what you
            talk about here and can use your reminders, notes, lists, apps and Google. Texts go through Sendblue, the service
            that carries {assistantName}'s messages, and only iMessage is answered.
          </Text>
          {missed && <Text style={[styles.meta, { color: colors.late }]}>Your text didn't arrive. Try again?</Text>}
          <Btn label="Link my number" kind="go" busy={busy} onPress={() => void link()} style={styles.left} />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // The same as a heading inside a Settings group (settings.tsx Sub).
  sub: { ...type.meta, fontWeight: "600", color: colors.inkMute, marginTop: space.s3 },
  meta: { ...type.meta, color: colors.inkMute },
  label: { ...type.body, color: colors.ink },
  row: { flexDirection: "row", alignItems: "center", gap: space.s2 },
  left: { alignSelf: "flex-start" },
});
