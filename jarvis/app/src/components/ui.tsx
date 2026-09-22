import Ionicons from "@expo/vector-icons/Ionicons";
import type { ComponentProps, ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useDrawer } from "../lib/drawer";
import { colors, numeric, radius, space, type } from "../lib/theme";

// Every part the white design is built out of. Screens compose these and add
// nothing of their own but layout: if a screen reaches for a hex value or a
// font size, the vocabulary is missing something and belongs here instead.

export type IconName = ComponentProps<typeof Ionicons>["name"];

/**
 * The icon tiles are the one place colour is identity rather than state — a
 * teal tile does not mean "now". Nothing else in the app may borrow these.
 */
export type Tone = "teal" | "violet" | "green" | "amber" | "coral" | "blue" | "pink";

const TONES: Record<Tone, { wash: string; ink: string }> = {
  teal: { wash: colors.nowWash, ink: colors.now },
  violet: { wash: colors.agentWash, ink: colors.agent },
  green: { wash: colors.doneWash, ink: colors.done },
  amber: { wash: colors.lateWash, ink: colors.late },
  coral: { wash: colors.stopWash, ink: colors.stop },
  blue: { wash: colors.blueWash, ink: colors.blue },
  pink: { wash: colors.pinkWash, ink: colors.pink },
};

export function IconTile({ name, tone, size = 30 }: { name: IconName; tone: Tone; size?: number }) {
  const t = TONES[tone];
  return (
    <View style={[styles.ico, { width: size, height: size, borderRadius: size * 0.3, backgroundColor: t.wash }]}>
      <Ionicons name={name} size={Math.round(size * 0.57)} color={t.ink} />
    </View>
  );
}

/** Hamburger, title, and a value on the right. On every screen reached from the drawer. */
export function TopBar({ title, when, right }: { title?: string; when?: string; right?: ReactNode }) {
  const drawer = useDrawer();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.topbar, { paddingTop: insets.top + space.s3 }]}>
      <Pressable
        onPress={drawer.open}
        hitSlop={10}
        style={styles.burger}
        accessibilityRole="button"
        accessibilityLabel="Open menu"
      >
        <Ionicons name="menu" size={24} color={colors.ink} />
      </Pressable>
      {!!title && <Text style={styles.topTitle}>{title}</Text>}
      <View style={{ flex: 1 }} />
      {!!when && <Text style={styles.when}>{when}</Text>}
      {right}
    </View>
  );
}

/** The body of every screen: one gutter, one bottom inset, no horizontal scroll. */
export function Screen({
  children,
  scroll = true,
  style,
  ...rest
}: { children: ReactNode; scroll?: boolean; style?: StyleProp<ViewStyle> } & Omit<
  ComponentProps<typeof ScrollView>,
  "children" | "style"
>) {
  const insets = useSafeAreaInsets();
  const pad = { paddingBottom: insets.bottom + space.s6 };
  if (!scroll) return <View style={[styles.screen, pad, style]}>{children}</View>;
  return (
    <ScrollView
      style={styles.screenScroll}
      contentContainerStyle={[styles.screen, pad]}
      showsVerticalScrollIndicator={false}
      {...rest}
    >
      {children}
    </ScrollView>
  );
}

/** A 2-up grid tile: icon, label, value. Nothing else. */
export function Tile({
  icon,
  tone,
  label,
  value,
  small,
  suffix,
  onPress,
  children,
}: {
  icon: IconName;
  tone: Tone;
  label: string;
  value: string;
  /** For values that are words rather than numbers, which need the room. */
  small?: boolean;
  suffix?: string;
  onPress?: () => void;
  children?: ReactNode;
}) {
  const body = (
    <>
      <IconTile name={icon} tone={tone} />
      <Text style={styles.tileLabel}>{label}</Text>
      <Text style={[styles.tileValue, small && styles.tileValueSm]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
        {!!suffix && <Text style={styles.tileSuffix}>{suffix}</Text>}
      </Text>
      {children}
    </>
  );
  if (!onPress) return <View style={styles.tile}>{body}</View>;
  return (
    <Pressable style={({ pressed }) => [styles.tile, pressed && styles.pressed]} onPress={onPress}>
      {body}
    </Pressable>
  );
}

export const Tiles = ({ children }: { children: ReactNode }) => <View style={styles.tiles}>{children}</View>;

/** A list row: icon, name, and whatever settles it. Divided by a hairline, never boxed. */
export function Row({
  icon,
  tone,
  title,
  value,
  right,
  onPress,
  first,
}: {
  icon?: IconName;
  tone?: Tone;
  title: string;
  value?: string;
  right?: ReactNode;
  onPress?: () => void;
  /** The first row in a group has no line above it. */
  first?: boolean;
}) {
  const body = (
    <>
      {!!icon && <IconTile name={icon} tone={tone ?? "blue"} />}
      <Text style={styles.rowTitle} numberOfLines={2}>
        {title}
      </Text>
      {!!value && <Text style={styles.rowValue}>{value}</Text>}
      {right}
    </>
  );
  if (!onPress) return <View style={[styles.row, first && styles.rowFirst]}>{body}</View>;
  return (
    <Pressable style={({ pressed }) => [styles.row, first && styles.rowFirst, pressed && styles.pressed]} onPress={onPress}>
      {body}
    </Pressable>
  );
}

/** Green when on, the way iOS does it. Teal is reserved for "now". */
export function Toggle({
  value,
  onValueChange,
  label,
}: {
  value: boolean;
  onValueChange: (on: boolean) => void;
  label?: string;
}) {
  return (
    <Switch
      value={value}
      onValueChange={onValueChange}
      accessibilityLabel={label}
      trackColor={{ true: colors.done, false: "#D3D8E0" }}
      thumbColor={colors.paper}
      ios_backgroundColor="#D3D8E0"
    />
  );
}

/**
 * `go` is the single most urgent button on a screen and the only one allowed
 * to be teal. Everything else is a wash, and `quiet` is barely a button at all.
 */
export function Btn({
  label,
  onPress,
  kind = "plain",
  disabled,
  busy,
  style,
}: {
  label: string;
  onPress: () => void;
  kind?: "go" | "plain" | "quiet" | "danger";
  disabled?: boolean;
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.btn,
        kind === "go" && styles.btnGo,
        kind === "quiet" && styles.btnQuiet,
        kind === "danger" && styles.btnDanger,
        (pressed || disabled || busy) && { opacity: disabled ? 0.4 : 0.7 },
        style,
      ]}
    >
      <Text
        style={[
          styles.btnText,
          kind === "go" && styles.btnTextGo,
          kind === "quiet" && styles.btnTextQuiet,
          kind === "danger" && styles.btnTextDanger,
        ]}
      >
        {busy ? "…" : label}
      </Text>
    </Pressable>
  );
}

