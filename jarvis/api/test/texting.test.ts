// Texting OVOA (texting.ts): what a text is, how it's linked, and the whole
// path from the webhook's body to the texts that go back, run against the real
// schema on Node's own SQLite (every migration applied), with a turn that
// answers from a script and a sender that keeps what it would have sent.

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  bubbles,
  capture,
  combine,
  findApp,
  issueLinkCode,
  linkCodesIn,
  linkOf,
  linkText,
  makeCode,
  openAppId,
  parseInbound,
  plainText,
  receive,
  secretMatches,
  tapbackOf,
  tapbackVerdict,
  textChannel,
  textingFirstSaid,
  textsTick,
  waitingApprovals,
  waitingLine,
  yesOrNo,
  type Deps,
  type Sender,
  type TextTurn,
  type TextTurnInput,
  type TextTurnOutcome,
} from "../src/texting";
import type { MadeApp } from "../src/myapps";
import type { Env } from "../src/types";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const g = typeof got === "object" ? JSON.stringify(got) : got;
  const w = typeof want === "object" ? JSON.stringify(want) : want;
  const ok = g === w;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${g}${ok ? "" : `  (wanted ${w})`}`);
}

// ---------- What came in ----------

const body = (over: Record<string, unknown> = {}) => ({
  accountEmail: "admin@ovoa.ai",
  content: "Hello!",
  is_outbound: false,
  status: "RECEIVED",
  message_handle: "99DCC379-DD76-4712-BA65-11EFB33B8CD6",
  date_sent: "2026-09-24T15:41:20.932Z",
  from_number: "+15865550100",
  number: "+15865550100",
  to_number: "+15125550000",
  media_url: "",
  message_type: "message",
  group_id: "",
  participants: ["+15865550100", "+15125550000"],
  opted_out: false,
  sendblue_number: "+15125550000",
  service: "iMessage",
  ...over,
});

{
  const m = parseInbound(body());
  eq("a text: who, which line, what", [m?.from, m?.line, m?.content, m?.handle], ["+15865550100", "+15125550000", "Hello!", "99DCC379-DD76-4712-BA65-11EFB33B8CD6"]);
  eq("and not outbound, a group, SMS or opted out", [m?.outbound, m?.group, m?.sms, m?.optedOut, m?.media], [false, false, false, false, false]);
  eq("OVOA's own, reported back", parseInbound(body({ is_outbound: true }))?.outbound, true);
  eq("a group, by its id", parseInbound(body({ group_id: "G1" }))?.group, true);
  eq("a group, by who's in it", parseInbound(body({ participants: ["+1", "+2", "+3"] }))?.group, true);
  eq("SMS", parseInbound(body({ service: "SMS" }))?.sms, true);
  eq("no service named: iMessage", parseInbound(body({ service: undefined }))?.sms, false);
  eq("a photo", parseInbound(body({ media_url: "https://x/y.jpg", content: "" }))?.media, true);
  eq("from an Apple ID email", parseInbound(body({ from_number: "sam@icloud.com", number: "" }))?.from, "sam@icloud.com");
  eq("no sender: not a text", parseInbound(body({ from_number: "", number: "" })), null);
  eq("not an object: not a text", parseInbound([1, 2]), null);
  eq("a bad line is dropped", parseInbound(body({ sendblue_number: "nope", to_number: "" }))?.line, null);
  const a = parseInbound(body({ message_handle: "" }))!;
  const b = parseInbound(body({ message_handle: "" }))!;
  eq("no handle: the same text gets the same made-up one", a.handle === b.handle && a.handle.startsWith("sb:"), true);
  eq("CRLF becomes LF, and it's trimmed", parseInbound(body({ content: "  a\r\nb  " }))?.content, "a\nb");
}

// ---------- Link codes ----------

{
  const codes = Array.from({ length: 300 }, () => makeCode());
  eq("codes are ten characters of the alphabet", codes.every((c) => /^[A-HJ-NP-Z2-9]{10}$/.test(c)), true);
  eq("each with a digit and a letter", codes.every((c) => /[2-9]/.test(c) && /[A-Z]/.test(c)), true);
  eq("and every one is found in its own text", codes.every((c) => linkCodesIn(linkText(c))[0] === c), true);
  eq("different each time", new Set(codes).size, 300);
  eq("found lower-cased, given back upper", linkCodesIn("link my ovoa account: k7qf9x3m2a"), ["K7QF9X3M2A"]);
  eq("on its own", linkCodesIn("K7QF9X3M2A"), ["K7QF9X3M2A"]);
  eq("never a word", linkCodesIn("Please strengthen my reminders, thanks"), []);
  eq("never a phone number", linkCodesIn("call 5865552234 or 8005559999"), []);
  eq("nor part of something longer", linkCodesIn("K7QF9X3M2AB"), []);
  eq("no I, O, 0 or 1 in one", linkCodesIn("K7QF9X3M2I K7QF9X3M20"), []);
  eq("two, and a repeat", linkCodesIn("K7QF9X3M2A and BBBBBBBBB2 K7QF9X3M2A"), ["K7QF9X3M2A", "BBBBBBBBB2"]);
}

// ---------- Short answers, reactions, what goes out ----------

{
  for (const y of ["yes", "Yes!", "YES.", "yep", "ok", "Okay", "send it", "go ahead", "👍"]) eq(`"${y}" is a yes`, yesOrNo(y), "yes");
  for (const n of ["no", "No.", "nope", "cancel", "don’t", "never mind", "👎"]) eq(`"${n}" is a no`, yesOrNo(n), "no");
  for (const x of ["yes but change the subject", "no, send it to Pat instead", "what time is it", ""]) eq(`"${x}" is neither`, yesOrNo(x), null);

  eq("a tapback", tapbackOf("Loved “Done — 3pm tomorrow”"), { kind: "loved", quoted: "Done — 3pm tomorrow" });
  eq("with straight quotes", tapbackOf('Liked "Reply YES to go ahead, or NO to cancel."')?.kind, "liked");
  eq("laughed at", tapbackOf("Laughed at “ha”")?.kind, "laughed");
  eq("a newer reaction", tapbackOf("Reacted 😂 to “ha”")?.kind, "reacted");
  eq("taking one back", tapbackOf("Removed a heart from “ha”")?.kind, "removed");
  eq("an ordinary text isn't one", tapbackOf("I loved the movie"), null);
  eq("a thumbs up on the YES line is the YES", tapbackVerdict({ kind: "liked", quoted: "Reply YES to go ahead, or NO to cancel." }), "yes");

  eq("'stop texting me first' is off", textingFirstSaid("Actually stop texting me first, notifications are fine"), false);
  eq("'don't text me first anymore' is off", textingFirstSaid("don’t text me first anymore"), false);
  eq("'no more texting me first' is off", textingFirstSaid("no more texting me first please"), false);
  eq("'text me first with reminders' is on", textingFirstSaid("text me first with reminders and stuff from now on"), true);
  eq("'you can text me first' is on", textingFirstSaid("You can text me first."), true);
  eq("a question is the model's", textingFirstSaid("will you text me first?"), null);
  eq("'first thing' is a time, not this", textingFirstSaid("text me first thing tomorrow about the dentist"), null);
  eq("nothing about it is nothing", textingFirstSaid("remind me to call mom"), null);
  eq("unclear is the model's", textingFirstSaid("I'm not sure you should text me first"), null);
  eq("down is the NO", tapbackVerdict({ kind: "disliked", quoted: "Reply YES to go ahead." }), "no");
  eq("on anything else it's nothing", tapbackVerdict({ kind: "liked", quoted: "Done — 3pm" }), null);

  eq("Markdown comes out", plainText("**Done** — *really*. See [the doc](https://x.co/d).\n\n## Next\n* one\n* two"), "Done — really. See the doc (https://x.co/d).\n\nNext\n- one\n- two");
  eq("arithmetic stays", plainText("2 * 3 * 4 = 24"), "2 * 3 * 4 = 24");
  eq("a link that is its own label", plainText("[https://x.co](https://x.co)"), "https://x.co");
  eq("a blank line starts the next text", bubbles("Done — 3pm tomorrow.\n\nWant me to add Sam?"), ["Done — 3pm tomorrow.", "Want me to add Sam?"]);
  eq("three at most", bubbles("a\n\nb\n\nc\n\nd"), ["a", "b", "c\n\nd"]);
  eq("nothing is no texts", bubbles("  \n\n "), []);

  eq("a YES waits", waitingLine([{ summary: "Email Sam\nSubject: hi" }]), "Reply YES to go ahead, or NO to cancel.");
  eq("two YESes", waitingLine([{ summary: "a" }, { summary: "b" }]), "Reply YES to do all 2, or NO to cancel.");
  eq(
    "the phone's wait in the app",
    waitingLine([{ summary: "Text Mom\nMessage: late", phone: { tool: "phone_message_compose", args: {} } }]),
    "Waiting for you in the OVOA app: Text Mom. Open it to finish.",
  );
  eq("nothing waits", waitingLine([]), "");

  eq("a burst is one message", combine([{ content: "hey", media: 0 }, { content: "what's on today", media: 0 }]), "hey\nwhat's on today");
  eq("with a photo", combine([{ content: "look", media: 1 }]).startsWith("look\n[They sent a photo"), true);
  eq("only a photo", combine([{ content: "", media: 1 }]).startsWith("[They sent a photo or file with no words"), true);

  eq("the secret", secretMatches("s3cret", "s3cret"), true);
  eq("not the secret", secretMatches("s3cres", "s3cret"), false);
  eq("a longer one", secretMatches("s3cret!", "s3cret"), false);
  eq("none sent", secretMatches(undefined, "s3cret"), false);
  eq("none set", secretMatches("s3cret", undefined), false);

  const apps = [{ name: "Grocery Helper" }, { name: "Water" }];
  eq("an app by name", findApp(apps, "water")?.name, "Water");
  eq("near enough", findApp(apps, "my grocery app")?.name, "Grocery Helper");
  eq("'grocery app'", findApp(apps, "grocery app")?.name, "Grocery Helper");
  eq("'the water app'", findApp(apps, "the water app")?.name, "Water");
  eq("no such app", findApp(apps, "budget"), undefined);
  eq("nothing said", findApp(apps, "  "), undefined);
  eq("'my app' names none of them", findApp(apps, "my app"), undefined);
  const now = Date.now();
  eq("an app open a minute ago is open", openAppId({ app_id: "a1", app_at: now - 60_000 }, now), "a1");
  eq("after an hour it's closed", openAppId({ app_id: "a1", app_at: now - 61 * 60_000 }, now), null);
  eq("approvals wait half an hour", waitingApprovals({ approvals: '["p1"]', approvals_at: now - 60_000 }, now), ["p1"]);
  eq("and no longer", waitingApprovals({ approvals: '["p1"]', approvals_at: now - 31 * 60_000 }, now), []);
  eq("nonsense is nothing", waitingApprovals({ approvals: "{", approvals_at: now }, now), []);
}

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
const env = {
  DB,
  SENDBLUE_API_KEY_ID: "k",
  SENDBLUE_API_SECRET: "s",
  SENDBLUE_NUMBER: "+15125550000",
  SENDBLUE_WEBHOOK_SECRET: "w",
} as unknown as Env;
const sql = (q: string, ...args: unknown[]) => sqlite.prepare(q).run(...(args as never[]));
const one = <T>(q: string, ...args: unknown[]) => sqlite.prepare(q).get(...(args as never[])) as T | undefined;
const count = (q: string, ...args: unknown[]) => Number((one<{ n: number }>(q, ...args) ?? { n: 0 }).n);

function waiter() {
  const work: Promise<unknown>[] = [];
  return { waitUntil: (p: Promise<unknown>) => void work.push(p), settle: () => Promise.allSettled(work) };
}

/** A turn that answers from a script and remembers what it was asked. */
function scripted(answers: (input: TextTurnInput) => TextTurnOutcome | Promise<TextTurnOutcome>) {
  const asked: string[] = [];
  const turn: TextTurn = async (_env, _ctx, input) => {
    asked.push(input.text);
    return answers(input);
  };
  return { asked, turn };
}

let n = 0;
const handle = () => `h${++n}`;

async function text(content: string, deps: Deps, over: Record<string, unknown> = {}) {
  const ctx = waiter();
  const got = await receive(env, ctx, body({ content, message_handle: handle(), ...over }), deps);
  if (got.work) await got.work;
  await ctx.settle();
  return got.outcome;
}

const U = "user-1";
const PHONE = "+15865550100";
sql("INSERT INTO users (id, email, password_hash, password_salt, name, created_at) VALUES (?, 'sam@example.com', '', '', 'Sam Lee', ?)", U, Date.now());
sql("INSERT INTO settings (user_id, assistant_name, time_zone, updated_at) VALUES (?, 'OVOA', 'America/New_York', ?)", U, Date.now());

async function main() {
  const out = capture();
  const replies = scripted(() => ({ reply: "Done — 3pm tomorrow.\n\nAnything else?", pendingActions: [] }));
  const deps = (turn: TextTurn = replies.turn, sender: Sender = out.sender, debounceMs = 0): Deps => ({
    turn,
    sender: () => sender,
    deadline: Date.now() + 60_000,
    debounceMs,
  });

  // ---------- Strangers, SMS, groups ----------

  eq("a number nobody linked", await text("hello", deps(), { from_number: "+15865550999" }), "stranger");
  eq("is told how to link", out.sent.at(-1)?.content.includes("Link my number"), true);
  eq("to that number", out.sent.at(-1)?.to, "+15865550999");
  const told = out.sent.length;
  eq("the next text from it", await text("hello?", deps(), { from_number: "+15865550999" }), "stranger");
  eq("isn't told again today", out.sent.length, told);
  eq("and nothing it said is kept", count("SELECT COUNT(*) AS n FROM text_inbox WHERE phone = '+15865550999' AND content != ''"), 0);
  eq("nor did any of it reach a turn", replies.asked.length, 0);

  eq("SMS", await text("hi", deps(), { service: "SMS", from_number: "+15865550998" }), "sms");
  eq("is told to use iMessage", out.sent.at(-1)?.content.includes("iMessage"), true);
  eq("group chats", await text("hi all", deps(), { group_id: "G1" }), "group");
  eq("OVOA's own texts, reported back", await text("sent", deps(), { is_outbound: true }), "outbound");
  eq("opted out", await text("hi", deps(), { opted_out: true }), "opted out");

  // ---------- Linking ----------

  const { code } = await issueLinkCode(DB, U);
  const linkBody = body({ content: linkText(code), message_handle: "link-1" });
  const sentBefore = out.sent.length;
  eq("the code from their number", (await receive(env, waiter(), linkBody, deps())).outcome, "linked");
  eq("links it", (await linkOf(DB, U))?.phone, PHONE);
  eq("and says so, by name", out.sent[sentBefore]?.content.startsWith("You're linked, Sam!"), true);
  eq("in two texts", out.sent.length - sentBefore, 2);
  eq("the same delivery again", (await receive(env, waiter(), linkBody, deps())).outcome, "duplicate");
  eq("sends nothing more", out.sent.length - sentBefore, 2);
  eq("the code is spent", count("SELECT COUNT(*) AS n FROM text_link_codes WHERE code = ?", code), 0);
  eq("so from another number it doesn't work", await text(linkText(code), deps(), { from_number: "+15865550777" }), "bad code");
  eq("and they're told", out.sent.at(-1)?.content.startsWith("That link code didn't work"), true);
  eq("a stranger's code keeps no words", count("SELECT COUNT(*) AS n FROM text_inbox WHERE phone = '+15865550777' AND content != ''"), 0);

  // ---------- A turn ----------

  eq("a text from them", await text("remind me at 3 tomorrow", deps()), "queued");
  eq("is a turn with their words", replies.asked.at(-1), "remind me at 3 tomorrow");
  eq("answered in two texts", out.sent.slice(-2).map((s) => s.content), ["Done — 3pm tomorrow.", "Anything else?"]);
  eq("to them", out.sent.at(-1)?.to, PHONE);
  eq("and done with: no words kept", one<{ status: string; content: string }>(`SELECT status, content FROM text_inbox WHERE handle = ?`, `h${n}`), {
    status: "done",
    content: "",
  });
  eq("no lock left behind", (await linkOf(DB, U))?.busy_until, null);

  // A reaction to one of OVOA's texts needs no answer.
  const asked = replies.asked.length;
  eq("a reaction", await text("Loved “Done — 3pm tomorrow.”", deps()), "reaction");
  eq("isn't a turn", replies.asked.length, asked);

  // ---------- A burst, and one reply at a time ----------

  {
    const burst = scripted((i) => ({ reply: `got: ${i.text}`, pendingActions: [] }));
    const d = deps(burst.turn, out.sender, 40);
    const ctx = waiter();
    const first = await receive(env, ctx, body({ content: "hey", message_handle: handle() }), d);
    const second = await receive(env, ctx, body({ content: "what's on today", message_handle: handle() }), d);
    await Promise.all([first.work, second.work]);
    await ctx.settle();
    eq("two texts in a burst are one turn", burst.asked, ["hey\nwhat's on today"]);
    eq("with one reply", out.sent.at(-1)?.content, "got: hey\nwhat's on today");
  }
  {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const order: string[] = [];
    const slow = scripted(async (i) => {
      order.push(`start ${i.text}`);
      if (i.text === "first") await gate;
      order.push(`end ${i.text}`);
      return { reply: `re: ${i.text}`, pendingActions: [] };
    });
    const d = deps(slow.turn);
    const ctx = waiter();
    const a = await receive(env, ctx, body({ content: "first", message_handle: handle() }), d);
    // Let the first turn start and take the lock.
    await new Promise((r) => setTimeout(r, 30));
    const b = await receive(env, ctx, body({ content: "second", message_handle: handle() }), d);
    await b.work;
    eq("a text while a reply is being written waits for it", order, ["start first"]);
    release();
    await a.work;
    await ctx.settle();
    eq("then comes after it, in order", order, ["start first", "end first", "start second", "end second"]);
    eq("and so do the replies", out.sent.slice(-2).map((s) => s.content), ["re: first", "re: second"]);
  }

  // ---------- Approvals by text ----------

  const park = (id: string, tool = "gmail_send") =>
    sql(
      "INSERT INTO pending_actions (id, user_id, tool, args, summary, created_at) VALUES (?, ?, ?, '{}', ?, ?)",
      id,
      U,
      tool,
      "Email Sam\nSubject: Friday",
      Date.now(),
    );
  const drafting = scripted((i) => {
    if (i.text.startsWith("email")) {
      park("pa1");
      return {
        reply: "Your email to Sam is ready.",
        pendingActions: [{ id: "pa1", summary: "Email Sam\nSubject: Friday", created_at: Date.now() }],
      };
    }
    return { reply: `re: ${i.text}`, pendingActions: [] };
  });
  eq("something that needs their OK", await text("email Sam about Friday", deps(drafting.turn)), "queued");
  eq("ends with how to give it", out.sent.slice(-2).map((s) => s.content), ["Your email to Sam is ready.", "Reply YES to go ahead, or NO to cancel."]);
  eq("and waits for the YES", waitingApprovals((await linkOf(DB, U))!, Date.now()), ["pa1"]);
  eq("YES", await text("Yes!", deps(drafting.turn)), "queued");
  eq("isn't a turn", drafting.asked, ["email Sam about Friday"]);
  eq("it carries the action out (no Google here: says why)", out.sent.at(-1)?.content.startsWith("I couldn't do that: No Google account is connected"), true);
  eq("the action is gone", count("SELECT COUNT(*) AS n FROM pending_actions WHERE id = 'pa1'"), 0);
  eq("nothing waits any more", (await linkOf(DB, U))?.approvals, null);
  eq("the YES and its outcome are in the conversation", count("SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND source = 'text'", U), 2);

  await text("email Sam again", deps(drafting.turn));
  eq("NO", await text("no", deps(drafting.turn)), "queued");
  eq("cancels it", out.sent.at(-1)?.content, "Okay, I've cancelled that.");
  eq("gone", count("SELECT COUNT(*) AS n FROM pending_actions WHERE id = 'pa1'"), 0);

  await text("email Sam once more", deps(drafting.turn));
  eq("a thumbs up on the YES line", await text("Liked “Reply YES to go ahead, or NO to cancel.”", deps(drafting.turn)), "queued");
  eq("is the YES", out.sent.at(-1)?.content.startsWith("I couldn't do that"), true);

  await text("email Sam one last time", deps(drafting.turn));
  await text("actually what's the weather", deps(drafting.turn));
  eq("anything else is a new request", drafting.asked.at(-1), "actually what's the weather");
  eq("and lets the waiting one go", count("SELECT COUNT(*) AS n FROM pending_actions WHERE id = 'pa1'"), 0);
  eq("so a later YES is only a word", (await linkOf(DB, U))?.approvals, null);

  {
    const phoneWait = scripted(() => ({
      reply: "That'll be waiting in OVOA for you.",
      pendingActions: [{ id: "pp1", summary: "Text Mom\nMessage: late", created_at: Date.now(), phone: { tool: "phone_message_compose", args: {} } }],
    }));
    await text("text mom I'm late", deps(phoneWait.turn));
    eq("what runs on the phone waits in the app", out.sent.at(-1)?.content, "Waiting for you in the OVOA app: Text Mom. Open it to finish.");
    eq("not for a YES", (await linkOf(DB, U))?.approvals, null);
  }

  // ---------- A turn that fails, and an empty reply ----------

  const broken: TextTurn = async () => {
    throw new Error("boom");
  };
  eq("a turn that throws", await text("hello", deps(broken)), "queued");
  eq("is apologised for", out.sent.at(-1)?.content.startsWith("Sorry, something went wrong"), true);
  eq("and marked failed", one<{ status: string }>("SELECT status FROM text_inbox WHERE handle = ?", `h${n}`)?.status, "failed");
  const silent = scripted(() => ({ reply: "", pendingActions: [] }));
  await text("hmm", deps(silent.turn));
  eq("a reply with no words still answers", out.sent.at(-1)?.content, "Okay.");

  // ---------- The cron ----------

  {
    const late = scripted((i) => ({ reply: `late: ${i.text}`, pendingActions: [] }));
    const old = Date.now() - 2 * 60_000;
    sql("INSERT INTO text_inbox (handle, user_id, phone, content, status, received_at) VALUES ('w1', ?, ?, 'are you there', 'new', ?)", U, PHONE, old);
    sql(
      "INSERT INTO text_inbox (handle, user_id, phone, content, status, received_at, claimed_at) VALUES ('s1', ?, ?, '', 'claimed', ?, ?)",
      U,
      PHONE,
      old - 10 * 60_000,
      old - 10 * 60_000,
    );
    const got = await textsTick(env, late.turn, Date.now(), () => out.sender);
    eq("answers a text nobody answered", late.asked, ["are you there"]);
    eq("says sorry for one a run died on", out.sent.some((s) => s.content.startsWith("Sorry, I lost track")), true);
    eq("and says what it did", got, { lost: 1, answered: 1 });
    eq("the lost one is failed", one<{ status: string }>("SELECT status FROM text_inbox WHERE handle = 's1'")?.status, "failed");
    eq("a second tick has nothing to do", await textsTick(env, late.turn, Date.now(), () => out.sender), { lost: 0, answered: 0 });
    eq("off without the keys", await textsTick({ DB } as unknown as Env, late.turn), {});
  }

  // ---------- Their apps, over text ----------

  {
    sql(
      `INSERT INTO user_apps (id, user_id, name, about, icon, tone, instructions, opener, created_at, blocks, state, speak, updated_at)
       VALUES ('app1', ?, 'Grocery Helper', 'Keeps the shopping list', 'cart-outline', 'teal', 'Ask what they are out of and add it to the list.', 'What are you out of?', ?, ?, '{}', 1, ?)`,
      U,
      Date.now(),
      JSON.stringify([{ id: "b1", kind: "list", title: "List" }]),
      Date.now(),
    );
    const link = (await linkOf(DB, U))!;
    let opened: MadeApp | null = null;
    const ch = textChannel(env, U, "America/New_York", [{ id: "app1", name: "Grocery Helper", about: "Keeps the shopping list" }], null, {
      openApp: (a) => (opened = a),
    });
    eq("the channel's tools", ch.tools.map((t) => t.name), ["my_apps", "app_open", "app_close", "texting_first"]);
    eq("its messages are saved as texts", ch.source, "text");
    eq("the prompt names their apps", ch.prompt.includes('"Grocery Helper"'), true);
    eq("my_apps", await ch.callTool("my_apps", {}), { apps: [{ name: "Grocery Helper", about: "Keeps the shopping list" }], open: null });
    const r = (await ch.callTool("app_open", { name: "grocery" })) as Record<string, unknown>;
    eq("app_open, near enough", r.opened, "Grocery Helper");
    eq("hands over its instructions and opener", [r.instructions, r.opener], ["Ask what they are out of and add it to the list.", "What are you out of?"]);
    eq("and its screen", String(r.screen).includes('"List" (checklist): empty'), true);
    eq("opens it in the turn", (opened as MadeApp | null)?.id, "app1");
    eq("and in the conversation", openAppId((await linkOf(DB, U))!), "app1");
    eq("my_apps says it's open", ((await ch.callTool("my_apps", {})) as { open: string }).open, "Grocery Helper");
    eq("no such app", String(((await ch.callTool("app_open", { name: "budget" })) as { error: string }).error).includes("Grocery Helper"), true);
    eq("app_close", await ch.callTool("app_close", {}), { closed: "Grocery Helper" });
    eq("closed in the conversation", openAppId((await linkOf(DB, U))!), null);
    void link;

    eq("no apps, no app tools: only texting_first", textChannel(env, U, "UTC", [], null, { openApp: () => {} }).tools.map((t) => t.name), ["texting_first"]);

    const waiting = ch.adjust("gmail_send", { status: "waiting_for_user_approval", note: "tap Approve", account: "Used work" }) as Record<string, unknown>;
    eq("an approval card becomes a YES", [waiting.status, waiting.account, String(waiting.note).includes("YES")], ["waiting_for_their_yes", "Used work", true]);
    eq("and never mentions a button to tap", String(waiting.note).includes("don't mention an Approve button"), true);
    eq("a phone action waits in the app", (ch.adjust("phone_message_compose", { status: "running_on_phone", note: "doing it now" }) as { status: string }).status, "waiting_in_the_ovoa_app");
    eq("its parked card too", (ch.adjust("phone_call", { status: "waiting_for_user_approval" }) as { status: string }).status, "waiting_in_the_ovoa_app");
    eq("anything else is left alone", ch.adjust("note_add", { ok: true }), { ok: true });
    const sym = Symbol("defer");
    eq("a pause is left alone", ch.adjust("phone_contacts_search", sym) === sym, true);
  }

  // ---------- Texting first, said plainly ----------

  {
    const seen: number[] = [];
    const turn = scripted((input) => (seen.push(input.link.proactive), { reply: "Okay.", pendingActions: [] }));
    await text("actually stop texting me first, notifications are fine", deps(turn.turn));
    eq("'stop texting me first' switches it off", (await linkOf(DB, U))?.proactive, 0);
    eq("before the turn, which sees it off", seen.at(-1), 0);
    await text("ok text me first again please", deps(turn.turn));
    eq("'text me first again' switches it back on", (await linkOf(DB, U))?.proactive, 1);
    await text("should you text me first?", deps(turn.turn));
    eq("a question leaves it to the model", (await linkOf(DB, U))?.proactive, 1);
  }

  // ---------- Unlinking ----------

  eq("UNLINK by text", await text("Unlink", deps()), "unlinked");
  eq("unlinks", await linkOf(DB, U), null);
  eq("and says so", out.sent.at(-1)?.content.startsWith("Unlinked"), true);
  eq("after that it's a stranger", await text("hello", deps()), "stranger");

  // An account that goes takes its link and its texts with it.
  const { code: again } = await issueLinkCode(DB, U);
  await text(linkText(again), deps());
  eq("linked again", (await linkOf(DB, U))?.phone, PHONE);
  sql("DELETE FROM users WHERE id = ?", U);
  eq("deleting the account unlinks the number", count("SELECT COUNT(*) AS n FROM text_links"), 0);
  eq("and takes its texts", count("SELECT COUNT(*) AS n FROM text_inbox WHERE user_id = ?", U), 0);
}

main()
  .catch((err) => {
    fails++;
    console.error(err);
  })
  .finally(() => {
    console.log(fails ? `\n${fails} check(s) failed` : "\nall texting checks passed");
    process.exit(fails ? 1 : 0);
  });
