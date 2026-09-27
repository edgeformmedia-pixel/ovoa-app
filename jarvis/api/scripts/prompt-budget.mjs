// What an ordinary turn carries before the model's first word: the system
// prompt's sections and the tool JSON, as index.ts logs them ("ovoa.prompt").
// Local only. No model is called and nothing leaves this machine: the worker
// runs in Miniflare with every outbound fetch answered 503 here, and without
// the AI binding, so the turn stops right after the prompt is built (the log
// line is written before the model runs).
//
//     node scripts/prompt-budget.mjs              this checkout
//     node scripts/prompt-budget.mjs <api dir>    another checkout's jarvis/api
//                                                 (e.g. a git worktree of main;
//                                                 it borrows this node_modules)
//
// Two people: "plain" (Plus, nothing new switched on) and "everything"
// (Plus, Outlook connected, every switch this branch added set). Each sends
// the same ordinary typed and spoken messages.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const here = resolve(fileURLToPath(new URL("..", import.meta.url)));
const src = resolve(process.argv[2] ?? here);
const work = mkdtempSync(join(tmpdir(), "ovoa-budget-"));
const DEBUG_KEY = "localbudget";

const MESSAGES = [
  { label: "typed hello", body: { message: "hey, how's it going?" } },
  { label: "typed ask", body: { message: "what should I make for dinner tonight?" } },
  { label: "spoken hello", body: { message: "hey, how's it going?", voice: true, stream: true } },
  { label: "spoken ask", body: { message: "what should I make for dinner tonight?", voice: true, stream: true } },
];

// Every switch this branch added, with dummy values: nothing reaches a real service.
const EVERYTHING = {
  CAMPAIGNS: "1",
  TEXT_GROUPS: "1",
  INBOUND_CODES: "1",
  TEXT_VOICE_REPLIES: "1",
  SENDBLUE_CONTACT_SHARING: "1",
  MS_CLIENT_ID: "dummy-client",
  MS_CLIENT_SECRET: "dummy-secret",
};

function config() {
  const text = readFileSync(join(src, "wrangler.jsonc"), "utf8");
  // Comments out (not inside strings: none of the config's strings has "//" after a quote-free run).
  const json = text.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(json);
}

async function run(name, extraVars, setup, extra = []) {
  const cfg = config();
  const persist = join(work, name);
  const db = cfg.d1_databases[0];
  execFileSync(join(here, "node_modules/.bin/wrangler"), ["d1", "migrations", "apply", db.database_name, "--local", "--persist-to", persist], {
    cwd: src,
    stdio: "ignore",
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });
  // Bundled by wrangler itself, exactly as a deploy would (--dry-run uploads nothing).
  const out = join(work, `${name}-bundle`);
  execFileSync(join(here, "node_modules/.bin/wrangler"), ["deploy", "--dry-run", "--outdir", out], {
    cwd: src,
    stdio: "ignore",
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });
  const outfile = join(out, "index.js");
  const logs = [];
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    scriptPath: outfile,
    modulesRoot: out,
    compatibilityDate: cfg.compatibility_date,
    compatibilityFlags: cfg.compatibility_flags ?? [],
    bindings: {
      ...cfg.vars,
      DEBUG_KEY,
      EMAIL_CODES_TO_LOG: "1",
      // A throwaway key so the vault's tools exist, as they do in production.
      TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString("base64"),
      ...extraVars,
    },
    d1Databases: { [db.binding]: db.database_id },
    resourcePersistencePath: join(persist, "v3"),
    durableObjects: { GAME_ROOM: "GameRoom" },
    // Nothing leaves: every fetch the worker makes is answered here.
    outboundService: () => new Response("offline", { status: 503 }),
    handleStructuredLogs: (log) => logs.push(String(log.message ?? "")),
    handleRuntimeStdio: (out, err) => {
      out.on("data", (d) => logs.push(String(d)));
      err.on("data", () => {});
    },
  }));
  try {
    const call = (path, init = {}) => mf.dispatchFetch(`http://localhost${path}`, init);
    const json = (method, path, body, headers = {}) =>
      call(path, { method, headers: { "content-type": "application/json", ...headers }, body: body && JSON.stringify(body) }).then((r) => r.json().catch(() => ({})));
    const debug = { "x-debug-key": DEBUG_KEY };
    const email = `budget-${name}@example.com`;
    const signup = await json("POST", "/auth/signup", { email, password: "password123", name: "Budget" });
    if (!signup.token) throw new Error(`sign-up failed: ${JSON.stringify(signup)}`);
    const auth = { authorization: `Bearer ${signup.token}` };
    const me = await json("GET", "/me", undefined, auth);
    await json("POST", "/debug/verify", { userId: me.user.id }, debug);
    await json("POST", "/me/consent", { version: me.user.aiConsent.current }, auth);
    await json("PUT", "/debug/plan", { userId: me.user.id, override: "plus" }, debug);
    if (setup) await setup(mf, me.user.id);
    const rows = [];
    for (const m of [...MESSAGES, ...extra]) {
      const before = logs.length;
      const res = await call("/chat", { method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify({ ...m.body, timeZone: "America/New_York" }) });
      await res.text();
      // The log can trail the response a little.
      for (let i = 0; i < 20 && !logs.slice(before).some((l) => l.includes("ovoa.prompt")); i++) await new Promise((r) => setTimeout(r, 50));
      const line = logs.slice(before).join("\n").split("\n").find((l) => l.includes("ovoa.prompt"));
      rows.push({ label: m.label, ...shape(line) });
    }
    return rows;
  } finally {
    await mf.dispose();
  }
}

