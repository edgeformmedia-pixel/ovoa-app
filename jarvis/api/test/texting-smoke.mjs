// Texting OVOA end to end against a local worker (texting.ts), with a fake
// Sendblue that keeps every call it gets: the webhook's secret, linking by a
// text with the code in it, strangers, SMS, groups, a second delivery, a turn
// (which fails at the model on a local worker, and says so by text, as it
// would in production with every engine down), /texting/try, the cron that
// answers what nobody answered, and unlinking.
//
//     npx wrangler d1 migrations apply jarvis-db --local --persist-to .wrangler/texting
//     npx wrangler dev --local --port 8797 --persist-to .wrangler/texting --test-scheduled \
//       --var DEBUG_KEY:localtest --var EMAIL_CODES_TO_LOG:1 \
//       --var SENDBLUE_API_KEY_ID:key-id --var SENDBLUE_API_SECRET:key-secret \
//       --var SENDBLUE_NUMBER:+15125550000 --var SENDBLUE_WEBHOOK_SECRET:whsec-local \
//       --var SENDBLUE_API_BASE:http://127.0.0.1:8788
//     node test/texting-smoke.mjs
//
// Run it alone, on a fresh state folder: the cron acts on every account there.
// Other ports: API=http://127.0.0.1:<port> for the worker, SENDBLUE_PORT for the
// fake Sendblue (the worker's SENDBLUE_API_BASE must point at it).

import { spawnSync } from "node:child_process";
import { createServer } from "node:http";

