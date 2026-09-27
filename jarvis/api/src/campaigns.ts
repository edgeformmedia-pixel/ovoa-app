// Campaigns: one approval, many targets.
//
// "Email these 80 landlords the same note with their name in it", "look up the
// opening hours of every place on my list", "tell my friends the party moved".
// campaign_start writes the plan down and parks ONE pending action showing the
// count and the estimated cost. Nothing happens until that is approved: the
// approver (approvers.ts) is the only thing that sets approved_at, and the cron
// (campaignsTick, index.ts) only works campaigns that are running with an
// approved action. It does a few items per tick, only in the person's daytime.
//
// Caps are here in code, not in the prompt: research 500 items, email 200 sent
// per person per rolling day (from their own Gmail), friends only to their
// accepted OVOA connections through the network's own limits (network.ts).
// Numbers on the do-not-contact list (keywords.ts) are skipped.

import { Hono } from "hono";
import { describeToolCall, kindForTool, logAction } from "./actionlog";
import { registerApprover } from "./approvers";
import { parkAction, validTimeZone } from "./google/assistant";
import { googleAccessToken, listGoogleAccounts } from "./google/oauth";
import { toolsByName } from "./google/tools";
import { hasOutlook, sendOutlookMail } from "./microsoft";
import { readList } from "./lists";
import { isModelRefused, type CallTool, type ToolSpec } from "./llm";
import { shareWithConnection } from "./network";
import { push, type PushMessage } from "./push";
import { noDashes } from "./sentences";
import { buckets, inQuietHours, localMinutes } from "./time";
import type { Env, Vars } from "./types";
import { searchWeb } from "./web";
import { blockedFor } from "./plans";

/** Campaigns are off unless the CAMPAIGNS var is "1": no tools, and the cron leaves running ones alone. */
export const campaignsOn = (env: Pick<Env, "CAMPAIGNS">) => env.CAMPAIGNS === "1";

export type Mode = "email" | "research" | "friends";
export const MODES: Mode[] = ["email", "research", "friends"];

/** Most items one campaign may have, by mode. */
export const MAX_ITEMS: Record<Mode, number> = { research: 500, email: 1_000, friends: 50 };
/** Emails a person's campaigns send in any 24 hours, from their own Gmail. */
export const EMAILS_PER_DAY = 200;
/** Items one campaign works per cron tick. */
export const ITEMS_PER_TICK = 5;
/** Campaigns a person may have waiting or running at once. */
export const MAX_ACTIVE = 3;
/** Daytime, local: never before this or after DAY_END, and never in their quiet hours. */
export const DAY_START = 8 * 60;
export const DAY_END = 21 * 60;
/** A rough cost of one research item (a grounded search), in micro-dollars, for the approval card. */
export const RESEARCH_MICRO_PER_ITEM = 3_000;

const RESULT_MAX = 2_000;
const TEXT_MAX = 4_000;
const DAY_MS = 24 * 3_600_000;

type Item = Record<string, unknown>;

export type CampaignRow = {
  id: string;
  user_id: string;
  mode: Mode;
  title: string;
  instructions: string;
  subject: string | null;
  mailbox: string | null;
  status: "proposed" | "running" | "done" | "stopped";
  action_id: string | null;
  approved_at: number | null;
  item_count: number;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
};

/** What the tick uses to reach the outside world. Swapped for fakes in the tests. */
export type CampaignIo = {
  /** `via`: the mailbox the approval named; null for a campaign from before that was kept. */
  sendEmail: (env: Env, userId: string, mail: { to: string; subject: string; body: string }, via?: "Gmail" | "Outlook" | null) => Promise<void>;
  research: (env: Env, userId: string, query: string, today: string) => Promise<string>;
  tellFriend: (env: Env, userId: string, username: string, text: string, timeZone: string) => Promise<unknown>;
  push: (env: Env, userId: string, message: PushMessage) => Promise<number>;
  now: () => number;
};

