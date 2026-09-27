import Ionicons from "@expo/vector-icons/Ionicons";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Btn, Empty, GroupLabel, Screen } from "../components/ui";
import { api, ApiError, type VaultCategory, type VaultItem } from "../lib/api";
import { useSession } from "../lib/auth";
import { logFail } from "../lib/devlog";
import { colors, radius, space, type } from "../lib/theme";

// The vault (api/src/vault.ts): the details OVOA fills in when it books
// something or fills in a form for someone. Encrypted on the server and read
// only by their own OVOA. Values stay hidden until tapped, so a glance over a
// shoulder doesn't give away a home address. The server refuses card and bank
// numbers, SSNs, passwords and codes, and its words for that are shown as they
// come. Settings, Assistant, "When it acts for you" opens it.

const CATEGORIES: { key: VaultCategory; label: string; group: string; example: { label: string; value: string } }[] = [
  { key: "address", label: "Address", group: "Addresses", example: { label: "Home address", value: "12 Oak St, Springfield, IL 62701" } },
  { key: "travel", label: "Travel", group: "Travel", example: { label: "Seat preference", value: "Aisle, near the front" } },
  { key: "loyalty", label: "Loyalty", group: "Loyalty and rewards", example: { label: "Delta SkyMiles", value: "9012345678" } },
  { key: "sizes", label: "Sizes", group: "Sizes", example: { label: "Shoe size", value: "US 10" } },
  { key: "vehicle", label: "Vehicle", group: "Vehicle", example: { label: "Car", value: "Blue 2019 Honda Civic" } },
  { key: "other", label: "Other", group: "Other", example: { label: "Allergies", value: "Peanuts" } },
];

/** Always the same length, so a hidden value doesn't give away how long it is. */
const MASK = "••••••••";

/** Labels the way the server keeps them: spaces squashed, and any case is the same label. */
const sameLabel = (a: string, b: string) => a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();

type Draft = { id?: string; category: VaultCategory; label: string; value: string };

export default function Vault() {
  const { token } = useSession();
  const [items, setItems] = useState<VaultItem[] | null>(null);
  // "off": the server has no key to encrypt with, so there's no vault yet (503).
  const [problem, setProblem] = useState<{ off: boolean; text: string } | null>(null);
  const [shown, setShown] = useState<Set<string>>(() => new Set());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.vault(token);
      setItems(r.items);
      setProblem(null);
    } catch (err) {
      // Maintenance is a 503 too, but it comes with a code; the vault's own 503 doesn't.
      const off = err instanceof ApiError && err.status === 503 && !err.code;
      setProblem({ off, text: err instanceof Error ? err.message : String(err) });
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (id: string) =>
    setShown((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (problem?.off) {
    return (
      <View style={styles.center}>
        <Empty
          icon="lock-closed-outline"
          title="Not available yet"
          body="The vault isn't switched on yet. Until it is, OVOA just asks you for a detail when it needs one."
        />
      </View>
    );
  }
  if (!items) {
    return (
      <View style={styles.center}>
        {problem ? (
          <Empty
            icon="cloud-offline-outline"
            title="Couldn't load your vault"
            body={problem.text}
            action={{ label: "Try again", onPress: () => void load() }}
          />
        ) : (
          <ActivityIndicator color={colors.now} />
        )}
      </View>
    );
  }

  const known = new Set<string>(CATEGORIES.map((c) => c.key));
  const groups = CATEGORIES.map((c) => ({
    ...c,
    items: items.filter((i) => (known.has(i.category) ? i.category : "other") === c.key),
  })).filter((g) => g.items.length > 0);

  return (
    <>
      <Screen
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              load()
                .catch(logFail("vault: refresh"))
                .finally(() => setRefreshing(false));
            }}
          />
        }
      >
        <Text style={styles.lead}>
          Details OVOA uses when it books something or fills in a form for you. Everything here is encrypted, and card numbers
          and passwords never go in.
        </Text>
        {!!problem && <Text style={styles.error}>{problem.text}</Text>}
        <Btn
          label="Add a detail"
          kind="go"
          style={styles.left}
          onPress={() => setDraft({ category: "address", label: "", value: "" })}
        />

        {groups.length === 0 ? (
          <Empty
            icon="lock-closed-outline"
            title="Nothing saved yet"
            body={`Add your home address, a frequent flyer number or your shoe size. Or just tell OVOA "save my Delta number, it's 9012345678".`}
          />
        ) : (
          groups.map((g) => (
            <View key={g.key}>
              <GroupLabel>{g.group}</GroupLabel>
              {g.items.map((item, i) => {
                const open = shown.has(item.id);
                return (
                  <View key={item.id} style={[styles.item, i === 0 && styles.itemFirst]}>
                    <Pressable
                      style={{ flex: 1, gap: 2 }}
                      onPress={() => setDraft({ id: item.id, category: item.category, label: item.label, value: item.value })}
                      accessibilityRole="button"
                      accessibilityHint="Change or remove it"
                    >
                      <Text style={styles.body}>{item.label}</Text>
                      <Text style={styles.value} selectable={open}>
                        {open ? item.value : MASK}
                      </Text>
                    </Pressable>
                    <Pressable
                      onPress={() => toggle(item.id)}
                      hitSlop={10}
                      accessibilityRole="button"
                      accessibilityLabel={open ? `Hide ${item.label}` : `Show ${item.label}`}
                    >
                      <Ionicons name={open ? "eye-off-outline" : "eye-outline"} size={22} color={colors.inkMute} />
                    </Pressable>
                  </View>
                );
              })}
            </View>
          ))
        )}
      </Screen>

      {draft && (
        <VaultSheet
          key={draft.id ?? "new"}
          draft={draft}
          others={items.filter((i) => i.id !== draft.id)}
          onClose={() => setDraft(null)}
          onDone={() => {
            setDraft(null);
            void load();
          }}
        />
      )}
    </>
  );
}

