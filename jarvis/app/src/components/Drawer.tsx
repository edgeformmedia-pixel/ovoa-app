import Ionicons from "@expo/vector-icons/Ionicons";
import { useRouter, usePathname, type Href } from "expo-router";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Animated,
  Easing,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAgent } from "../lib/agent";
import { useSession } from "../lib/auth";
import { DrawerContext, type DrawerHandle } from "../lib/drawer";
import { usePlan } from "../lib/plan";
import { colors, lift, numeric, space, type } from "../lib/theme";
import { IconTile, type IconName, type Tone } from "./ui";

// The whole of navigation. Hand-rolled on core Animated + PanResponder rather
// than @react-navigation/drawer: that would make gesture-handler and
// reanimated direct dependencies and cost a new dev build before any of this
// could be run, and the app is tested in Expo Go every day.
//
// Split in three on purpose: DrawerPanel is a pure view that can be rendered
// and looked at on its own, AppDrawer is the one that reads the app's state,
// and DrawerHost is only the panel, the scrim and the gesture.

/** How far in from the left edge a drag still counts as reaching for the menu. */
const EDGE = 28;
/** Past this much of the panel, letting go opens it. */
const SNAP = 0.4;
/** A flick this fast decides it whatever the distance. */
const FLICK = 0.35;

const EASE = Easing.bezier(0.32, 0.72, 0, 1);

export type NavItem = { label: string; href: Href; icon: IconName; tone: Tone };

/** The seven screens, in the order the design puts them. */
export const MAIN: NavItem[] = [
  { label: "Talk", href: "/chat", icon: "mic", tone: "teal" },
  { label: "Brief", href: "/brief" as Href, icon: "sunny-outline", tone: "amber" },
  { label: "Activity", href: "/", icon: "pulse", tone: "coral" },
  { label: "Day", href: "/day" as Href, icon: "time-outline", tone: "violet" },
  { label: "Record", href: "/record", icon: "radio-button-on", tone: "blue" },
  { label: "Safety", href: "/safety", icon: "shield-checkmark-outline", tone: "green" },
  { label: "Background", href: "/agent" as Href, icon: "git-branch-outline", tone: "pink" },
];

export const MORE: NavItem[] = [
  { label: "Settings", href: "/settings", icon: "settings-outline", tone: "blue" },
  { label: "Transcripts", href: "/transcripts" as Href, icon: "document-text-outline", tone: "violet" },
  { label: "Report a problem", href: "/report-bug" as Href, icon: "bug-outline", tone: "coral" },
];

// The two shortcuts the Activity tab used to carry, plus dev tools. The design
// has nowhere else for them and losing them would make this rework a net
// negative, so they get their own group. Motion lab and the ES100 screen stay
// where they are, inside dev tools.
export const DEV: NavItem[] = [
  { label: "Sensors & ES100", href: "/dev-tools", icon: "hardware-chip-outline", tone: "amber" },
  { label: "Live listen", href: "/live" as Href, icon: "radio-outline", tone: "coral" },
  { label: "Ask Claude", href: "/claude" as Href, icon: "sparkles-outline", tone: "violet" },
];

// The free plan's menu: its day, its recordings, safety, and the way out.
// Talk, Brief, Background work and Transcripts are the assistant's, and the
// home screen's one card says so; the menu doesn't list them to say it again.
// Home is the day itself on the free plan (components/FreeToday.tsx).
export const FREE_MAIN: NavItem[] = [
  { label: "Today", href: "/", icon: "time-outline", tone: "violet" },
  { label: "Record", href: "/record", icon: "radio-button-on", tone: "blue" },
  { label: "Safety", href: "/safety", icon: "shield-checkmark-outline", tone: "green" },
];
const ASSISTANT_ONLY = new Set(["Transcripts", "Live listen", "Ask Claude"]);

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

// ---------- the panel ----------

