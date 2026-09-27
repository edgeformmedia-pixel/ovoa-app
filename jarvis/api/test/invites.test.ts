// Invite a friend (invites.ts): the invite is a text the person sends
// themselves; a stranger's "@tigh sent me" is remembered once; when that number
// links an account the inviter is told once; OVOA never texts the friend first.

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { blockRoutes, blocksAssistant } from "../src/blocks";
import { inviteFor, inviteJoined, inviterIn, noteInvite } from "../src/invites";
import type { Reach } from "../src/reach";
import { capture, receive, type Deps } from "../src/texting";
import type { Env, Vars } from "../src/types";

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
      for (const s of list) out.push(await s.run());
      return out;
    },
  } as unknown as D1Database;
}

const sqlite = new DatabaseSync(":memory:");
for (const file of readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort()) {
  sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
}
sqlite.exec("PRAGMA foreign_keys = ON");
const add = (id: string, name: string, username: string | null, createdAt = Date.now()) =>
  sqlite.prepare("INSERT INTO users (id, email, password_hash, password_salt, name, created_at, username) VALUES (?, ?, '', '', ?, ?, ?)").run(id, `${id}@example.com`, name, createdAt, username);
add("tigh", "Tigh Eckard", "tigh");
add("maya", "Maya", "maya");
add("jake", "Jake Lee", null);

