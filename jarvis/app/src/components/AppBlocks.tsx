import Ionicons from "@expo/vector-icons/Ionicons";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState } from "react";
import { Alert, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { AppBlock, AppContents, AppOp, BlockState } from "../lib/api";
import { counterValue } from "../lib/appKit";
import { cue } from "../lib/cues";
import { colors, numeric, radius, space, type } from "../lib/theme";
import { PressScale } from "./motion";
import { toneInk, toneWash, type Tone } from "./ui";

// A made app's screen, drawn from its parts (server: api/src/myapps.ts Block).
//
// Each part is a small tool with one job, in the app's own colour: buttons that
// ask OVOA something, a checklist, a counter, a log, a timer, a note. Taps
// change what's in them straight away (lib/myApps.ts shows the change before
// the server confirms it). `preview` draws the same screen for the editor,
// with nothing that can be pressed.

type Props = {
  blocks: AppBlock[];
  state: AppContents;
  tone: Tone;
  /** A button was tapped: ask OVOA this, as the app. */
  onAsk?: (prompt: string) => void;
  onChange?: (op: AppOp) => void;
  /** OVOA is answering: the buttons wait. */
  busy?: boolean;
  preview?: boolean;
};

export function AppBlocks({ blocks, state, tone, onAsk, onChange, busy, preview }: Props) {
  const change = (op: AppOp) => {
    if (preview) return;
    if (Platform.OS !== "web") void Haptics.selectionAsync().catch(() => {});
    onChange?.(op);
  };
  return (
    <View style={{ gap: space.s3 }}>
      {blocks.map((b) => (
        <View key={b.id} style={styles.part}>
          {b.kind !== "buttons" && <Text style={styles.title}>{b.title}</Text>}
          {b.kind === "buttons" && <Buttons block={b} tone={tone} onAsk={onAsk} busy={busy} preview={preview} />}
          {b.kind === "list" && <Checklist block={b} s={state[b.id]} tone={tone} change={change} preview={preview} />}
          {b.kind === "counter" && <Counter block={b} s={state[b.id]} tone={tone} change={change} preview={preview} />}
          {b.kind === "log" && <Log block={b} s={state[b.id]} tone={tone} change={change} preview={preview} />}
          {b.kind === "timer" && <Timer block={b} tone={tone} preview={preview} />}
          {b.kind === "note" && <Text style={styles.note}>{b.text}</Text>}
        </View>
      ))}
    </View>
  );
}

type PartProps = {
  block: AppBlock;
  s?: BlockState;
  tone: Tone;
  change: (op: AppOp) => void;
  preview?: boolean;
};

function Buttons({
  block,
  tone,
  onAsk,
  busy,
  preview,
}: {
  block: AppBlock;
  tone: Tone;
  onAsk?: (p: string) => void;
  busy?: boolean;
  preview?: boolean;
}) {
  return (
    <View style={styles.buttons}>
      {(block.buttons ?? []).map((b, i) => (
        <PressScale
          key={`${b.label}-${i}`}
          sink={0.94}
          disabled={preview || busy}
          onPress={() => onAsk?.(b.prompt)}
          accessibilityRole="button"
          accessibilityLabel={b.label}
          accessibilityHint={b.prompt}
          style={[styles.button, { backgroundColor: toneWash(tone) }, busy && !preview && { opacity: 0.5 }]}
        >
          <Ionicons name="sparkles" size={14} color={toneInk(tone)} />
          <Text style={[styles.buttonText, { color: toneInk(tone) }]} numberOfLines={1}>
            {b.label}
          </Text>
        </PressScale>
      ))}
    </View>
  );
}

/** The box at the bottom of a list or a log: type, press return, it's in. */
function AddRow({
  placeholder,
  tone,
  onAdd,
  preview,
}: {
  placeholder: string;
  tone: Tone;
  onAdd: (text: string) => void;
  preview?: boolean;
}) {
  const [text, setText] = useState("");
  const add = () => {
    const t = text.trim();
    if (!t) return;
    onAdd(t);
    setText("");
  };
  return (
    <View style={styles.addRow}>
      <TextInput
        style={styles.addInput}
        value={text}
        onChangeText={setText}
        placeholder={placeholder}
        placeholderTextColor={colors.inkMute}
        onSubmitEditing={add}
        returnKeyType="done"
        submitBehavior="blurAndSubmit"
        editable={!preview}
        textContentType="none"
        autoComplete="off"
        importantForAutofill="no"
      />
      <Pressable
        onPress={add}
        disabled={preview || !text.trim()}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Add"
        style={[styles.addBtn, { backgroundColor: text.trim() ? toneInk(tone) : colors.wash2 }]}
      >
        <Ionicons name="add" size={20} color={text.trim() ? colors.paper : colors.inkMute} />
      </Pressable>
    </View>
  );
}

function Checklist({ block, s, tone, change, preview }: PartProps) {
  const items = s?.items ?? [];
  const left = items.filter((x) => !x.done).length;
  const ticked = items.length - left;
  const remove = (id: string, text: string) =>
    Alert.alert(`Take "${text}" off?`, undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => change({ block: block.id, op: "remove", item: id }),
      },
    ]);
  return (
    <View>
      {items.length > 0 && (
        <Text style={styles.meta}>
          {left ? `${left} to go` : "All done"}
          {ticked ? ` · ${ticked} ticked` : ""}
        </Text>
      )}
      {items.map((x) => (
        <Pressable
          key={x.id}
          onPress={() => change({ block: block.id, op: "toggle", item: x.id })}
          onLongPress={() => !preview && remove(x.id, x.text)}
          disabled={preview}
          style={styles.item}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: x.done }}
          accessibilityHint="Press and hold to remove it"
        >
          <Ionicons name={x.done ? "checkmark-circle" : "ellipse-outline"} size={24} color={x.done ? toneInk(tone) : colors.inkMute} />
          <Text style={[styles.itemText, x.done && styles.itemDone]}>{x.text}</Text>
        </Pressable>
      ))}
      {!items.length && <Text style={styles.empty}>Nothing yet. Add something below, or ask OVOA to.</Text>}
      <AddRow
        placeholder={block.placeholder || "Add an item"}
        tone={tone}
        preview={preview}
        onAdd={(text) => change({ block: block.id, op: "add", text })}
      />
      {ticked > 0 && !preview && (
        <Pressable
          onPress={() => change({ block: block.id, op: "clear_done" })}
          hitSlop={8}
          style={{ alignSelf: "flex-start", marginTop: space.s2 }}
        >
          <Text style={[styles.link, { color: toneInk(tone) }]}>Clear ticked</Text>
        </Pressable>
      )}
    </View>
  );
}

