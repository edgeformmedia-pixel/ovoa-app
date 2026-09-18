import data from "./catalog.json";

/**
 * Apple's built-in Shortcuts actions the assistant may use. Generated from the
 * ShortcutsBench dataset by scripts/build-shortcut-catalog.py.
 */

export type ParamSpec = { type: string; doc: string; enum?: string[]; default?: string };
export type ActionSpec = { title: string; desc: string; params: Record<string, ParamSpec>; returns?: string };

export const ACTION_PREFIX = "is.workflow.actions.";

const catalog = data as Record<string, ActionSpec>;

/** Accepts "gettext" or "is.workflow.actions.gettext". */
export function shortActionId(id: string) {
  return id.startsWith(ACTION_PREFIX) ? id.slice(ACTION_PREFIX.length) : id;
}

export function getAction(id: string): ActionSpec | undefined {
  return Object.hasOwn(catalog, id) ? catalog[id] : undefined;
}

/** What the user is warned about on the install card, by action. */
const SENSITIVE: Record<string, string> = {
  sendmessage: "send messages",
  sendemail: "send email",
  "facebook.messenger.send": "send messages",
  downloadurl: "use the internet",
  getwebpagecontents: "use the internet",
  "url.getheaders": "use the internet",
  runjavascriptonwebpage: "run code on web pages",
  openxcallbackurl: "open other apps",
  "file.delete": "delete files",
  "file.move": "move files",
  deletephotos: "delete photos",
  removeevents: "delete calendar events",
  removereminders: "delete reminders",
  "setters.calendarevents": "change calendar events",
  "setters.contacts": "change contacts",
  "setters.reminders": "change reminders",
  getcurrentlocation: "read your location",
  location: "read your location",
  getclipboard: "read your clipboard",
  "personalhotspot.password.get": "read your hotspot password",
  "personalhotspot.password.set": "change your hotspot password",
  "airplanemode.set": "change device settings",
  "cellulardata.set": "change device settings",
  "wifi.set": "change device settings",
  "bluetooth.set": "change device settings",
  "vpn.set": "change device settings",
  "wallpaper.set": "change your wallpaper",
  homeaccessory: "control Home accessories",
  airdropdocument: "share files",
  share: "share files",
  runworkflow: "run other shortcuts",
  reboot: "restart or shut down the device",
  logout: "log out",
};

export const sensitivity = (id: string) => SENSITIVE[id];

const words = (s: string): string[] => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/** Keyword search over action ids, titles, and descriptions. */
export function searchActions(query: string, limit = 8) {
  const terms = [...new Set(words(query))];
  if (!terms.length) return [];
  const scored = Object.entries(catalog).map(([id, a]) => {
    const title = words(a.title);
    const idWords = words(id);
    const desc = words(a.desc);
    let score = 0;
    for (const t of terms) {
      if (title.includes(t) || idWords.includes(t)) score += 3;
      else if (title.some((w) => w.startsWith(t)) || idWords.some((w) => w.startsWith(t))) score += 2;
      if (desc.includes(t)) score += 1;
    }
    return { id, a, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit)
    .map(({ id, a }) => describeAction(id, a));
}

/** The action as the model sees it. */
export function describeAction(id: string, a: ActionSpec) {
  return {
    action: id,
    title: a.title,
    description: a.desc,
    ...(a.returns && { output: a.returns }),
    params: Object.fromEntries(
      Object.entries(a.params).map(([name, p]) => [
        name,
        [p.type, p.doc, p.enum && `one of: ${p.enum.join(" | ")}`, p.default && `default ${p.default}`]
          .filter(Boolean)
          .join(" — "),
      ]),
    ),
  };
}

export const actionCount = Object.keys(catalog).length;
