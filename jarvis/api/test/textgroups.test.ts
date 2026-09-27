// OVOA in iMessage groups (textgroups.ts via texting.ts receive): off by
// default; when on, only when named, only among the sender's Friends, no
// private data in the group, and tasks go to the sender's private thread.

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { capture, receive, type Deps, type TextTurn } from "../src/texting";
import { mentionsOvoa, type GroupAnswer } from "../src/textgroups";
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
const on = { ...base, TEXT_GROUPS: "1" } as unknown as Env;

const SAM = "+15865550100";
const ALEX = "+15865550101";
const STRANGER = "+15865550199";
for (const [id, name, phone] of [
  ["sam", "Sam Lee", SAM],
  ["alex", "Alex Kim", ALEX],
]) {
  sqlite.prepare("INSERT INTO users (id, email, password_hash, password_salt, name, created_at) VALUES (?, ?, '', '', ?, 0)").run(id!, `${id}@example.com`, name!);
  sqlite.prepare("INSERT INTO settings (user_id, assistant_name, time_zone, updated_at) VALUES (?, 'OVOA', 'America/New_York', 0)").run(id!);
  sqlite.prepare("INSERT INTO text_links (user_id, phone, linked_at) VALUES (?, ?, 0)").run(id!, phone!);
}
const connect = () =>
  sqlite
    .prepare("INSERT INTO connections (id, requester_id, addressee_id, status, created_at) VALUES ('c1', 'sam', 'alex', 'accepted', 0)")
    .run();

let n = 0;
const body = (from: string, content: string, participants: string[]) => ({
  content,
  is_outbound: false,
  status: "RECEIVED",
  message_handle: `g-${++n}`,
  from_number: from,
  number: from,
  to_number: LINE,
  media_url: "",
  message_type: "group",
  group_id: "grp-1",
  participants,
  opted_out: false,
  sendblue_number: LINE,
  service: "iMessage",
});

async function main() {
  eq("named", mentionsOvoa("hey ovoa what time works"), true);
  eq("@-named", mentionsOvoa("@OVOA thoughts?"), true);
  eq("their own name for it", mentionsOvoa("jarvis, pick a place", "Jarvis"), true);
  eq("not named", mentionsOvoa("ovoamazing"), false);

  // The group's calls to Sendblue.
  const groupSends: { group_id: string; content: string }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    if (String(url).endsWith("/api/send-group-message")) groupSends.push(JSON.parse(String(init.body)));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  const out = capture();
  const asked: string[] = [];
  const turn: TextTurn = async (_env, _ctx, input) => {
    asked.push(input.text);
    return { reply: "Booked a table request for 7, check your approvals.", pendingActions: [] };
  };
  let answer: GroupAnswer = { reply: "Saturday at 7 works for both of you — nice.", private_task: null };
  const seen: string[][] = [];
  const deps: Deps = {
    turn,
    sender: () => out.sender,
    deadline: Date.now() + 60_000,
    debounceMs: 0,
    groupWrite: async (_system, turns) => {
      seen.push(turns.map((t) => t.text));
      return answer;
    },
  };
  const text = async (env: Env, from: string, content: string, participants: string[]) => {
    const waits: Promise<unknown>[] = [];
    const got = await receive(env, { waitUntil: (p: Promise<unknown>) => void waits.push(p) }, body(from, content, participants), deps);
    if (got.work) await got.work;
    await Promise.allSettled(waits);
    return got.outcome;
  };
  const everyone = [SAM, ALEX, LINE];

  // Off by default: groups are ignored as before.
  eq("off: ignored", await text(off, SAM, "ovoa pick a time", everyone), "group");
  eq("off: nothing sent", [groupSends.length, seen.length], [0, 0]);

  // On, but not friends yet: quiet.
  eq("on, not friends: no answer", await text(on, SAM, "ovoa pick a time", everyone), "group");
  eq("nothing sent", groupSends.length, 0);

  connect();
  // Not named: quiet.
  await text(on, SAM, "what time works for everyone", everyone);
  eq("not named: nothing sent", groupSends.length, 0);

  // Named, among friends: answers in the group, with no em dashes.
  await text(on, SAM, "ovoa what time works saturday?", everyone);
  eq("answers in the group", groupSends.map((s) => [s.group_id, s.content]), [["grp-1", "Saturday at 7 works for both of you, nice."]]);
  eq("the model saw the ask by first name", seen.at(-1)?.at(-1), "Sam: ovoa what time works saturday?");
  eq("no private turn ran", asked, []);

  // A task that needs Sam's accounts goes to Sam's private thread.
  answer = { reply: "On it, Sam, I'll text you to confirm.", private_task: "Book a table for 4 at Luca on Saturday at 7" };
  await text(on, SAM, "ovoa book us a table saturday at 7 at luca", everyone);
  eq("group told", groupSends.at(-1)?.content, "On it, Sam, I'll text you to confirm.");
  eq("the task ran as Sam's own private text, in Sam's own words (never the group's)", asked, ['[From your group chat] Sam asked in the group: "ovoa book us a table saturday at 7 at luca"']);
  eq("and the private reply went 1:1 to Sam", out.sent.filter((s) => s.to === SAM).at(-1)?.content.startsWith("Booked a table request"), true);
  eq("context carries across asks", seen.at(-1)?.includes("Saturday at 7 works for both of you, nice."), true);

  // A stranger in the group: quiet again.
  const before = groupSends.length;
  await text(on, SAM, "ovoa you there?", [SAM, ALEX, STRANGER, LINE]);
  eq("a non-friend in the group: nothing sent", groupSends.length, before);

  // No member list from Sendblue: nobody can be checked, so it stays quiet (fails closed).
  const quietBefore = groupSends.length;
  await text(on, SAM, "ovoa you there?", []);
  eq("no participants: nothing sent", groupSends.length, quietBefore);

  // An unlinked sender: quiet.
  await text(on, STRANGER, "ovoa hi", [SAM, STRANGER, LINE]);
  eq("an unlinked sender: nothing sent", groupSends.length, before);

  // Only what named OVOA, and its answers, are kept.
  const kept = JSON.parse((sqlite.prepare("SELECT history FROM text_groups WHERE group_id = 'grp-1'").get() as { history: string }).history) as { who: string; text: string }[];
  eq("the unnamed line wasn't kept", kept.some((l) => l.text === "what time works for everyone"), false);
  eq("kept lines", kept.length, 4);

  console.log(fails ? `\n${fails} failed` : "\nall passed");
  if (fails) process.exit(1);
}

main();
