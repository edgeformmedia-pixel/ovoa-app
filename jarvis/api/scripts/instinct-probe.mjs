// Games for two, plans followed up, budgets with a YES (docs/instinct-more.md),
// by text against production, end to end:
//   1. "make a game for me and my girlfriend": game_make resolves her from what
//      OVOA remembers and the OVOA connection, the sites lane builds it, it's
//      served sandboxed with its script, and the link reaches her OVOA.
//   2. "I'm traveling to San Francisco next month": a plan with a follow-up,
//      the booking-time advice, and on yes a dated reminder.
//   3. A travel budget, a hotel prepared within it ("Book this for $X? Reply
//      YES"), and the YES recording it and giving the link.
//   4. Which engine answered every model call (usage_daily): GLM on Z.ai ("glm").
// Runs through POST /texting/try, so no real text is sent.
//
//     cd jarvis/api
//     XDG_CONFIG_HOME=C:/Users/thoma/.wrangler-ovoa node scripts/instinct-probe.mjs > instinct-probe.txt
//
// Two throwaway accounts (texting first off, a made-up number), deleted at the end.

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

function wrangler(args) {
  const r = spawnSync("npx", ["wrangler", "d1", "execute", "jarvis-db", "--remote", "-y", ...args], { shell: true, encoding: "utf8", env: process.env });
  if (r.status !== 0) throw new Error(`wrangler d1 execute failed: ${(r.stderr || r.stdout).slice(-400)}`);
  return r.stdout;
}