/** A heading over a group of rows. Not a card — just a label and a hairline. */
export const GroupLabel = ({ children }: { children: ReactNode }) => <Text style={styles.groupLabel}>{children}</Text>;

export function Empty({
  icon,
  title,
  body,
  action,
}: {
  icon: IconName;
  title: string;
  body: string;
  action?: { label: string; onPress: () => void };
}) {
  return (
    <View style={styles.empty}>
      <Ionicons name={icon} size={30} color={colors.inkMute} />
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyBody}>{body}</Text>
      {action && <Btn label={action.label} onPress={action.onPress} />}
    </View>
  );
}

/** Something that came back wrong, said once, in the colour for it. */
export const Warn = ({ children }: { children: ReactNode }) => <Text style={styles.warn}>{children}</Text>;

export const text = StyleSheet.create({
  display: { ...type.display, color: colors.ink, ...numeric },
  title: { ...type.title, color: colors.ink },
  lead: { ...type.lead, color: colors.ink },
  head: { ...type.head, color: colors.ink },
  body: { ...type.body, color: colors.ink },
  sub: { ...type.sub, color: colors.inkDim },
  meta: { ...type.meta, color: colors.inkMute },
  micro: { ...type.micro, color: colors.inkMute, textTransform: "uppercase" },
  num: { ...numeric },
});

const styles = StyleSheet.create({
  ico: { alignItems: "center", justifyContent: "center" },

  topbar: { flexDirection: "row", alignItems: "center", gap: space.s3, paddingHorizontal: space.s5, paddingBottom: space.s4 },
  burger: { width: 40, height: 40, marginLeft: -8, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  topTitle: { ...type.title, color: colors.ink },
  when: { ...type.meta, color: colors.inkMute, ...numeric },

  screenScroll: { flex: 1, backgroundColor: colors.paper },
  screen: { paddingHorizontal: space.s5, gap: space.s3 },

  tiles: { flexDirection: "row", flexWrap: "wrap", gap: space.s3 },
  tile: {
    // Two to a row at any width: half of what is left after the gap.
    flexBasis: "47%",
    flexGrow: 1,
    backgroundColor: colors.wash,
    borderRadius: radius.tile,
    padding: space.s4,
    gap: space.s2,
  },
  tileLabel: { ...type.meta, color: colors.inkMute },
  tileValue: { ...type.lead, color: colors.ink, ...numeric },
  tileValueSm: { ...type.head },
  tileSuffix: { ...type.meta, color: colors.inkMute },

  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.s3,
    paddingVertical: space.s3,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  rowFirst: { borderTopWidth: 0 },
  rowTitle: { ...type.body, color: colors.ink, flex: 1 },
  rowValue: { ...type.meta, color: colors.inkMute, ...numeric },

  btn: {
    minHeight: 40,
    paddingHorizontal: 18,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.wash2,
  },
  btnGo: { backgroundColor: colors.now },
  btnQuiet: { backgroundColor: "transparent", paddingHorizontal: 10 },
  btnDanger: { backgroundColor: colors.stopWash },
  btnText: { ...type.sub, fontWeight: "600", color: colors.ink },
  btnTextGo: { color: colors.paper },
  btnTextQuiet: { color: colors.inkMute },
  btnTextDanger: { color: colors.stop },

  groupLabel: { ...type.meta, fontWeight: "600", color: colors.inkMute, paddingTop: space.s5, paddingBottom: space.s2 },

  empty: { alignItems: "center", gap: space.s3, paddingVertical: space.s8, paddingHorizontal: space.s4 },
  emptyTitle: { ...type.head, color: colors.ink, textAlign: "center" },
  emptyBody: { ...type.sub, color: colors.inkDim, textAlign: "center" },

  warn: { ...type.meta, color: colors.late },

  pressed: { opacity: 0.6 },
});
