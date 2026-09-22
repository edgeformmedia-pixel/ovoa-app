import { createContext, useContext } from "react";

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