export function DrawerPanel({
  current,
  tails,
  recent,
  onGo,
  onClose,
  free = false,
}: {
  /** The free plan: no assistant, so no Talk and no assistant screens. */
  free?: boolean;
  /** The route showing behind the panel, so its row can be marked. */
  current: string;
  /** Only the values actually to hand; the rest of the rows go without. */
  tails: Record<string, string | undefined>;
  /** What OVOA said today, newest first. Empty is the normal state. */
  recent: { id: string; title: string }[];
  onGo: (href: Href) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();

  const row = (item: NavItem) => {
    const on = current === item.href;
    const tail = tails[item.label];
    return (
      <Pressable
        key={item.label}
        onPress={() => onGo(item.href)}
        accessibilityRole="button"
        accessibilityState={{ selected: on }}
        style={({ pressed }) => [styles.navRow, on && styles.navRowOn, pressed && { opacity: 0.6 }]}
      >
        <IconTile name={item.icon} tone={item.tone} />
        <Text style={styles.navLabel} numberOfLines={1}>
          {item.label}
        </Text>
        {!!tail && <Text style={styles.navTail}>{tail}</Text>}
      </Pressable>
    );
  };

  return (
    <View style={[styles.panelBody, { paddingTop: insets.top + space.s4, paddingBottom: insets.bottom + space.s4 }]}>
      <View style={styles.head}>
        <Text style={styles.brand}>OVOA</Text>
        <Pressable onPress={onClose} hitSlop={10} style={styles.round} accessibilityLabel="Close menu">
          <Ionicons name="close" size={20} color={colors.ink} />
        </Pressable>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: space.s4 }}>
        {(free ? FREE_MAIN : MAIN).map(row)}

        {/* "Today" is what OVOA actually said today, not a list of screens. An
            agent that had nothing to say shows nothing here, which is the point
            of it — see docs/agent.md. */}
        {recent.length > 0 && (
          <>
            <Text style={styles.label}>Today</Text>
            {recent.map((n) => (
              <Pressable key={n.id} onPress={() => onGo("/day" as Href)} style={({ pressed }) => (pressed ? { opacity: 0.6 } : null)}>
                <Text style={styles.recent} numberOfLines={1}>
                  {n.title}
                </Text>
              </Pressable>
            ))}
          </>
        )}

        <Text style={styles.label}>More</Text>
        {MORE.filter((i) => !free || !ASSISTANT_ONLY.has(i.label)).map(row)}

        <Text style={styles.label}>Developer</Text>
        {DEV.filter((i) => !free || !ASSISTANT_ONLY.has(i.label)).map(row)}
      </ScrollView>

      {!free && (
        <View style={styles.talk}>
          <Pressable
            onPress={() => onGo("/chat")}
            style={({ pressed }) => [styles.pill, pressed && { opacity: 0.8 }]}
            accessibilityRole="button"
          >
            <Ionicons name="mic" size={19} color={colors.paper} />
            <Text style={styles.pillText}>Talk</Text>
          </Pressable>
          <Pressable onPress={() => onGo("/agent" as Href)} hitSlop={8} style={styles.round} accessibilityLabel="Background work">
            <Ionicons name="git-branch-outline" size={18} color={colors.ink} />
          </Pressable>
        </View>
      )}
    </View>
  );
}

// ---------- the panel, wired to the app ----------