function Counter({ block, s, tone, change, preview }: PartProps) {
  const value = counterValue(block, s);
  const goal = block.goal ?? 0;
  const step = block.step ?? 1;
  const reached = goal > 0 && value >= goal;
  const pct = goal > 0 ? Math.min(1, Math.max(0, value / goal)) * 100 : 0;
  const was = useRef(value);
  useEffect(() => {
    // The moment the goal is reached, once.
    if (goal > 0 && was.current < goal && value >= goal && !preview) cue("done");
    was.current = value;
  }, [value, goal, preview]);
  const setIt = () => {
    if (preview || Platform.OS !== "ios") return;
    Alert.prompt(
      `Set ${block.title}`,
      undefined,
      (v) => {
        const n = Number(v);
        if (v?.trim() && Number.isFinite(n)) change({ block: block.id, op: "set", value: n });
      },
      "plain-text",
      String(value),
      "decimal-pad",
    );
  };
  return (
    <View>
      <View style={styles.counterRow}>
        <CircleBtn
          icon="remove"
          tone={tone}
          disabled={preview}
          onPress={() => change({ block: block.id, op: "count", amount: -step })}
          label={`Take away ${step}`}
        />
        <Pressable onPress={setIt} style={{ flex: 1, alignItems: "center" }} accessibilityHint="Tap to type a number">
          <Text style={[styles.count, { color: reached ? toneInk(tone) : colors.ink }]}>{value}</Text>
          <Text style={styles.meta}>
            {goal > 0 ? `of ${goal}` : ""}
            {block.unit ? ` ${block.unit}` : ""}
            {block.daily ? `${goal > 0 || block.unit ? " · " : ""}today` : ""}
          </Text>
        </Pressable>
        <CircleBtn
          icon="add"
          tone={tone}
          solid
          disabled={preview}
          onPress={() => change({ block: block.id, op: "count", amount: step })}
          label={`Add ${step}`}
        />
      </View>
      {goal > 0 && (
        <View style={styles.track}>
          <View style={[styles.trackFill, { backgroundColor: toneInk(tone), width: `${pct}%` }]} />
        </View>
      )}
    </View>
  );
}

function CircleBtn({
  icon,
  tone,
  onPress,
  disabled,
  solid,
  label,
}: {
  icon: "add" | "remove";
  tone: Tone;
  onPress: () => void;
  disabled?: boolean;
  solid?: boolean;
  label: string;
}) {
  return (
    <PressScale
      sink={0.9}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[styles.circle, { backgroundColor: solid ? toneInk(tone) : toneWash(tone) }]}
    >
      <Ionicons name={icon} size={26} color={solid ? colors.paper : toneInk(tone)} />
    </PressScale>
  );
}

const SHOWN = 5;

