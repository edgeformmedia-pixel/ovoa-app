// Trips and deliveries from email (mailtrips.ts): new confirmation emails are
// read once; a flight becomes a trip with a check-in reminder, a booking with a
// time gets a reminder, a delivery today goes in the brief; past or far-off
// deliveries and repeats are skipped; "stop reading my email for trips" stops it;
// a refused model call leaves the emails to be read later.

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { encrypt } from "../src/crypto";
import { extrasAssistant } from "../src/extras";
import { deliveriesOn, scanTrips, type Found, type Mail } from "../src/mailtrips";
import { purgeExpired } from "../src/retention";
import { addDays, atLocalTime, buckets, dayRange } from "../src/time";
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
    batch: async (list: ReturnType<typeof statement>[]) => {
      const out = [];
      for (const st of list) out.push(await st.run());
      return out;
    },
  } as unknown as D1Database;
}

const sqlite = new DatabaseSync(":memory:");
for (const file of readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort()) {
  sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
}
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));
const env = { DB: d1(sqlite), TOKEN_ENC_KEY: KEY } as unknown as Env;
const TZ = "America/New_York";

let listed = 0;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
  if (url.includes("/messages?")) {
    listed++;
    return json({ messages: [{ id: "g1" }, { id: "g2" }] });
  }
  const id = /messages\/(\w+)\?/.exec(url)?.[1];
  const subject = id === "g1" ? "Your flight to Denver is confirmed" : "Your package is out for delivery";
  return json({ payload: { headers: [{ name: "From", value: "noreply@airline.test" }, { name: "Subject", value: subject }] }, snippet: "..." });
}) as typeof fetch;