/** "base 1200, voice 500, tools 9000 (12), history 40" to numbers. */
export function shape(line) {
  if (!line) return { system: NaN, tools: NaN, toolCount: NaN, sections: "(no ovoa.prompt line)" };
  const body = line.replace(/^.*ovoa\.prompt rid=\S+ (typed|spoken) /, "");
  const parts = body.split(/, (?=[a-z]+ \d)/);
  let system = 0;
  let tools = 0;
  let toolCount = 0;
  const sections = [];
  let count = 0;
  for (const p of parts) {
    const m = p.match(/^([a-z]+) (\d+)(?: \((\d+))?/);
    if (!m) continue;
    const n = Number(m[2]);
    if (m[1] === "tools") {
      tools = n;
      toolCount = Number(m[3] ?? 0);
    } else if (m[1] !== "history") {
      system += n;
      count++;
      sections.push(`${m[1]} ${n}`);
    }
  }
  // The sections are joined with a blank line each (index.ts).
  system += Math.max(0, count - 1) * 2;
  return { system, tools, toolCount, sections: sections.join(", ") };
}

async function connectOutlook(mf, userId) {
  const db = await mf.getD1Database("DB");
  // A checkout from before Outlook (main at 16c2deb) has no such table: nothing to connect.
  const table = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'microsoft_accounts'").first();
  if (!table) return;
  await db
    .prepare("INSERT INTO microsoft_accounts (user_id, email, scopes, refresh_token_enc, connected_at) VALUES (?, ?, ?, ?, ?)")
    .bind(userId, "budget@outlook.com", "offline_access User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite People.Read", "x", Date.now())
    .run();
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (!existsSync(join(src, "wrangler.jsonc"))) {
    console.error(`No wrangler.jsonc in ${src}`);
    process.exit(1);
  }
  try {
    console.log(`Prompt budget for ${src}\n`);
    for (const [name, vars, setup, extra] of [
      ["plain", {}, null],
      // The last row is a check that Outlook really is connected: it names an Outlook tool.
      ["everything", EVERYTHING, connectOutlook, [{ label: "outlook check", body: { message: "what's in my outlook inbox?" } }]],
    ]) {
      const rows = await run(name, vars, setup, extra);
      console.log(`${name}:`);
      for (const r of rows) {
        console.log(`  ${r.label.padEnd(13)} system ${String(r.system).padStart(6)}  tools ${String(r.tools).padStart(6)} (${r.toolCount})  total ${String(r.system + r.tools).padStart(6)}`);
        console.log(`    ${r.sections}`);
      }
      console.log();
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