function Log({ block, s, tone, change, preview }: PartProps) {
  const [all, setAll] = useState(false);
  const entries = s?.entries ?? [];
  const shown = all ? entries : entries.slice(0, SHOWN);
  const remove = (id: string) =>
    Alert.alert("Delete this entry?", undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => change({ block: block.id, op: "remove", item: id }),
      },
    ]);
  return (
    <View>
      <AddRow
        placeholder={block.placeholder || "Write an entry"}
        tone={tone}
        preview={preview}
        onAdd={(text) => change({ block: block.id, op: "add", text })}
      />
      {shown.map((e) => (
        <Pressable
          key={e.id}
          onLongPress={() => !preview && remove(e.id)}
          style={styles.entry}
          accessibilityHint="Press and hold to delete it"
        >
          <View style={[styles.dot, { backgroundColor: toneInk(tone) }]} />
          <View style={{ flex: 1 }}>
            <Text style={styles.itemText}>{e.text}</Text>
            <Text style={styles.meta}>{when(e.at)}</Text>
          </View>
        </Pressable>
      ))}
      {!entries.length && <Text style={styles.empty}>Entries you write, or tell OVOA, show here with the date.</Text>}
      {entries.length > SHOWN && (
        <Pressable onPress={() => setAll((a) => !a)} hitSlop={8} style={{ alignSelf: "flex-start", marginTop: space.s2 }}>
          <Text style={[styles.link, { color: toneInk(tone) }]}>{all ? "Show fewer" : `Show all ${entries.length}`}</Text>
        </Pressable>
      )}
    </View>
  );
}

function when(at: number) {
  const d = new Date(at);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const days = Math.round((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}, ${time}`;
}

function Timer({ block, tone, preview }: { block: AppBlock; tone: Tone; preview?: boolean }) {
  const total = (block.minutes ?? 10) * 60;
  const [left, setLeft] = useState(total);
  const [running, setRunning] = useState(false);
  const endsAt = useRef(0);
  useEffect(() => {
    if (!running) setLeft(total);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [total]);
  useEffect(() => {
    if (!running) return;
    // Counted from when it ends, not tick by tick, so a slow frame never loses time.
    const tick = setInterval(() => {
      const s = Math.max(0, Math.round((endsAt.current - Date.now()) / 1000));
      setLeft(s);
      if (s === 0) {
        setRunning(false);
        cue("done");
      }
    }, 250);
    return () => clearInterval(tick);
  }, [running]);
  const start = () => {
    const from = left === 0 ? total : left;
    endsAt.current = Date.now() + from * 1000;
    setLeft(from);
    setRunning(true);
  };
  const mm = Math.floor(left / 60);
  const ss = String(left % 60).padStart(2, "0");
  return (
    <View style={styles.counterRow}>
      <Text style={[styles.count, { flex: 1, color: running ? toneInk(tone) : colors.ink }]}>
        {mm}:{ss}
      </Text>
      <PressScale
        sink={0.93}
        disabled={preview}
        onPress={() => (running ? setRunning(false) : start())}
        accessibilityRole="button"
        style={[styles.timerBtn, { backgroundColor: toneInk(tone) }]}
      >
        <Ionicons name={running ? "pause" : "play"} size={18} color={colors.paper} />
        <Text style={styles.timerText}>{running ? "Pause" : left < total && left > 0 ? "Resume" : "Start"}</Text>
      </PressScale>
      <Pressable
        onPress={() => {
          setRunning(false);
          setLeft(total);
        }}
        disabled={preview || (left === total && !running)}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Reset"
      >
        <Ionicons name="refresh" size={22} color={left === total && !running ? colors.wash2 : colors.inkMute} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  part: {
    backgroundColor: colors.paper,
    borderRadius: radius.tile,
    borderWidth: 1,
    borderColor: colors.line,
    padding: space.s4,
    gap: space.s2,
  },
  title: { ...type.micro, color: colors.inkMute, textTransform: "uppercase" },
  meta: { ...type.meta, color: colors.inkMute },
  empty: { ...type.sub, color: colors.inkMute, paddingVertical: space.s2 },
  note: { ...type.sub, color: colors.inkDim },
  link: { ...type.meta, fontWeight: "600" },

  buttons: { flexDirection: "row", flexWrap: "wrap", gap: space.s2 },
  button: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: radius.pill,
    paddingHorizontal: 14,
    paddingVertical: 10,
    maxWidth: "100%",
  },
  buttonText: { fontSize: 15, fontWeight: "600" },

  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.s3,
    paddingVertical: 9,
  },
  itemText: { ...type.sub, color: colors.ink, flexShrink: 1 },
  itemDone: { color: colors.inkMute, textDecorationLine: "line-through" },

  addRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.s2,
    marginTop: space.s1,
  },
  addInput: {
    flex: 1,
    minHeight: 42,
    borderRadius: radius.chip,
    backgroundColor: colors.wash,
    paddingHorizontal: space.s3,
    color: colors.ink,
    fontSize: 16,
  },
  addBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
  },

  counterRow: { flexDirection: "row", alignItems: "center", gap: space.s3 },
  count: {
    fontSize: 40,
    lineHeight: 46,
    fontWeight: "600",
    letterSpacing: -1,
    ...numeric,
  },
  circle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
  },
  track: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.wash,
    overflow: "hidden",
    marginTop: space.s3,
  },
  trackFill: { height: 6, borderRadius: 3 },

  entry: {
    flexDirection: "row",
    gap: space.s3,
    paddingVertical: 8,
    alignItems: "flex-start",
  },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 7 },

  timerBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: radius.pill,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  timerText: { color: colors.paper, fontSize: 15, fontWeight: "600" },
});
