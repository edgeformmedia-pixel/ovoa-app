import type { AppBlock, AppContents, AppDraft, AppOp, BlockKind, BlockState } from "./api";
import type { IconName, Tone } from "../components/ui";

// The kit a made app is built from (server: api/src/myapps.ts). The icons and
// tones are the server's lists, kept in step by hand; the parts are what the
// editor offers and AppBlocks draws.

export const APP_ICONS: IconName[] = [
  "sparkles-outline",
  "cart-outline",
  "restaurant-outline",
  "fitness-outline",
  "barbell-outline",
  "medkit-outline",
  "book-outline",
  "school-outline",
  "briefcase-outline",
  "cash-outline",
  "home-outline",
  "car-outline",
  "airplane-outline",
  "paw-outline",
  "leaf-outline",
  "musical-notes-outline",
  "chatbubbles-outline",
  "people-outline",
  "heart-outline",
  "moon-outline",
  "sunny-outline",
  "calendar-outline",
  "checkbox-outline",
  "bulb-outline",
  "gift-outline",
  "language-outline",
  "water-outline",
  "cafe-outline",
];
export const APP_TONES: Tone[] = ["teal", "violet", "green", "amber", "coral", "blue", "pink"];
export const MAX_BLOCKS = 8;
export const MAX_BUTTONS = 6;

/** What the editor calls each part, and says about it. */
export const BLOCK_INFO: Record<BlockKind, { name: string; icon: IconName; about: string }> = {
  buttons: {
    name: "Buttons",
    icon: "grid-outline",
    about: "Quick actions: each one asks OVOA something",
  },
  list: {
    name: "Checklist",
    icon: "checkbox-outline",
    about: "Items you tick off. OVOA can add to it",
  },
  counter: {
    name: "Counter",
    icon: "add-circle-outline",
    about: "Count up with + and -, with a goal",
  },
  log: {
    name: "Log",
    icon: "journal-outline",
    about: "Dated entries, kept over time",
  },
  timer: {
    name: "Timer",
    icon: "timer-outline",
    about: "A countdown you start",
  },
  note: {
    name: "Note",
    icon: "document-text-outline",
    about: "Words you want to see every time",
  },
};
export const BLOCK_KINDS = Object.keys(BLOCK_INFO) as BlockKind[];

const shortId = () => Math.random().toString(36).slice(2, 12);

/** A fresh part of `kind`, ready to edit. */
export function newBlock(kind: BlockKind): AppBlock {
  const id = shortId();
  switch (kind) {
    case "buttons":
      return {
        id,
        kind,
        title: "Quick actions",
        buttons: [{ label: "Help me", prompt: "What can you help me with here?" }],
      };
    case "list":
      return { id, kind, title: "List", placeholder: "Add an item" };
    case "counter":
      return {
        id,
        kind,
        title: "Count",
        unit: "",
        goal: null,
        step: 1,
        daily: true,
      };
    case "log":
      return { id, kind, title: "Log", placeholder: "Write an entry" };
    case "timer":
      return { id, kind, title: "Timer", minutes: 10 };
    case "note":
      return { id, kind, title: "Note", text: "" };
  }
}

/** Today, on this phone, the way the server keys a daily counter (YYYY-MM-DD). */
export function today() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const counterValue = (block: AppBlock, s: BlockState | undefined, day = today()) =>
  block.daily && s?.day !== day ? 0 : (s?.value ?? 0);

/**
 * The server's applyOp, for showing a tap at once. The server's answer
 * replaces this a moment later, so an id made up here never sticks.
 */
export function applyLocal(blocks: AppBlock[], state: AppContents, op: AppOp): AppContents {
  const block = blocks.find((b) => b.id === op.block);
  if (!block) return state;
  const cur: BlockState = { ...(state[block.id] ?? {}) };
  if (block.kind === "list") {
    let items = [...(cur.items ?? [])];
    if (op.op === "add" && op.text?.trim())
      items.push({
        id: `local-${shortId()}`,
        text: op.text.trim(),
        done: false,
      });
    if (op.op === "toggle") items = items.map((x) => (x.id === op.item ? { ...x, done: op.done ?? !x.done } : x));
    if (op.op === "remove") items = items.filter((x) => x.id !== op.item);
    if (op.op === "clear_done") items = items.filter((x) => !x.done);
    cur.items = items;
  } else if (block.kind === "log") {
    let entries = [...(cur.entries ?? [])];
    if (op.op === "add" && op.text?.trim()) entries = [{ id: `local-${shortId()}`, text: op.text.trim(), at: Date.now() }, ...entries];
    if (op.op === "remove") entries = entries.filter((x) => x.id !== op.item);
    cur.entries = entries;
  } else if (block.kind === "counter") {
    let value = counterValue(block, cur);
    if (op.op === "count") value += op.amount ?? block.step ?? 1;
    if (op.op === "set" && op.value !== undefined) value = op.value;
    cur.value = Math.round(value * 100) / 100;
    cur.day = today();
  }
  return { ...state, [block.id]: cur };
}

/** What must be there before an app can be saved; the server refuses the same. */
export function missingFrom(d: AppDraft) {
  if (!d.name.trim()) return "It needs a name.";
  if (!d.about.trim()) return "It needs a line under the name.";
  if (!d.instructions.trim()) return "It needs instructions: what it tells OVOA to do.";
  return null;
}
