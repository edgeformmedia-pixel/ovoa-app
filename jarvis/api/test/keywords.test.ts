// STOP / START / HELP / CARD on OVOA's texting line (keywords.ts, texting.ts
// receive): whole-message only, a bare "stop" while an approval waits is still
// its NO, STOP keeps OVOA from texting first (reach.ts), START undoes it.

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { KEYWORD_REPLIES, keywordOf, onDoNotContact, shareContact } from "../src/keywords";
import { reach } from "../src/reach";
import { capture, receive, type Deps, type TextTurn } from "../src/texting";
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
const env = {
  DB,
  SENDBLUE_API_KEY_ID: "k",
  SENDBLUE_API_SECRET: "s",
  SENDBLUE_NUMBER: "+15125550000",
  SENDBLUE_WEBHOOK_SECRET: "w",
} as unknown as Env;

const U = "user-1";
const LINKED = "+15865550100";
const GUEST = "+15865550999";
sqlite.prepare("INSERT INTO users (id, email, password_hash, password_salt, name, created_at) VALUES (?, 'sam@example.com', '', '', 'Sam Lee', 0)").run(U);
sqlite.prepare("INSERT INTO settings (user_id, assistant_name, time_zone, updated_at) VALUES (?, 'OVOA', 'America/New_York', 0)").run(U);
sqlite.prepare("INSERT INTO text_links (user_id, phone, linked_at) VALUES (?, ?, 0)").run(U, LINKED);

let n = 0;
const body = (from: string, content: string) => ({
  content,
  is_outbound: false,
  status: "RECEIVED",
  message_handle: `kw-${++n}`,
  from_number: from,
  number: from,
  to_number: "+15125550000",
  media_url: "",
  message_type: "message",
  group_id: "",
  participants: [from, "+15125550000"],
  opted_out: false,
  sendblue_number: "+15125550000",
  service: "iMessage",
});

async function main() {
  // Whole message only.
  eq("STOP", keywordOf("STOP"), "stop");
  eq("stop.", keywordOf("  stop. "), "stop");
  eq("Unsubscribe", keywordOf("Unsubscribe"), "stop");
  eq("start!", keywordOf("start!"), "start");
  eq("help", keywordOf("Help"), "help");
  eq("contact card", keywordOf("Contact card"), "card");
  for (const text of ["stop texting me first", "help me plan dinner", "send me your card", "cards", "stop?"]) {
    eq(`not a keyword: ${text}`, keywordOf(text), null);
  }
  eq("no em dashes in any keyword reply", Object.values(KEYWORD_REPLIES).some((t) => /[—–]/.test(t)), false);

  const out = capture();
  const asked: string[] = [];
  const turn: TextTurn = async (_env, _ctx, input) => {
    asked.push(input.text);
    return { reply: "ok", pendingActions: [] };
  };
  const deps: Deps = { turn, sender: () => out.sender, deadline: Date.now() + 60_000, debounceMs: 0, guestWrite: async () => "guest reply" };
  const text = async (from: string, content: string) => {
    const waits: Promise<unknown>[] = [];
    const got = await receive(env, { waitUntil: (p: Promise<unknown>) => void waits.push(p) }, body(from, content), deps);
    if (got.work) await got.work;
    await Promise.allSettled(waits);
    return got.outcome;
  };
  const lastTo = (to: string) => out.sent.filter((s) => s.to === to).at(-1);

  // A guest: STOP, then START.
  eq("guest STOP", await text(GUEST, "STOP"), "keyword stop");
  eq("guest told", lastTo(GUEST)?.content, KEYWORD_REPLIES.stopGuest);
  eq("guest on the list", await onDoNotContact(DB, GUEST), true);
  eq("didn't use a free text", (sqlite.prepare("SELECT COUNT(*) AS n FROM text_guests").get() as { n: number }).n, 0);
  eq("they can still text and be answered", await text(GUEST, "hey what's up"), "guest");
  eq("guest START", await text(GUEST, "start"), "keyword start");
  eq("off the list", await onDoNotContact(DB, GUEST), false);

  // HELP and CARD, for anyone.
  eq("HELP", await text(GUEST, "HELP"), "keyword help");
  eq("help reply", lastTo(GUEST)?.content, KEYWORD_REPLIES.help);
  eq("CARD", await text(LINKED, "card"), "keyword card");
  const cardSent = out.sent.filter((s) => s.to === LINKED).slice(-2);
  eq("card: a line, then the vCard", [cardSent[0]?.content, cardSent[1]?.media?.endsWith("/texting/contact.vcf")], [KEYWORD_REPLIES.card, true]);
  eq("keywords never reach the model", asked, []);

  // A linked person: STOP turns off texting first, and reach falls back to a notification.
  eq("linked STOP", await text(LINKED, "Stop"), "keyword stop");
  eq("linked told", lastTo(LINKED)?.content, KEYWORD_REPLIES.stopLinked);
  eq("texting first is off", (sqlite.prepare("SELECT proactive FROM text_links WHERE user_id = ?").get(U) as { proactive: number }).proactive, 0);
  sqlite.prepare("UPDATE text_links SET proactive = 1 WHERE user_id = ?").run(U);
  const pushed: string[] = [];
  const via = await reach(env, U, { kind: "brief", text: "Morning! 2 things today.", push: { title: "OVOA", body: "Morning!" } }, {
    sender: out.sender,
    push: async (_e, _u, m) => {
      pushed.push("title" in m ? m.title : "silent");
      return 1;
    },
  });
  eq("even with texting first switched back on in the app, STOP holds: a notification instead", [via, pushed.length], ["push", 1]);
  eq("linked START", await text(LINKED, "START"), "keyword start");
  eq("texting first back on, off the list", [(sqlite.prepare("SELECT proactive FROM text_links WHERE user_id = ?").get(U) as { proactive: number }).proactive, await onDoNotContact(DB, LINKED)], [1, false]);

  // Someone linked: one-word replies stay replies. HELP and CONTACT go to the model, and START
  // only means something after a STOP.
  eq("linked 'help' goes to the model", (await text(LINKED, "help")).startsWith("keyword"), false);
  eq("linked 'contact' goes to the model", (await text(LINKED, "contact")).startsWith("keyword"), false);
  eq("linked 'start' with no STOP before goes to the model", (await text(LINKED, "start")).startsWith("keyword"), false);
  eq("a guest still gets HELP", await text(GUEST, "help"), "keyword help");

  // A bare "stop" while an approval waits is its NO, not the keyword.
  sqlite.prepare("UPDATE text_links SET approvals = '[\"p1\"]', approvals_at = ? WHERE user_id = ?").run(Date.now(), U);
  const outcome = await text(LINKED, "stop");
  eq("with an approval waiting, 'stop' isn't the keyword", outcome.startsWith("keyword"), false);
  eq("and they're not put on the list", await onDoNotContact(DB, LINKED), false);

  // Contact sharing: off unless the owner switches it on.
  eq("sharing is off by default", await shareContact(env, LINKED, null), false);
  let called = "";
  let sentBody = "";
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    called = String(url);
    sentBody = String(init.body);
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const on = { ...env, SENDBLUE_CONTACT_SHARING: "1" } as Env;
  eq("when on, it asks Sendblue", [await shareContact(on, LINKED, null), called], [true, "https://api.sendblue.co/api/v2/contact-sharing/share"]);
  eq("from OVOA's line to them", JSON.parse(sentBody), { fromNumber: "+15125550000", toNumber: LINKED });

  console.log(fails ? `\n${fails} failed` : "\nall passed");
  if (fails) process.exit(1);
}

main();
