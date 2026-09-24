// Runs the same twenty turns against production on one engine and measures
// them: time to the first token and the first sentence, total time, whether
// the right tool was called, tokens per reply and what it cost.
//
//     cd jarvis/api
//     XDG_CONFIG_HOME=C:/Users/thoma/.wrangler-ovoa node scripts/engine-bench.mjs \
//         --label "gemini first" --engine_order gemini,glm --voice_engine gemini
//
// It signs up a throwaway account, gives that account alone the engine choices
// asked for (a row per setting in server_settings, written with wrangler so no
// debug key is needed), waits for the Worker's one-minute settings cache to
// turn over, runs ten spoken and ten typed turns, prints one table row, saves
// every turn to a JSON file, and deletes the account and its rows.
//
// A new account can do nothing until its address is proven (src/verify.ts),
// and an example.com address can't receive the code (the server doesn't even try:
// emailauth.ts reservedAddress, so no bounce counts against no-reply@ovoa.ai).
// So the account is marked proven: through POST /debug/verify when DEBUG_KEY is
// in the environment, or otherwise with wrangler, like the settings rows. Then
// it agrees to AI, as the app's consent screen would (src/consent.ts), or every
// turn is refused.
//
// Phone lookups (reminders, the calendar, contacts) pause the turn for the app;
// this answers them with a plain made-up result and resumes, exactly as the
// phone would, so a paused turn counts as a tool call that worked.
//
// Nothing here prints a token or a key. The account's password is random and
// thrown away with the account.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? "1" : all[i + 1]]);
    return acc;
  }, []),
);
const API = args.api ?? "https://api.ovoa.ai";
const LABEL = args.label ?? "default";
const WAIT_S = Number(args.wait ?? 65);
const PREFS = Object.fromEntries(["engine_order", "voice_engine"].filter((k) => args[k]).map((k) => [k, args[k]]));
const OUT = args.out ?? `bench-${LABEL.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.json`;

/**
 * What the phone tells the server it can do, so the lookup tools exist (phone.ts).
 * recipientGuard as the app sends it in builds after 67 (phoneActions.ts
 * phoneCaps): a spoken "Call Mom." may then go straight to phone_call by name,
 * with no contact search first (phone.ts phonePrompt byName).
 */
const PHONE = { lookups: true, capabilities: ["calendar", "reminders", "contacts", "health", "location"], recipientGuard: true };

/** expect: a tool name (or one of several) the turn should have called; none means "just answer". */
const SPOKEN = [
  { text: "What time is it?" },
  { text: "Set an alarm for seven tomorrow morning.", expect: ["alarm_set"] },
  { text: "Remind me to call Mom at four this afternoon.", expect: ["reminder_set"] },
  { text: "What's on my calendar tomorrow?", expect: ["phone_calendar_events"] },
  { text: "Add milk and eggs to my notes.", expect: ["note_add"] },
  { text: "Can I afford a sixty dollar dinner this week?", expect: ["money_afford", "money_status"] },
  { text: "Cancel my seven o'clock alarm.", expect: ["alarm_cancel", "alarm_list"] },
  { text: "Tell me something interesting in one sentence." },
  { text: "What do I have on my list?", expect: ["todo_list", "note_list", "note_search"] },
  { text: "Call Mom.", expect: ["phone_contacts_search", "phone_call"] },
];
const TYPED = [
  { text: "What's today's date?" },
  { text: "Set an alarm for 6:30 tomorrow.", expect: ["alarm_set"] },
  { text: "Remind me to submit the report on Friday at 9am.", expect: ["reminder_set"] },
  { text: "What's on my calendar this week?", expect: ["phone_calendar_events"] },
  { text: "Note: the wifi password is on the fridge.", expect: ["note_add"] },
  { text: "Do I have any alarms set?", expect: ["alarm_list"] },
  { text: "Write two sentences about why sleep matters." },
  { text: "Add a to-do to buy a gift for Jake.", expect: ["note_add", "todo_add", "phone_reminder_create"] },
  { text: "Who was I supposed to call?", expect: ["note_search", "note_list", "phone_reminders_list", "todo_list"] },
  { text: "Show me Mom's contact details.", expect: ["phone_contacts_search"] },
];