export function AppDrawer({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { user } = useSession();
  const { notes, unread } = useAgent();
  const { free, can } = usePlan();

  const today = new Date().toLocaleDateString("en-CA");
  const recent = notes
    .filter((n) => new Date(n.created_at).toLocaleDateString("en-CA") === today)
    .slice(0, 4)
    .map((n) => ({ id: n.id, title: n.title }));

  // Only what is cheaply and truthfully to hand. The mock shows a value beside
  // every row; inventing the rest would be worse than leaving them blank.
  const tails = {
    Day: unread ? `${unread} new` : undefined,
    Safety: user?.settings.fallDetection ? "Armed" : "Off",
    // Background work is part of Pro; on Base its row says so rather than opening onto a surprise.
    Background: can.agent ? undefined : "Pro",
  };

  return (
    <DrawerHost
      panel={(close) => (
        <DrawerPanel
          current={pathname}
          tails={tails}
          recent={recent}
          free={free}
          onClose={close}
          onGo={(href) => {
            close();
            // navigate, not push: opening the same screen twice from the menu
            // must never stack two of it.
            router.navigate(href);
          }}
        />
      )}
    >
      {children}
    </DrawerHost>
  );
}

// ---------- the panel, the scrim and the gesture ----------

export function DrawerHost({
  children,
  panel,
}: {
  children: ReactNode;
  panel: (close: () => void) => ReactNode;
}) {
  const { width } = useWindowDimensions();
  // 79% of the screen, as the mock has it, but never so wide on a large phone
  // that the panel stops reading as a panel.
  const panelWidth = Math.min(340, Math.round(width * 0.79));

  const progress = useRef(new Animated.Value(0)).current;
  const [open, setOpen] = useState(false);
  // The gesture callbacks are made once and never see a re-render, so they read
  // the state from here rather than from `open`.
  const openRef = useRef(false);
  const startX = useRef(0);

  const settle = useCallback(
    (to: 0 | 1) => {
      openRef.current = to === 1;
      setOpen(to === 1);
      Animated.timing(progress, { toValue: to, duration: 280, easing: EASE, useNativeDriver: true }).start();
    },
    [progress],
  );

  const handle = useMemo<DrawerHandle>(
    () => ({
      open: () => settle(1),
      close: () => settle(0),
      toggle: () => settle(openRef.current ? 0 : 1),
    }),
    [settle],
  );

  const pan = useMemo(
    () =>
      PanResponder.create({
        // Never claims a tap. Capture is used only to remember where the finger
        // went down, because that is what decides whether a drag is an edge drag.
        onStartShouldSetPanResponderCapture: (e) => {
          startX.current = e.nativeEvent.pageX;
          return false;
        },
        // Taken in the capture phase so an edge drag beats a ScrollView to it.
        // The predicate needs a clearly sideways drag, so a vertical scroll is
        // never stolen.
        onMoveShouldSetPanResponderCapture: (_e, g) => {
          const sideways = Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5;
          if (!sideways) return false;
          return openRef.current ? g.dx < 0 : startX.current <= EDGE && g.dx > 0;
        },
        // Once the drawer has the drag, nothing else may take it. The default
        // answer is yes, which lets the ScrollView underneath ask for the
        // responder part-way through and strand the panel wherever the finger
        // was, because Release then never fires — only Terminate does.
        //
        // The same symptom is reproducible in a browser, where it is the
        // browser's own drag-and-drop that cancels the pointer stream rather
        // than another responder; that one cannot be refused from here and is
        // web-only, so it does not affect the phone.
        onPanResponderTerminationRequest: () => false,
        // And on iOS, stop the scroll view scrolling underneath the gesture.
        onShouldBlockNativeResponder: () => true,
        onPanResponderMove: (_e, g) => {
          const from = openRef.current ? panelWidth : 0;
          progress.setValue(clamp((from + g.dx) / panelWidth, 0, 1));
        },
        onPanResponderRelease: (_e, g) => {
          const from = openRef.current ? panelWidth : 0;
          const at = clamp((from + g.dx) / panelWidth, 0, 1);
          settle((Math.abs(g.vx) > FLICK ? g.vx > 0 : at > SNAP) ? 1 : 0);
        },
        onPanResponderTerminate: () => settle(openRef.current ? 1 : 0),
      }),
    [panelWidth, progress, settle],
  );

  return (
    <DrawerContext.Provider value={handle}>
      <View style={styles.host} {...pan.panHandlers}>
        {children}

        <Animated.View pointerEvents={open ? "auto" : "none"} style={[styles.scrim, { opacity: progress }]}>
          <Pressable style={styles.fill} onPress={handle.close} accessibilityLabel="Close menu" />
        </Animated.View>

        <Animated.View
          style={[
            styles.panel,
            {
              width: panelWidth,
              transform: [{ translateX: Animated.multiply(Animated.subtract(progress, 1), panelWidth) }],
            },
          ]}
        >
          {panel(handle.close)}
        </Animated.View>
      </View>
    </DrawerContext.Provider>
  );
}

const styles = StyleSheet.create({
  host: {
    flex: 1,
    backgroundColor: colors.paper,
    // An app shell is not a document, and the study's own phone frame says the
    // same. On iOS this changes nothing. On web it reduces, but does not
    // remove, the browser starting its own text-selection drag part-way
    // through an edge drag and cancelling the pointer stream — see the note on
    // onPanResponderTerminationRequest below. Anything that wants to be
    // selectable (the crash screen, the log panel, an approval summary) still
    // sets it on itself and wins.
    userSelect: "none",
  },
  fill: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 },

  scrim: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, zIndex: 9, backgroundColor: "rgba(12,14,18,0.30)" },

  panel: {
    position: "absolute",
    zIndex: 10,
    top: 0,
    bottom: 0,
    left: 0,
    backgroundColor: colors.paper,
    borderTopRightRadius: 26,
    borderBottomRightRadius: 26,
    ...lift,
  },
  panelBody: { flex: 1, paddingHorizontal: space.s4 },

  head: { flexDirection: "row", alignItems: "center", paddingHorizontal: space.s3, paddingBottom: space.s5 },
  brand: { ...type.title, color: colors.ink },
  round: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.wash,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: "auto",
  },

  navRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.s4,
    paddingVertical: 10,
    paddingHorizontal: space.s3,
    borderRadius: 12,
    marginBottom: 2,
  },
  navRowOn: { backgroundColor: colors.wash },
  navLabel: { ...type.body, color: colors.ink, flex: 1 },
  navTail: { ...type.meta, color: colors.inkMute, ...numeric },

  label: {
    ...type.meta,
    fontWeight: "600",
    color: colors.inkMute,
    paddingHorizontal: space.s3,
    paddingTop: space.s5,
    paddingBottom: space.s2,
  },
  recent: { ...type.sub, color: colors.inkDim, paddingVertical: 8, paddingHorizontal: space.s3 },

  talk: { flexDirection: "row", alignItems: "center", gap: space.s3, paddingTop: space.s4 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.s2,
    backgroundColor: colors.now,
    borderRadius: 24,
    paddingVertical: 13,
    paddingHorizontal: 22,
  },
  pillText: { ...type.body, fontWeight: "600", color: colors.paper },
});