/** Adding one, or changing or removing one: a sheet over the list, like Calorie's. */
function VaultSheet({
  draft,
  others,
  onClose,
  onDone,
}: {
  draft: Draft;
  others: VaultItem[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { token } = useSession();
  const insets = useSafeAreaInsets();
  const [category, setCategory] = useState<VaultCategory>(draft.category);
  const [label, setLabel] = useState(draft.label);
  const [value, setValue] = useState(draft.value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = !!draft.id;
  const example = (CATEGORIES.find((c) => c.key === category) ?? CATEGORIES[CATEGORIES.length - 1]).example;
  const ready = !!label.trim() && !!value.trim();
  const changed = category !== draft.category || label.trim() !== draft.label || value.trim() !== draft.value;

  const run = async (what: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await what();
      onDone();
    } catch (err) {
      // The server's own words: "The vault doesn't hold card or bank numbers..." and the like.
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const save = () => {
    const l = label.trim();
    const v = value.trim();
    if (!l || !v) return;
    if (draft.id) {
      const id = draft.id;
      const patch: Partial<{ category: VaultCategory; label: string; value: string }> = {};
      if (category !== draft.category) patch.category = category;
      if (l !== draft.label) patch.label = l;
      if (v !== draft.value) patch.value = v;
      return void run(() => api.updateVaultItem(token, id, patch));
    }
    const add = () => void run(() => api.saveVaultItem(token, { category, label: l, value: v }));
    // Saving a label that's already there replaces it on the server, so say so first.
    const clash = others.find((i) => sameLabel(i.label, l));
    if (!clash) return add();
    Alert.alert(`Replace "${clash.label}"?`, "You already have a detail with that name. Saving this puts it in its place.", [
      { text: "Cancel", style: "cancel" },
      { text: "Replace", style: "destructive", onPress: add },
    ]);
  };

  const remove = () => {
    const id = draft.id;
    if (!id) return;
    Alert.alert(`Remove "${draft.label}"?`, "OVOA won't have it any more, so it'll ask you next time it needs it.", [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: () => void run(() => api.deleteVaultItem(token, id)) },
    ]);
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <Pressable style={styles.scrim} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + space.s5 }]}>
          <View style={styles.grip} />
          <Text style={styles.sheetTitle}>{editing ? "Change a detail" : "Add a detail"}</Text>

          <View style={styles.pills}>
            {CATEGORIES.map((c) => (
              <Pressable
                key={c.key}
                onPress={() => setCategory(c.key)}
                style={[styles.pill, category === c.key && styles.pillOn]}
                accessibilityRole="radio"
                accessibilityState={{ checked: category === c.key }}
              >
                <Text style={[styles.pillText, category === c.key && styles.pillTextOn]}>{c.label}</Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.fieldLabel}>What it is</Text>
          <TextInput
            style={styles.input}
            value={label}
            onChangeText={setLabel}
            placeholder={`e.g. ${example.label}`}
            placeholderTextColor={colors.inkMute}
            maxLength={80}
            returnKeyType="next"
          />
          <Text style={styles.fieldLabel}>The detail</Text>
          <TextInput
            style={[styles.input, styles.multi]}
            value={value}
            onChangeText={setValue}
            placeholder={`e.g. ${example.value}`}
            placeholderTextColor={colors.inkMute}
            autoCorrect={false}
            maxLength={1000}
            multiline
          />
          {!!error && <Text style={styles.error}>{error}</Text>}

          <View style={styles.sheetButtons}>
            {editing && <Btn label="Remove" kind="quiet" onPress={remove} disabled={busy} />}
            <View style={{ flex: 1 }} />
            <Btn label="Cancel" onPress={onClose} />
            <Btn label="Save" kind="go" busy={busy} disabled={!ready || (editing && !changed)} onPress={save} />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.paper, padding: space.s4 },
  lead: { ...type.sub, color: colors.inkDim, marginTop: space.s2 },
  body: { ...type.body, color: colors.ink },
  value: { ...type.sub, color: colors.inkDim },
  error: { ...type.meta, color: colors.stop },
  left: { alignSelf: "flex-start" },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.s3,
    paddingVertical: space.s3,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  itemFirst: { borderTopWidth: 0 },

  scrim: { flex: 1, backgroundColor: "rgba(12,14,18,0.3)" },
  sheet: {
    backgroundColor: colors.paper,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    paddingHorizontal: space.s5,
    paddingTop: space.s3,
    gap: space.s2,
  },
  grip: { alignSelf: "center", width: 40, height: 5, borderRadius: 3, backgroundColor: colors.wash2, marginBottom: space.s2 },
  sheetTitle: { ...type.title, color: colors.ink },
  pills: { flexDirection: "row", flexWrap: "wrap", gap: space.s2, paddingVertical: space.s2 },
  pill: { paddingHorizontal: space.s3, paddingVertical: space.s1, borderRadius: 14, backgroundColor: colors.wash },
  pillOn: { backgroundColor: colors.ink },
  pillText: { ...type.sub, color: colors.inkDim },
  pillTextOn: { color: colors.paper, fontWeight: "600" },
  fieldLabel: { ...type.meta, fontWeight: "600", color: colors.inkMute, marginTop: space.s1 },
  input: {
    backgroundColor: colors.wash,
    borderRadius: 14,
    color: colors.ink,
    ...type.body,
    paddingHorizontal: space.s3,
    paddingVertical: space.s3,
  },
  multi: { minHeight: 72, textAlignVertical: "top" },
  sheetButtons: { flexDirection: "row", alignItems: "center", gap: space.s2, marginTop: space.s3 },
});