const API = process.env.API ?? "http://127.0.0.1:8797";
const PERSIST_TO = process.env.PERSIST_TO ?? ".wrangler/texting";
const DEBUG_KEY = process.env.DEBUG_KEY ?? "localtest";
const SECRET = "whsec-local";
const LINE = "+15125550000";
// New numbers every run: the once-a-day replies to strangers and SMS remember the last run's.
const run = String(Date.now()).slice(-6);
const ME = `+1586${run}0`;
const STRANGER = `+1586${run}1`;
const SMS_SENDER = `+1586${run}2`;
const OTHER = `+1586${run}3`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
function check(label, got, want) {
  const g = typeof got === "object" ? JSON.stringify(got) : String(got);
  const w = typeof want === "object" ? JSON.stringify(want) : String(want);
  const ok = g === w;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${g}${ok ? "" : `  (wanted ${w})`}`);
}

// ---------- A fake Sendblue ----------

const calls = [];
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {}
    calls.push({ path: req.url, key: req.headers["sb-api-key-id"], secret: req.headers["sb-api-secret-key"], body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: req.url === "/api/send-message" ? "QUEUED" : "SENT", message_handle: `out-${calls.length}` }));
  });
});
await new Promise((r) => server.listen(Number(process.env.SENDBLUE_PORT ?? 8788), "127.0.0.1", r));
const sends = () => calls.filter((c) => c.path === "/api/send-message");
const sentTo = (to) => sends().filter((c) => c.body?.number === to);

async function http(path, init = {}) {
  // Once more on a dropped connection: an idle keep-alive one is closed by the
  // local server while wrangler d1 execute runs, and fetch reuses it anyway.
  const res = await fetch(`${API}${path}`, init).catch(() => sleep(500).then(() => fetch(`${API}${path}`, init)));
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, body };
}
const authed = (token) => (path, init = {}) =>
  http(path, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...init.headers } });

let n = 0;
const webhook = (content, over = {}, secret = SECRET) =>
  http("/texting/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", ...(secret && { "sb-signing-secret": secret }) },
    body: JSON.stringify({
      content,
      is_outbound: false,
      status: "RECEIVED",
      message_handle: `local-${Date.now()}-${++n}`,
      from_number: ME,
      number: ME,
      to_number: LINE,
      sendblue_number: LINE,
      media_url: "",
      message_type: "message",
      group_id: "",
      participants: [ME, LINE],
      service: "iMessage",
      opted_out: false,
      ...over,
    }),
  });

function d1(sql) {
  const r = spawnSync("npx", ["wrangler", "d1", "execute", "jarvis-db", "--local", "--persist-to", PERSIST_TO, "--command", JSON.stringify(sql)], {
    shell: true,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`d1 execute failed: ${(r.stderr || r.stdout).slice(-300)}`);
}

try {
  const up = await http("/");
  if (up.body?.service !== "jarvis-api") throw new Error(`No worker on ${API}: start wrangler dev as the header says.`);

  // ---------- An account, proven and agreed to AI ----------
  const email = `texting${Date.now()}@example.com`;
  const signup = await http("/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123", name: "Tex Tester" }),
  });
  const token = signup.body?.token;
  const api = authed(token);
  const me = await api("/me");
  await http("/debug/verify", { method: "POST", headers: { "content-type": "application/json", "x-debug-key": DEBUG_KEY }, body: JSON.stringify({ userId: me.body.user.id }) });
  await api("/me/consent", { method: "POST", body: JSON.stringify({ version: me.body.user.aiConsent.current }) });

  // ---------- The app's side ----------
  const state = await api("/texting");
  check("texting is on, with OVOA's number", [state.body?.available, state.body?.number, state.body?.linked], [true, LINE, null]);

  // ---------- The webhook's door ----------
  check("no secret: 401", (await webhook("hi", {}, null)).status, 401);
  check("a wrong one: 401", (await webhook("hi", {}, "nope")).status, 401);
  check("not JSON: 400", (await http("/texting/webhook", { method: "POST", headers: { "sb-signing-secret": SECRET }, body: "{" })).status, 400);

  // ---------- Linking ----------
  const link = await api("/texting/link", { method: "POST" });
  check("a code, and the text it goes in", [link.status, link.body?.number, link.body?.body?.endsWith(link.body?.code)], [200, LINE, true]);
  const linked = await webhook(link.body.body);
  check("the text with the code", linked.status, 200);
  check("links the number", (await api("/texting")).body?.linked?.phone, ME);
  check("and says so, in two texts", sentTo(ME).length, 2);
  check("from OVOA's line, with its keys", [sentTo(ME)[0]?.body?.from_number, sentTo(ME)[0]?.key, sentTo(ME)[0]?.secret], [LINE, "key-id", "key-secret"]);
  check("by name", sentTo(ME)[0]?.body?.content.startsWith("You're linked, Tex!"), true);

  // ---------- A turn ----------
  const before = sends().length;
  const handle = `turn-${Date.now()}`;
  const turn = await webhook("what's on my calendar tomorrow?", { message_handle: handle });
  check("a text is answered before the webhook returns", turn.status, 200);
  const reply = sends().slice(before);
  check("with one text", reply.length, 1);
  // A local worker has no model: the turn says so, as production would with every engine down.
  check("saying the AI is out of reach", /AI|reach|model/i.test(reply[0]?.body?.content ?? ""), true);
  check("and marked read, with the typing bubble", ["/api/mark-read", "/api/send-typing-indicator"].every((p) => calls.some((c) => c.path === p && c.body?.number === ME)), true);
  const again = await webhook("what's on my calendar tomorrow?", { message_handle: handle });
  check("the same delivery again: 200", again.status, 200);
  check("and not answered twice", sends().length, before + 1);

  // ---------- Strangers, SMS, groups, reactions ----------
  const s0 = sends().length;
  await webhook("hello?", { from_number: STRANGER, number: STRANGER });
  check("a stranger is told how to link", sentTo(STRANGER).at(-1)?.body?.content.includes("Link my number"), true);
  await webhook("hello??", { from_number: STRANGER, number: STRANGER });
  check("once", sentTo(STRANGER).length, 1);
  await webhook("hi", { service: "SMS", from_number: SMS_SENDER, number: SMS_SENDER });
  check("SMS is told to use iMessage", sentTo(SMS_SENDER).at(-1)?.body?.content.includes("iMessage"), true);
  await webhook("hi all", { group_id: "group-1", participants: [ME, LINE, OTHER] });
  await webhook("Loved “something”");
  await webhook("sent", { is_outbound: true });
  check("groups, reactions and OVOA's own texts get nothing", sends().length, s0 + 2);

  // ---------- /texting/try ----------
  const tried = await api("/texting/try", { method: "POST", body: JSON.stringify({ message: "hello from try" }) });
  check("/texting/try answers in the response", [tried.status, tried.body?.outcome, tried.body?.texts?.length], [200, "queued", 1]);
  check("and sends nothing", sends().length, s0 + 2);

  // ---------- The cron answers what nobody did ----------
  const uid = me.body.user.id;
  d1(`INSERT INTO text_inbox (handle, user_id, phone, line, content, status, received_at) VALUES ('stale-${run}', '${uid}', '${ME}', '${LINE}', 'are you there?', 'new', ${Date.now() - 5 * 60_000})`);
  const c0 = sends().length;
  // --test-scheduled's trigger (wrangler 4); the two-minute cron is the one with the texts in it.
  const tick = await http("/cdn-cgi/handler/scheduled?cron=*/2+*+*+*+*");
  check("a cron tick runs", tick.status, 200);
  for (let i = 0; i < 20 && sends().length === c0; i++) await sleep(500);
  check("and answers the text that was waiting", sentTo(ME).length > 0 && sends().length === c0 + 1, true);

  // ---------- Unlinking ----------
  check("unlink", (await api("/texting/link", { method: "DELETE" })).status, 200);
  check("unlinked", (await api("/texting")).body?.linked, null);
  const u0 = sentTo(ME).length;
  await webhook("still there?");
  check("the number is a stranger again", sentTo(ME).at(-1)?.body?.content.includes("Link my number") && sentTo(ME).length === u0 + 1, true);

  await api("/me", { method: "DELETE" });
} catch (err) {
  fails++;
  console.error(err);
} finally {
  server.close();
}
console.log(fails ? `\n${fails} check(s) failed` : "\nall texting smoke checks passed");
process.exit(fails ? 1 : 0);
