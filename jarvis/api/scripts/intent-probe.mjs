// Replays the texts real people sent (2026-09-27..29) against production and
// checks the mistakes they exposed: opening with the hour in the wrong zone,
// step counts tacked onto jokes, made-up capability limits and shared past,
// and the wrong way to get the app. Like texting-probe.mjs it signs up a
// throwaway account (no time zone, a New York number, marked as a trial) and
// deletes it at the end. Runs through POST /texting/try, so nothing is texted.
//
//     cd jarvis/api
//     node scripts/intent-probe.mjs [--api URL]

import { spawnSync } from "node:child_process";

const API = process.argv.includes("--api") ? process.argv[process.argv.indexOf("--api") + 1] : "https://api.ovoa.ai";

async function json(path, token, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }), ...init.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${body.error ?? ""}`);
  return body;
}

function d1(statements) {
  let last = "";
  for (const sql of statements) {
    const r = spawnSync("npx", ["wrangler", "d1", "execute", "jarvis-db", "--remote", "--json", "--command", JSON.stringify(sql)], { shell: true, encoding: "utf8", env: process.env });
    if (r.status !== 0) throw new Error(`wrangler d1 execute failed: ${(r.stderr || r.stdout).slice(-400)}`);
    last = r.stdout;
  }
  return last;
}

let fails = 0;
const check = (label, ok, detail) => {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};
async function text(token, message) {
  const r = await json("/texting/try", token, { method: "POST", body: JSON.stringify({ message }) });
  const out = (r.texts ?? []).join("\n");
  console.log(`  > ${message}\n  < ${out.replace(/\n/g, "\n    ") || "(nothing)"}`);
  return out;
}

const email = `intent-${Date.now().toString(36)}@example.com`;
const password = `p${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
const phone = `+1212555${String(Math.floor(Math.random() * 1e4)).padStart(4, "0")}`;
const { token, user } = await json("/auth/signup", null, { method: "POST", body: JSON.stringify({ email, password, name: "Probe Person" }) });
const id = user.id.replace(/[^0-9a-f-]/gi, "");
try {
  d1([
    `UPDATE users SET email_verified_at = ${Date.now()}, plan_override = 'base', trial_phone = '${phone}' WHERE id = '${id}'`,
    `UPDATE settings SET time_zone = NULL WHERE user_id = '${id}'`,
    `INSERT INTO text_links (user_id, phone, linked_at) VALUES ('${id}', '${phone}', ${Date.now()})`,
  ]);
  const me = await json("/me", token);
  await json("/me/consent", token, { method: "POST", body: JSON.stringify({ version: me.user.aiConsent.current }) });

  // The trial's five free texts first (a trial number is capped there).
  const limit = await text(token, "why do i only get 5 free texts");
  const app = await text(token, "i can't find the app");
  check("never sends them to the App Store", !/app store/i.test(app) || /not (in|on) the app store/i.test(app), app.slice(0, 80));
  check("points at ovoa.ai/text", /ovoa\.ai\/text/i.test(app + limit));
  const hello = await text(token, "Hi OVOA!");
  check("a hello doesn't open with the hour", !/late|early|midnight|night|[0-9]:[0-9][0-9]|[0-9] ?(am|pm)/i.test(hello));
  const dog = await text(token, "Send me a pic of a dog");
  check("no step nag on a dog request", !/steps|goal|routine/i.test(dog));
  const how = await text(token, "hey how u doing");
  check("no time-of-day remark on small talk", !/late|rough night|[0-9]:[0-9][0-9]|[0-9] ?(am|pm)/i.test(how));
  check("no step nag on small talk", !/steps|goal/i.test(how));
  // Then as an ordinary account with the number linked.
  d1([`UPDATE users SET trial_phone = NULL WHERE id = '${id}'`]);
  const ig = await text(token, "hi can u send dms using my ig");
  check("Instagram: says how to connect, not 'impossible'", /connect|link/i.test(ig) && !/locked down|doesn't give|no way/i.test(ig));
  const img = await text(token, "hey can u read images");
  check("says it can read photos", /yes|yeah|can |send/i.test(img) && !/^nope|can't (view|read|see)|just text/i.test(img));
  const past = await text(token, "iya bebe");
  check("doesn't invent a shared past", !/last (10k|day)|remember when|you called me/i.test(past));

  const zone = JSON.parse(d1([`SELECT time_zone FROM settings WHERE user_id = '${id}'`]))[0].results[0]?.time_zone;
  check("the zone was guessed from the number and saved", zone === "America/New_York", String(zone));
} finally {
  await json("/me", token, { method: "DELETE" }).catch((err) => console.error(`couldn't delete ${id}: ${err.message}`));
  console.error(`account ${id} deleted`);
}
console.log(fails ? `\n${fails} check(s) failed` : "\nall intent probe checks passed");
process.exit(fails ? 1 : 0);