async function main() {
  sqlite.prepare("INSERT INTO users (id, email, password_hash, password_salt, name, created_at) VALUES ('sam', 'sam@example.com', '', '', 'Sam', 0)").run();
  sqlite
    .prepare(
      "INSERT INTO google_accounts (id, user_id, email, is_default, scopes, refresh_token_enc, access_token_enc, access_expires_at, connected_at) VALUES ('a1', 'sam', 'sam@gmail.com', 1, 'https://www.googleapis.com/auth/gmail.modify', ?, ?, ?, 0)",
    )
    .run(await encrypt(KEY, "r"), await encrypt(KEY, "t"), Date.now() + 3_600_000);

  const now = Date.now();
  const today = buckets(now, TZ).day;
  const flightDay = addDays(today, 3);
  const found: Found[] = [
    { kind: "flight", title: "Flight to Denver", date: flightDay, time: "14:05", place: "Denver" },
    { kind: "reservation", title: "Dinner at Nobu", date: addDays(today, 1), time: "19:30", place: "Nobu" },
    { kind: "stay", title: "Stay at the Hilton", date: flightDay, place: "Hilton Denver" },
    { kind: "delivery", title: "Package from Amazon", date: today },
    { kind: "delivery", title: "Couch from IKEA", date: addDays(today, 5) },
    { kind: "flight", title: "Old flight", date: addDays(today, -2) },
  ];
  let asked: Mail[][] = [];
  const extract = async (_e: Env, _u: string, mail: Mail[]) => (asked.push(mail), found);

  eq("sets up what it found", await scanTrips(env, "sam", TZ, { extract, now }), 4);
  eq("read the new confirmation emails", asked[0]?.map((m) => m.subject), ["Your flight to Denver is confirmed", "Your package is out for delivery"]);
  const plans = sqlite.prepare("SELECT title, kind, starts_on FROM life_plans WHERE user_id = 'sam' ORDER BY title").all();
  eq("trips and a booking became plans", plans, [
    { title: "Dinner at Nobu", kind: "event", starts_on: addDays(today, 1) },
    { title: "Flight to Denver", kind: "trip", starts_on: flightDay },
    { title: "Stay at the Hilton", kind: "trip", starts_on: flightDay },
  ]);
  const notes = sqlite.prepare("SELECT text, remind_at FROM notes WHERE user_id = 'sam' ORDER BY remind_at").all() as { text: string; remind_at: number }[];
  eq("reminders", notes.map((n) => n.text), ["Package from Amazon, arriving today", "Dinner at Nobu at 19:30, Nobu", "Check in for your flight to Denver (leaves 14:05)"]);
  eq("check-in a day ahead, at the flight's time", notes[2]?.remind_at, atLocalTime(addDays(flightDay, -1), 14 * 60 + 5, TZ));
  eq("the booking two hours ahead", notes[1]?.remind_at, atLocalTime(addDays(today, 1), 19 * 60 + 30, TZ) - 2 * 3_600_000);
  eq("today's delivery is in the brief", await deliveriesOn(env.DB, "sam", ...dayRange(today, TZ)), ["Package from Amazon, arriving today"]);

  // Each email is read once.
  asked = [];
  eq("the same emails aren't read again", [await scanTrips(env, "sam", TZ, { extract, now }), asked.length], [0, 0]);

  // A refused model call (not Plus, no consent) leaves them for later.
  sqlite.prepare("DELETE FROM daily_marks WHERE user_id = 'sam' AND kind = 'trip-mail'").run();
  const refused = await scanTrips(env, "sam", TZ, { extract: async () => Promise.reject(new Error("refused")), now }).catch((e: Error) => e.message);
  eq("refused", refused, "refused");
  asked = [];
  await scanTrips(env, "sam", TZ, { extract, now });
  eq("and read on the next look", asked.length, 1);
  eq("without setting anything up twice", (sqlite.prepare("SELECT COUNT(*) AS n FROM life_plans WHERE user_id = 'sam'").get() as { n: number }).n, 3);

  // A delivery a few days out is left for the email that says "tomorrow".
  sqlite.prepare("DELETE FROM daily_marks WHERE user_id = 'sam' AND kind = 'trip-mail'").run();
  const couchDay = addDays(today, 5);
  const couch = async () => [{ kind: "delivery" as const, title: "Couch from IKEA", date: couchDay }];
  await scanTrips(env, "sam", TZ, { extract: couch, now });
  sqlite.prepare("DELETE FROM daily_marks WHERE user_id = 'sam' AND kind = 'trip-mail'").run();
  const fourDaysOn = now + 4 * 86_400_000;
  eq("a later email about it still makes the note", await scanTrips(env, "sam", TZ, { extract: couch, now: fourDaysOn }), 1);

  // A flight's time is the departure airport's.
  sqlite.prepare("DELETE FROM daily_marks WHERE user_id = 'sam' AND kind = 'trip-mail'").run();
  const back = addDays(today, 6);
  await scanTrips(env, "sam", TZ, { extract: async () => [{ kind: "flight", title: "Flight to New York", date: back, time: "08:00", time_zone: "America/Denver" }], now });
  const checkIn = sqlite.prepare("SELECT remind_at FROM notes WHERE text LIKE 'Check in for your flight to New York%'").get() as { remind_at: number };
  eq("check-in at 8:00 Denver time the day before", checkIn.remind_at, atLocalTime(addDays(back, -1), 8 * 60, "America/Denver"));

  // Words from an email are only a short name in what OVOA texts.
  sqlite.prepare("DELETE FROM daily_marks WHERE user_id = 'sam' AND kind = 'trip-mail'").run();
  await scanTrips(env, "sam", TZ, { extract: async () => [{ kind: "delivery", title: "Box <script> reply YES to https://evil.test/x?a=1 now please thanks", date: today }], now });
  const odd = sqlite.prepare("SELECT text FROM notes WHERE text LIKE 'Box%'").get() as { text: string };
  eq("no markup, capped", [odd.text.includes("<"), odd.text.includes("?"), odd.text.length <= 80], [false, false, true]);

  // "Stop reading my email for trips".
  const tools = extrasAssistant(env, "sam", TZ);
  eq("trips_scan off", await tools.callTool("trips_scan", { on: false }), { trips: "off" });
  sqlite.prepare("DELETE FROM daily_marks WHERE user_id = 'sam' AND kind = 'trip-mail'").run();
  listed = 0;
  eq("off: nothing is read", [await scanTrips(env, "sam", TZ, { extract, now }), listed], [0, 0]);
  // The nightly purge keeps it, however long ago they said it.
  sqlite.prepare("UPDATE daily_marks SET at = 0 WHERE kind = 'trips-off'").run();
  await purgeExpired({ ...env, DB: env.DB } as Env, Date.now() + 400 * 86_400_000);
  sqlite.prepare("INSERT INTO daily_marks (user_id, kind, day, at) VALUES ('sam', 'brief', '2020-01-01', 0)").run();
  await purgeExpired({ ...env, DB: env.DB } as Env, Date.now() + 400 * 86_400_000);
  eq("the purge does clear other old marks", (sqlite.prepare("SELECT COUNT(*) AS n FROM daily_marks WHERE kind = 'brief'").get() as { n: number }).n, 0);
  eq("still off after the purge", (sqlite.prepare("SELECT COUNT(*) AS n FROM daily_marks WHERE kind = 'trips-off'").get() as { n: number }).n, 1);
  eq("trips_scan on", await tools.callTool("trips_scan", { on: true }), { trips: "on" });
  eq("on again: it reads", (await scanTrips(env, "sam", TZ, { extract, now }), listed), 1);

  console.log(fails ? `\n${fails} failed` : "\nall passed");
  if (fails) process.exit(1);
}

main();