/** A made-up answer for a phone lookup, shaped like the app's (phoneActions.ts). */
function phoneResult(call) {
  switch (call.name) {
    case "phone_calendar_events":
      return { events: [{ title: "Dentist", start: "2026-09-23T14:00:00", end: "2026-09-23T15:00:00" }] };
    case "phone_reminders_list":
      return { reminders: [] };
    case "phone_contacts_search":
      return { contacts: [{ id: "c1", name: "Mom", phones: ["+1 555 010 0100"] }] };
    default:
      return { ok: true, detail: "Done." };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => {
  const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
const mean = (xs) => {
  const s = xs.filter((x) => typeof x === "number");
  return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null;
};

async function json(path, token, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }), ...init.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${body.error ?? ""}`);
  return body;
}

/** One streamed request (/chat or /chat/resume), with the client-side timings. */
async function streamed(path, token, body) {
  const t0 = Date.now();
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ ...body, stream: true }),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let firstSentenceMs = null;
  let done = null;
  let error = null;
  const handle = (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    if (msg.type === "sentence") firstSentenceMs ??= Date.now() - t0;
    else if (msg.type === "error") error = msg.error;
    else if (msg.type === "done") done = msg;
  };
  for (;;) {
    const { done: end, value } = await reader.read();
    if (end) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      handle(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  }
  handle(buffer);
  return { ms: Date.now() - t0, firstSentenceMs, done, error };
}

/** Writes or removes this account's own engine settings with wrangler, no debug key needed. */
function settingsRows(userId, prefs, remove = false) {
  const now = Date.now();
  const statements = remove
    ? [`DELETE FROM server_settings WHERE key LIKE '%:${userId}'`]
    : Object.entries(prefs).map(
        ([k, v]) =>
          `INSERT INTO server_settings (key, value, updated_at) VALUES ('${k}:${userId}', '${v.replace(/'/g, "")}', ${now}) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      );
  d1Execute(statements);
}

/** Marks the throwaway account's address proven: the debug route when DEBUG_KEY is set, else wrangler. */
async function proveAddress(userId) {
  if (process.env.DEBUG_KEY) {
    await json("/debug/verify", null, {
      method: "POST",
      headers: { "x-debug-key": process.env.DEBUG_KEY },
      body: JSON.stringify({ userId }),
    });
    return;
  }
  d1Execute([`UPDATE users SET email_verified_at = ${Date.now()} WHERE id = '${userId.replace(/[^0-9a-f-]/gi, "")}'`]);
}

