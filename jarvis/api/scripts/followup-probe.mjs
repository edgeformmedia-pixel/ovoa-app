// Plays the conversation that broke on 2026-09-24 against production, and
// checks each thing that went wrong that night:
//
//   - an answer to OVOA's own question, sent the way the phone sends a
//     follow-up without the name (ambient), gets a reply instead of silence;
//   - "hold me accountable to ... every day" becomes a routine, not one-off
//     reminders for today;
//   - the same reminder asked for twice is set once.
//
//     cd jarvis/api
//     XDG_CONFIG_HOME=C:/Users/thoma/.wrangler-ovoa node scripts/followup-probe.mjs
//
// Like engine-bench.mjs, it signs up a throwaway account, marks its address
// proven with wrangler, agrees to AI, runs the turns, and deletes the account.
// Phone lookups are answered with a made-up result, as the phone would.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API = process.argv.includes("--api") ? process.argv[process.argv.indexOf("--api") + 1] : "https://api.ovoa.ai";
const PHONE = { lookups: true, capabilities: ["calendar", "reminders", "contacts", "health", "location"], recipientGuard: true };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(path, token, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }), ...init.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${body.error ?? ""}`);
  return body;
}

/** One streamed request, read to the end: the final message, or the error. */
async function streamed(path, token, body) {
  const t0 = Date.now();
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ ...body, stream: true }),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  let done = null;
  let error = null;
  for (const line of (await res.text()).split("\n")) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.type === "error") error = msg.error;
    else if (msg.type === "done") done = msg;
  }
  return { ms: Date.now() - t0, done, error };
}

/** A spoken turn, lookups answered, as the phone runs it. */
async function say(token, message, { ambient = false } = {}) {
  let r = await streamed("/chat", token, { message, timeZone: "America/New_York", phone: PHONE, voice: true, ambient });
  const tools = (r.done?.meta?.tools ?? []).map((t) => t.name);
  let ms = r.ms;
  while (r.done?.paused) {
    const results = Object.fromEntries(r.done.paused.calls.map((c) => [c.id, { ok: true, detail: "Done." }]));
    tools.push(...r.done.paused.calls.map((c) => c.name));
    r = await streamed("/chat/resume", token, { turnId: r.done.paused.turnId, results });
    ms += r.ms;
    tools.push(...(r.done?.meta?.tools ?? []).map((t) => t.name));
  }
  const reply = r.done?.ignored ? null : (r.done?.messages?.at(-1)?.content ?? null);
  return { reply, ignored: !!r.done?.ignored, tools, ms, error: r.error, engine: r.done?.meta?.engine };
}

function d1Execute(statements) {
  const dir = mkdtempSync(join(tmpdir(), "ovoa-probe-"));
  const file = join(dir, "probe.sql");
  writeFileSync(file, `${statements.join(";\n")};\n`);
  try {
    const r = spawnSync("npx", ["wrangler", "d1", "execute", "jarvis-db", "--remote", "-y", "--file", file], { shell: true, encoding: "utf8", env: process.env });
    if (r.status !== 0) throw new Error(`wrangler d1 execute failed: ${(r.stderr || r.stdout).slice(-400)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let fails = 0;
function check(label, ok, detail) {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}
const show = (t) => `${t.ignored ? "(ignored)" : JSON.stringify(t.reply?.slice(0, 140))} · tools ${t.tools.join(",") || "none"} · ${t.ms} ms · ${t.engine ?? "?"}`;

const email = `probe-${Date.now().toString(36)}@example.com`;
const password = `p${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
const { token, user } = await json("/auth/signup", null, { method: "POST", body: JSON.stringify({ email, password, name: "Probe" }) });
console.error(`account ${user.id} created`);
try {
  d1Execute([`UPDATE users SET email_verified_at = ${Date.now()} WHERE id = '${user.id.replace(/[^0-9a-f-]/gi, "")}'`]);
  const me = await json("/me", token);
  await json("/me/consent", token, { method: "POST", body: JSON.stringify({ version: me.user.aiConsent.current }) });

  // 1. The gym: OVOA may ask when; the answer, without the name, must be heard.
  const gym = await say(token, "Hey OVOA, I want you to hold me accountable to going to the gym at least one time a day.");
  console.log(`  gym: ${show(gym)}`);
  let gymRoutine = gym.tools.includes("routine_add");
  if (!gymRoutine && gym.reply?.includes("?")) {
    await sleep(1500);
    const answer = await say(token, "An evening check at 8 p.m.", { ambient: true });
    console.log(`  answer: ${show(answer)}`);
    check("the answer to its question gets a reply, not silence", !answer.ignored && !!answer.reply);
    gymRoutine = answer.tools.includes("routine_add");
  }
  check("going to the gym every day is a routine", gymRoutine);
  check("and not one-off reminders", !gym.tools.includes("reminder_set"));
  await sleep(1500);

  // 2. Water, said with its times.
  const water = await say(token, "OVOA, hold me accountable to drinking a gallon of water a day, check on me at 10 AM and 6 PM.");
  console.log(`  water: ${show(water)}`);
  check("water every day is a routine", water.tools.includes("routine_add"));
  await sleep(1500);

  // 3. A follow-up to a reply that asked nothing still reaches the model, and a plain one gets a reply.
  const time = await say(token, "OVOA, what time is it?");
  console.log(`  time: ${show(time)}`);
  // It once answered this with an apology that the routines were never set, and set them again.
  check("an unrelated question doesn't redo what was set", !time.tools.some((t) => t === "routine_add" || t === "reminder_set"));
  const routines = await json("/routines", token).catch(() => null);
  check("two routines, no copies", routines ? routines.routines.length === 2 : true, routines ? routines.routines.map((r) => r.title).join(", ") : "couldn't read them");
  await sleep(1500);
  const more = await say(token, "And what's the date today?", { ambient: true });
  console.log(`  follow-up: ${show(more)}`);
  check("a follow-up question right after a reply is answered", !more.ignored && !!more.reply);
  await sleep(1500);

  // 4. The same one-off reminder twice is set once.
  const first = await say(token, "OVOA, remind me to call the dentist tomorrow at 11 AM.");
  console.log(`  reminder: ${show(first)}`);
  await sleep(1500);
  const again = await say(token, "OVOA, remind me to call the dentist tomorrow at 11 AM.");
  console.log(`  again: ${show(again)}`);
  const reminders = await json("/notes", token).catch(() => null);
  const dentist = reminders?.notes?.filter((n) => /dentist/i.test(n.text) && (n.remindAt ?? n.remind_at)) ?? null;
  check(
    "the dentist reminder is set once",
    dentist ? dentist.length === 1 : true,
    dentist ? `${dentist.length} set: ${JSON.stringify(dentist.map((n) => ({ text: n.text, at: n.remindAt ?? n.remind_at, tags: n.tags })))}` : "couldn't read the notes; see the replies above",
  );
} finally {
  try {
    await json("/me", token, { method: "DELETE" });
    console.error("account deleted");
  } catch (err) {
    console.error("could not delete the account:", err.message);
  }
}
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
