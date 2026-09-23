import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { api, type GoogleAccount } from "../lib/api";
import { useAuth } from "../lib/auth";
import { connectGoogle, GOOGLE_APPS, mayHaveHadGoogle } from "../lib/google";
import { colors } from "../lib/theme";

// Starting points for a tag; the user can type anything instead.
const TAG_SUGGESTIONS = ["Work", "Personal", "School", "Business"];
const TAG_MAX = 24;

export function GoogleConnection({ token }: { token: string }) {
  const [accounts, setAccounts] = useState<GoogleAccount[] | null>(null);
  const [busy, setBusy] = useState(false);
  const { user } = useAuth();

  const refresh = useCallback(() => {
    api
      .googleStatus(token)
      .then((status) => setAccounts(status.accounts ?? []))
      .catch(() => setAccounts([]));
  }, [token]);

  // Re-check on focus: the server drops expired connections, and the assistant can retag accounts.
  useFocusEffect(refresh);

  // Without an id this adds an account; with one it reconnects that account.
  const connect = async (accountId?: string) => {
    setBusy(true);
    try {
      const result = await connectGoogle(token, accountId);
      if (!result.ok && !result.cancelled) Alert.alert("Couldn't connect", result.message);
    } catch (err) {
      Alert.alert("Couldn't connect", (err as Error).message);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const update = async (id: string, patch: { label?: string; isDefault?: true }) => {
    try {
      setAccounts((await api.googleUpdateAccount(token, id, patch)).accounts);
    } catch (err) {
      Alert.alert("Couldn't save that", (err as Error).message);
    }
  };

  const remove = (account: GoogleAccount) =>
    Alert.alert("Disconnect this account?", `The assistant will lose access to ${account.email}.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Disconnect",
        style: "destructive",
        onPress: async () => {
          try {
            setAccounts((await api.googleRemoveAccount(token, account.id)).accounts);
          } catch {
            refresh();
          }
        },
      },
    ]);

  if (!accounts) return <ActivityIndicator color={colors.now} />;

  return (
    <View style={styles.wrap}>
      {accounts.length === 0 ? (
        <>
          <Text style={styles.meta}>
            Connect to let the assistant use your {GOOGLE_APPS.join(", ")}. In Drive it only sees the files it creates.
            It asks before sending, deleting, or inviting anyone.
          </Text>
          {mayHaveHadGoogle(user?.created_at) && (
            <Text style={styles.meta}>
              Had Google connected before? Reconnect Google: OVOA's link to Google changed, so earlier connections
              stopped working.
            </Text>
          )}
        </>
      ) : (
        <>
          {accounts.map((account) => (
            <AccountCard
              key={account.id}
              account={account}
              showDefault={accounts.length > 1}
              busy={busy}
              onTag={(label) => update(account.id, { label })}
              onMakeDefault={() => update(account.id, { isDefault: true })}
              onReconnect={() => connect(account.id)}
              onRemove={() => remove(account)}
            />
          ))}
          <Text style={styles.meta}>
            Tag an account to tell the assistant what it's for — then ask it things like "what's on my work calendar
            today". It can also tag accounts for you when you tell it in a chat.
          </Text>
        </>
      )}

      <Pressable style={[styles.button, !accounts.length && styles.primary]} onPress={() => connect()} disabled={busy}>
        <Text style={[styles.buttonText, !accounts.length && { color: colors.paper }]}>
          {busy ? "Opening Google…" : accounts.length ? "Add another Google account" : "Connect Google account"}
        </Text>
      </Pressable>
    </View>
  );
}

function AccountCard({
  account,
  showDefault,
  busy,
  onTag,
  onMakeDefault,
  onReconnect,
  onRemove,
}: {
  account: GoogleAccount;
  showDefault: boolean;
  busy: boolean;
  onTag: (label: string) => void;
  onMakeDefault: () => void;
  onReconnect: () => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(account.label ?? "");

  const startEditing = () => {
    setDraft(account.label ?? "");
    setEditing(true);
  };

  const save = (label: string) => {
    setEditing(false);
    if (label.trim() !== (account.label ?? "")) onTag(label.trim());
  };

  return (
    <View style={styles.card}>
      <View style={styles.cardTop}>
        <Pressable style={account.label ? styles.tag : styles.tagEmpty} onPress={startEditing} hitSlop={6}>
          <Text style={account.label ? styles.tagText : styles.tagEmptyText}>{account.label ?? "+ Add a tag"}</Text>
        </Pressable>
        {showDefault && account.isDefault && <Text style={styles.default}>Default</Text>}
      </View>

      <Text style={styles.label}>{account.email}</Text>
      {!!account.name && <Text style={styles.meta}>{account.name}</Text>}

      {editing && (
        <View style={styles.editor}>
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            placeholder="e.g. Work"
            placeholderTextColor={colors.inkMute}
            maxLength={TAG_MAX}
            autoFocus
            autoCapitalize="words"
            returnKeyType="done"
            onSubmitEditing={() => save(draft)}
          />
          <View style={styles.suggestions}>
            {TAG_SUGGESTIONS.map((suggestion) => (
              <Pressable key={suggestion} style={styles.suggestion} onPress={() => save(suggestion)}>
                <Text style={styles.suggestionText}>{suggestion}</Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.editorRow}>
            <Pressable onPress={() => save(draft)} hitSlop={8}>
              <Text style={styles.action}>Save tag</Text>
            </Pressable>
            {!!account.label && (
              <Pressable onPress={() => save("")} hitSlop={8}>
                <Text style={[styles.action, { color: colors.stop }]}>Remove tag</Text>
              </Pressable>
            )}
            <Pressable onPress={() => setEditing(false)} hitSlop={8}>
              <Text style={[styles.action, { color: colors.inkMute }]}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      )}

      <View style={styles.actions}>
        {showDefault && !account.isDefault && (
          <Pressable onPress={onMakeDefault} hitSlop={8}>
            <Text style={styles.action}>Make default</Text>
          </Pressable>
        )}
        <Pressable onPress={onReconnect} disabled={busy} hitSlop={8}>
          <Text style={styles.action}>Reconnect</Text>
        </Pressable>
        <Pressable onPress={onRemove} hitSlop={8}>
          <Text style={[styles.action, { color: colors.stop }]}>Disconnect</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 10 },
  card: {
    backgroundColor: colors.wash2,
    borderRadius: 12,
    padding: 14,
    gap: 6,
  },
  cardTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  tag: {
    backgroundColor: colors.nowWash,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  tagText: { color: colors.now, fontSize: 13, fontWeight: "600" },
  tagEmpty: {
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  tagEmptyText: { color: colors.inkMute, fontSize: 13 },
  default: { color: colors.done, fontSize: 12, fontWeight: "600" },
  label: { color: colors.ink, fontSize: 15 },
  meta: { color: colors.inkMute, fontSize: 13, lineHeight: 18 },
  editor: { gap: 8, marginTop: 4 },
  input: {
    backgroundColor: colors.wash,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 10,
    color: colors.ink,
    fontSize: 15,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  suggestions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  suggestion: {
    backgroundColor: colors.wash,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  suggestionText: { color: colors.ink, fontSize: 13 },
  editorRow: { flexDirection: "row", gap: 18, flexWrap: "wrap" },
  actions: { flexDirection: "row", gap: 18, flexWrap: "wrap", marginTop: 4 },
  action: { color: colors.now, fontSize: 14, fontWeight: "600" },
  button: { backgroundColor: colors.wash2, borderRadius: 10, paddingVertical: 12, alignItems: "center" },
  primary: { backgroundColor: colors.now },
  buttonText: { color: colors.now, fontSize: 15, fontWeight: "600" },
});
