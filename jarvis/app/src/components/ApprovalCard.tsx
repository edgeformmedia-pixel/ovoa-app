import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { PendingAction } from "../lib/api";
import { preparePhoneAction, type Approval, type Prep } from "../lib/phoneActions";
import { colors } from "../lib/theme";

type Props = {
  action: PendingAction;
  /** For phone actions: the contact picked and the recipients looked up. */
  onApprove: (approval: Approval) => Promise<void>;
  onCancel: () => Promise<void>;
};

export function ApprovalCard({ action, onApprove, onCancel }: Props) {
  const [busy, setBusy] = useState<"approve" | "cancel" | null>(null);
  const prep = usePhonePrep(action);

  const run = (kind: "approve" | "cancel", fn: () => Promise<void>) => async () => {
    setBusy(kind);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  const canApprove = !busy && prep.ready;
  const approve = () => onApprove({ contactId: prep.selected ?? undefined, prep: prep.data ?? undefined });

  return (
    <View style={styles.card}>
      <Text style={styles.heading}>Needs your approval</Text>
      <ScrollView style={styles.summaryBox} nestedScrollEnabled>
        <Text style={styles.summary} selectable>
          {action.summary}
        </Text>
      </ScrollView>

      {prep.needed && <PhoneDetails prep={prep} />}

      <View style={styles.row}>
        <Pressable style={[styles.button, styles.cancel]} onPress={run("cancel", onCancel)} disabled={!!busy}>
          {busy === "cancel" ? <ActivityIndicator color={colors.text} /> : <Text style={styles.cancelText}>Cancel</Text>}
        </Pressable>
        <Pressable
          style={[styles.button, styles.approve, !canApprove && { opacity: 0.4 }]}
          onPress={run("approve", approve)}
          disabled={!canApprove}
        >
          {busy === "approve" ? (
            <ActivityIndicator color={colors.bg} />
          ) : (
            <Text style={styles.approveText}>Approve</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

type PhonePrep = ReturnType<typeof usePhonePrep>;

const NEEDS_PREP = new Set(["phone_contact_update", "phone_message_compose", "phone_email_compose", "phone_call"]);

/**
 * For phone actions that need it, looks things up on the phone before Approve:
 * which contact to edit, or the numbers and emails behind recipient names.
 */
function usePhonePrep(action: PendingAction) {
  const needed = !!action.phone && NEEDS_PREP.has(action.phone.tool);
  const [data, setData] = useState<Prep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (!needed) return;
    preparePhoneAction(action)
      .then((prep) => {
        setData(prep);
        if (prep.kind === "contact" && prep.matches.length === 1) setSelected(prep.matches[0].id);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't read contacts"));
  }, [needed, action]);

  let ready = !needed;
  if (data?.kind === "contact") ready = !!selected;
  if (data?.kind === "recipients") ready = data.recipients.every((r) => r.value);

  return { needed, data, error, selected, setSelected, ready };
}

function PhoneDetails({ prep }: { prep: PhonePrep }) {
  const { data, error, selected, setSelected } = prep;
  if (error) return <Text style={styles.note}>{error}</Text>;
  if (!data) return <ActivityIndicator color={colors.accent} />;

  if (data.kind === "recipients") {
    return (
      <View style={{ gap: 2 }}>
        {data.recipients.map((r) => (
          <Text key={r.input} style={[styles.note, !r.value && { color: colors.danger }]}>
            {r.value ? "To: " : ""}
            {r.label}
          </Text>
        ))}
      </View>
    );
  }
  if (data.kind !== "contact") return null;

  const { matches, name } = data;
  if (!matches.length) return <Text style={styles.note}>No contact on this iPhone matches "{name}".</Text>;
  if (matches.length === 1) {
    return (
      <Text style={styles.note}>
        Contact: {matches[0].name}
        {matches[0].detail ? ` · ${matches[0].detail}` : ""}
      </Text>
    );
  }
  return (
    <View style={{ gap: 6 }}>
      <Text style={styles.note}>Which contact?</Text>
      {matches.map((m) => (
        <Pressable
          key={m.id}
          style={[styles.choice, selected === m.id && styles.choiceOn]}
          onPress={() => setSelected(m.id)}
        >
          <Text style={styles.choiceName}>{m.name}</Text>
          {!!m.detail && <Text style={styles.choiceDetail}>{m.detail}</Text>}
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 12,
    marginBottom: 8,
    padding: 12,
    gap: 8,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#f5c26b",
    backgroundColor: colors.surface,
  },
  heading: { color: "#f5c26b", fontSize: 12, fontWeight: "700", letterSpacing: 0.5 },
  summaryBox: { maxHeight: 140 },
  summary: { color: colors.text, fontSize: 14, lineHeight: 20 },
  note: { color: colors.textDim, fontSize: 13 },
  choice: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  choiceOn: { borderColor: colors.accent, backgroundColor: colors.surfaceHigh },
  choiceName: { color: colors.text, fontSize: 14, fontWeight: "600" },
  choiceDetail: { color: colors.textDim, fontSize: 12, marginTop: 2 },
  row: { flexDirection: "row", gap: 8 },
  button: { flex: 1, borderRadius: 10, paddingVertical: 11, alignItems: "center" },
  cancel: { backgroundColor: colors.surfaceHigh },
  cancelText: { color: colors.text, fontWeight: "600" },
  approve: { backgroundColor: colors.accent },
  approveText: { color: colors.bg, fontWeight: "700" },
});