async function gmailAccount(env: Env, userId: string) {
  const accounts = await listGoogleAccounts(env.DB, userId);
  const canMail = (a: (typeof accounts)[number]) => a.scopes.some((s) => s.includes("gmail") || s.includes("mail.google.com"));
  return accounts.find((a) => a.isDefault && canMail(a)) ?? accounts.find(canMail) ?? null;
}

/** Which mailbox an email campaign sends from: Gmail when they have it, else Outlook (microsoft.ts). */
async function mailbox(env: Env, userId: string): Promise<"Gmail" | "Outlook" | null> {
  if (await gmailAccount(env, userId)) return "Gmail";
  return (await hasOutlook(env, userId)) ? "Outlook" : null;
}

async function sendFromMailbox(env: Env, userId: string, mail: { to: string; subject: string; body: string }, via: "Gmail" | "Outlook" | null = null) {
  // Only from the mailbox they approved: connecting or removing one later never moves the campaign to another.
  if (via === "Outlook") {
    if (!(await hasOutlook(env, userId))) throw new Error("Outlook isn't connected any more.");
    return sendOutlookMail(env, userId, mail);
  }
  const account = await gmailAccount(env, userId);
  if (via === "Gmail" && !account) throw new Error("Gmail isn't connected any more.");
  if (account) {
    const ctx = { token: await googleAccessToken(env, userId, account.id), timeZone: "UTC" };
    await toolsByName.get("gmail_send")!.run(ctx, mail);
    return;
  }
  if (await hasOutlook(env, userId)) return sendOutlookMail(env, userId, mail);
  throw new Error("No Google account with Gmail is connected.");
}

async function researchOnWeb(env: Env, userId: string, query: string, today: string) {
  const found = await searchWeb(env, userId, query, today);
  const text = found.answer || (found.snippets ?? []).map((s) => `${s.title}: ${s.text}`).join("\n") || found.note || "";
  const sources = (found.sources ?? []).slice(0, 3).map((s) => s.url);
  return [text.trim(), sources.length ? `Sources: ${sources.join(" ")}` : ""].filter(Boolean).join("\n");
}

export const realIo: CampaignIo = {
  sendEmail: sendFromMailbox,
  research: researchOnWeb,
  tellFriend: shareWithConnection,
  push,
  now: () => Date.now(),
};

// ---------- Pure pieces ----------

/** The fields a template asks for: "{name}" and "{ city }" give name and city. */
export function placeholders(template: string): string[] {
  return [...new Set([...template.matchAll(/\{\s*([A-Za-z_][\w ]{0,40}?)\s*\}/g)].map((m) => m[1]!))];
}

/** Fills "{field}" from the item; a field the item doesn't have becomes empty. */
export function render(template: string, item: Item): string {
  return template.replace(/\{\s*([A-Za-z_][\w ]{0,40}?)\s*\}/g, (_, key: string) => {
    const v = item[key];
    return v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  });
}

export const isEmail = (v: unknown) => typeof v === "string" && /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(v.trim());

/** Digits of a phone number in +E.164 form, for the do-not-contact list. US ten-digit numbers get +1. */
export function phoneKey(v: unknown): string | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const digits = String(v).replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;
  return null;
}

/** Inside their daytime: 8 AM to 9 PM local, and outside their quiet hours. */
export function inDaytime(at: number, timeZone: string, quietStart: number | null, quietEnd: number | null) {
  const m = localMinutes(at, timeZone);
  if (m < DAY_START || m >= DAY_END) return false;
  return !inQuietHours(at, timeZone, quietStart ?? 1320, quietEnd ?? 420);
}

/** "$1.50", from micro-dollars. */
export const dollars = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;

export function estimateText(mode: Mode, count: number) {
  if (mode === "research") return `about ${dollars(count * RESEARCH_MICRO_PER_ITEM)} of your plan's AI spend`;
  if (mode === "email") return "no AI cost (the same email with each person's details filled in)";
  return "no AI cost on your side";
}

