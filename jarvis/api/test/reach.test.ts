// OVOA texting first (reach.ts), the agent's notes going by text (agent.ts
// drainNotes, tell), questions it follows up (followUpDropped), and what a run
// with nobody there may use (ownToolsFor), on the real schema over Node's own
// SQLite, with Sendblue and Expo stood in for by a fetch that writes down
// what it was asked to send.

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { drainNotes, followUpDropped, ownToolsFor, READ_ALONE, tell, worthChasing, WRITE_ON_ACT } from "../src/agent";
import { reach, TEXTS_FIRST_PER_DAY } from "../src/reach";
import { capture, textChannel, waitingApprovals, type Sender } from "../src/texting";
import type { ToolSpec } from "../src/llm";
import type { Env } from "../src/types";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const g = typeof got === "object" ? JSON.stringify(got) : got;
  const w = typeof want === "object" ? JSON.stringify(want) : want;
  const ok = g === w;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${g}${ok ? "" : `  (wanted ${w})`}`);
}

// ---------- Pure ----------

eq("a real question is chased", worthChasing("When did you have your last vape? Tell me and I'll keep count."), true);
eq("so is one that ends a text", worthChasing("I can book 7 or 8. Which works?"), true);
eq("'did I get the right address?' is a real one", worthChasing("Did I get the right address?"), true);
eq("manners aren't", worthChasing("Done, reminder set for 3pm. Anything else?"), false);
eq("nor 'sound good?'", worthChasing("I'll text you at 7. Sound good?"), false);
eq("nor 'okay?'", worthChasing("Moved it to Friday, okay?"), false);
eq("no question, nothing to chase", worthChasing("All set for tomorrow."), false);
eq("a real one beside a polite one is", worthChasing("What time works for you?\n\nAnything else?"), true);

const spec = (name: string): ToolSpec => ({ name, description: name, parameters: { type: "object", properties: {} } });
const family = { tools: ["note_add", "note_search", "todo_add", "todo_list", "alarm_set", "reminder_set", "routine_change", "site_build", "site_list"].map(spec), callTool: async (name: string) => ({ ran: name }) };
eq("Suggest reads only", ownToolsFor([family], "suggest").tools.map((t) => t.name), ["note_search", "todo_list", "site_list"]);
eq("Act adds the writes that only touch their own things", ownToolsFor([family], "act").tools.map((t) => t.name), ["note_add", "note_search", "todo_add", "todo_list", "reminder_set", "site_list"]);
eq("never an alarm, a routine change or a website build on their own", ["alarm_set", "routine_change", "site_build"].some((n) => READ_ALONE.has(n) || WRITE_ON_ACT.has(n)), false);
eq("and it calls the right family", await ownToolsFor([family], "act").callTool("todo_add", {}), { ran: "todo_add" });

// ---------- A D1 over node:sqlite, with every migration ----------

function d1(sqlite: DatabaseSync): D1Database {
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => (sqlite.prepare(sql).get(...(args as never[])) as unknown) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...(args as never[])) }),
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...(args as never[])).changes) } }),
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (list: ReturnType<typeof statement>[]) => {
      sqlite.exec("BEGIN");
      try {
        const out = [];
        for (const s of list) out.push(await s.run());
        sqlite.exec("COMMIT");
        return out;
      } catch (err) {
        sqlite.exec("ROLLBACK");
        throw err;
      }
    },
  } as unknown as D1Database;
}

const sqlite = new DatabaseSync(":memory:");
for (const file of readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort()) {
  sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
}
sqlite.exec("PRAGMA foreign_keys = ON");
const DB = d1(sqlite);
const sql = (q: string, ...args: unknown[]) => sqlite.prepare(q).run(...(args as never[]));
const one = <T>(q: string, ...args: unknown[]) => sqlite.prepare(q).get(...(args as never[])) as T | undefined;
const count = (q: string, ...args: unknown[]) => Number((one<{ n: number }>(q, ...args) ?? { n: 0 }).n);

const TEXTER = "user-texts";
const APP_ONLY = "user-app";
const PHONE = "+15865550100";
const now = Date.now();
for (const [id, email] of [
  [TEXTER, "sam@example.com"],
  [APP_ONLY, "pat@example.com"],
]) {
  sql(
    "INSERT INTO users (id, email, password_hash, password_salt, name, created_at, ai_consent_at, ai_consent_version) VALUES (?, ?, '', '', 'Sam Lee', ?, ?, 1)",
    id,
    email,
    now,
    now,
  );
  // Quiet hours that never come: 3:00 to 3:01 in a zone nobody tests in.
  sql("INSERT INTO settings (user_id, assistant_name, time_zone, quiet_start, quiet_end, updated_at) VALUES (?, 'OVOA', 'Pacific/Kiritimati', 180, 181, ?)", id, now);
}
sql("INSERT INTO text_links (user_id, phone, linked_at) VALUES (?, ?, ?)", TEXTER, PHONE, now);
sql("INSERT INTO push_tokens (token, user_id, created_at, fail_count) VALUES ('ExponentPushToken[app]', ?, ?, 0)", APP_ONLY, now);

// Sendblue and Expo, written down rather than reached.
const texted: { to: string; content: string }[] = [];
const pushed: { to: string; title?: string; body?: string }[] = [];
let sendblueDown = false;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const body = JSON.parse(String(init?.body ?? "null"));
  if (url === "https://sendblue.test/api/send-message") {
    if (sendblueDown) return new Response(JSON.stringify({ status: "ERROR", error_message: "down" }), { status: 500 });
    texted.push({ to: body.number, content: body.content });
    return new Response(JSON.stringify({ status: "QUEUED" }));
  }
  if (url.startsWith("https://sendblue.test/")) return new Response("{}");
  if (url === "https://exp.host/--/api/v2/push/send") {
    for (const m of body) pushed.push({ to: m.to, title: m.title, body: m.body });
    return new Response(JSON.stringify({ data: body.map(() => ({ status: "ok" })) }));
  }
  throw new Error(`unexpected fetch in a test: ${url}`);
}) as typeof fetch;

const env = {
  DB,
  SENDBLUE_API_KEY_ID: "k",
  SENDBLUE_API_SECRET: "s",
  SENDBLUE_NUMBER: "+15125550000",
  SENDBLUE_WEBHOOK_SECRET: "w",
  SENDBLUE_API_BASE: "https://sendblue.test",
  CHAT_MODEL: "gemini-3.5-flash-lite",
  MEMORY_MODEL: "gemini-3.5-flash-lite",
  PUBLIC_URL: "https://api.ovoa.ai",
  TOKEN_ENC_KEY: "k",
} as unknown as Env;

const notification = { title: "Reminder", body: "Call the vet" };

async function main() {
  // ---------- reach ----------
  {
    const out = capture();
    let pushes = 0;
    const io = { sender: out.sender, push: async () => ((pushes += 1), 1) };
    eq("someone who texts OVOA gets a text", await reach(env, TEXTER, { kind: "reminder", text: "Reminder: call the vet", push: notification }, io), "text");
    eq("to their number", out.sent[0], { to: PHONE, content: "Reminder: call the vet" });
    eq("and no notification", pushes, 0);
    eq("it's in the conversation, as OVOA's", one<{ role: string; content: string; source: string }>("SELECT role, content, source FROM messages WHERE user_id = ? ORDER BY created_at DESC LIMIT 1", TEXTER), {
      role: "assistant",
      content: "Reminder: call the vet",
      source: "text",
    });
    eq("and in the outbox, without its words", one<{ kind: string; ok: number }>("SELECT kind, ok FROM text_outbox WHERE user_id = ?", TEXTER), { kind: "reminder", ok: 1 });

    eq("someone who doesn't gets the notification", await reach(env, APP_ONLY, { kind: "reminder", text: "x", push: notification }, io), "push");
    eq("once", pushes, 1);

    const failing: Sender = { text: async () => false, typing: async () => {}, read: async () => {} };
    eq("Sendblue saying no: the notification instead", await reach(env, TEXTER, { kind: "reminder", text: "x", push: notification }, { sender: failing, push: io.push }), "push");
    eq("and nothing is claimed to have been said", count("SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND content = 'x'", TEXTER), 0);

    const bubbles = capture();
    await reach(env, TEXTER, { kind: "brief", text: "Good morning!\n\nDentist at 10.\n\nRain after 3." }, { sender: bubbles.sender, push: io.push } as never);
    eq("a blank line is a new bubble", bubbles.sent.map((s) => s.content), ["Good morning!", "Dentist at 10.", "Rain after 3."]);

    const proposed = capture();
    sql("INSERT INTO pending_actions (id, user_id, tool, args, summary, created_at) VALUES ('p1', ?, 'gmail_send', '{}', 'Send email to Sam', ?)", TEXTER, now);
    await reach(env, TEXTER, { kind: "note:finding", text: "Your landlord asked about the lease. I drafted a yes.", push: notification, approvals: ["p1"] }, { sender: proposed.sender, push: io.push });
    eq("a proposal ends by asking for a YES", proposed.sent.at(-1)?.content, "Reply YES to go ahead, or NO to cancel.");
    const link = one<{ approvals: string; approvals_at: number; approvals_until: number }>("SELECT approvals, approvals_at, approvals_until FROM text_links WHERE user_id = ?", TEXTER)!;
    eq("which counts for a YES", waitingApprovals(link, Date.now()), ["p1"]);
    eq("for hours, not half an hour", waitingApprovals(link, Date.now() + 3 * 3_600_000), ["p1"]);
    eq("but not forever", waitingApprovals(link, Date.now() + 13 * 3_600_000), []);
    eq("a reply's YES still waits only half an hour", waitingApprovals({ approvals: '["p2"]', approvals_at: now, approvals_until: null }, now + 31 * 60_000), []);

    // The day's share.
    sql("DELETE FROM text_outbox");
    const many = capture();
    for (let i = 0; i < TEXTS_FIRST_PER_DAY; i++) await reach(env, TEXTER, { kind: "nudge", text: `n${i}`, push: notification }, { sender: many.sender, push: io.push });
    eq(`${TEXTS_FIRST_PER_DAY} a day by text`, many.sent.length, TEXTS_FIRST_PER_DAY);
    eq("then notifications", await reach(env, TEXTER, { kind: "nudge", text: "one too many", push: notification }, { sender: many.sender, push: io.push }), "push");
    eq("except what they asked for and are waiting on", await reach(env, TEXTER, { kind: "site", text: "Your site is live", push: notification, asked: true }, { sender: many.sender, push: io.push }), "text");
    sql("DELETE FROM text_outbox");

    sql("UPDATE text_links SET proactive = 0 WHERE user_id = ?", TEXTER);
    eq("texting first turned off: notifications", await reach(env, TEXTER, { kind: "reminder", text: "x", push: notification }, io), "push");
    sql("UPDATE text_links SET proactive = 1 WHERE user_id = ?", TEXTER);
  }

  // ---------- texting_first, by text ----------
  {
    const ch = textChannel(env, TEXTER, "UTC", [], null, { openApp: () => {} }, { proactive: true, agent: true });
    eq("the prompt says it texts first", ch.prompt.includes("You text them first too"), true);
    eq("and hands long jobs to background work", ch.prompt.includes("agent_schedule (kind once, inMinutes 1, notify always)"), true);
    eq("and acts rather than narrates", ch.prompt.includes("Act, don't narrate"), true);
    await ch.callTool("texting_first", { on: false });
    eq("off", one<{ proactive: number }>("SELECT proactive FROM text_links WHERE user_id = ?", TEXTER)?.proactive, 0);
    eq("the prompt knows", textChannel(env, TEXTER, "UTC", [], null, { openApp: () => {} }, { proactive: false }).prompt.includes("turned off your texting them first"), true);
    eq("without background work, no hand-off", textChannel(env, TEXTER, "UTC", [], null, { openApp: () => {} }, { agent: false }).prompt.includes("agent_schedule"), false);
    await ch.callTool("texting_first", { on: true });
    eq("on again", one<{ proactive: number }>("SELECT proactive FROM text_links WHERE user_id = ?", TEXTER)?.proactive, 1);
  }

  // ---------- The agent's notes, and OVOA's own ----------
  {
    texted.length = 0;
    pushed.length = 0;
    sql(
      "INSERT INTO agent_notes (id, user_id, kind, title, body, urgency, created_at) VALUES ('n1', ?, 'finding', 'Flight moved', 'Your flight to Denver now leaves at 6:40, not 5:10.', 'normal', ?)",
      TEXTER,
      now,
    );
    sql("INSERT INTO agent_notes (id, user_id, kind, title, body, urgency, created_at) VALUES ('n2', ?, 'finding', 'Flight moved', 'Same news, by notification.', 'normal', ?)", APP_ONLY, now);
    sql("INSERT INTO agent_notes (id, user_id, kind, title, body, urgency, created_at) VALUES ('n3', ?, 'finding', 'Quiet one', 'Waits in the app.', 'low', ?)", TEXTER, now);
    eq("drained", await drainNotes(env), 3);
    eq("the texter's came by text", texted, [{ to: PHONE, content: "Your flight to Denver now leaves at 6:40, not 5:10." }]);
    eq("the other's by notification", pushed.map((p) => p.body), ["Same news, by notification."]);
    eq("every one marked sent", count("SELECT COUNT(*) AS n FROM agent_notes WHERE pushed_at IS NULL"), 0);
    eq("drained again: nothing twice", await drainNotes(env), 0);

    // Two lanes at once can't both send one.
    sql("INSERT INTO agent_notes (id, user_id, kind, title, body, urgency, created_at) VALUES ('n4', ?, 'done', 't', 'Once only.', 'normal', ?)", TEXTER, now);
    texted.length = 0;
    await Promise.all([drainNotes(env), drainNotes(env, { userId: TEXTER })]);
    eq("claimed before it's sent", texted.filter((t) => t.content === "Once only.").length, 1);

    texted.length = 0;
    await tell(env, TEXTER, { kind: "done", title: "Tony's Pizza is live", body: "Tony's Pizza's website is live: https://tonys-pizza.ovoa.ai", waiting: true });
    eq("OVOA's own news goes the same way", texted.map((t) => t.content), ["Tony's Pizza's website is live: https://tonys-pizza.ovoa.ai"]);
    eq("and is in the app's outbox too", count("SELECT COUNT(*) AS n FROM agent_notes WHERE title = ? AND pushed_at IS NOT NULL", "Tony's Pizza is live"), 1);

    sendblueDown = true;
    pushed.length = 0;
    sql("INSERT INTO push_tokens (token, user_id, created_at, fail_count) VALUES ('ExponentPushToken[texter]', ?, ?, 0)", TEXTER, now);
    sql("INSERT INTO agent_notes (id, user_id, kind, title, body, urgency, created_at) VALUES ('n5', ?, 'nudge', 'Rent', 'Rent is due tomorrow.', 'normal', ?)", TEXTER, now);
    await drainNotes(env);
    eq("Sendblue down: the notification still gets there", pushed.map((p) => p.body), ["Rent is due tomorrow."]);
    sendblueDown = false;
  }

  // ---------- A question left hanging ----------
  {
    const at = Date.now() - 4 * 3_600_000;
    const say = (role: string, content: string, t: number, source: string | null = "text") =>
      sql("INSERT INTO messages (id, user_id, role, content, created_at, source) VALUES (?, ?, ?, ?, ?, ?)", crypto.randomUUID(), TEXTER, role, content, t, source);
    sql("DELETE FROM messages WHERE user_id = ?", TEXTER);
    say("user", "How long have I been vape free?", at);
    say("assistant", "I've got nothing noted. When did you have your last vape?", at + 1);
    eq("an unanswered question is looked at", await followUpDropped(env), 0);
    // No model here: the run it started failed, and says so, as the real one writes it down.
    eq("once, by a run of its own", count("SELECT COUNT(*) AS n FROM agent_runs WHERE user_id = ? AND trigger = 'event'", TEXTER), 1);
    eq("marked, so it's never chased twice", one<{ followed_up_at: number }>("SELECT followed_up_at FROM text_links WHERE user_id = ?", TEXTER)?.followed_up_at, at + 1);
    await followUpDropped(env);
    eq("the next tick leaves it alone", count("SELECT COUNT(*) AS n FROM agent_runs WHERE user_id = ? AND trigger = 'event'", TEXTER), 1);

    sql("DELETE FROM messages WHERE user_id = ?", TEXTER);
    sql("UPDATE text_links SET followed_up_at = NULL WHERE user_id = ?", TEXTER);
    const later = Date.now() - 5 * 3_600_000;
    say("assistant", "Here's your brief for today.", later - 60_000);
    say("assistant", 'Did you do Gym? Text "done" when you have.', later);
    await followUpDropped(env);
    eq("a text OVOA sent first isn't chased", count("SELECT COUNT(*) AS n FROM agent_runs WHERE user_id = ? AND trigger = 'event'", TEXTER), 1);

    sql("DELETE FROM messages WHERE user_id = ?", TEXTER);
    sql("UPDATE text_links SET followed_up_at = NULL WHERE user_id = ?", TEXTER);
    const recent = Date.now() - 30 * 60_000;
    say("user", "Book dinner", recent);
    say("assistant", "7 or 8?", recent + 1);
    await followUpDropped(env);
    eq("too soon to chase", count("SELECT COUNT(*) AS n FROM agent_runs WHERE user_id = ? AND trigger = 'event'", TEXTER), 1);

    sql("DELETE FROM messages WHERE user_id = ?", TEXTER);
    const old = Date.now() - 30 * 3_600_000;
    say("user", "Book dinner", old);
    say("assistant", "7 or 8?", old + 1);
    await followUpDropped(env);
    eq("too old to chase", count("SELECT COUNT(*) AS n FROM agent_runs WHERE user_id = ? AND trigger = 'event'", TEXTER), 1);

    sql("DELETE FROM messages WHERE user_id = ?", TEXTER);
    say("user", "Thanks!", at);
    say("assistant", "Anytime. Anything else?", at + 1);
    await followUpDropped(env);
    eq("manners aren't chased", count("SELECT COUNT(*) AS n FROM agent_runs WHERE user_id = ? AND trigger = 'event'", TEXTER), 1);

    sql("DELETE FROM messages WHERE user_id = ?", TEXTER);
    sql("UPDATE text_links SET followed_up_at = NULL, proactive = 0 WHERE user_id = ?", TEXTER);
    say("user", "Book dinner", at);
    say("assistant", "7 or 8?", at + 1);
    await followUpDropped(env);
    eq("nor for someone who turned texting first off", count("SELECT COUNT(*) AS n FROM agent_runs WHERE user_id = ? AND trigger = 'event'", TEXTER), 1);
  }
}

main()
  .catch((err) => {
    fails++;
    console.error(err);
  })
  .finally(() => {
    globalThis.fetch = realFetch;
    console.log(fails ? `\n${fails} FAILED` : "\nall passed");
    process.exit(fails ? 1 : 0);
  });