const LINE = "+15125550000";
const DB = d1(sqlite);
const env = { DB, SENDBLUE_API_KEY_ID: "k", SENDBLUE_API_SECRET: "s", SENDBLUE_NUMBER: LINE, SENDBLUE_WEBHOOK_SECRET: "w" } as unknown as Env;
// Whatever reach() would send goes nowhere here.
globalThis.fetch = (async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

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
  // Reading who sent them.
  eq("'@tigh sent me'", inviterIn("hey! @Tigh sent me"), "tigh");
  eq("'invited by @tigh'", inviterIn("I was invited by @tigh, what can you do"), "tigh");
  eq("an email address isn't a mention", inviterIn("mail me at sam@tigh.com, he sent me"), null);
  eq("no mention", inviterIn("hi what can you do"), null);

  // The invite itself.
  const invite = inviteFor(LINE, "tigh");
  eq("the words", invite.text, `I use OVOA, an assistant you just text. Try it: text ${LINE} and say "@tigh sent me".`);
  eq("a tap-to-text link that fills in the hello", invite.smsLink, `sms:${LINE}?&body=Hi%20OVOA%2C%20%40tigh%20sent%20me`);
  eq("no dashes in it", /[–—]/.test(invite.text), false);
  eq("without a username, still an invite", inviteFor(LINE, null).text.includes("@"), false);

  // Remembered once, from the number's own text.
  const throwing = { prepare: () => { throw new Error("read"); } } as unknown as D1Database;
  eq("an ordinary text reads nothing", await noteInvite(throwing, "+1", "hi there"), null);
  eq("an unknown username is nothing", await noteInvite(DB, "+15865550100", "@nobody sent me"), null);
  eq("remembered, with the inviter's first name", await noteInvite(DB, "+15865550100", "@tigh sent me"), "Tigh");
  eq("the first inviter keeps it", await noteInvite(DB, "+15865550100", "@maya sent me"), null);
  sqlite.prepare("INSERT INTO text_links (user_id, phone, linked_at) VALUES ('maya', '+15865550199', 0)").run();
  eq("a number already on OVOA isn't anyone's invite", await noteInvite(DB, "+15865550199", "@tigh sent me"), null);

  // Joining.
  const told: { to: string; r: Reach }[] = [];
  const tell = async (_env: Env, to: string, r: Reach) => void told.push({ to, r });
  eq("the inviter is told", await inviteJoined(env, "+15865550100", "jake", Date.now(), tell), true);
  eq("with the new person's first name", told.map((t) => [t.to, t.r.text]), [["tigh", "Jake just joined OVOA from your invite."]]);
  eq("only once", await inviteJoined(env, "+15865550100", "jake", Date.now(), tell), false);
  eq("a number nobody invited tells nobody", await inviteJoined(env, "+15865550111", "jake", Date.now(), tell), false);
  await noteInvite(DB, "+15865550122", "@tigh sent me");
  eq("inviting yourself counts for nothing", await inviteJoined(env, "+15865550122", "tigh", Date.now(), tell), false);
  // Someone already on OVOA who unlinks, says "@tigh sent me" and links again didn't join from an invite.
  add("old", "Old Timer", null, Date.now() - 90 * 86_400_000);
  await noteInvite(DB, "+15865550144", "@tigh sent me");
  eq("an old account relinking isn't a join", await inviteJoined(env, "+15865550144", "old", Date.now(), tell), false);
  // A name is only ever a first name's letters in what OVOA texts.
  add("sneaky", "Your OVOA account is locked, visit ovoa-help.com", null);
  await noteInvite(DB, "+15865550155", "@tigh sent me");
  told.length = 0;
  await inviteJoined(env, "+15865550155", "sneaky", Date.now(), tell);
  eq("a sentence typed as a name is never texted", told[0]?.r.text, "Your just joined OVOA from your invite.");
  // An old invite text still credits whoever gave the name up.
  sqlite.prepare("INSERT INTO usernames_history (username, user_id, released_at) VALUES ('tighold', 'tigh', 0)").run();
  eq("an old username still credits them", await noteInvite(DB, "+15865550166", "@tighold sent me"), "Tigh");

  // Over the real texting path: a stranger says who sent them, later links an account.
  const out = capture();
  const deps: Deps = { turn: async () => ({ reply: "x", pendingActions: [] }), sender: () => out.sender, deadline: Date.now() + 60_000, debounceMs: 0, guestWrite: async () => "trial reply" };
  const text = async (from: string, content: string) => {
    const waits: Promise<unknown>[] = [];
    const got = await receive(env, { waitUntil: (p: Promise<unknown>) => void waits.push(p) }, body(from, content), deps);
    if (got.work) await got.work;
    await Promise.allSettled(waits);
    return got.outcome;
  };
  const FRIEND = "+15865550133";
  eq("the stranger gets the free trial as ever", await text(FRIEND, "hey, @maya sent me. what can you do?"), "guest");
  eq("and Maya's invite is remembered", sqlite.prepare("SELECT inviter_id FROM invite_referrals WHERE phone = ?").get(FRIEND), { inviter_id: "maya" });
  add("sam", "Sam", null);
  sqlite.prepare("INSERT INTO text_link_codes (code, user_id, created_at, expires_at) VALUES ('ABCD2345EF', 'sam', 0, ?)").run(Date.now() + 600_000);
  eq("they link an account", await text(FRIEND, "Link my OVOA account: ABCD2345EF"), "linked");
  eq("and Maya's invite is marked joined", sqlite.prepare("SELECT joined_user_id FROM invite_referrals WHERE phone = ?").get(FRIEND), { joined_user_id: "sam" });
  eq("OVOA texted only the number that texted it", [...new Set(out.sent.map((s) => s.to))], [FRIEND]);

  // The tool and the app's route.
  const tigh = blocksAssistant(env, "tigh", "UTC");
  const got = (await tigh.callTool("invite_friend", {})) as { text: string; joined: number; waiting: number };
  eq("invite_friend: the words and the count", [got.text.includes("@tigh sent me"), got.joined, got.waiting], [true, 2, 3]);
  const jake = (await blocksAssistant(env, "jake", "UTC").callTool("invite_friend", {})) as { note?: string };
  eq("no username: offered one", typeof jake.note, "string");
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();
  app.use("*", async (c, next) => {
    c.set("userId", "maya");
    await next();
  });
  app.route("/", blockRoutes);
  const route = (await (await app.request("/invites", {}, env)).json()) as { username: string; joined: number; smsLink: string };
  eq("GET /invites", [route.username, route.joined, route.smsLink.startsWith("sms:")], ["maya", 1, true]);

  sqlite.prepare("DELETE FROM users WHERE id = 'tigh'").run();
  eq("an inviter's invites go with their account", sqlite.prepare("SELECT COUNT(*) AS n FROM invite_referrals WHERE inviter_id = 'tigh'").get(), { n: 0 });

  console.log(fails ? `\n${fails} failed` : "\nall passed");
  if (fails) process.exit(1);
}

main();
