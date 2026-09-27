import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
  type KeyboardTypeOptions,
} from "react-native";
import { Btn, Empty, GroupLabel, IconTile, Screen, type IconName, type Tone } from "../components/ui";
import { api, type ApprovalRule, type RuleKind } from "../lib/api";
import { useSession } from "../lib/auth";
import { logFail } from "../lib/devlog";
import { colors, space, type } from "../lib/theme";

// Standing approvals (api/src/rules.ts): the middle ground between asking every
// time and Approve for me. A rule lets one kind of action (email, text, call,
// calendar) go without asking, for one recipient or for anyone. The server
// never lets a rule cover deleting, money, or anything OVOA starts on its own.
// Rules can also be made by saying so ("don't ask before emailing Sam").
// Settings, Assistant, "When it acts for you" opens it.

const KINDS: Record<
  RuleKind,
  {
    label: string;
    icon: IconName;
    tone: Tone;
    to: (who: string) => string;
    anyone: string;
    placeholder: string;
    keyboard: KeyboardTypeOptions;
    empty: string;
  }
> = {
  email: {
    label: "Email",
    icon: "mail-outline",
    tone: "blue",
    to: (who) => `Emails to ${who}`,
    anyone: "Emails to anyone",
    placeholder: "Their email address",
    keyboard: "email-address",
    empty: "Leave it empty for anyone.",
  },
  text: {
    label: "Text",
    icon: "chatbubble-outline",
    tone: "green",
    to: (who) => `Texts to ${who}`,
    anyone: "Texts to anyone",
    placeholder: "Their number or contact name",
    keyboard: "default",
    empty: "Leave it empty for anyone.",
  },
  call: {
    label: "Call",
    icon: "call-outline",
    tone: "pink",
    to: (who) => `Calls to ${who}`,
    anyone: "Calls to anyone",
    placeholder: "Their number or contact name",
    keyboard: "default",
    empty: "Leave it empty for anyone.",
  },
  calendar: {
    label: "Calendar",
    icon: "calendar-outline",
    tone: "amber",
    to: (who) => `Calendar events with ${who}`,
    anyone: "Calendar events with no guests",
    placeholder: "A guest's email address",
    keyboard: "email-address",
    empty: "Leave it empty for events with no guests. Events with guests send them an invite, so each guest needs their own rule.",
  },
};

const ORDER: RuleKind[] = ["email", "text", "call", "calendar"];

/** Before a rule for anyone: it's a big one, so it's said out loud first. Calendar is only events with no guests. */
const ANYONE: Partial<Record<RuleKind, { title: string; body: string }>> = {
  email: { title: "Email anyone without asking?", body: "OVOA will send emails for you without checking with you first, to anyone." },
  text: { title: "Text anyone without asking?", body: "OVOA will send texts for you without checking with you first, to anyone." },
  call: { title: "Call anyone without asking?", body: "OVOA will place calls for you without checking with you first, to anyone." },
};

/** The server keeps a US number as its last ten digits: "5865550100" reads as "(586) 555-0100". */
const who = (recipient: string) => {
  const m = /^(\d{3})(\d{3})(\d{4})$/.exec(recipient);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : recipient;
};

