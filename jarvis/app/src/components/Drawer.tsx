import Ionicons from "@expo/vector-icons/Ionicons";
import { useRouter, usePathname, type Href } from "expo-router";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Animated,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ADDONS, useInstalledAddons } from "../lib/addons";
import { useSession } from "../lib/auth";
import { useDevMode } from "../lib/devMode";
import { useMyApps } from "../lib/myApps";
import { BlurView } from "expo-blur";
import { DrawerContext, drawerLocked, spotRef, usePointedAt, type DrawerHandle } from "../lib/drawer";
import { PLAN_NAMES, usePlan } from "../lib/plan";
import { colors, lift, numeric, space, type } from "../lib/theme";
import { PressScale } from "./motion";
import { IconTile, type IconName, type Tone } from "./ui";

// The whole of navigation. Hand-rolled on core Animated + PanResponder rather
// than @react-navigation/drawer, from when the app avoided gesture-handler and
// reanimated. It has both now (2026-09-23, the motion pass) but the gesture
// here is tuned and works, so it stays; the panel settles on a spring and is
// frosted glass (expo-blur).
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

/** Extra panel off the left edge, so a spring that overshoots never opens a gap. */
const OVERHANG = 24;

export type NavItem = { label: string; href: Href; icon: IconName; tone: Tone };

/**
 * The menu (2026-09-23): Talk and Apps at the top, the apps you've added
 * listed under Apps, and Settings, which holds the account too, pinned at the
 * bottom. Nothing else ever joins them.
 */
export const TOP: NavItem[] = [
  { label: "Talk", href: "/chat", icon: "mic", tone: "teal" },
  { label: "Apps", href: "/apps" as Href, icon: "apps-outline", tone: "violet" },
];

// The free plan has no assistant to talk to, so its first row is its day
// (components/FreeToday.tsx) rather than Talk.
export const FREE_TOP: NavItem[] = [{ label: "Today", href: "/", icon: "time-outline", tone: "teal" }, TOP[1]];

export const SETTINGS: NavItem = { label: "Settings", href: "/settings", icon: "settings-outline", tone: "amber" };

/** One of their apps, as the menu lists it under Apps. */
export type MenuApp = { key: string; label: string; icon: IconName; tone: Tone; href?: Href; open: () => void };

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

// ---------- the panel ----------

export function DrawerPanel({
  current,
  tails,
  apps,
  onGo,
  onClose,
  free = false,
}: {
  /** The free plan: no assistant, so its day where Talk would be. */
  free?: boolean;
  /** The route showing behind the panel, so its row can be marked. */
  current: string;
  /** Only the values actually to hand; the rest of the rows go without. */
  tails: Record<string, string | undefined>;
  /** Their apps, in the order they added them. */
  apps: MenuApp[];
  onGo: (href: Href) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  // The spoken tour pointing at a row to show how the menu works.
  const pointed = usePointedAt();

  const row = (item: NavItem) => {
    const on = current === item.href;
    const tail = tails[item.label];
    return (
      <View key={item.label} ref={spotRef(item.label)} collapsable={false}>
        <PressScale
          onPress={() => onGo(item.href)}
          accessibilityRole="button"
          accessibilityState={{ selected: on }}
          style={[styles.navRow, on && styles.navRowOn, pointed === item.label && styles.navRowPointed]}
        >
          <IconTile name={item.icon} tone={item.tone} />
          <Text style={styles.navLabel} numberOfLines={1}>
            {item.label}
          </Text>
          {!!tail && <Text style={styles.navTail}>{tail}</Text>}
        </PressScale>
      </View>
    );
  };

  return (
    <View
      ref={spotRef("Menu")}
      style={[styles.panelBody, { paddingTop: insets.top + space.s4, paddingBottom: insets.bottom + space.s3 }]}
    >
      <View style={styles.head}>
        <Text style={styles.brand}>OVOA</Text>
        <Pressable onPress={onClose} hitSlop={10} style={styles.round} accessibilityLabel="Close menu">
          <Ionicons name="close" size={20} color={colors.ink} />
        </Pressable>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: space.s4 }}>
        {(free ? FREE_TOP : TOP).map(row)}

        {apps.length > 0 && (
          <View ref={spotRef("Your apps")} collapsable={false}>
            <Text style={styles.label}>Your apps</Text>
            {apps.map((a) => {
              const on = !!a.href && current === a.href;
              return (
                <PressScale
                  key={a.key}
                  onPress={a.open}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  style={[styles.appRow, on && styles.navRowOn]}
                >
                  <IconTile name={a.icon} tone={a.tone} size={26} />
                  <Text style={styles.appLabel} numberOfLines={1}>
                    {a.label}
                  </Text>
                </PressScale>
              );
            })}
          </View>
        )}
      </ScrollView>

      {/* Settings at the foot, where it's found without being in the way. */}
      <View style={styles.foot}>{row(SETTINGS)}</View>
    </View>
  );
}

