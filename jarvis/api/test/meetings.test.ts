// Scheduling with people who aren't on OVOA (meetings.ts): three free weekday
// times from their real calendar, one email that waits for approval (or goes
// under a standing rule), then the reply: a clear pick prepares the invite and
// asks for a YES, anything else is handed to them; never more than 5 open,
// ended after 7 days, and reading replies needs Plus with AI consent.

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { blocksAssistant } from "../src/blocks";
import { encrypt } from "../src/crypto";
import { freeSlots, meetingsTick, meetingsWaiting, slotWords } from "../src/meetings";
import type { Reach } from "../src/reach";
import { addRule } from "../src/rules";
import { atLocalTime } from "../src/time";
import type { Env } from "../src/types";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(got)}${ok ? "" : `  (wanted ${JSON.stringify(want)})`}`);
}

function d1(sqlite: DatabaseSync): D1Database {
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => (sqlite.prepare(sql).get(...(args as never[])) as unknown) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...(args as never[])) }),
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...(args as never[])).changes) } }),
  });
  return { prepare: (sql: string) => statement(sql) } as unknown as D1Database;
}

const sqlite = new DatabaseSync(":memory:");
for (const file of readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort()) {
  sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
}
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(3)));
const env = { DB: d1(sqlite), TOKEN_ENC_KEY: KEY, GOOGLE_CLIENT_SECRET: "x" } as unknown as Env;
const TZ = "America/New_York";

const sent: string[] = [];
let busy: { start: string; end: string }[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
  if (url.endsWith("/freeBusy")) return json({ calendars: { primary: { busy } } });
  if (url.includes("/messages/send")) {
    sent.push(String(init?.body ?? ""));
    return json({ id: "sent-1" });
  }
  return json({});
}) as typeof fetch;

async function main() {
  // The times. Monday 2026-10-05 to Wednesday 2026-10-07, New York; "now" is the Friday before.
  const now = Date.parse("2026-10-02T15:00:00Z");
  const at = (day: string, h: number, m = 0) => atLocalTime(day, h * 60 + m, TZ);
  const slots = freeSlots([[at("2026-10-05", 9), at("2026-10-05", 11)]], "2026-10-03", "2026-10-07", TZ, 30, now);
  eq("one a day, weekends skipped, around what's busy", slots.map((s) => slotWords(s, TZ)), ["Mon, Oct 5 at 11:00 AM", "Tue, Oct 6 at 9:00 AM", "Wed, Oct 7 at 9:00 AM"]);
  eq("never sooner than 2 hours", freeSlots([], "2026-10-02", "2026-10-02", TZ, 30, now).map((s) => slotWords(s, TZ))[0], "Fri, Oct 2 at 1:00 PM");
  eq("one free day still gives three, spread out", freeSlots([], "2026-10-05", "2026-10-05", TZ, 60, now).map((s) => slotWords(s, TZ)), ["Mon, Oct 5 at 9:00 AM", "Mon, Oct 5 at 11:00 AM", "Mon, Oct 5 at 1:00 PM"]);
  eq("a full calendar gives none", freeSlots([[at("2026-10-05", 0), at("2026-10-06", 0)]], "2026-10-05", "2026-10-05", TZ, 30, now), []);

  // Offering them.
  sqlite
    .prepare("INSERT INTO users (id, email, password_hash, password_salt, name, created_at, ai_consent_at, ai_consent_version) VALUES ('sam', 'sam@example.com', '', '', 'Sam Lee', 0, 1, 99)")
    .run();
  const sam = blocksAssistant(env, "sam", TZ);
  eq("no calendar connected: says so", ((await sam.callTool("meet_propose", { email: "dana@x.com" })) as { error: string }).error.startsWith("It needs their Google or Outlook"), true);
  sqlite
    .prepare(
      "INSERT INTO google_accounts (id, user_id, email, is_default, scopes, refresh_token_enc, access_token_enc, access_expires_at, connected_at) VALUES ('g1', 'sam', 'sam@gmail.com', 1, 'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/gmail.modify', ?, ?, ?, 0)",
    )
    .run(await encrypt(KEY, "r"), await encrypt(KEY, "t"), Date.now() + 3_600_000);
  eq("a bad address", await sam.callTool("meet_propose", { email: "dana" }), { error: "I need their email address." });
  const offered = (await sam.callTool("meet_propose", { email: "Dana@X.com", name: "Dana", title: "Coffee" })) as { status: string; times: string[] };
  eq("the email waits for approval", [offered.status, offered.times.length], ["waiting_for_user_approval", 3]);
  eq("nothing sent yet", sent.length, 0);
  const card = sam.pending[0]!;
  eq("the card is the email", card.summary.split("\n")[0], "Send an email from your Gmail to dana@x.com");
  eq("it offers the three times, no dashes", [card.summary.includes("1. "), card.summary.includes("3. "), /[–—]/.test(card.summary)], [true, true, false]);
  const parked = sqlite.prepare("SELECT tool, args FROM pending_actions WHERE id = ?").get(card.id) as { tool: string; args: string };
  eq("parked as a Gmail send from their account", [parked.tool, (JSON.parse(parked.args) as { account: string }).account], ["gmail_send", "g1"]);
  eq("and waiting for Dana", (sqlite.prepare("SELECT status, email FROM meetings WHERE user_id = 'sam'").get() as { status: string; email: string }), { status: "waiting", email: "dana@x.com" });

  // A standing rule for someone: it just goes.
  await addRule(env.DB, "sam", "email", "lee@x.com");
  const ruled = (await blocksAssistant(env, "sam", TZ).callTool("meet_propose", { email: "lee@x.com" })) as { sent?: boolean };
  eq("a rule covers Lee: sent", [ruled.sent, sent.length], [true, 1]);

  // At most five open.
  for (const e of ["a@x.com", "b@x.com", "c@x.com"]) await blocksAssistant(env, "sam", TZ).callTool("meet_propose", { email: e });
  eq("a sixth waits", ((await blocksAssistant(env, "sam", TZ).callTool("meet_propose", { email: "f@x.com" })) as { error: string }).error.includes("5 times"), true);

  // The replies.

  const later = Date.now() + 2 * 3_600_000;
  eq("due for a look", await meetingsWaiting(env.DB, later), true);
  const told: Reach[] = [];
  const replies: Record<string, string> = { "dana@x.com": "Tuesday works for me!", "lee@x.com": "Can we do the week after?" };
  const done = await meetingsTick(env, {
    now: later,
    reply: async (_e, m) => (replies[m.email] ? { id: `r-${m.email}`, text: replies[m.email]! } : null),
    pick: async (_e, _m, _slots, reply) => (reply.startsWith("Tuesday") ? 2 : 0),
    tell: async (_e, _u, r) => void told.push(r),
  });
  eq("checked, one picked, one handed", [done.checked, done.picked, done.handed], [5, 1, 1]);
  const picked = told.find((t) => t.approvals?.length)!;
  eq("they're asked before the invite goes", picked.text.includes("picked") && picked.text.includes("Want me to send the invite?"), true);
  const invite = sqlite.prepare("SELECT tool, args, summary FROM pending_actions WHERE id = ?").get(picked.approvals![0]) as { tool: string; args: string; summary: string };
  const inviteArgs = JSON.parse(invite.args) as { attendees: string[]; account: string; start: string };
  eq("the invite is a calendar event with Dana, from their account", [invite.tool, inviteArgs.attendees, inviteArgs.account], ["calendar_create_event", ["dana@x.com"], "g1"]);
  eq("an unclear reply is handed to them, quoted", told.some((t) => !t.approvals && t.text.includes('"Can we do the week after?"')), true);
  eq("replies were never answered: only the rule-covered offer to Lee went out", sent.length, 1);
  eq("statuses", sqlite.prepare("SELECT email, status FROM meetings WHERE email IN ('dana@x.com', 'lee@x.com') ORDER BY email").all(), [
    { email: "dana@x.com", status: "picked" },
    { email: "lee@x.com", status: "handed" },
  ]);
  eq("the others are looked at again in an hour, not before", await meetingsWaiting(env.DB, later + 60_000), false);

  // Seven days on, what's still waiting ends.
  await meetingsTick(env, { now: Date.now() + 8 * 86_400_000, reply: async () => null, tell: async () => undefined });
  eq("ended after a week", (sqlite.prepare("SELECT COUNT(*) AS n FROM meetings WHERE status = 'expired'").get() as { n: number }).n, 3);

  console.log(fails ? `\n${fails} failed` : "\nall passed");
  if (fails) process.exit(1);
}

main();