function d1Execute(statements) {
  const dir = mkdtempSync(join(tmpdir(), "ovoa-probe-"));
  const file = join(dir, "probe.sql");
  writeFileSync(file, `${statements.join(";\n")};\n`);
  try {
    wrangler(["--file", file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One SELECT's rows. */
function d1Query(sql, tries = 3) {
  try {
    return d1QueryOnce(sql);
  } catch (err) {
    if (tries <= 1) throw err;
    return d1Query(sql, tries - 1);
  }
}

function d1QueryOnce(sql) {
  const r =spawnSync("npx", ["wrangler", "d1", "execute", "jarvis-db", "--remote", "--json", "--command", JSON.stringify(sql.replace(/\s+/g, " "))], { shell: true, encoding: "utf8", env: process.env });
  if (r.status !== 0) throw new Error(`wrangler d1 query failed: ${(r.stderr || r.stdout).slice(-400)}`);
  return JSON.parse(r.stdout.slice(r.stdout.indexOf("[")))[0]?.results ?? [];
}

let fails = 0;
function check(label, ok, detail) {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

async function text(token, message) {
  const t0 = Date.now();
  const r = await json("/texting/try", token, { method: "POST", body: JSON.stringify({ message }) });
  const texts = r.texts ?? [];
  console.log(`  > ${message}\n  < ${texts.map((t) => JSON.stringify(t)).join("\n  < ") || "(nothing)"}  [${Date.now() - t0} ms, ${r.outcome}]`);
  return texts.join("\n");
}

async function waitFor(what, look, minutes = 8) {
  const t0 = Date.now();
  for (;;) {
    const got = await look();
    if (got) {
      console.log(`  (${what} after ${Math.round((Date.now() - t0) / 1000)} s)`);
      return got;
    }
    if (Date.now() - t0 > minutes * 60_000) {
      console.log(`  (gave up waiting for ${what})`);
      return null;
    }
    await sleep(15_000);
  }
}

const tag = Date.now().toString(36);
const people = [];
async function signUp(name, who) {
  const email = `probe-${who}-${tag}@example.com`;
  const password = `p${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  const { token, user } = await json("/auth/signup", null, { method: "POST", body: JSON.stringify({ email, password, name }) });
  const id = user.id.replace(/[^0-9a-f-]/gi, "");
  people.push({ token, id });
  console.error(`account ${id} created`);
  return { token, id, username: `instprobe-${who}-${tag}` };
}

try {
  const me = await signUp("Tomas Probe", "t");
  const her = await signUp("Mariela Probe", "m");
  const phone = `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
  d1Execute([
    ...[me, her].flatMap((p) => [
      `UPDATE users SET email_verified_at = ${Date.now()}, plan_override = 'base' WHERE id = '${p.id}'`,
      `UPDATE settings SET time_zone = 'America/New_York' WHERE user_id = '${p.id}'`,
    ]),
    `INSERT INTO text_links (user_id, phone, linked_at, proactive) VALUES ('${me.id}', '${phone}', ${Date.now()}, 0)`,
    `INSERT INTO memories (id, user_id, content, created_at) VALUES ('${crypto.randomUUID()}', '${me.id}', 'Tomas''s girlfriend is Mariela; they both love travel and bad puns', ${Date.now()})`,
  ]);
  for (const p of [me, her]) {
    const m = await json("/me", p.token);
    await json("/me/consent", p.token, { method: "POST", body: JSON.stringify({ version: m.user.aiConsent.current }) });
    await json("/me/username", p.token, { method: "PUT", body: JSON.stringify({ username: p.username }) });
  }
  await json("/ovoa/connect", me.token, { method: "POST", body: JSON.stringify({ username: her.username }) });
  await json(`/ovoa/connections/${me.username}/answer`, her.token, { method: "POST", body: JSON.stringify({ answer: "yes" }) });
  check("their OVOAs are connected", (await json("/ovoa/connections", me.token)).connections.some((c) => c.status === "connected"));

  // ---------- 1. A game for the two of them ----------
  const asked = await text(me.token, "make a little game for me and my girlfriend, a would-you-rather about travel");
  const [game] = d1Query(`SELECT id, slug, kind, share_to, share_for, status FROM sites WHERE user_id = '${me.id}' AND kind = 'game'`);
  check("game_make was called: a game is queued", !!game, JSON.stringify(game));
  check("for her, resolved from memory and the connection", game?.share_to === her.username && game?.share_for === "Mariela", `${game?.share_for} @${game?.share_to}`);
  check("the reply says it's on its way, not that it's ready", /way|minute|making|build/i.test(asked) && !/\bis ready\b/i.test(asked), asked.split("\n")[0]);
  const built = game && (await waitFor("the game to be built", async () => d1Query(`SELECT status, html FROM sites WHERE id = '${game.id}'`).find((s) => s.status !== "building")));
  check("it went live", built?.status === "live", built?.status);
  if (built?.status === "live") {
    const link = (await json("/sites", me.token)).sites.find((s) => s.name && s.link.includes(game.slug.split("/")[1]))?.link ?? `https://${game.slug.replace("/", ".ovoa.ai/")}/`;
    const res = await fetch(link);
    const html = await res.text();
    const policy = res.headers.get("content-security-policy") ?? "";
    check("the game is served", res.status === 200, `${res.status} ${link}`);
    check("with its own script", /<script(?![^>]*src)[^>]*>[\s\S]*\S[\s\S]*<\/script>/i.test(html));
    check("sandboxed, no network, no same-origin", policy.startsWith("sandbox allow-scripts") && policy.includes("connect-src 'none'") && !policy.includes("allow-same-origin"), policy.slice(0, 90));
    check("not indexed", (res.headers.get("x-robots-tag") ?? "").includes("noindex"));
    const shared = await waitFor("the link to reach her OVOA", async () =>
      d1Query(`SELECT body FROM agent_notes WHERE user_id = '${her.id}' AND body LIKE '%game for the two of you%'`)[0],
    5);
    check("her OVOA got it, with the link", !!shared && shared.body.includes(game.slug.split("/")[1]), shared?.body?.slice(0, 160));
    const told = d1Query(`SELECT body FROM agent_notes WHERE user_id = '${me.id}' AND body LIKE '%is ready%'`)[0];
    check("he was told it's ready and sent to her", !!told && /sent it to Mariela/.test(told.body), told?.body?.slice(0, 160));
  }

  // ---------- 2. A trip ----------
  const trip = await text(me.token, "I'm traveling to San Francisco next month for a long weekend");
  const [plan] = d1Query(`SELECT title, kind, starts_on, followup_on, followup_text FROM life_plans WHERE user_id = '${me.id}'`);
  check("plan_add kept it", !!plan && plan.kind === "trip", JSON.stringify(plan));
  check("with a specific follow-up question", !!plan?.followup_text && plan.followup_text.includes("?"), plan?.followup_text);
  check("the reply has the booking-time advice", /week|month|out|cheap/i.test(trip), "");
  check("and offers a reminder to book", /remind/i.test(trip), "");
  const yes = await text(me.token, "yes, remind me to book");
  const reminders = d1Query(`SELECT text, remind_at FROM notes WHERE user_id = '${me.id}' AND remind_at IS NOT NULL`);
  check("a dated reminder to book was set", reminders.some((r) => /book/i.test(r.text) && r.remind_at > Date.now()), JSON.stringify(reminders.map((r) => [r.text, new Date(Number(r.remind_at)).toISOString()])));
  check("and it says so", /remind|buzz|set|done/i.test(yes));

  // ---------- 3. A budget, a purchase, a YES ----------
  await text(me.token, "set a travel budget of $900 a month, max $600 per purchase");
  const [budget] = d1Query(`SELECT category, amount_cents, period, per_purchase_cents FROM spend_budgets WHERE user_id = '${me.id}'`);
  check("budget_set kept it", budget?.amount_cents === 90000 && budget?.per_purchase_cents === 60000, JSON.stringify(budget));
  const offer = await text(me.token, "find me a hotel in San Francisco for 2 nights next month within my travel budget and set it up so I can book it");
  let [prop] = d1Query(`SELECT id, what, price_cents, url, status FROM purchases WHERE user_id = '${me.id}'`);
  if (!prop) {
    // Some turns ask which dates or area first: answer once.
    await text(me.token, "any good mid-range hotel near Union Square, the 16th to the 18th, you pick");
    [prop] = d1Query(`SELECT id, what, price_cents, url, status FROM purchases WHERE user_id = '${me.id}'`);
  }
  check("purchase_propose prepared one within the budget", !!prop && prop.status === "proposed" && prop.price_cents <= 60000, JSON.stringify(prop));
  check("nothing is bought yet", !/booked|paid|purchased/i.test(offer.replace(/(not|nothing('s| is)) (been |yet )?(booked|paid|purchased)/gi, "")), offer.split("\n")[0]);
  if (prop) {
    const done = await text(me.token, "YES");
    const [after] = d1Query(`SELECT status FROM purchases WHERE id = '${prop.id}'`);
    check("the YES recorded it against the budget", after?.status === "approved", after?.status);
    check("and gave the link to finish it", done.includes(new URL(prop.url).hostname), prop.url);
    check("without claiming it's booked or paid", !/\b(booked|paid)\b/i.test(done.replace(/not (yet )?(booked|paid)|isn't (booked|paid)/gi, "")), done.split("\n")[0]);
  }
  const status = await text(me.token, "how's my travel budget?");
  check("the budget's status is told", /\$\d/.test(status));

  // ---------- 4. Which engine answered ----------
  const usage = d1Query(`SELECT engine, model, SUM(n) AS n FROM usage_daily WHERE user_id = '${me.id}' AND kind = 'llm_call' GROUP BY engine, model`);
  console.log(`  model calls by engine: ${JSON.stringify(usage)}`);
  const total = usage.reduce((a, r) => a + r.n, 0);
  const glm = usage.filter((r) => r.engine === "glm").reduce((a, r) => a + r.n, 0);
  check("every model call was answered by GLM on Z.ai (engine glm)", total > 0 && glm === total, `${glm} of ${total}`);
} catch (err) {
  fails++;
  console.log(`FAIL the probe stopped: ${err.message}`);
} finally {
  for (const p of people) await json("/me", p.token, { method: "DELETE" }).catch((err) => console.error(`couldn't delete ${p.id}: ${err.message}`));
  console.error(`deleted ${people.length} accounts`);
}
console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
