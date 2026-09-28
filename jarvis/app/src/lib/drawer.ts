import { createContext, useContext, useEffect, useState } from "react";
import { Dimensions } from "react-native";

/**
 * The left drawer's handle, kept in its own file so the panel and the top bars
 * that open it can both reach it without importing each other.
 */
export type DrawerHandle = {
  /** Resolves once the panel has finished sliding, so what's in it can be measured. */
  open: () => Promise<void>;
  close: () => Promise<void>;
  toggle: () => void;
};

const noop: DrawerHandle = { open: async () => {}, close: async () => {}, toggle: () => {} };

// While the tour is showing it drives the menu itself; a stray edge swipe
// opening or closing it under the tour left the spotlight pointing at nothing.
let locked = false;
export const setDrawerLocked = (on: boolean) => {
  locked = on;
};
export const drawerLocked = () => locked;

export const DrawerContext = createContext<DrawerHandle>(noop);

/** Safe before the drawer is mounted — sign-in and onboarding have no menu. */
export const useDrawer = () => useContext(DrawerContext);

// ---------- pointing at a row ----------
//
// The spoken tour (components/Tour.tsx) shows how the menu works by opening it
// and pointing at the row it is talking about, then tapping it. The row being
// pointed at is kept here so the tour and the panel don't import each other.

const pointers = new Set<(label: string | null) => void>();
let pointed: string | null = null;

/** Rings one menu row by its label, or none. */
export function pointAt(label: string | null) {
  pointed = label;
  pointers.forEach((p) => p(label));
}

/** The menu row being pointed at, if any. */
export function usePointedAt() {
  const [label, setLabel] = useState(pointed);
  useEffect(() => {
    pointers.add(setLabel);
    return () => void pointers.delete(setLabel);
  }, []);
  return label;
}

// ---------- where things are, for the spotlight ----------
//
// The tour's spotlight (components/Tour.tsx) needs to know where on screen the
// thing it's talking about is: a menu row, the menu itself, Apps' Create card.
// Each registers how to measure itself, and is measured at the moment it's
// pointed at, after the menu has slid open, not when it was laid out.

export type SpotRect = { x: number; y: number; width: number; height: number };
type Measurable = { measureInWindow: (cb: (x: number, y: number, width: number, height: number) => void) => void };

// Every mounted copy of a label, since tabs keep screens mounted: with one slot
// per label, the last to mount won and the first to unmount emptied it, and the
// spotlight lit nothing. Measuring picks whichever copy is on screen.
const spots = new Map<string, Set<Measurable>>();

/** For a `ref` callback: `ref={spotRef("Apps")}`. Each copy removes only itself. */
export const spotRef = (label: string) => (node: Measurable | null) => {
  if (!node) return;
  let set = spots.get(label);
  if (!set) spots.set(label, (set = new Set()));
  set.add(node);
  return () => void spots.get(label)?.delete(node);
};

function measureOne(node: Measurable): Promise<SpotRect | null> {
  const { width: W, height: H } = Dimensions.get("window");
  return new Promise((resolve) => {
    try {
      node.measureInWindow((x, y, width, height) => {
        const onScreen = width > 0 && height > 0 && x + width > 4 && x < W - 4 && y + height > 0 && y < H;
        resolve(onScreen ? { x, y, width, height } : null);
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * Where `label` is on screen right now, or null if it isn't there. Something
 * laid out off the edge (the menu, measured before it has slid in) counts as
 * not there, so the caller looks again rather than lighting empty space.
 */
export async function measureSpot(label: string): Promise<SpotRect | null> {
  for (const node of spots.get(label) ?? []) {
    const r = await measureOne(node);
    if (r) return r;
  }
  return null;
}

// ---------- opened by hand ----------
//
// The menu button during the tour: the tour steps aside (hides its card, stops
// talking and moving on) until the menu is closed again, rather than showing
// through on top of it. Only toggle() sets this; the tour's own open() never does.

const userMenuListeners = new Set<(on: boolean) => void>();
let userMenu = false;
export function setUserMenuOpen(on: boolean) {
  if (on === userMenu) return;
  userMenu = on;
  userMenuListeners.forEach((l) => l(on));
}

/** Whether the person opened the menu themselves and it is still open. */
export function useUserMenuOpen() {
  const [on, setOn] = useState(userMenu);
  useEffect(() => {
    userMenuListeners.add(setOn);
    return () => void userMenuListeners.delete(setOn);
  }, []);
  return on;
}