// ---------- the panel, wired to the app ----------

export function AppDrawer({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { free, plan } = usePlan();
  const { token, user } = useSession();
  const devMode = useDevMode();
  const installed = useInstalledAddons();
  const made = useMyApps(token);

  // Only what is cheaply and truthfully to hand.
  const tails = {
    Settings: plan ? PLAN_NAMES[plan.tier] : undefined,
  };

  return (
    <DrawerHost
      panel={(close) => {
        // navigate, not push: opening the same screen twice from the menu must
        // never stack two of it.
        const go = (href: Href) => {
          close();
          router.navigate(href);
        };
        const apps: MenuApp[] = [
          ...installed
            .map((id) => ADDONS.find((a) => a.id === id))
            .filter((a): a is (typeof ADDONS)[number] => !!a && (devMode || !a.dev))
            .map((a) => ({ key: a.id, label: a.name, icon: a.icon, tone: a.tone, href: a.href, open: () => go(a.href) })),
          // The ones they made open on their own screen (app/made/[id].tsx).
          ...made.map((a) => ({
            key: a.id,
            label: a.name,
            icon: a.icon as IconName,
            tone: a.tone,
            href: `/made/${a.id}` as Href,
            open: () => go(`/made/${a.id}` as Href),
          })),
        ];
        return <DrawerPanel current={pathname} tails={tails} apps={user ? apps : []} free={free} onClose={close} onGo={go} />;
      }}
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
    (to: 0 | 1) =>
      new Promise<void>((resolve) => {
        openRef.current = to === 1;
        setOpen(to === 1);
        // A spring, so it lands rather than stops. It may go a little past open;
        // the panel is drawn wider than it looks (OVERHANG) so that never shows a gap.
        // Resolves when it has landed (or was overtaken): the tour measures rows
        // only then, because a native-driven slide isn't in the layout until it ends.
        Animated.spring(progress, { toValue: to, useNativeDriver: true, damping: 22, stiffness: 240, mass: 0.9 }).start(() => resolve());
      }),
    [progress],
  );

  const handle = useMemo<DrawerHandle>(
    () => ({
      open: () => settle(1),
      close: () => settle(0),
      toggle: () => void settle(openRef.current ? 0 : 1),
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
          if (drawerLocked()) return false;
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
          void settle((Math.abs(g.vx) > FLICK ? g.vx > 0 : at > SNAP) ? 1 : 0);
        },
        onPanResponderTerminate: () => void settle(openRef.current ? 1 : 0),
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
              left: -OVERHANG,
              width: panelWidth + OVERHANG,
              transform: [{ translateX: Animated.multiply(Animated.subtract(progress, 1), panelWidth + OVERHANG) }],
            },
          ]}
        >
          {/* Frosted glass: what's behind shows through, blurred, like Control Center. */}
          <View style={styles.glass}>
            <BlurView intensity={50} tint="light" style={StyleSheet.absoluteFill} />
            <View style={[StyleSheet.absoluteFill, styles.frost]} />
            <View style={{ flex: 1, paddingLeft: OVERHANG }}>{panel(handle.close)}</View>
          </View>
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

  scrim: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, zIndex: 9, backgroundColor: "rgba(12,14,18,0.22)" },

  panel: {
    position: "absolute",
    zIndex: 10,
    top: 0,
    bottom: 0,
    borderTopRightRadius: 26,
    borderBottomRightRadius: 26,
    ...lift,
  },
  glass: { flex: 1, borderTopRightRadius: 26, borderBottomRightRadius: 26, overflow: "hidden" },
  // Mostly white, so it's still the paper-white app; the blur is in the last fifth.
  frost: { backgroundColor: "rgba(255,255,255,0.78)" },
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
  // Teal, because it means "here, this one": the tour is showing where to tap.
  navRowPointed: { backgroundColor: colors.nowWash, borderWidth: 2, borderColor: colors.now, marginVertical: -2 },
  navLabel: { ...type.body, color: colors.ink, flex: 1 },
  navTail: { ...type.meta, color: colors.inkMute, ...numeric },
  label: {
    ...type.meta,
    fontWeight: "600",
    color: colors.inkMute,
    paddingHorizontal: space.s3,
    paddingTop: space.s5,
    paddingBottom: space.s1,
  },
  appRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.s3,
    paddingVertical: 7,
    paddingHorizontal: space.s3,
    borderRadius: 12,
  },
  appLabel: { ...type.sub, color: colors.ink, flex: 1 },
  foot: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, paddingTop: space.s3 },
});
