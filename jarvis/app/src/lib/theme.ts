import type { TextStyle } from "react-native";

// OVOA's look: white paper, one teal accent that only ever means "now, or your
// turn", and a violet that only ever marks something the background agent did
// on its own. Ported from the approved "one day, one spine" study.
//
// Everything below is the whole vocabulary. If a screen needs a value that
// isn't here, the screen is wrong, not the scale.

export const colors = {
  // ---- surfaces ----
  paper: "#FFFFFF",
  wash: "#F4F5F7",
  wash2: "#EAECF0",
  line: "#E4E7EC",

  // ---- text ----
  ink: "#0C0E12",
  inkDim: "#5A6270",
  inkMute: "#8B93A1",

  // ---- the spine ----
  rail: "#D6DAE1",
  railNext: "#EDEFF3",

  // ---- state. now is the only accent. ----
  now: "#0E8CA8",
  nowWash: "#E1F3F8",
  agent: "#5B4FC7",
  agentWash: "#ECEAFB",
  done: "#1C8C5E",
  doneWash: "#E2F3EB",
  late: "#B0761A",
  lateWash: "#FBF0DC",
  stop: "#D24540",
  stopWash: "#FCE9E8",

  // ---- identity, for icon tiles only. Never state. ----
  blue: "#2E6FE8",
  blueWash: "#E6EEFD",
  pink: "#C7488F",
  pinkWash: "#FBE8F3",

};

export const space = { s1: 4, s2: 8, s3: 12, s4: 16, s5: 20, s6: 24, s8: 32, s10: 40 } as const;

export const type = {
  display: { fontSize: 44, lineHeight: 46, fontWeight: "600", letterSpacing: -1.5 },
  /**
   * The voice screen's one word — Listening, Thinking…, Speaking. The study
   * sets it at 28/400, lighter than anything else at that size, because it is
   * a state and not a heading. It is the only place this is used.
   */
  phase: { fontSize: 28, lineHeight: 32, fontWeight: "400", letterSpacing: -0.3 },
  title: { fontSize: 22, lineHeight: 28, fontWeight: "600" },
  /** A moment that is due now — the one thing on the screen that is bigger. */
  lead: { fontSize: 19, lineHeight: 26, fontWeight: "600" },
  head: { fontSize: 17, lineHeight: 23, fontWeight: "600" },
  body: { fontSize: 17, lineHeight: 23, fontWeight: "500" },
  sub: { fontSize: 15, lineHeight: 21, fontWeight: "400" },
  meta: { fontSize: 13, lineHeight: 20, fontWeight: "400" },
  micro: { fontSize: 11, lineHeight: 14, fontWeight: "500", letterSpacing: 0.9 },
} as const;

export const radius = { chip: 12, pill: 22, tile: 20, sheet: 26 } as const;

/**
 * Wherever digits stack: the time column, steps, bpm, run counts.
 *
 * Deliberately not `["tabular-nums"] as const`. React Native 0.86 types
 * `TextStyle["fontVariant"]` as a mutable `FontVariant[]`, so a readonly tuple
 * is not assignable to it — spreading this into a style would stop the style
 * being a TextStyle at all, and `StyleSheet.create` would silently widen every
 * entry in the sheet to `ViewStyle | TextStyle | ImageStyle`.
 */
export const numeric: { fontVariant: TextStyle["fontVariant"] } = { fontVariant: ["tabular-nums"] };

/**
 * The mock is set in IBM Plex. Nothing loads a font file here, so this is the
 * closest thing iOS already has: SF for prose, and the system monospace for
 * the time column, which is the only place the mock's mono actually matters.
 */
export const mono = { fontFamily: "Menlo" } as const;

/** The drawer, and the one shadow on the voice screen's orb. Nothing else lifts. */
export const lift = {
  shadowColor: "#101828",
  shadowOpacity: 0.18,
  shadowRadius: 22,
  shadowOffset: { width: 0, height: 10 },
  elevation: 6,
};
