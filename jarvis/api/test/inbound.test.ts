// Creators' text-in codes (inbound.ts): "text JAKE to OVOA". Opt-in only,
// questions one at a time without a model, answers only for the owner, STOP
// ends it, a daily cap, and nothing at all while INBOUND_CODES is off.

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { blocksAssistant } from "../src/blocks";
import { codeProblem, DONE_TEXT, FULL_TEXT } from "../src/inbound";
import { capture, receive, type Deps } from "../src/texting";
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
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (list: ReturnType<typeof statement>[]) => Promise.all(list.map((s) => s.run())),
  } as unknown as D1Database;
}

const sqlite = new DatabaseSync(":memory:");
for (const file of readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort()) {
  sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
}
const DB = d1(sqlite);
const LINE = "+15125550000";
const base = { DB, SENDBLUE_API_KEY_ID: "k", SENDBLUE_API_SECRET: "s", SENDBLUE_NUMBER: LINE, SENDBLUE_WEBHOOK_SECRET: "w" };
const off = base as unknown as Env;
const on = { ...base, INBOUND_CODES: "1" } as unknown as Env;

for (const id of ["jake", "maya"]) {
  sqlite.prepare("INSERT INTO users (id, email, password_hash, password_salt, name, created_at) VALUES (?, ?, '', '', ?, 0)").run(id, `${id}@example.com`, id);
}

let n = 0;
const body = (from: string, content: string) => ({
  content,
  is_outbound: false,
  status: "RECEIVED",
  message_handle: `in-${++n}`,
  from_number: from,
  number: from,
  to_number: LINE,
  media_url: "",
  message_type: "message",
  group_id: "",
  participants: [from, LINE],
  opted_out: false,
  sendblue_number: LINE,
  service: "iMessage",
});

async function main() {
  eq("a normal code", codeProblem("JAKE"), null);
  eq("no digits (never a link code)", codeProblem("JAKE2") !== null, true);
  eq("not a keyword", codeProblem("STOP") !== null, true);

  const out = capture();
  const deps: Deps = { turn: async () => ({ reply: "x", pendingActions: [] }), sender: () => out.sender, deadline: Date.now() + 60_000, debounceMs: 0, guestWrite: async () => "trial reply" };
  const text = async (env: Env, from: string, content: string) => {
    const waits: Promise<unknown>[] = [];
    const got = await receive(env, { waitUntil: (p: Promise<unknown>) => void waits.push(p) }, body(from, content), deps);
    if (got.work) await got.work;
    await Promise.allSettled(waits);
    return got.outcome;
  };
  const last = (to: string) => out.sent.filter((s) => s.to === to).at(-1)?.content;

  // The owner makes a code.
  const jake = blocksAssistant(on, "jake", "UTC");
  eq("tools offered when on", jake.tools.filter((t) => t.name.startsWith("inbound_")).map((t) => t.name), ["inbound_create", "inbound_results", "inbound_close"]);
  eq("not offered when off", blocksAssistant(off, "jake", "UTC").tools.some((t) => t.name.startsWith("inbound_")), false);
  eq("create", await jake.callTool("inbound_create", { code: "jake", intro: "Hey! It's Jake's AI. 2 quick questions.", questions: ["What city are you in?", "What do you do for fun?"] }), { code: "JAKE", questions: 2, tellPeople: "Text JAKE to OVOA's number" });
  const maya = blocksAssistant(on, "maya", "UTC");
  eq("someone else can't take JAKE", await maya.callTool("inbound_create", { code: "JAKE", intro: "x", questions: ["y"] }), { error: "JAKE is taken. Try another." });

  // Off: a fan's "JAKE" is just a free-trial text.
  const FAN = "+15865550201";
  eq("off: the free trial answers", await text(off, FAN, "JAKE"), "guest");

  // On: opt in, answer, finish.
  const FAN2 = "+15865550202";
  eq("texting the code opts in", await text(on, FAN2, "jake!"), "inbound");
  eq("intro and the first question", last(FAN2), "Hey! It's Jake's AI. 2 quick questions.\n\nWhat city are you in?");
  await text(on, FAN2, "Austin");
  eq("second question", last(FAN2), "What do you do for fun?");
  await text(on, FAN2, "Climbing and tacos");
  eq("done", last(FAN2), DONE_TEXT);
  eq("afterwards it's the free trial again", await text(on, FAN2, "hey what can you do"), "guest");
  eq("texting the code again", [await text(on, FAN2, "JAKE"), last(FAN2)], ["inbound", "You already answered this one, thanks!"]);

  // STOP ends a screener midway.
  const FAN3 = "+15865550203";
  await text(on, FAN3, "JAKE");
  await text(on, FAN3, "STOP");
  eq("after STOP, the next text isn't taken as an answer", await text(on, FAN3, "Denver"), "guest");

  // Only the owner sees the answers.
  const results = (await jake.callTool("inbound_results", { code: "JAKE" })) as { total: number; people: { phone: string; finished: boolean; answers: string[] }[] };
  eq("the owner sees them", results.people.map((p) => [p.phone, p.finished, p.answers]), [
    [FAN2, true, ["Austin", "Climbing and tacos"]],
    [FAN3, true, []],
  ]);
  eq("nobody else can read them", await maya.callTool("inbound_results", { code: "JAKE" }), { error: "They have no code JAKE." });
  eq("counts per code", await jake.callTool("inbound_results", {}), { codes: [{ code: "JAKE", open: true, started: 2, finished: 2 }] });

  // A daily cap per code.
  sqlite.prepare("UPDATE inbound_codes SET daily_cap = 2 WHERE code = 'JAKE'").run();
  eq("over the day's cap", [await text(on, "+15865550204", "JAKE"), last("+15865550204")], ["inbound", FULL_TEXT]);

  // Closed: the code is just a word again.
  eq("close", await jake.callTool("inbound_close", { code: "JAKE" }), { closed: "JAKE" });
  eq("a closed code goes to the free trial", await text(on, "+15865550205", "JAKE"), "guest");

  // Nothing here texts first.
  const texted = new Set(out.sent.map((s) => s.to));
  eq("only numbers that texted in were ever texted", [...texted].every((to) => [FAN, FAN2, FAN3, "+15865550204", "+15865550205"].includes(to)), true);

  console.log(fails ? `\n${fails} failed` : "\nall passed");
  if (fails) process.exit(1);
}

main();
