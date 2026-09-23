import { createContext, useContext, useEffect, useState } from "react";

/**
 * The left drawer's handle, kept in its own file so the panel and the top bars
 * that open it can both reach it without importing each other.
 */
export type DrawerHandle = {
  open: () => void;
  close: () => void;
  toggle: () => void;
};

const noop: DrawerHandle = { open: () => {}, close: () => {}, toggle: () => {} };

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
