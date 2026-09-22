import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { PendingAction } from "../lib/api";
import { preparePhoneAction, type Approval, type Prep } from "../lib/phoneActions";
import { colors, space, type } from "../lib/theme";
import { Btn, text } from "./ui";

// The one thing on the voice screen that asks something of you, in the shape
// the rest of the app asks in: a 2px teal rail and an indent. Deliberately not
// a card — a card is what the old app made everything look like, and this is
// the one moment that has to stand out from the rest of the screen.

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
    <View style={styles.answer}>
      <Text style={styles.eyebrow}>Send this?</Text>
      <ScrollView style={styles.summaryBox} nestedScrollEnabled>
        <Text style={styles.said} selectable>
          {action.summary}
        </Text>
      </ScrollView>

      {prep.needed && <PhoneDetails prep={prep} />}

      <View style={styles.acts}>
        <Btn label="Approve" kind="go" onPress={run("approve", approve)} disabled={!canApprove} busy={busy === "approve"} />
        <Btn label="Cancel" kind="quiet" onPress={run("cancel", onCancel)} disabled={!!busy} busy={busy === "cancel"} />
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
  if (error) return <Text style={styles.problem}>{error}</Text>;
  if (!data) return <ActivityIndicator color={colors.now} />;

  if (data.kind === "recipients") {
    return (
      <View style={{ gap: 2 }}>
        {data.recipients.map((r) => (
          <Text key={r.input} style={[text.meta, !r.value && styles.problem]}>
            {r.value ? "To: " : ""}
            {r.label}
          </Text>
        ))}
      </View>
    );
  }
  if (data.kind !== "contact") return null;

  const { matches, name } = data;
  if (!matches.length) return <Text style={styles.problem}>No contact on this iPhone matches &ldquo;{name}&rdquo;.</Text>;
  if (matches.length === 1) {
    return (
      <Text style={text.meta}>
        {matches[0].name}
        {matches[0].detail ? ` · ${matches[0].detail}` : ""}
      </Text>
    );
  }
  return (
    <View style={{ gap: space.s1 }}>
      <Text style={text.meta}>Which contact?</Text>
      {matches.map((m) => (
        <Pressable key={m.id} style={[styles.choice, selected === m.id && styles.choiceOn]} onPress={() => setSelected(m.id)}>
          <Text style={[text.body, selected === m.id && { color: colors.paper }]}>{m.name}</Text>
          {!!m.detail && <Text style={[text.meta, selected === m.id && { color: colors.wash2 }]}>{m.detail}</Text>}
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  answer: {
    marginHorizontal: space.s5,
    marginBottom: space.s3,
    paddingLeft: space.s4,
    borderLeftWidth: 2,
    borderLeftColor: colors.now,
    gap: space.s2,
  },
  eyebrow: { ...type.micro, color: colors.now, textTransform: "uppercase" },
  summaryBox: { maxHeight: 140, flexGrow: 0 },
  said: { ...type.body, color: colors.ink },
  problem: { ...type.meta, color: colors.stop },
  acts: { flexDirection: "row", alignItems: "center", gap: space.s2 },
  choice: { borderRadius: 12, paddingHorizontal: space.s3, paddingVertical: space.s2, backgroundColor: colors.wash },
  choiceOn: { backgroundColor: colors.ink },
});