/** A CSV cell that can't run as a formula when opened in a spreadsheet. */
export function csvCell(v: unknown): string {
  let s = v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(items: { idx: number; status: string; data: Item; result: string | null }[]) {
  const fields: string[] = [];
  for (const i of items) for (const k of Object.keys(i.data)) if (!fields.includes(k)) fields.push(k);
  const head = ["#", ...fields, "status", "result"];
  const lines = [head.map(csvCell).join(",")];
  for (const i of items) lines.push([i.idx + 1, ...fields.map((f) => i.data[f]), i.status, i.result ?? ""].map(csvCell).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

const clean = (v: unknown, max: number) =>
  String(v ?? "")
    .replace(/\r/g, "")
    .trim()
    .slice(0, max);

function plainItems(value: unknown): Item[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((r): r is Item => !!r && typeof r === "object" && !Array.isArray(r));
}

const parseItem = (text: string): Item => {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Item) : {};
  } catch {
    return {};
  }
};

// ---------- Starting one ----------

export type Plan = { mode: Mode; title: string; instructions: string; subject: string; items: Item[] };

/** Checks a proposed campaign. Returns the plan, or the error the model can say. */
export function checkPlan(args: Record<string, unknown>, items: Item[] | null): Plan | { error: string } {
  const mode = String(args.mode ?? "") as Mode;
  if (!MODES.includes(mode)) return { error: "mode must be email, research or friends" };
  const title = clean(args.title, 120);
  const instructions = clean(args.instructions, TEXT_MAX);
  const subject = clean(args.subject, 200);
  if (!title) return { error: "title is required" };
  if (!instructions) return { error: "instructions are required: the text for each item, with {field} placeholders" };
  if (!items || !items.length) return { error: "items are required: a list of objects, or the name of a saved list" };
  if (items.length > MAX_ITEMS[mode]) return { error: `A ${mode} campaign can have up to ${MAX_ITEMS[mode]} items; this has ${items.length}.` };
  const missing = placeholders(`${subject}\n${instructions}`).filter((f) => !items.some((i) => i[f] !== undefined && i[f] !== ""));
  if (missing.length) return { error: `No item has ${missing.map((f) => `{${f}}`).join(", ")}. Fix the fields or the text.` };
  if (mode === "email") {
    if (!subject) return { error: "subject is required for an email campaign" };
    const bad = items.filter((i) => !isEmail(i.email)).length;
    if (bad) return { error: `${bad} of the items have no valid email field. Every item needs one.` };
  }
  if (mode === "friends") {
    const bad = items.filter((i) => typeof i.username !== "string" || !String(i.username).trim()).length;
    if (bad) return { error: `${bad} of the items have no username. Friends campaigns only go to their OVOA friends, by @username.` };
  }
  return { mode, title, instructions, subject, items };
}

/** The approval card: what will happen, how many, how much, and the first one filled in. */
export function approvalSummary(plan: Plan, via: "Gmail" | "Outlook" = "Gmail") {
  const n = plan.items.length;
  const first = plan.items[0]!;
  const what =
    plan.mode === "email"
      ? `email ${n} ${n === 1 ? "person" : "people"} from your ${via}, up to ${EMAILS_PER_DAY} a day`
      : plan.mode === "friends"
        ? `send a note to ${n} of your OVOA friends`
        : `look up ${n} ${n === 1 ? "thing" : "things"} on the web`;
  const sample =
    plan.mode === "email"
      ? `To ${String(first.email)}\nSubject: ${render(plan.subject, first)}\n\n${render(plan.instructions, first)}`
      : plan.mode === "friends"
        ? `To @${String(first.username).replace(/^@/, "")}: ${render(plan.instructions, first)}`
        : render(plan.instructions, first);
  return noDashes(
    [
      `Run "${plan.title}": ${what}, only in the daytime.`,
      `Estimated cost: ${estimateText(plan.mode, n)}.`,
      `The first one:\n${sample.slice(0, 900)}`,
    ].join("\n\n"),
  );
}

export async function startCampaign(env: Env, userId: string, args: Record<string, unknown>, now = Date.now()) {
  const db = env.DB;
  let items = plainItems(args.items);
  if ((!items || !items.length) && typeof args.list === "string" && args.list.trim()) {
    const list = await readList(db, userId, clean(args.list, 80));
    if (!list) return { error: `They have no list called "${clean(args.list, 80)}".` };
    // Rows a Friend added to a shared list (lists.ts addedBy) aren't theirs to email.
    items = list.rows.filter((r) => typeof r.addedBy !== "string");
    const friends = list.rows.length - items.length;
    if (friends && !items.length) return { error: `Every row of "${list.name}" was added by a Friend; a campaign only goes to rows they added themselves.` };
  }
  const plan = checkPlan(args, items);
  if ("error" in plan) return plan;
  const active = await db
    .prepare("SELECT COUNT(*) AS n FROM campaigns WHERE user_id = ? AND status IN ('proposed', 'running')")
    .bind(userId)
    .first<{ n: number }>();
  if ((active?.n ?? 0) >= MAX_ACTIVE) return { error: `They already have ${MAX_ACTIVE} campaigns waiting or running. Stop one first (campaign_stop).` };

  const id = crypto.randomUUID();
  const via = plan.mode === "email" ? ((await mailbox(env, userId)) ?? "Gmail") : null;
  const statements = [
    db
      .prepare(
        "INSERT INTO campaigns (id, user_id, mode, title, instructions, subject, mailbox, status, item_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?)",
      )
      .bind(id, userId, plan.mode, plan.title, plan.instructions, plan.subject || null, via, plan.items.length, now, now),
    ...plan.items.map((item, idx) => db.prepare("INSERT INTO campaign_items (campaign_id, idx, data) VALUES (?, ?, ?)").bind(id, idx, JSON.stringify(item))),
  ];
  for (let i = 0; i < statements.length; i += 100) await db.batch(statements.slice(i, i + 100));

  const summary = approvalSummary(plan, via ?? "Gmail");
  const action = await parkAction(env, userId, CAMPAIGN_RUN, { campaignId: id }, summary, false);
  await db.prepare("UPDATE campaigns SET action_id = ? WHERE id = ?").bind(action.id, id).run();
  return { action, result: { status: "waiting_for_user_approval", campaignId: id, items: plan.items.length, note: "Nothing has been sent. The user sees an Approve button with the count and cost; it runs only after they approve." } };
}

// ---------- The approval ----------

export const CAMPAIGN_RUN = "campaign_run";

/** Approving the one pending action is the only way a campaign starts running. */
registerApprover(CAMPAIGN_RUN, async (env, userId, args) => {
  const id = String(args.campaignId ?? "");
  const now = Date.now();
  const row = await env.DB
    .prepare(
      "UPDATE campaigns SET status = 'running', approved_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status = 'proposed' AND action_id IS NOT NULL RETURNING title",
    )
    .bind(now, now, id, userId)
    .first<{ title: string }>();
  if (!row) return "That campaign isn't waiting anymore, so nothing was started.";
  return `Done: "${row.title}" is on. I'll work through it in the daytime and tell you when it's finished.`;
});

// ---------- The tick ----------

/** Whether any approved campaign is running. */
export async function campaignsWaiting(env: Env) {
  if (!campaignsOn(env)) return false;
  return !!(await env.DB
    .prepare("SELECT 1 AS x FROM campaigns WHERE status = 'running' AND approved_at IS NOT NULL AND action_id IS NOT NULL LIMIT 1")
    .first());
}

async function onDoNotContact(db: D1Database, item: Item, mode: Mode) {
  const phones = ["phone", "mobile", "cell", "number"].map((k) => phoneKey(item[k])).filter((p): p is string => !!p);
  for (const p of phones) if (await db.prepare("SELECT 1 AS x FROM do_not_contact WHERE phone = ?").bind(p).first()) return true;
  if (mode === "friends") {
    const username = String(item.username ?? "").replace(/^@/, "").trim().toLowerCase();
    const hit = await db
      .prepare("SELECT 1 AS x FROM users u JOIN text_links l ON l.user_id = u.id JOIN do_not_contact d ON d.phone = l.phone WHERE u.username = ? LIMIT 1")
      .bind(username)
      .first();
    if (hit) return true;
  }
  return false;
}

async function emailsSentSince(db: D1Database, userId: string, since: number) {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM campaign_items i JOIN campaigns c ON c.id = i.campaign_id WHERE c.user_id = ? AND c.mode = 'email' AND i.status = 'done' AND i.done_at >= ?",
    )
    .bind(userId, since)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

const setItem = (db: D1Database, id: string, idx: number, status: string, result: string, now: number) =>
  db
    .prepare("UPDATE campaign_items SET status = ?, result = ?, done_at = ? WHERE campaign_id = ? AND idx = ?")
    .bind(status, noDashes(result).slice(0, RESULT_MAX), now, id, idx)
    .run();

type Due = CampaignRow & { time_zone: string | null; quiet_start: number | null; quiet_end: number | null };

/** Works one item. "refused": the model gate said no, so the item goes back and the campaign waits. */
async function workItem(env: Env, io: CampaignIo, c: Due, idx: number, item: Item, timeZone: string, now: number): Promise<"done" | "skipped" | "failed" | "refused"> {
  const db = env.DB;
  if (await onDoNotContact(db, item, c.mode)) {
    await setItem(db, c.id, idx, "skipped", "On the do-not-contact list.", now);
    return "skipped";
  }
  const text = noDashes(render(c.instructions, item)).slice(0, TEXT_MAX);
  try {
    if (c.mode === "email") {
      const mail = { to: String(item.email).trim(), subject: noDashes(render(c.subject ?? "", item)).slice(0, 200), body: text };
      await io.sendEmail(env, c.user_id, mail, (c.mailbox as "Gmail" | "Outlook" | null) ?? null);
      await setItem(db, c.id, idx, "done", `Sent to ${mail.to}`, now);
      await logAction(db, c.user_id, kindForTool("gmail_send")!, describeToolCall("gmail_send", mail), "approval", c.id).catch(() => {});
    } else if (c.mode === "research") {
      const found = await io.research(env, c.user_id, text, buckets(now, timeZone).day);
      await setItem(db, c.id, idx, "done", found || "Nothing found.", now);
    } else {
      const username = String(item.username).replace(/^@/, "").trim();
      const sent = (await io.tellFriend(env, c.user_id, username, text, timeZone)) as { error?: string } | null;
      if (sent && typeof sent === "object" && sent.error) {
        await setItem(db, c.id, idx, "failed", sent.error, now);
        return "failed";
      }
      await setItem(db, c.id, idx, "done", `Sent to @${username}`, now);
    }
    return "done";
  } catch (err) {
    if (isModelRefused(err)) {
      await db.prepare("UPDATE campaign_items SET status = 'pending' WHERE campaign_id = ? AND idx = ?").bind(c.id, idx).run();
      return "refused";
    }
    await setItem(db, c.id, idx, "failed", err instanceof Error ? err.message : "failed", now);
    return "failed";
  }
}

async function finishIfDone(env: Env, io: CampaignIo, c: Due, now: number) {
  const db = env.DB;
  const left = await db
    .prepare("SELECT COUNT(*) AS n FROM campaign_items WHERE campaign_id = ? AND status IN ('pending', 'working')")
    .bind(c.id)
    .first<{ n: number }>();
  if ((left?.n ?? 0) > 0) return false;
  const done = await db
    .prepare("UPDATE campaigns SET status = 'done', finished_at = ?, updated_at = ? WHERE id = ? AND status = 'running'")
    .bind(now, now, c.id)
    .run();
  if (!done.meta.changes) return false;
  const text = await summaryLine(db, c);
  await db
    .prepare("INSERT INTO messages (id, user_id, role, content, created_at) VALUES (?, ?, 'assistant', ?, ?)")
    .bind(crypto.randomUUID(), c.user_id, text, now)
    .run();
  await io.push(env, c.user_id, { title: "Campaign finished", body: text, data: { screen: "campaigns", id: c.id } }).catch(() => 0);
  return true;
}

export async function summaryLine(db: D1Database, c: Pick<CampaignRow, "id" | "title" | "mode">) {
  const { results } = await db
    .prepare("SELECT status, COUNT(*) AS n FROM campaign_items WHERE campaign_id = ? GROUP BY status")
    .bind(c.id)
    .all<{ status: string; n: number }>();
  const n = (s: string) => results.find((r) => r.status === s)?.n ?? 0;
  const verb = c.mode === "research" ? "looked up" : "sent";
  const parts = [`${n("done")} ${verb}`];
  if (n("skipped")) parts.push(`${n("skipped")} skipped (do not contact)`);
  if (n("failed")) parts.push(`${n("failed")} didn't work`);
  return noDashes(`Finished "${c.title}": ${parts.join(", ")}. Ask me for the results anytime.`);
}

/**
 * The cron's campaigns lane (index.ts runTick): a few items of each approved,
 * running campaign whose owner is in their daytime. Email stops for the day at
 * EMAILS_PER_DAY; a model refusal (plan or spend) leaves the item for later.
 */
export async function campaignsTick(env: Env, io: CampaignIo = realIo, deadline = Date.now() + 60_000) {
  const db = env.DB;
  if (!campaignsOn(env)) return {};
  const { results } = await db
    .prepare(
      `SELECT c.*, s.time_zone, s.quiet_start, s.quiet_end FROM campaigns c LEFT JOIN settings s ON s.user_id = c.user_id
       WHERE c.status = 'running' AND c.approved_at IS NOT NULL AND c.action_id IS NOT NULL ORDER BY c.updated_at LIMIT 20`,
    )
    .all<Due>();
  const tally = { worked: 0, skipped: 0, failed: 0, refused: 0, finished: 0, night: 0, capped: 0, blocked: 0 };
  for (const c of results) {
    if (Date.now() > deadline) break;
    const now = io.now();
    const timeZone = validTimeZone(c.time_zone);
    // Skipped ones go to the back of the line (updated_at), so they can't hold the lane's 20 places.
    const later = () => db.prepare("UPDATE campaigns SET updated_at = ? WHERE id = ?").bind(now, c.id).run();
    if (!inDaytime(now, timeZone, c.quiet_start, c.quiet_end)) {
      tally.night++;
      await later();
      continue;
    }
    // The plan and consent still hold, checked here because an email campaign never calls a
    // model (so the model gate never sees it): below Base or no consent, it waits.
    if (await blockedFor(env, c.user_id, "base")) {
      tally.blocked++;
      await later();
      continue;
    }
    const { results: items } = await db
      .prepare("SELECT idx, data FROM campaign_items WHERE campaign_id = ? AND status = 'pending' ORDER BY idx LIMIT ?")
      .bind(c.id, ITEMS_PER_TICK)
      .all<{ idx: number; data: string }>();
    for (const it of items) {
      if (c.mode === "email" && (await emailsSentSince(db, c.user_id, now - DAY_MS)) >= EMAILS_PER_DAY) {
        tally.capped++;
        break;
      }
      // Claimed first: an email is sent at most once even if this tick dies halfway.
      const claim = await db
        .prepare("UPDATE campaign_items SET status = 'working' WHERE campaign_id = ? AND idx = ? AND status = 'pending'")
        .bind(c.id, it.idx)
        .run();
      if (!claim.meta.changes) continue;
      const how = await workItem(env, io, c, it.idx, parseItem(it.data), timeZone, io.now());
      if (how === "done") tally.worked++;
      else if (how === "refused") {
        tally.refused++;
        break;
      } else tally[how]++;
    }
    await db.prepare("UPDATE campaigns SET updated_at = ? WHERE id = ?").bind(io.now(), c.id).run();
    // Anything a dead tick left "working" is counted as not done, so the campaign can end.
    if (!items.length) {
      await db
        .prepare("UPDATE campaign_items SET status = 'failed', result = 'Interrupted; not retried in case it went out.', done_at = ? WHERE campaign_id = ? AND status = 'working'")
        .bind(io.now(), c.id)
        .run();
    }
    if (await finishIfDone(env, io, c, io.now())) tally.finished++;
  }
  return tally;
}

// ---------- Reading and stopping ----------

async function counts(db: D1Database, id: string) {
  const { results } = await db
    .prepare("SELECT status, COUNT(*) AS n FROM campaign_items WHERE campaign_id = ? GROUP BY status")
    .bind(id)
    .all<{ status: string; n: number }>();
  const out: Record<string, number> = { pending: 0, working: 0, done: 0, skipped: 0, failed: 0 };
  for (const r of results) out[r.status] = r.n;
  return out;
}

const view = (c: CampaignRow) => ({
  id: c.id,
  mode: c.mode,
  title: c.title,
  status: c.status === "proposed" ? "waiting_for_approval" : c.status,
  items: c.item_count,
  createdAt: c.created_at,
  approvedAt: c.approved_at,
  finishedAt: c.finished_at,
});

export async function getCampaign(db: D1Database, userId: string, id: string) {
  return db.prepare("SELECT * FROM campaigns WHERE id = ? AND user_id = ?").bind(id, userId).first<CampaignRow>();
}

export async function listCampaigns(db: D1Database, userId: string) {
  const { results } = await db
    .prepare("SELECT * FROM campaigns WHERE user_id = ? ORDER BY created_at DESC LIMIT 50")
    .bind(userId)
    .all<CampaignRow>();
  return results.map(view);
}

export async function campaignDetail(db: D1Database, c: CampaignRow, offset = 0, limit = 20) {
  const { results } = await db
    .prepare("SELECT idx, data, status, result FROM campaign_items WHERE campaign_id = ? ORDER BY idx LIMIT ? OFFSET ?")
    .bind(c.id, limit, offset)
    .all<{ idx: number; data: string; status: string; result: string | null }>();
  return {
    ...view(c),
    instructions: c.instructions,
    subject: c.subject,
    counts: await counts(db, c.id),
    offset,
    results: results.map((r) => ({ idx: r.idx, data: parseItem(r.data), status: r.status, result: r.result })),
  };
}

export async function stopCampaign(db: D1Database, userId: string, id: string, now = Date.now()) {
  const row = await db
    .prepare("UPDATE campaigns SET status = 'stopped', finished_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status IN ('proposed', 'running') RETURNING action_id, title")
    .bind(now, now, id, userId)
    .first<{ action_id: string | null; title: string }>();
  if (!row) return null;
  // A campaign stopped before it was approved takes its Approve button with it.
  if (row.action_id) await db.prepare("DELETE FROM pending_actions WHERE id = ? AND user_id = ?").bind(row.action_id, userId).run();
  return row;
}

// ---------- The assistant ----------

const TOOLS: ToolSpec[] = [
  {
    name: "campaign_start",
    description:
      "Proposes one job over many items: the same email to many people (mode email, from their Gmail, or Outlook if that is what they have), the same lookup for many things (mode research), or a note to many of their OVOA friends (mode friends). It asks for ONE approval showing the count and cost, then runs in the background in the daytime. instructions (and subject for email) use {field} placeholders from each item. Items: a list of objects (email needs an email field, friends a username field), or list = the name of a saved list.",
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", enum: MODES },
        title: { type: "string", description: "Short name, e.g. 'Landlord outreach'." },
        instructions: { type: "string", description: "The email body, lookup question, or note, with {field} placeholders." },
        subject: { type: "string", description: "Email subject (email mode), may use {field}." },
        items: { type: "array", items: { type: "object" }, description: "The targets, one object each." },
        list: { type: "string", description: "Instead of items: the name of one of their saved lists." },
      },
      required: ["mode", "title", "instructions"],
    },
  },
  {
    name: "campaign_status",
    description: "How their campaigns are going: with an id, the counts and results (pass offset for more); without, the list of them.",
    parameters: { type: "object", properties: { id: { type: "string" }, offset: { type: "number" } } },
  },
  {
    name: "campaign_stop",
    description: "Stops one of their campaigns (or cancels one still waiting for approval). What was already done stays done.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
];

