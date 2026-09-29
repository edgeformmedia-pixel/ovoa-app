// Runs a real browser errand against production and reports what the agent did.
//
//     cd jarvis/api
//     XDG_CONFIG_HOME=C:/Users/thoma/.wrangler-ovoa node scripts/browser-probe.mjs ["errand"] [start_url]
//
// Signs up a throwaway account (Base plan, AI consent), asks for the errand in
// chat, polls browser_tasks until it's done or waiting, prints the result and
// deletes the account. Costs a little browser time and a few GLM vision calls.

import { spawnSync } from "node:child_process";

const API = "https://api.ovoa.ai";
const goal = process.argv[2] ?? "Go to example.com and tell me what the page's main heading says.";
const start = process.argv[3] ?? "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(path, token, init = {}) {
  const res = await fetch(`${API}${path}`, { ...init, headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) } , });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${body.error ?? ""}`);
  return body;
}
async function post(path, token, body, method = "POST") {
  const res = await fetch(`${API}${path}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${out.error ?? ""}`);
  return out;
}
function d1(sql) {
  // No shell: quoting SQL through one on Windows mangles it. --command, unlike --file, returns rows.
  const r = spawnSync(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "d1", "execute", "jarvis-db", "--remote", "--json", "--command", sql], { encoding: "utf8", env: process.env });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout).slice(-400));
  const out = JSON.parse(r.stdout.slice(r.stdout.indexOf("[")));
  return out.at(-1)?.results ?? [];
}

const email = `probe-${Date.now().toString(36)}@example.com`;
const password = `p${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
const { token, user } = await json("/auth/signup", null, { method: "POST", body: JSON.stringify({ email, password, name: "Probe Person" }) });
const id = user.id.replace(/[^0-9a-f-]/gi, "");
console.error(`account ${id}`);
try {
  d1(`UPDATE users SET email_verified_at = ${Date.now()}, plan_override = 'base' WHERE id = '${id}'`);
  const me = await json("/me", token);
  await post("/me/consent", token, { version: me.user.aiConsent.current });
  const ask = `Use the browser: ${goal}${start ? ` Start at ${start}.` : ""}`;
  const chat = await post("/chat", token, { message: ask, timeZone: "America/New_York" });
  console.log(`asked: ${ask}\nreply: ${chat.messages?.at(-1)?.content}`);
  for (let i = 0; i < 40; i++) {
    await sleep(6000);
    const [t] = d1(`SELECT status, steps, result FROM browser_tasks WHERE user_id = '${id}' ORDER BY created_at DESC LIMIT 1`);
    console.log(`  ${t ? `${t.status}, ${t.steps} steps` : "no errand yet"}`);
    if (t && t.status !== "running") {
      console.log(`RESULT (${t.status}): ${t.result}`);
      if (t.status === "waiting" && process.argv.includes("--approve")) {
        // Their YES: the held step goes ahead on the same browser.
        const actions = (await json("/actions", token)).actions ?? [];
        const a = actions.find((x) => /^Browser:/.test(x.summary));
        console.log(`YES to: ${a?.summary}`);
        console.log(`  ${(await post(`/actions/${a.id}/approve`, token, {})).message}`);
        for (let j = 0; j < 20; j++) {
          await sleep(6000);
          const [u] = d1(`SELECT status, steps, result FROM browser_tasks WHERE user_id = '${id}' ORDER BY created_at DESC LIMIT 1`);
          console.log(`  ${u.status}, ${u.steps} steps`);
          if (u.status !== "running") {
            console.log(`AFTER YES (${u.status}): ${u.result}`);
            break;
          }
        }
      }
      const msgs = d1(`SELECT content FROM messages WHERE user_id = '${id}' AND role = 'assistant' ORDER BY created_at DESC LIMIT 2`);
      console.log(`last messages: ${JSON.stringify(msgs.map((m) => m.content))}`);
      break;
    }
  }
} finally {
  await post("/me", token, {}, "DELETE").catch((e) => console.error(`couldn't delete ${id}: ${e.message}`));
}