/** Runs statements on the remote database with wrangler. */
function d1Execute(statements) {
  if (!statements.length) return;
  // From a file, not --command: on Windows the shell splits a quoted statement
  // into one argument per word.
  const dir = mkdtempSync(join(tmpdir(), "ovoa-bench-"));
  const file = join(dir, "settings.sql");
  writeFileSync(file, `${statements.join(";\n")};\n`);
  try {
    const r = spawnSync("npx", ["wrangler", "d1", "execute", "jarvis-db", "--remote", "-y", "--file", file], {
      shell: true,
      encoding: "utf8",
      env: process.env,
    });
    if (r.status !== 0) throw new Error(`wrangler d1 execute failed: ${(r.stderr || r.stdout).slice(-400)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runTurn(token, turn, voice) {
  const first = await streamed("/chat", token, { message: turn.text, timeZone: "America/New_York", phone: PHONE, voice });
  const record = {
    text: turn.text,
    voice,
    expect: turn.expect ?? null,
    ms: first.ms,
    firstSentenceMs: first.firstSentenceMs,
    error: first.error,
    engine: first.done?.meta?.engine ?? null,
    firstTokenMs: first.done?.meta?.firstTokenMs ?? null,
    calls: first.done?.meta?.usage?.calls ?? 0,
    tokensIn: first.done?.meta?.usage?.input ?? 0,
    tokensCached: first.done?.meta?.usage?.cached ?? 0,
    tokensOut: first.done?.meta?.usage?.output ?? 0,
    microUsd: first.done?.meta?.usage?.microUsd ?? 0,
    toolsRan: (first.done?.meta?.tools ?? []).map((t) => t.name),
    paused: (first.done?.paused?.calls ?? []).map((c) => c.name),
    reply: first.done?.messages?.at(-1)?.content?.slice(0, 160) ?? null,
    // Only when the reply claimed an action no tool took (llm.ts repairClaims): repaired, unrepaired or pending.
    claim: first.done?.meta?.claim ?? null,
  };
  // The phone answers the lookup and the turn carries on: the same reply, measured whole.
  if (first.done?.paused) {
    const results = Object.fromEntries(first.done.paused.calls.map((c) => [c.id, phoneResult(c)]));
    const second = await streamed("/chat/resume", token, { turnId: first.done.paused.turnId, results });
    record.ms += second.ms;
    record.resumeMs = second.ms;
    record.error ??= second.error;
    record.calls += second.done?.meta?.usage?.calls ?? 0;
    record.tokensIn += second.done?.meta?.usage?.input ?? 0;
    record.tokensCached += second.done?.meta?.usage?.cached ?? 0;
    record.tokensOut += second.done?.meta?.usage?.output ?? 0;
    record.microUsd += second.done?.meta?.usage?.microUsd ?? 0;
    record.toolsRan.push(...(second.done?.meta?.tools ?? []).map((t) => t.name));
    record.reply = second.done?.messages?.at(-1)?.content?.slice(0, 160) ?? record.reply;
    record.claim = second.done?.meta?.claim ?? record.claim;
  }
  const used = new Set([...record.toolsRan, ...record.paused]);
  record.ok = record.error ? false : turn.expect ? turn.expect.some((t) => used.has(t)) : !!record.reply;
  return record;
}

const email = `bench-${Date.now().toString(36)}@example.com`;
const password = `b${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
const { token, user } = await json("/auth/signup", null, { method: "POST", body: JSON.stringify({ email, password, name: "Bench" }) });
console.error(`account ${user.id} created`);
const turns = [];
try {
  await proveAddress(user.id);
  // The wording the server wants now (GET /me): a fixed 1 stopped counting when
  // the consent named Cloudflare (version 2, 2026-09-23), and every turn was refused.
  const me = await json("/me", token);
  await json("/me/consent", token, { method: "POST", body: JSON.stringify({ version: me.user.aiConsent.current }) });
  console.error("address proven, AI agreed to");
  if (Object.keys(PREFS).length) {
    settingsRows(user.id, PREFS);
    console.error(`settings written: ${JSON.stringify(PREFS)}; waiting ${WAIT_S} s for the Worker's cache`);
    await sleep(WAIT_S * 1000);
  }
  for (const [list, voice] of [
    [SPOKEN, true],
    [TYPED, false],
  ]) {
    for (const turn of list) {
      let record;
      try {
        record = await runTurn(token, turn, voice);
      } catch (err) {
        record = { text: turn.text, voice, error: err.message, ok: false, ms: null };
      }
      turns.push(record);
      console.error(
        `${voice ? "spoken" : "typed "} ${record.ok ? "ok  " : "FAIL"} ${String(record.firstTokenMs ?? "-").padStart(5)} ms first · ${String(record.ms ?? "-").padStart(6)} ms · ${record.engine ?? "?"} · ${record.calls ?? 0} calls · ${record.tokensIn ?? 0} in ${record.tokensOut ?? 0} out · ${record.text}${record.claim ? ` · claim ${record.claim}` : ""}${record.error ? ` · ${record.error.slice(0, 80)}` : ""}`,
      );
      // Under the per-person turn limit (20 a minute), with room for the resume.
      await sleep(1500);
    }
  }
} finally {
  try {
    await json("/me", token, { method: "DELETE" });
    console.error("account deleted");
  } catch (err) {
    console.error("could not delete the account:", err.message);
  }
  try {
    settingsRows(user.id, {}, true);
  } catch (err) {
    console.error("could not remove the settings rows:", err.message);
  }
}

const spoken = turns.filter((t) => t.voice);
const typed = turns.filter((t) => !t.voice);
const line = (name, list) => {
  const withTool = list.filter((t) => t.expect);
  return `| ${LABEL} · ${name} | ${median(list.map((t) => t.firstTokenMs))} | ${median(list.map((t) => t.firstSentenceMs))} | ${median(list.map((t) => t.ms))} | ${withTool.filter((t) => t.ok).length}/${withTool.length} | ${list.filter((t) => t.ok).length}/${list.length} | ${Math.round(mean(list.map((t) => t.calls)) * 10) / 10} | ${Math.round(mean(list.map((t) => t.tokensIn)))} / ${Math.round(mean(list.map((t) => t.tokensOut)))} | $${(mean(list.map((t) => t.microUsd)) / 1e6).toFixed(4)} | ${[...new Set(list.map((t) => t.engine))].join(",")} |`;
};
console.log("| run | first token (median ms) | first sentence | total | tools right | answered | calls/reply | tokens in / out | $/reply | engine |");
console.log("|---|---|---|---|---|---|---|---|---|---|");
console.log(line("spoken", spoken));
console.log(line("typed", typed));
writeFileSync(OUT, JSON.stringify({ label: LABEL, prefs: PREFS, at: new Date().toISOString(), turns }, null, 1));
console.error(`saved ${OUT}`);