const NAMES = new Set(TOOLS.map((t) => t.name));
export const isCampaignTool = (name: string) => NAMES.has(name);

export function campaignsAssistant(env: Env, userId: string, onPark: (action: Awaited<ReturnType<typeof parkAction>>) => void) {
  const db = env.DB;
  const callTool: CallTool = async (name, args) => {
    if (name === "campaign_start") {
      const started = await startCampaign(env, userId, args);
      if ("error" in started) return started;
      onPark(started.action);
      return started.result;
    }
    if (name === "campaign_status") {
      const id = clean(args.id, 80);
      if (!id) return { campaigns: (await listCampaigns(db, userId)).slice(0, 10) };
      const c = await getCampaign(db, userId, id);
      if (!c) return { error: "No campaign with that id." };
      return campaignDetail(db, c, Math.max(0, Math.floor(Number(args.offset) || 0)), 10);
    }
    if (name === "campaign_stop") {
      const stopped = await stopCampaign(db, userId, clean(args.id, 80));
      return stopped ? { stopped: stopped.title } : { error: "No campaign with that id is waiting or running." };
    }
    return { error: `Unknown tool ${name}` };
  };
  const on = campaignsOn(env);
  return {
    tools: on ? TOOLS : [],
    callTool,
    prompt: !on
      ? ""
      : "Campaigns: when they want the same thing done for many people or things (dozens of emails, a lookup per row of a list, a note to several friends), use campaign_start once instead of many separate calls. It waits for their one approval; say it's waiting, never that it's done.",
  };
}

