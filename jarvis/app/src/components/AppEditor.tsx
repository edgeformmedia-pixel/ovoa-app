import Ionicons from "@expo/vector-icons/Ionicons";
import { useState, type ReactNode } from "react";
import { Alert, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";
import { api, type AppBlock, type AppContents, type AppDraft, type BlockKind } from "../lib/api";
import { APP_ICONS, APP_TONES, BLOCK_INFO, BLOCK_KINDS, MAX_BLOCKS, MAX_BUTTONS, newBlock } from "../lib/appKit";
import { cue } from "../lib/cues";
import { useDictation } from "../lib/dictation";
import { colors, radius, space, type } from "../lib/theme";
import { AppBlocks } from "./AppBlocks";
import { Glimmer, PressScale } from "./motion";
import { IconTile, Toggle, toneInk, toneWash, type IconName, type Tone } from "./ui";

// Everything about a made app, in their hands.
//
// A live preview of its screen at the top, so every change shows as it's made.
// Under it, the quickest way to change anything: say or type what to change
// ("add a button for dessert ideas", "make it green") and OVOA rewrites the app,
// with Undo. Then every piece by hand: the name and line under it, the icon and
// colour, the parts of its screen (add, reorder, edit, remove), and how it
// behaves — what it says first, its instructions, whether it reads answers out.
//
// Used by Create for a new app before it's saved, and by Edit for one they have.
// Nothing here saves; the screen that holds it does.

type Props = {
  draft: AppDraft;
  /** What's in it now, for the preview; a new app has nothing yet. */
  contents?: AppContents;
  onChange: (draft: AppDraft) => void;
  token: string;
  assistant: string;
};

export function AppEditor({ draft, contents = {}, onChange, token, assistant }: Props) {
  const [change, setChange] = useState("");
  const [changing, setChanging] = useState(false);
  const [undo, setUndo] = useState<AppDraft | null>(null);
  const [changeError, setChangeError] = useState<string | null>(null);
  const [openPart, setOpenPart] = useState<string | null>(null);
  const tone = draft.tone as Tone;
  const set = (patch: Partial<AppDraft>) => onChange({ ...draft, ...patch });

  const revise = async (said?: string) => {
    const what = (said ?? change).trim();
    if (what.length < 2 || changing) return;
    setChanging(true);
    setChangeError(null);
    try {
      const { draft: next } = await api.reviseApp(token, draft, what);
      setUndo(draft);
      onChange(next);
      setChange("");
      cue("created", { sound: false });
    } catch (err) {
      setChangeError(err instanceof Error ? err.message : String(err));
    } finally {
      setChanging(false);
    }
  };
  const dictation = useDictation(token, (said) => {
    setChange(said);
    void revise(said);
  });

  // ---- the parts ----
  const setBlock = (id: string, patch: Partial<AppBlock>) =>
    set({
      blocks: draft.blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)),
    });
  const move = (i: number, by: -1 | 1) => {
    const blocks = [...draft.blocks];
    const j = i + by;
    if (j < 0 || j >= blocks.length) return;
    [blocks[i], blocks[j]] = [blocks[j], blocks[i]];
    set({ blocks });
  };
  const removeBlock = (b: AppBlock) =>
    Alert.alert(
      `Remove "${b.title}"?`,
      b.kind === "list" || b.kind === "log" || b.kind === "counter" ? "What's in it goes too, once you save." : undefined,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => set({ blocks: draft.blocks.filter((x) => x.id !== b.id) }),
        },
      ],
    );
  const addBlock = (kind: BlockKind) => {
    if (draft.blocks.length >= MAX_BLOCKS) return Alert.alert(`Up to ${MAX_BLOCKS} parts`, "Remove one to make room.");
    const b = newBlock(kind);
    set({ blocks: [...draft.blocks, b] });
    setOpenPart(b.id);
  };

  return (
    <View style={{ gap: space.s2 }}>
      {/* ---------- Preview ---------- */}
      <View style={styles.phone}>
        <View style={[styles.phoneHead, { backgroundColor: toneWash(tone) }]}>
          <IconTile name={draft.icon as IconName} tone={tone} size={44} />
          <View style={{ flex: 1 }}>
            <Text style={styles.phoneName} numberOfLines={1}>
              {draft.name || "Untitled"}
            </Text>
            <Text style={styles.phoneAbout} numberOfLines={2}>
              {draft.about}
            </Text>
          </View>
        </View>
        <View style={styles.phoneBody}>
          {!!draft.opener && <Text style={styles.phoneOpener}>{draft.opener}</Text>}
          {draft.blocks.length ? (
            <AppBlocks blocks={draft.blocks} state={contents} tone={tone} preview />
          ) : (
            <Text style={styles.hint}>No parts yet. Add some below, or say what you want.</Text>
          )}
        </View>
      </View>

      {/* ---------- Change it by saying so ---------- */}
      <Section title="Change it by saying so" icon="sparkles-outline">
        <View style={styles.changeRow}>
          {dictation.listening ? (
            <Text style={[styles.input, styles.changeInput, { color: toneInk(tone) }]}>{dictation.words || "Listening…"}</Text>
          ) : (
            <Field
              value={change}
              onChangeText={setChange}
              placeholder="e.g. Add a counter for glasses of water"
              style={styles.changeInput}
              editable={!changing}
              onSubmitEditing={() => void revise()}
              returnKeyType="go"
              submitBehavior="blurAndSubmit"
            />
          )}
          <Pressable
            onPress={() => (dictation.listening ? dictation.stop() : change.trim() ? void revise() : void dictation.start())}
            disabled={changing}
            style={[
              styles.roundBtn,
              {
                backgroundColor: change.trim() || dictation.listening ? toneInk(tone) : toneWash(tone),
              },
            ]}
            accessibilityRole="button"
            accessibilityLabel={dictation.listening ? "Stop listening" : change.trim() ? "Change it" : "Say what to change"}
          >
            <Ionicons
              name={dictation.listening ? "stop" : change.trim() ? "arrow-forward" : "mic"}
              size={20}
              color={change.trim() || dictation.listening ? colors.paper : toneInk(tone)}
            />
          </Pressable>
        </View>
        {changing && <Glimmer text="Changing it…" style={{ color: toneInk(tone), fontSize: 15 }} />}
        {!!(changeError || dictation.error) && <Text style={styles.error}>{changeError ?? dictation.error}</Text>}
        {undo && !changing && (
          <Pressable
            onPress={() => {
              onChange(undo);
              setUndo(null);
            }}
            hitSlop={8}
            style={styles.undo}
          >
            <Ionicons name="arrow-undo" size={15} color={colors.inkDim} />
            <Text style={styles.undoText}>Undo that change</Text>
          </Pressable>
        )}
      </Section>

      {/* ---------- Look ---------- */}
      <Section title="Name and look" icon="color-palette-outline">
        <Label>Name</Label>
        <Field value={draft.name} onChangeText={(name) => set({ name })} maxLength={30} placeholder="My App" />
        <Label>Under the name</Label>
        <Field value={draft.about} onChangeText={(about) => set({ about })} maxLength={90} placeholder="What it does, in a line" />
        <Label>Colour</Label>
        <View style={styles.swatches}>
          {APP_TONES.map((t) => (
            <Pressable
              key={t}
              onPress={() => set({ tone: t })}
              style={[styles.swatch, { backgroundColor: toneInk(t) }, t === tone && styles.swatchOn]}
              accessibilityRole="radio"
              accessibilityState={{ selected: t === tone }}
              accessibilityLabel={t}
            >
              {t === tone && <Ionicons name="checkmark" size={18} color={colors.paper} />}
            </Pressable>
          ))}
        </View>
        <Label>Icon</Label>
        <View style={styles.icons}>
          {APP_ICONS.map((icon) => (
            <Pressable
              key={icon}
              onPress={() => set({ icon })}
              style={[
                styles.icon,
                icon === draft.icon && {
                  backgroundColor: toneWash(tone),
                  borderColor: toneInk(tone),
                },
              ]}
              accessibilityRole="radio"
              accessibilityState={{ selected: icon === draft.icon }}
              accessibilityLabel={String(icon).replace(/-outline$/, "")}
            >
              <Ionicons name={icon} size={22} color={icon === draft.icon ? toneInk(tone) : colors.inkDim} />
            </Pressable>
          ))}
        </View>
      </Section>

      {/* ---------- The screen ---------- */}
      <Section title="What's on its screen" icon="grid-outline">
        {draft.blocks.map((b, i) => {
          const open = openPart === b.id;
          const info = BLOCK_INFO[b.kind];
          return (
            <View key={b.id} style={styles.part}>
              <Pressable
                onPress={() => setOpenPart(open ? null : b.id)}
                style={styles.partHead}
                accessibilityRole="button"
                accessibilityState={{ expanded: open }}
              >
                <Ionicons name={info.icon} size={20} color={toneInk(tone)} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.partTitle} numberOfLines={1}>
                    {b.title}
                  </Text>
                  <Text style={styles.partKind}>{info.name}</Text>
                </View>
                <Pressable onPress={() => move(i, -1)} disabled={i === 0} hitSlop={6} accessibilityLabel="Move up" style={styles.partIcon}>
                  <Ionicons name="chevron-up" size={20} color={i === 0 ? colors.wash2 : colors.inkDim} />
                </Pressable>
                <Pressable
                  onPress={() => move(i, 1)}
                  disabled={i === draft.blocks.length - 1}
                  hitSlop={6}
                  accessibilityLabel="Move down"
                  style={styles.partIcon}
                >
                  <Ionicons name="chevron-down" size={20} color={i === draft.blocks.length - 1 ? colors.wash2 : colors.inkDim} />
                </Pressable>
                <Pressable onPress={() => removeBlock(b)} hitSlop={6} accessibilityLabel={`Remove ${b.title}`} style={styles.partIcon}>
                  <Ionicons name="trash-outline" size={18} color={colors.stop} />
                </Pressable>
              </Pressable>
              {open && <PartFields block={b} tone={tone} onChange={(patch) => setBlock(b.id, patch)} />}
            </View>
          );
        })}
        <Label>Add a part</Label>
        <View style={styles.kinds}>
          {BLOCK_KINDS.map((k) => (
            <PressScale
              key={k}
              sink={0.94}
              onPress={() => addBlock(k)}
              style={styles.kind}
              accessibilityRole="button"
              accessibilityLabel={`Add a ${BLOCK_INFO[k].name}`}
              accessibilityHint={BLOCK_INFO[k].about}
            >
              <Ionicons name={BLOCK_INFO[k].icon} size={16} color={toneInk(tone)} />
              <Text style={styles.kindText}>{BLOCK_INFO[k].name}</Text>
            </PressScale>
          ))}
        </View>
      </Section>

      {/* ---------- Behaviour ---------- */}
      <Section title="How it behaves" icon="chatbubble-ellipses-outline">
        <Label>What it says when you open it</Label>
        <Field value={draft.opener} onChangeText={(opener) => set({ opener })} maxLength={160} placeholder="e.g. What are we out of?" />
        <Label>What it tells {assistant} to do</Label>
        <Field
          value={draft.instructions}
          onChangeText={(instructions) => set({ instructions })}
          maxLength={1500}
          multiline
          style={{ minHeight: 120, textAlignVertical: "top" }}
          placeholder={`Written to ${assistant}: what to do when you use this app`}
        />
        <View style={styles.toggleRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.partTitle}>Read answers out loud</Text>
            <Text style={styles.partKind}>Off: answers only show on its screen</Text>
          </View>
          <Toggle value={draft.speak} onValueChange={(speak) => set({ speak })} label="Read answers out loud" />
        </View>
      </Section>
    </View>
  );
}

