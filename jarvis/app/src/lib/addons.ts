import type { Href } from "expo-router";
import { useEffect, useState } from "react";
import type { IconName, Tone } from "../components/ui";
import { logFail } from "./devlog";
import { onSignOut } from "./signOut";
import { storage } from "./storage";

// Apps: everything in OVOA that isn't Talk, Account or Settings.
//
// The menu is four rows now (components/Drawer.tsx). Every other screen is an
// add-on that someone installs onto their OVOA from the Apps screen, and only
// what they installed is listed under "Your apps". Installing is a choice about
// what to see, nothing more: the screens are already in the app, so installing
// downloads nothing, and removing one only takes it off the list — whatever it
// had switched on (fall detection, the location timeline) stays as it was, and
// is turned off on its own screen or in Settings.
//
// `by` is the maker's name, shown as "by OVOA". Every add-on today is OVOA's
// own; the field is there so the catalog reads the same once it isn't.

export type AddonNeeds =
  /** Talking to the assistant: any paid plan. */
  | "assistant"
  /** Background work: Pro. */
  | "agent";

export type Addon = {
  id: string;
  name: string;
  by: string;
  /** One line, what it does for you. Shown in the list and searched. */
  about: string;
  icon: IconName;
  tone: Tone;
  href: Href;
  /** Which plan it comes with, if not every plan. */
  needs?: AddonNeeds;
  /** Installed on a phone that never chose. */
  preinstalled?: boolean;
  /** Only listed while dev mode is on (lib/devMode.ts). */
  dev?: boolean;
  /** Extra words search should find it by. */
  keywords?: string;
};

export const ADDONS: Addon[] = [
  {
    id: "brief",
    name: "Morning Brief",
    by: "OVOA",
    about: "Your day, read out to you each morning.",
    icon: "sunny-outline",
    tone: "amber",
    href: "/brief" as Href,
    needs: "assistant",
    preinstalled: true,
    keywords: "morning summary today news",
  },
  {
    id: "day",
    name: "Day",
    by: "OVOA",
    about: "Today on one timeline: what's next and what's done.",
    icon: "time-outline",
    tone: "violet",
    href: "/day" as Href,
    preinstalled: true,
    keywords: "timeline schedule calendar tasks todo list journal",
  },
  {
    id: "activity",
    name: "Activity",
    by: "OVOA",
    about: "Steps, heart rate and sleep from your band and Health.",
    icon: "pulse",
    tone: "coral",
    href: "/activity" as Href,
    preinstalled: true,
    keywords: "health steps heart rate bpm sleep fitness",
  },
  {
    id: "record",
    name: "Record",
    by: "OVOA",
    about: "Record notes on your phone or band and play them back.",
    icon: "radio-button-on",
    tone: "blue",
    href: "/record",
    preinstalled: true,
    keywords: "notes voice memo audio band clip es100",
  },
  {
    id: "safety",
    name: "Safety",
    by: "OVOA",
    about: "Fall detection that tells your emergency contacts.",
    icon: "shield-checkmark-outline",
    tone: "green",
    href: "/safety",
    keywords: "fall emergency contacts sos alert",
  },
  {
    id: "background",
    name: "Background Work",
    by: "OVOA",
    about: "OVOA works between chats and speaks up only when it matters.",
    icon: "git-branch-outline",
    tone: "pink",
    href: "/agent" as Href,
    needs: "agent",
    keywords: "agent automatic watch notify",
  },
  {
    id: "transcripts",
    name: "Transcripts",
    by: "OVOA",
    about: "Everything said to OVOA, by day, searchable.",
    icon: "document-text-outline",
    tone: "violet",
    href: "/transcripts" as Href,
    needs: "assistant",
    keywords: "history words search conversation",
  },

  // Developer: listed only in dev mode, and installed from the start for it.
  {
    id: "dev-tools",
    name: "Sensors & ES100",
    by: "OVOA",
    about: "The band's raw inputs and sensors, for testing.",
    icon: "hardware-chip-outline",
    tone: "amber",
    href: "/dev-tools",
    dev: true,
    preinstalled: true,
    keywords: "developer debug band motion gyro",
  },
  {
    id: "live",
    name: "Live Listen",
    by: "OVOA",
    about: "Hear what the band's microphone hears, live.",
    icon: "radio-outline",
    tone: "coral",
    href: "/live" as Href,
    dev: true,
    needs: "assistant",
    preinstalled: true,
    keywords: "developer microphone audio",
  },
  {
    id: "claude",
    name: "Ask Claude",
    by: "OVOA",
    about: "Ask Claude directly, without OVOA in between.",
    icon: "sparkles-outline",
    tone: "violet",
    href: "/claude" as Href,
    dev: true,
    needs: "assistant",
    preinstalled: true,
    keywords: "developer ai model",
  },
];

/** Case-insensitive, over the name, maker, description and keywords. Every word must match. */
export function searchAddons(list: Addon[], query: string) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  return list.filter((a) => {
    const hay = `${a.name} ${a.by} ${a.about} ${a.keywords ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

// ---------- what's installed on this phone ----------

const KEY = "ovoa.addons";
const listeners = new Set<(ids: string[]) => void>();
/** Read once, then kept, so the menu and the Apps screen agree without waiting on storage. */
let current: string[] | null = null;

const DEFAULTS = ADDONS.filter((a) => a.preinstalled).map((a) => a.id);

function publish(ids: string[]) {
  current = ids;
  listeners.forEach((l) => l(ids));
  storage.set(KEY, JSON.stringify(ids)).catch(logFail("addons: saving"));
}

export const installedAddons = {
  /** A phone that never chose gets the preinstalled set. */
  get: async (): Promise<string[]> => {
    if (current) return current;
    const raw = await storage.get(KEY).catch(() => null);
    try {
      const parsed = raw ? JSON.parse(raw) : null;
      current = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : DEFAULTS;
    } catch {
      current = DEFAULTS;
    }
    return current;
  },
  install: async (id: string) => {
    const ids = await installedAddons.get();
    if (!ids.includes(id)) publish([...ids, id]);
  },
  remove: async (id: string) => {
    const ids = await installedAddons.get();
    publish(ids.filter((x) => x !== id));
  },
};

// Someone else signing in on this phone picks their own apps.
onSignOut("installed apps", async () => {
  current = null;
  await storage.remove(KEY);
});

/** The ids installed on this phone, in the order they were installed. */
export function useInstalledAddons() {
  const [ids, setIds] = useState<string[]>(current ?? DEFAULTS);
  useEffect(() => {
    installedAddons.get().then(setIds);
    listeners.add(setIds);
    return () => void listeners.delete(setIds);
  }, []);
  return ids;
}