// ---------- The app ----------

export const campaignRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

campaignRoutes.get("/campaigns", async (c) => c.json({ campaigns: await listCampaigns(c.env.DB, c.var.userId) }));

campaignRoutes.get("/campaigns/:id", async (c) => {
  const row = await getCampaign(c.env.DB, c.var.userId, c.req.param("id"));
  if (!row) return c.json({ error: "Not found." }, 404);
  const offset = Math.max(0, Math.floor(Number(c.req.query("offset")) || 0));
  return c.json(await campaignDetail(c.env.DB, row, offset, 100));
});

campaignRoutes.post("/campaigns/:id/stop", async (c) => {
  const stopped = await stopCampaign(c.env.DB, c.var.userId, c.req.param("id"));
  return stopped ? c.json({ ok: true }) : c.json({ error: "Not found, or already finished." }, 404);
});

campaignRoutes.get("/campaigns/:id/export.csv", async (c) => {
  const row = await getCampaign(c.env.DB, c.var.userId, c.req.param("id"));
  if (!row) return c.json({ error: "Not found." }, 404);
  const { results } = await c.env.DB
    .prepare("SELECT idx, data, status, result FROM campaign_items WHERE campaign_id = ? ORDER BY idx")
    .bind(row.id)
    .all<{ idx: number; data: string; status: string; result: string | null }>();
  const csv = toCsv(results.map((r) => ({ ...r, data: parseItem(r.data) })));
  const file = row.title.replace(/[^\w ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "campaign";
  return c.body(csv, 200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${file}.csv"` });
});