/** The fields for one part, by kind. */
function PartFields({ block: b, tone, onChange }: { block: AppBlock; tone: Tone; onChange: (patch: Partial<AppBlock>) => void }) {
  const num = (v: string) => {
    const n = Number(v.replace(/[^\d.]/g, ""));
    return Number.isFinite(n) ? n : 0;
  };
  const buttons = b.buttons ?? [];
  return (
    <View style={styles.fields}>
      <Label>Title</Label>
      <Field value={b.title} onChangeText={(title) => onChange({ title })} maxLength={40} />
      {b.kind === "buttons" && (
        <>
          {buttons.map((x, i) => (
            <View key={i} style={styles.buttonEdit}>
              <View style={{ flex: 1, gap: space.s1 }}>
                <Field
                  value={x.label}
                  onChangeText={(label) =>
                    onChange({
                      buttons: buttons.map((y, j) => (j === i ? { ...y, label } : y)),
                    })
                  }
                  maxLength={28}
                  placeholder="Button"
                />
                <Field
                  value={x.prompt}
                  onChangeText={(prompt) =>
                    onChange({
                      buttons: buttons.map((y, j) => (j === i ? { ...y, prompt } : y)),
                    })
                  }
                  maxLength={300}
                  multiline
                  placeholder="What it asks OVOA"
                  style={{ fontSize: 14 }}
                />
              </View>
              <Pressable
                onPress={() => onChange({ buttons: buttons.filter((_, j) => j !== i) })}
                hitSlop={8}
                accessibilityLabel="Remove this button"
              >
                <Ionicons name="close-circle" size={22} color={colors.inkMute} />
              </Pressable>
            </View>
          ))}
          {buttons.length < MAX_BUTTONS && (
            <Pressable onPress={() => onChange({ buttons: [...buttons, { label: "", prompt: "" }] })} style={styles.undo} hitSlop={8}>
              <Ionicons name="add" size={16} color={toneInk(tone)} />
              <Text style={[styles.undoText, { color: toneInk(tone) }]}>Add a button</Text>
            </Pressable>
          )}
        </>
      )}
      {(b.kind === "list" || b.kind === "log") && (
        <>
          <Label>Hint in the empty box</Label>
          <Field value={b.placeholder ?? ""} onChangeText={(placeholder) => onChange({ placeholder })} maxLength={60} />
        </>
      )}
      {b.kind === "counter" && (
        <>
          <Label>What it counts</Label>
          <Field value={b.unit ?? ""} onChangeText={(unit) => onChange({ unit })} maxLength={20} placeholder="e.g. glasses" />
          <View style={{ flexDirection: "row", gap: space.s3 }}>
            <View style={{ flex: 1 }}>
              <Label>Goal</Label>
              <Field
                value={b.goal ? String(b.goal) : ""}
                onChangeText={(v) => onChange({ goal: num(v) || null })}
                keyboardType="number-pad"
                placeholder="None"
              />
            </View>
            <View style={{ flex: 1 }}>
              <Label>Each tap</Label>
              <Field value={String(b.step ?? 1)} onChangeText={(v) => onChange({ step: Math.max(1, num(v)) })} keyboardType="number-pad" />
            </View>
          </View>
          <View style={styles.toggleRow}>
            <Text style={[styles.partTitle, { flex: 1 }]}>Start again each day</Text>
            <Toggle value={b.daily !== false} onValueChange={(daily) => onChange({ daily })} label="Start again each day" />
          </View>
        </>
      )}
      {b.kind === "timer" && (
        <>
          <Label>Minutes</Label>
          <Field
            value={String(b.minutes ?? 10)}
            onChangeText={(v) => onChange({ minutes: Math.min(240, Math.max(1, num(v))) })}
            keyboardType="number-pad"
          />
        </>
      )}
      {b.kind === "note" && (
        <>
          <Label>Words</Label>
          <Field
            value={b.text ?? ""}
            onChangeText={(text) => onChange({ text })}
            maxLength={1000}
            multiline
            style={{ minHeight: 90, textAlignVertical: "top" }}
          />
        </>
      )}
    </View>
  );
}