export default function ApprovalRules() {
  const { token, user } = useSession();
  const [rules, setRules] = useState<ApprovalRule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<RuleKind>("email");
  const [recipient, setRecipient] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setRules((await api.approvalRules(token)).rules);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = () => {
    const to = recipient.trim();
    const save = async () => {
      setBusy(true);
      try {
        await api.addApprovalRule(token, kind, to || undefined);
        setRecipient("");
        await load();
      } catch (err) {
        Alert.alert("Couldn't add that", err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    };
    const warn = !to ? ANYONE[kind] : undefined;
    if (!warn) return void save();
    Alert.alert(warn.title, `${warn.body} Deleting and money still ask.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Add rule", style: "destructive", onPress: () => void save() },
    ]);
  };

  const remove = async (rule: ApprovalRule) => {
    setRules((list) => list?.filter((r) => r.id !== rule.id) ?? null);
    try {
      await api.removeApprovalRule(token, rule.id);
    } catch (err) {
      Alert.alert("Couldn't remove that", err instanceof Error ? err.message : String(err));
      load().catch(logFail("approval rules: reload"));
    }
  };

  if (!rules) {
    return (
      <View style={styles.center}>
        {error ? (
          <Empty
            icon="cloud-offline-outline"
            title="Couldn't load your rules"
            body={error}
            action={{ label: "Try again", onPress: () => void load() }}
          />
        ) : (
          <ActivityIndicator color={colors.now} />
        )}
      </View>
    );
  }

  const k = KINDS[kind];

  return (
    <Screen
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            load()
              .catch(logFail("approval rules: refresh"))
              .finally(() => setRefreshing(false));
          }}
        />
      }
    >
      <Text style={styles.lead}>
        Things OVOA can do without asking you first, like emailing your partner or adding to your calendar. Deleting anything,
        spending money, and anything OVOA does on its own always still ask.
      </Text>
      {user.settings.autoApprove && (
        <Text style={styles.note}>Approve for me is on in Settings, so OVOA isn't asking before these anyway.</Text>
      )}
      {!!error && <Text style={styles.error}>{error}</Text>}

      <GroupLabel>Your rules</GroupLabel>
      {rules.length === 0 ? (
        <Text style={styles.meta}>No rules yet. You can also just tell OVOA "you don't need to ask before emailing Sam".</Text>
      ) : (
        rules.map((rule, i) => {
          const r = KINDS[rule.kind] ?? KINDS.email;
          return (
            <View key={rule.id} style={[styles.rule, i === 0 && styles.ruleFirst]}>
              <IconTile name={r.icon} tone={r.tone} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.body}>{rule.recipient === "anyone" ? r.anyone : r.to(who(rule.recipient))}</Text>
                <Text style={styles.meta}>Goes without asking</Text>
              </View>
              <Btn label="Remove" kind="quiet" onPress={() => void remove(rule)} />
            </View>
          );
        })
      )}

      <GroupLabel>Add a rule</GroupLabel>
      <View style={styles.segment}>
        {ORDER.map((key) => (
          <Pressable
            key={key}
            onPress={() => setKind(key)}
            style={[styles.segmentItem, kind === key && styles.segmentOn]}
            accessibilityRole="radio"
            accessibilityState={{ checked: kind === key }}
          >
            <Text style={[styles.segmentText, kind === key && styles.segmentTextOn]}>{KINDS[key].label}</Text>
          </Pressable>
        ))}
      </View>
      <TextInput
        style={styles.input}
        value={recipient}
        onChangeText={setRecipient}
        placeholder={k.placeholder}
        placeholderTextColor={colors.inkMute}
        keyboardType={k.keyboard}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="done"
      />
      <Text style={styles.meta}>{k.empty}</Text>
      <Btn label="Add rule" kind="go" busy={busy} style={styles.left} onPress={add} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.paper, padding: space.s4 },
  lead: { ...type.sub, color: colors.inkDim, marginTop: space.s2 },
  note: { ...type.meta, color: colors.late },
  body: { ...type.body, color: colors.ink },
  meta: { ...type.meta, color: colors.inkMute },
  error: { ...type.meta, color: colors.stop },
  left: { alignSelf: "flex-start" },
  rule: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.s3,
    paddingVertical: space.s3,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  ruleFirst: { borderTopWidth: 0 },
  // Selection is ink, never teal: which option is picked is not urgency.
  segment: { flexDirection: "row", backgroundColor: colors.wash, borderRadius: 14, padding: 3, gap: 3 },
  segmentItem: { flex: 1, borderRadius: 11, paddingVertical: 9, alignItems: "center" },
  segmentOn: { backgroundColor: colors.paper },
  segmentText: { ...type.meta, fontWeight: "600", color: colors.inkMute },
  segmentTextOn: { color: colors.ink },
  input: {
    backgroundColor: colors.wash,
    borderRadius: 14,
    color: colors.ink,
    ...type.body,
    paddingHorizontal: space.s3,
    paddingVertical: space.s3,
  },
});
