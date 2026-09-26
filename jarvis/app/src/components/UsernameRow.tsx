import { useEffect, useRef, useState } from "react";
import { Alert, StyleSheet, Text, TextInput, View } from "react-native";
import { api, type UsernameState } from "../lib/api";
import { useSession } from "../lib/auth";
import { logFail } from "../lib/devlog";
import { colors, space, type } from "../lib/theme";
import { Btn } from "./ui";

/** How long typing has to pause before it's checked. */
const CHECK_AFTER_MS = 400;

/** What they typed as a username: "@Tom L" is "tom-l", as the server reads it (usernames.ts usernameFrom). */
const asUsername = (typed: string) =>
  typed
    .trim()
    .replace(/^@+/, "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);

/**
 * Their @username (api/src/usernames.ts), Settings → Account: their websites'
 * address (<name>.ovoa.ai) and how other people's OVOAs find theirs. Checked
 * as they type, then set; it can change once every 30 days.
 */
export function UsernameRow() {
  const { token, refreshUser } = useSession();
  const [state, setState] = useState<UsernameState | null>(null);
  const [typed, setTyped] = useState("");
  const [check, setCheck] = useState<{ for: string; available: boolean; problem?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    api
      .username(token)
      .then((s) => {
        if (!alive.current) return;
        setState(s);
        setTyped(s.username ?? s.suggestion ?? "");
      })
      .catch(logFail("UsernameRow: api.username"));
    return () => {
      alive.current = false;
    };
  }, [token]);

  const wanted = asUsername(typed);
  useEffect(() => {
    if (!state || !wanted || wanted === state.username) return setCheck(null);
    const timer = setTimeout(() => {
      api
        .checkUsername(token, wanted)
        .then((r) => alive.current && setCheck({ for: wanted, available: r.available, problem: r.problem }))
        .catch(logFail("UsernameRow: api.checkUsername"));
    }, CHECK_AFTER_MS);
    return () => clearTimeout(timer);
  }, [wanted, state, token]);

  if (!state) return null;
  const locked = !!state.changeableAt && state.changeableAt > Date.now();
  const checked = check?.for === wanted ? check : null;

  const save = () => {
    const go = async () => {
      setSaving(true);
      try {
        const r = await api.setUsername(token, wanted);
        setState({ username: r.username, address: r.address, changeableAt: r.changeableAt, suggestion: null });
        setCheck(null);
        await refreshUser();
      } catch (err) {
        Alert.alert("Couldn't set it", err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    };
    if (!state.username) return void go();
    Alert.alert(
      `Change to @${wanted}?`,
      `Your websites move to ${wanted}.ovoa.ai, and ${state.username}.ovoa.ai sends visitors there for 90 days. You can change it again in 30 days.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Change", onPress: () => void go() },
      ],
    );
  };

  return (
    <View style={{ gap: 6 }}>
      <Text style={styles.label}>Username</Text>
      <View style={styles.inputRow}>
        <Text style={styles.at}>@</Text>
        <TextInput
          style={styles.input}
          value={typed}
          onChangeText={setTyped}
          editable={!locked}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="yourname"
          placeholderTextColor={colors.inkMute}
          accessibilityLabel="Username"
        />
      </View>
      <Text style={[styles.meta, checked && !checked.available && { color: colors.stop }]}>
        {locked
          ? `Your websites live at ${state.address}. You can change it on ${new Date(state.changeableAt!).toLocaleDateString()}.`
          : checked
            ? checked.available
              ? `@${wanted} is free. Your websites would live at ${wanted}.ovoa.ai.`
              : checked.problem
            : state.username
              ? `Your websites live at ${state.address}, and other people's OVOAs find yours as @${state.username}.`
              : "Your websites will live at yourname.ovoa.ai, and other people's OVOAs find yours by it."}
      </Text>
      {!locked && wanted !== state.username && (
        <Btn
          label={state.username ? "Change username" : "Set username"}
          onPress={save}
          busy={saving}
          disabled={!wanted || !checked?.available}
          style={styles.btn}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  label: { ...type.body, color: colors.ink },
  meta: { ...type.meta, color: colors.inkMute },
  btn: { alignSelf: "flex-start" },
  inputRow: { flexDirection: "row", alignItems: "center", backgroundColor: colors.wash, borderRadius: 14, paddingLeft: space.s3 },
  at: { ...type.body, color: colors.inkMute },
  input: { flex: 1, color: colors.ink, ...type.body, paddingHorizontal: space.s1, paddingVertical: space.s3 },
});