function Section({ title, icon, children }: { title: string; icon: IconName; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Ionicons name={icon} size={18} color={colors.ink} />
        <Text style={styles.sectionTitle}>{title}</Text>
      </View>
      {children}
    </View>
  );
}

const Label = ({ children }: { children: ReactNode }) => <Text style={styles.label}>{children}</Text>;

/** A text box with iOS AutoFill off: it put its bar over the buttons under it. */
function Field(props: TextInputProps) {
  return (
    <TextInput
      placeholderTextColor={colors.inkMute}
      textContentType="none"
      autoComplete="off"
      importantForAutofill="no"
      {...props}
      style={[styles.input, props.style]}
    />
  );
}

const styles = StyleSheet.create({
  phone: {
    borderRadius: radius.sheet,
    borderWidth: 1,
    borderColor: colors.line,
    overflow: "hidden",
    backgroundColor: colors.paper,
  },
  phoneHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.s3,
    padding: space.s4,
  },
  phoneName: { ...type.head, color: colors.ink },
  phoneAbout: { ...type.meta, color: colors.inkDim },
  phoneBody: { padding: space.s3, gap: space.s3, backgroundColor: colors.wash },
  phoneOpener: { ...type.sub, color: colors.ink, paddingHorizontal: space.s1 },
  hint: { ...type.sub, color: colors.inkMute, padding: space.s2 },

  section: { paddingTop: space.s5, gap: space.s2 },
  sectionHead: { flexDirection: "row", alignItems: "center", gap: space.s2 },
  sectionTitle: { ...type.head, color: colors.ink },
  label: {
    ...type.meta,
    fontWeight: "600",
    color: colors.inkMute,
    paddingTop: space.s2,
  },
  input: {
    minHeight: 44,
    borderRadius: radius.chip,
    backgroundColor: colors.wash,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: space.s3,
    paddingVertical: 10,
    color: colors.ink,
    fontSize: 16,
  },
  error: { ...type.meta, color: colors.stop },

  changeRow: { flexDirection: "row", alignItems: "center", gap: space.s2 },
  changeInput: { flex: 1 },
  roundBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  undo: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    paddingVertical: space.s1,
  },
  undoText: { ...type.meta, fontWeight: "600", color: colors.inkDim },

  swatches: { flexDirection: "row", flexWrap: "wrap", gap: space.s3 },
  swatch: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  swatchOn: {
    borderWidth: 3,
    borderColor: colors.paper,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
  },
  icons: { flexDirection: "row", flexWrap: "wrap", gap: space.s2 },
  icon: {
    width: 44,
    height: 44,
    borderRadius: radius.chip,
    borderWidth: 1.5,
    borderColor: "transparent",
    backgroundColor: colors.wash,
    alignItems: "center",
    justifyContent: "center",
  },

  part: {
    borderRadius: radius.tile,
    borderWidth: 1,
    borderColor: colors.line,
    overflow: "hidden",
  },
  partHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.s3,
    padding: space.s3,
  },
  partTitle: { ...type.sub, fontWeight: "600", color: colors.ink },
  partKind: { ...type.meta, color: colors.inkMute },
  partIcon: { padding: 4 },
  fields: {
    paddingHorizontal: space.s3,
    paddingBottom: space.s3,
    gap: space.s1,
  },
  buttonEdit: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.s2,
    paddingTop: space.s2,
  },
  kinds: { flexDirection: "row", flexWrap: "wrap", gap: space.s2 },
  kind: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  kindText: { ...type.meta, fontWeight: "600", color: colors.ink },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.s3,
    paddingTop: space.s3,
  },
});
