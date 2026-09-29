// The browser agent's rules that need no browser (browser.ts): which moves
// exist, which need a YES, which addresses it will open. Kept apart so they
// can be tested without Cloudflare's runtime.

/** Words that make a click or Enter a step that needs a YES whatever the model said. */
export const RISKY = /\b(pay|buy|purchase|place (?:your )?order|complete (?:order|purchase)|checkout|check out|confirm (?:order|booking|purchase|payment|reservation)|book (?:now|it)|reserve|subscribe|donate|send|post|publish|tweet|delete|remove|cancel|close account|unsubscribe|transfer|withdraw|deposit|submit|apply|sign up|register|change (?:password|email)|save changes)\b/i;

export type Mark = { id: number; tag: string; type: string; label: string };
export type Move =
  | { action: "goto"; url: string }
  | { action: "click"; id: number }
  | { action: "type"; id: number; text: string; enter?: boolean }
  | { action: "select"; id: number; value: string }
  | { action: "scroll"; dir: "up" | "down" }
  | { action: "key"; key: string }
  | { action: "wait" }
  | { action: "needs_approval"; summary: string }
  | { action: "need_login"; site?: string }
  | { action: "done"; result: string }
  | { action: "fail"; reason: string };

export const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** Only web pages: never a file, an app link, or an address inside the network. */
export function safeUrl(raw: string): string | null {
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const h = u.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || !h.includes(".")) return null;
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(h) || h.includes(":")) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

/** The first {...} in what the model said, as a move; null when it isn't one. */
export function parseMove(text: string): Move | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let raw: any;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const id = Number(raw?.id);
  switch (raw?.action) {
    case "goto": return typeof raw.url === "string" ? { action: "goto", url: raw.url } : null;
    case "click": return Number.isInteger(id) ? { action: "click", id } : null;
    case "type": return Number.isInteger(id) ? { action: "type", id, text: String(raw.text ?? ""), enter: raw.enter === true } : null;
    case "select": return Number.isInteger(id) ? { action: "select", id, value: String(raw.value ?? "") } : null;
    case "scroll": return { action: "scroll", dir: raw.dir === "up" ? "up" : "down" };
    case "key": return typeof raw.key === "string" ? { action: "key", key: raw.key } : null;
    case "wait": return { action: "wait" };
    case "needs_approval": return { action: "needs_approval", summary: clip(raw.summary, 300) || "the next step" };
    case "need_login": return { action: "need_login", site: clip(raw.site, 80) };
    case "done": return { action: "done", result: clip(raw.result, 1200) };
    case "fail": return { action: "fail", reason: clip(raw.reason, 300) };
    default: return null;
  }
}

/** True when the move is one that needs a YES on its own account, whatever the model said. */
export function isRisky(move: Move, marks: Mark[]) {
  if (move.action === "click") return RISKY.test(marks.find((m) => m.id === move.id)?.label ?? "");
  if (move.action === "type" && move.enter) return RISKY.test(marks.find((m) => m.id === move.id)?.label ?? "");
  return false;
}

