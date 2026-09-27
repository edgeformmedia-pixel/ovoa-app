// OVOA's tone rule reaches notifications and the emails it writes, and the free
// text trial has a ceiling for the whole day (guest.ts guest_daily).

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { cleanEmailArgs } from "../src/google/assistant";
import { BUSY, GUEST_DAILY_DEFAULT, guestDailyLimit, guestText } from "../src/guest";
import { push } from "../src/push";
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

async function main() {
  // Emails OVOA drafts or sends: cleaned before they're parked for approval.
  const args: Record<string, unknown> = { to: "a@b.co", subject: "Friday — still on?", body: "Hey — running late, be there 5–10 min." };
  cleanEmailArgs("gmail_send", args);
  eq("email subject", args.subject, "Friday, still on?");
  eq("email body", args.body, "Hey, running late, be there 5-10 min.");
  const other: Record<string, unknown> = { body: "a — b" };
  cleanEmailArgs("docs_append", other);
  eq("other tools untouched", other.body, "a — b");

  // Notifications.
  sqlite.exec("INSERT INTO users (id, email, password_hash, password_salt, name, created_at) VALUES ('u1', 'u1@x.co', '', '', 'Sam', 0)");
  sqlite.exec("INSERT INTO push_tokens (token, user_id, created_at) VALUES ('ExponentPushToken[abc]', 'u1', 0)");
  let sent: { title?: string; body?: string }[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ data: sent.map(() => ({ status: "ok" })) }));
  }) as typeof fetch;
  await push({ DB } as unknown as Env, "u1", { title: "Maria's OVOA — asks", body: "Dinner Friday — 7 or 8?" });
  eq("push title", sent[0]?.title, "Maria's OVOA, asks");
  eq("push body", sent[0]?.body, "Dinner Friday, 7 or 8?");

  // The trial's daily ceiling.
  eq("default ceiling", guestDailyLimit({}), GUEST_DAILY_DEFAULT);
  eq("set by the var", guestDailyLimit({ GUEST_DAILY_REPLIES: "2" }), 2);
  eq("nonsense falls back", guestDailyLimit({ GUEST_DAILY_REPLIES: "lots" }), GUEST_DAILY_DEFAULT);

  const env = { DB, GUEST_DAILY_REPLIES: "2" } as unknown as Env;
  const texts: string[] = [];
  const send = async (text: string) => {
    texts.push(text);
    return true;
  };
  const write = async () => "hey!";
  const now = Date.parse("2026-09-27T15:00:00Z");
  eq("first guest reply", await guestText(env, "+15125550001", "hi", send, now, write), "guest reply");
  eq("second guest reply (another number)", await guestText(env, "+15125550002", "hi", send, now, write), "guest reply");
  const before = sqlite.prepare("SELECT used FROM text_guests WHERE phone = '+15125550003'").get() as { used: number } | undefined;
  eq("third is over the day's ceiling", await guestText(env, "+15125550003", "hi", send, now, write), "guest busy");
  eq("they're told plainly", texts.at(-1), BUSY);
  const after = sqlite.prepare("SELECT used FROM text_guests WHERE phone = '+15125550003'").get() as { used: number };
  eq("and their own free text is given back", [before?.used ?? 0, after.used], [0, 0]);
  eq("a new day opens it again", await guestText(env, "+15125550003", "hi", send, now + 86_400_000, write), "guest reply");
  eq("BUSY has no em dashes", /[—–]/.test(BUSY), false);

  const off = { DB, GUEST_DAILY_REPLIES: "0" } as unknown as Env;
  eq("0 pauses the trial", await guestText(off, "+15125550009", "hi", send, now + 2 * 86_400_000, write), "guest busy");

  console.log(fails ? `\n${fails} failed` : "\nall passed");
  if (fails) process.exit(1);
}

main();
