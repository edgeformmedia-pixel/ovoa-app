// Usernames (usernames.ts): what a username can be, the one namespace it shares
// with the flat website names (both are a <name>.ovoa.ai), the tools that pick
// and change one (suggested, then claimed only once confirmed), the 30 days
// between changes, the 90 days an old one is held, and the app's routes, on
// the real schema over Node's own SQLite (every migration applied).

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { labelTaken, sitesAssistant } from "../src/sites";
import type { Env, Vars } from "../src/types";
import {
  claimUsername,
  isUsernameTool,
  suggestUsername,
  usernameAssistant,
  usernameFrom,
  usernameIdeas,
  usernameProblem,
  usernameRoutes,
} from "../src/usernames";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const g = typeof got === "object" ? JSON.stringify(got) : got;
  const w = typeof want === "object" ? JSON.stringify(want) : want;
  const ok = g === w;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${g}${ok ? "" : `  (wanted ${w})`}`);
}

// ---------- What a username can be ----------

eq("a fine one", usernameProblem("thomas"), null);
eq("with digits and a hyphen", usernameProblem("maria-2"), null);
eq("too short", usernameProblem("ab")?.includes("at least 3"), true);
eq("too long", usernameProblem("a".repeat(31))?.includes("at most 30"), true);
eq("no capitals", usernameProblem("Thomas")?.includes("lowercase"), true);
eq("no double hyphens", usernameProblem("tom--l")?.includes("single hyphens"), true);
eq("no hyphen at an end", usernameProblem("tom-")?.includes("hyphen"), true);
eq("OVOA's own names are kept", usernameProblem("admin")?.includes("kept for OVOA"), true);
eq("and the sign-in page ones", usernameProblem("login")?.includes("kept for OVOA"), true);
eq("no brands", usernameProblem("apple-support")?.includes("brand"), true);
eq("nor anything with a big one in it", usernameProblem("mypaypal")?.includes("brand"), true);
eq("said with an @ and a capital", usernameFrom(" @Thomas.L "), "thomas-l");
eq("ideas from a name", usernameIdeas("Thomas Lancheros"), ["thomas", "thomas-lancheros", "thomasl", "tlancheros", "thomaslancheros"]);
eq("one name", usernameIdeas("Cher"), ["cher"]);
eq("accents", usernameIdeas("José Núñez")[0], "jose");
eq("the tools are known", ["username_get", "username_set", "username_change"].every(isUsernameTool), true);

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
const sql = (q: string, ...args: unknown[]) => sqlite.prepare(q).run(...(args as never[]));
const one = <T>(q: string, ...args: unknown[]) => sqlite.prepare(q).get(...(args as never[])) as T | undefined;

const U = "user-1";
const OTHER = "user-2";
for (const [id, email, name] of [
  [U, "thomas@example.com", "Thomas Lancheros"],
  [OTHER, "maria@example.com", "Maria Diaz"],
]) {
  sql("INSERT INTO users (id, email, password_hash, password_salt, name, created_at) VALUES (?, ?, '', '', ?, ?)", id, email, name, Date.now());
  sql("INSERT INTO settings (user_id, assistant_name, time_zone, updated_at) VALUES (?, 'OVOA', 'America/New_York', ?)", id, Date.now());
}
// A flat website from before, at thomas.ovoa.ai: the name can't be anyone's username.
sql("INSERT INTO sites (id, user_id, slug, name, brief, status, created_at, updated_at) VALUES ('s1', ?, 'thomas', 'Thomas', 'x', 'live', 0, 0)", OTHER);

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("https://cloudflare-dns.com/")) return new Response(JSON.stringify({ Status: 3 }), { headers: { "content-type": "application/dns-json" } });
  throw new Error(`unexpected fetch in a test: ${url}`);
}) as typeof fetch;

const env = { DB, SITES_DOMAIN: "ovoa.ai", PUBLIC_URL: "https://api.ovoa.ai", TOKEN_ENC_KEY: "k" } as unknown as Env;

async function main() {
  // ---------- One namespace ----------
  eq("a flat site's name is taken", await labelTaken(DB, "thomas"), "site");
  eq("so the suggestion skips it", await suggestUsername(DB, "Thomas Lancheros", U), "thomas-lancheros");

  // ---------- In conversation: suggested, confirmed, claimed ----------
  const tools = usernameAssistant(env, U);
  const call = (name: string, args: Record<string, unknown>) => tools.callTool(name, args) as Promise<Record<string, unknown>>;
  eq("none yet, with a suggestion", await call("username_get", {}), {
    username: null,
    suggestion: "thomas-lancheros",
    note: "They don't have one yet. Offer the suggestion if it comes up; set it with username_set once they agree.",
  });
  const offered = await call("username_set", {});
  eq("set without a name offers one", offered.available, "@thomas-lancheros");
  eq("and asks for their yes first", String(offered.note).includes("confirm: true"), true);
  eq("nothing claimed yet", one<{ username: string | null }>("SELECT username FROM users WHERE id = ?", U)?.username, null);
  const clash = await call("username_set", { username: "thomas" });
  eq("a website's address can't be a username", String(clash.error).includes("already a website's address"), true);
  eq("with another offered", clash.suggestion, "thomas-lancheros");
  eq("a kept name can't be had", String((await call("username_set", { username: "support" })).error).includes("kept"), true);
  eq("claimed once confirmed", (await call("username_set", { username: "@TomL", confirm: true })).username, "@toml");
  eq("it's theirs", one<{ username: string }>("SELECT username FROM users WHERE id = ?", U)?.username, "toml");
  eq("set again says to change it", String((await call("username_set", { username: "x-y-z", confirm: true })).error).includes("username_change"), true);
  eq("taken for anyone else", await labelTaken(DB, "toml", OTHER), "username");
  eq("and not a website's address now", String(((await sitesAssistant(env, OTHER, "UTC").callTool("site_build", { name: "T", about: "x", subdomain: "toml" })) as { error: string }).error).includes("taken"), true);
  eq("the other person can't claim it", await claimUsername(DB, OTHER, "toml"), { error: "@toml is taken." });

  // ---------- Changing it: once in 30 days, the old one held 90 ----------
  eq("a change right after picking waits 30 days", String((await call("username_change", { username: "tom-l", confirm: true })).error).includes("once every 30 days"), true);
  sql("UPDATE users SET username_at = ? WHERE id = ?", Date.now() - 31 * 86_400_000, U);
  sql("INSERT INTO sites (id, user_id, slug, name, brief, status, created_at, updated_at, owner_username, path) VALUES ('p1', ?, 'toml/bakery', 'Bakery', 'x', 'live', 0, 0, 'toml', 'bakery')", U);
  eq("a change asks for their yes first", (await call("username_change", { username: "tom-l" })).available, "@tom-l");
  const changed = await call("username_change", { username: "tom-l", confirm: true });
  eq("then changes", changed.username, "@tom-l");
  eq("and says the old address sends people on", String(changed.note).includes("toml.ovoa.ai sends visitors there for 90 days"), true);
  eq("their projects moved", one("SELECT slug, owner_username FROM sites WHERE id = 'p1'"), { slug: "tom-l/bakery", owner_username: "tom-l" });
  eq("the old one is held for them", one<{ user_id: string }>("SELECT user_id FROM usernames_history WHERE username = 'toml'")?.user_id, U);
  eq("nobody else can have it", (await claimUsername(DB, OTHER, "toml")) as unknown, { error: "@toml is taken." });
  sql("UPDATE users SET username_at = ? WHERE id = ?", Date.now() - 31 * 86_400_000, U);
  eq("but they can take it back", await claimUsername(DB, U, "toml"), { username: "toml" });
  eq("and it isn't held any more", one("SELECT username FROM usernames_history WHERE username = 'toml'"), undefined);
  eq("the one in between is held instead", one<{ username: string }>("SELECT username FROM usernames_history WHERE user_id = ?", U)?.username, "tom-l");
  eq("the projects came back too", one<{ slug: string }>("SELECT slug FROM sites WHERE id = 'p1'")?.slug, "toml/bakery");
  eq("what it is now", (await call("username_get", {})).address, "toml.ovoa.ai");

  // ---------- The app's routes ----------
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();
  app.use("*", async (c, next) => {
    c.set("userId" as never, OTHER as never);
    await next();
  });
  app.route("/", usernameRoutes);
  const req = async (path: string, init?: RequestInit) => {
    const res = await app.request(path, init, env);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  eq("theirs, with a suggestion", (await req("/me/username")).body, { username: null, address: null, changeableAt: null, suggestion: "maria" });
  eq("checked as they type: free", (await req("/me/username/check?name=Maria")).body, { username: "maria", available: true });
  eq("checked: taken", (await req("/me/username/check?name=toml")).body, { username: "toml", available: false, problem: "@toml is taken." });
  eq("checked: a website's", (await req("/me/username/check?name=thomas")).body.available, false);
  const put = await req("/me/username", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "maria" }) });
  eq("set from the app", [put.status, put.body.username, put.body.address], [200, "maria", "maria.ovoa.ai"]);
  const again = await req("/me/username", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "maria-d" }) });
  eq("and not changed again the same day", [again.status, String(again.body.error).includes("30 days")], [409, true]);
  eq("nothing to set is a 400", (await req("/me/username", { method: "PUT", body: "{}" })).status, 400);
}

main()
  .catch((err) => {
    fails++;
    console.error(err);
  })
  .finally(() => {
    globalThis.fetch = realFetch;
    console.log(fails ? `\n${fails} FAILED` : "\nall passed");
    process.exit(fails ? 1 : 0);
  });
