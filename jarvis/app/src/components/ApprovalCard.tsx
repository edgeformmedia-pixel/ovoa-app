import Ionicons from "@expo/vector-icons/Ionicons";
import { useEffect, useState } from "react";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { FadeInDown, interpolate, runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { PendingAction } from "../lib/api";
import { preparePhoneAction, type Approval, type Prep } from "../lib/phoneActions";
import { colors, space, type } from "../lib/theme";
import { SPRING } from "./motion";
import { Btn, text } from "./ui";

// The one thing on the voice screen that asks something of you, in the shape
// the rest of the app asks in: a 2px teal rail and an indent. Deliberately not
// a card — a card is what the old app made everything look like, and this is
// the one moment that has to stand out from the rest of the screen.
//
// It can be swiped as well as tapped: right to send, left to cancel, with the
// answer showing underneath as it goes. Let go early and it springs back. The
// buttons stay, for anyone who'd rather tap or can't drag.

/** How far it has to go before letting go counts. */
const SWIPE = 110;

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

  const dx = useSharedValue(0);
  const gone = useSharedValue(0);
  const swiped = (kind: "approve" | "cancel") => void run(kind, kind === "approve" ? approve : onCancel)();
  const pan = Gesture.Pan()
    // Sideways only: a vertical drag still scrolls the summary.
    .activeOffsetX([-16, 16])
    .failOffsetY([-12, 12])
    .enabled(!busy)
    .onUpdate((e) => {
      // Approving isn't allowed yet (a contact to pick): it gives, then resists.
      dx.value = e.translationX > 0 && !canApprove ? e.translationX * 0.25 : e.translationX;
    })
    .onEnd(() => {
      if (dx.value > SWIPE && canApprove) {
        gone.value = withTiming(1, { duration: 220 });
        dx.value = withTiming(500, { duration: 260 }, () => runOnJS(swiped)("approve"));
      } else if (dx.value < -SWIPE) {
        gone.value = withTiming(1, { duration: 220 });
        dx.value = withTiming(-500, { duration: 260 }, () => runOnJS(swiped)("cancel"));
      } else dx.value = withSpring(0, SPRING);
    });

  const cardStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: dx.value }, { rotate: `${dx.value / 40}deg` }],
    opacity: 1 - gone.value,
  }));
  const sendStyle = useAnimatedStyle(() => ({ opacity: interpolate(dx.value, [0, SWIPE], [0, 1], "clamp") }));
  const cancelStyle = useAnimatedStyle(() => ({ opacity: interpolate(dx.value, [-SWIPE, 0], [1, 0], "clamp") }));

  return (
    <Animated.View entering={FadeInDown.springify().damping(16)} style={styles.swipeWrap}>
      <Animated.View style={[styles.under, styles.underSend, sendStyle]}>
        <Ionicons name="checkmark-circle" size={22} color={colors.done} />
        <Text style={[styles.underText, { color: colors.done }]}>Send</Text>
      </Animated.View>
      <Animated.View style={[styles.under, styles.underCancel, cancelStyle]}>
        <Text style={[styles.underText, { color: colors.stop }]}>Cancel</Text>
        <Ionicons name="close-circle" size={22} color={colors.stop} />
      </Animated.View>
      <GestureDetector gesture={pan}>
    <Animated.View style={[styles.answer, cardStyle]}>
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
        <Text style={styles.swipeHint}>or swipe</Text>
      </View>
    </Animated.View>
      </GestureDetector>
    </Animated.View>
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
  swipeWrap: { marginHorizontal: space.s5, marginBottom: space.s3 },
  under: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    borderRadius: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: space.s2,
    paddingHorizontal: space.s4,
  },
  underSend: { backgroundColor: colors.doneWash, justifyContent: "flex-start" },
  underCancel: { backgroundColor: colors.stopWash, justifyContent: "flex-end" },
  underText: { ...type.sub, fontWeight: "600" },
  swipeHint: { ...type.meta, color: colors.inkMute, marginLeft: "auto" },
  answer: {
    backgroundColor: colors.paper,
    paddingVertical: space.s2,
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
