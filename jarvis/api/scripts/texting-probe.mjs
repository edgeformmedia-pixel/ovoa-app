// Texts OVOA the way Sendblue would deliver them, against production, and
// checks that a text is the same OVOA as the app: it uses the tools (a
// reminder, a note), their own apps (open one, change its screen), says what
// waits for the phone, remembers, and the app's own turn knows what was said
// by text. Runs through POST /texting/try, so no Sendblue keys are needed and
// no real text is sent: the replies come back in the response.
//
//     cd jarvis/api
//     XDG_CONFIG_HOME=C:/Users/thoma/.wrangler-ovoa node scripts/texting-probe.mjs > probe.txt
//
// Like followup-probe.mjs, it signs up a throwaway account, marks its address
// proven and links a made-up number with wrangler, agrees to AI, and deletes
// the account at the end.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API = process.argv.includes("--api") ? process.argv[process.argv.indexOf("--api") + 1] : "https://api.ovoa.ai";
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

const everything = [];
/** One text, answered: the texts that would have gone back. */
async function text(token, message) {
  const t0 = Date.now();
  const r = await json("/texting/try", token, { method: "POST", body: JSON.stringify({ message }) });
  const texts = r.texts ?? [];
  everything.push(...texts);
  console.log(`  > ${message}\n  < ${texts.map((t) => JSON.stringify(t)).join("\n  < ") || "(nothing)"}  [${Date.now() - t0} ms, ${r.outcome}]`);
  return texts.join("\n");
}

const email = `probe-${Date.now().toString(36)}@example.com`;
const password = `p${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
const phone = `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
const { token, user } = await json("/auth/signup", null, { method: "POST", body: JSON.stringify({ email, password, name: "Probe Person" }) });
const id = user.id.replace(/[^0-9a-f-]/gi, "");
console.error(`account ${id} created`);
try {
  d1Execute([
    // Base, since plans are on: texting OVOA is a turn.
    `UPDATE users SET email_verified_at = ${Date.now()}, plan_override = 'base' WHERE id = '${id}'`,
    `UPDATE settings SET time_zone = 'America/New_York' WHERE user_id = '${id}'`,
    `INSERT INTO text_links (user_id, phone, linked_at) VALUES ('${id}', '${phone}', ${Date.now()})`,
  ]);
  const me = await json("/me", token);
  await json("/me/consent", token, { method: "POST", body: JSON.stringify({ version: me.user.aiConsent.current }) });
  const texting = await json("/texting", token);
  check("GET /texting shows the link", texting.linked?.phone === phone, JSON.stringify(texting));
  const { app } = await json("/apps", token, {
    method: "POST",
    body: JSON.stringify({
      name: "Grocery Helper",
      about: "Keeps the shopping list",
      icon: "cart-outline",
      tone: "teal",
      instructions: "Help them keep their shopping list. When they name things they need, add each one to the List.",
      opener: "What do you need?",
      blocks: [{ id: "list", kind: "list", title: "List" }],
    }),
  });

  // 1. A hello, answered as a text.
  const hello = await text(token, "hey! what can you do for me over text?");
  check("a hello is answered", hello.length > 0);

  // 2. OVOA's own reminder, from a text.
  await text(token, "remind me to call mom tomorrow at 5pm");
  const notes = (await json("/notes", token)).notes ?? [];
  check("the reminder is set", notes.some((n) => /mom/i.test(n.text) && n.remind_at), notes.map((n) => n.text).join(" | "));

  // 3. A note.
  await text(token, "add oat milk to my notes");
  const notes2 = (await json("/notes", token)).notes ?? [];
  check("the note is kept", notes2.some((n) => /oat milk/i.test(n.text)), notes2.map((n) => n.text).join(" | "));

  // 4. Their apps.
  const apps = await text(token, "what apps do I have?");
  check("it knows their apps", /grocery/i.test(apps));
  await text(token, "open my grocery app");
  await sleep(1000);
  await text(token, "I need bananas and coffee");
  const after = (await json("/apps", token)).apps?.find((a) => a.id === app.id);
  const items = (after?.state?.list?.items ?? []).map((i) => i.text).join(", ");
  check("the open app's list gets what they texted", /banana/i.test(items) && /coffee/i.test(items), items || "empty");
  await text(token, "thanks, close the app");

  // 5. What has to run on the phone waits in the app, and says so.
  const late = await text(token, "text Sam that I'm running 10 minutes late");
  check("a text to someone waits in the app", /waiting for you in the ovoa app/i.test(late));
  check("and OVOA doesn't say it went", !/\b(texted|sent)\b/i.test(late), late.split("\n")[0]);
  const actions = (await json("/actions", token)).actions ?? [];
  check("as an action on the phone", actions.some((a) => a.phone?.tool === "phone_message_compose"), actions.map((a) => a.summary).join(" | "));

  // 6. Memory, shared with the app.
  await text(token, "remember that my favorite color is teal");
  await sleep(8000);
  const color = await text(token, "what's my favorite color?");
  check("it remembers what was texted", /teal/i.test(color));
  const typed = await json("/chat", token, {
    method: "POST",
    body: JSON.stringify({ message: "What did I add to my grocery list when I texted you?", timeZone: "America/New_York" }),
  });
  const reply = typed.messages?.at(-1)?.content ?? "";
  console.log(`  app> ${reply}`);
  check("the app's own turn knows what was texted", /banana|coffee/i.test(reply));
  check("and that it came by text", !/not (by|over|via) text/i.test(reply));

  check("no Markdown in any text", !everything.some((t) => /\*\*|^#{1,6}\s/m.test(t)), everything.find((t) => /\*\*|^#{1,6}\s/m.test(t)));
} finally {
  await json("/me", token, { method: "DELETE" }).catch((err) => console.error(`couldn't delete ${id}: ${err.message}`));
  console.error(`account ${id} deleted`);
}
console.log(fails ? `\n${fails} check(s) failed` : "\nall texting probe checks passed");
process.exit(fails ? 1 : 0);
