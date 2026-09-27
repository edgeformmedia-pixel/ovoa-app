// Logins without passwords (sitesessions.ts): a site they signed into in the
// app is lent to OVOA's browser as encrypted cookies, only for that site, for
// 30 days at most; money sites are refused; the browser loads the session
// before opening a page there, and again when an approval is replayed.

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { blockRoutes, blocksAssistant } from "../src/blocks";
import { type BrowserPage, type PageState, setBrowserFactory } from "../src/browser";
import { approveAction } from "../src/google/assistant";
import { cookiesFor, refusedHost, saveSiteSession, type SiteCookie } from "../src/sitesessions";
import type { Env, Vars } from "../src/types";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(got)}${ok ? "" : `  (wanted ${JSON.stringify(want)})`}`);
}

function d1(sqlite: DatabaseSync): D1Database {
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => (sqlite.prepare(sql).get(...(args as never[])) as unknown) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...(args as never[])) }),
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...(args as never[])).changes) } }),
  });
  return { prepare: (sql: string) => statement(sql) } as unknown as D1Database;
}

const sqlite = new DatabaseSync(":memory:");
for (const file of readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort()) {
  sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
}
sqlite.exec("PRAGMA foreign_keys = ON");
for (const id of ["sam", "alex"]) {
  sqlite.prepare("INSERT INTO users (id, email, password_hash, password_salt, name, created_at) VALUES (?, ?, '', '', ?, 0)").run(id, `${id}@example.com`, id);
}
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
const env = { DB: d1(sqlite), TOKEN_ENC_KEY: KEY, BROWSER: {} } as unknown as Env;

const cookie = (name: string, domain: string): SiteCookie => ({ name, value: `v-${name}`, domain, path: "/", httpOnly: true, secure: true });

async function main() {
  // Money sites.
  for (const host of ["chase.com", "www.bankofamerica.com", "online.mybank-bank.com", "paypal.com", "venmo.com", "robinhood.com", "coinbase.com", "sa.www4.irs.gov"]) {
    eq(`refused ${host}`, refusedHost(host) !== null, true);
  }
  for (const host of ["opentable.com", "amazon.com", "delta.com", "discovery.com", "wisely.example.com"]) {
    eq(`allowed ${host}`, refusedHost(host), null);
  }
  eq("saving a bank is refused", ((await saveSiteSession(env, "sam", "chase.com", [cookie("s", "chase.com")])) as { error?: string }).error?.startsWith("OVOA doesn't sign into banks"), true);

  // Saving: only cookies for that site, encrypted.
  const saved = await saveSiteSession(env, "sam", "www.OpenTable.com", [cookie("session", ".opentable.com"), cookie("tracker", "ads.example.net"), cookie("pref", "www.opentable.com")]);
  eq("saved, other sites' cookies dropped", "error" in saved ? saved.error : [saved.host, saved.cookies], ["opentable.com", 2]);
  const stored = sqlite.prepare("SELECT cookies_enc FROM site_sessions WHERE user_id = 'sam'").get() as { cookies_enc: string };
  eq("encrypted at rest", stored.cookies_enc.includes("v-session"), false);
  eq("loaded for the site", (await cookiesFor(env, "sam", "www.opentable.com")).map((c) => c.name), ["session", "pref"]);
  eq("and for its subdomains", (await cookiesFor(env, "sam", "reservations.opentable.com")).length, 2);
  eq("not for another site", (await cookiesFor(env, "sam", "resy.com")).length, 0);
  eq("not for another person", (await cookiesFor(env, "alex", "opentable.com")).length, 0);
  eq("gone after 30 days", (await cookiesFor(env, "sam", "opentable.com", Date.now() + 31 * 86_400_000)).length, 0);

  // The browser: loaded before the page opens, and when an approval replays.
  const log: string[] = [];
  const page = (): BrowserPage => ({
    async goto(url) {
      log.push(`goto ${url}`);
    },
    async state(): Promise<PageState> {
      return {
        url: "https://www.opentable.com/r/luca",
        title: "Luca",
        text: "Table for 4, 7:00 PM",
        elements: [{ id: 1, kind: "submit", label: "Complete reservation", selector: "#book", inForm: true }],
      };
    },
    async click(selector) {
      log.push(`click ${selector}`);
    },
    async type() {},
    async select() {},
    async pressEnter() {},
    async back() {},
    async setCookies(cookies) {
      log.push(`cookies ${cookies.map((c) => c.name).join(",")}`);
    },
  });
  setBrowserFactory(async () => {
    const p = page();
    return { page: async () => p, close: async () => void log.push("close") };
  });
  const b = blocksAssistant(env, "sam", "UTC");
  const opened = (await b.callTool("browser_open", { url: "https://www.opentable.com/r/luca" })) as { signedIn?: string };
  eq("signed in before the page opened", log.slice(0, 2), ["cookies session,pref", "goto https://www.opentable.com/r/luca"]);
  eq("and the model is told", typeof opened.signedIn, "string");
  const waiting = (await b.callTool("browser_click", { id: 1 })) as { status: string };
  eq("booking still waits for approval", waiting.status, "waiting_for_user_approval");
  const parked = sqlite.prepare("SELECT id, args FROM pending_actions WHERE user_id = 'sam'").get() as { id: string; args: string };
  eq("no cookies in the parked action", parked.args.includes("v-session"), false);
  log.length = 0;
  const done = await approveAction(env, "sam", parked.id);
  eq("approved", done?.content.startsWith("Done:"), true);
  eq("the replay signed in first, then booked", log, ["cookies session,pref", "goto https://www.opentable.com/r/luca", "click #book", "close"]);

  const alexBrowser = blocksAssistant(env, "alex", "UTC");
  log.length = 0;
  const alexOpened = (await alexBrowser.callTool("browser_open", { url: "https://www.opentable.com/r/luca" })) as { signedIn?: string };
  eq("someone else's browser isn't signed in with Sam's session", [log.some((l) => l.startsWith("cookies")), alexOpened.signedIn], [false, undefined]);

  // The app's routes.
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();
  app.use("*", async (c, next) => {
    c.set("userId", "sam");
    await next();
  });
  app.route("/", blockRoutes);
  const listed = (await (await app.request("/browser/sites", {}, env)).json()) as { sites: { host: string }[] };
  eq("GET /browser/sites (no cookie values in it)", listed.sites.map((s) => s.host), ["opentable.com"]);
  const post = await app.request("/browser/sites", { method: "POST", body: JSON.stringify({ host: "delta.com", cookies: [cookie("dl", ".delta.com")] }), headers: { "content-type": "application/json" } }, env);
  eq("POST /browser/sites", post.status, 201);
  const bank = await app.request("/browser/sites", { method: "POST", body: JSON.stringify({ host: "chase.com", cookies: [cookie("c", "chase.com")] }), headers: { "content-type": "application/json" } }, env);
  eq("POST a bank: refused", bank.status, 400);
  eq("DELETE /browser/sites/:host", (await app.request("/browser/sites/delta.com", { method: "DELETE" }, env)).status, 204);

  sqlite.prepare("DELETE FROM users WHERE id = 'sam'").run();
  eq("gone with the account", (sqlite.prepare("SELECT COUNT(*) AS n FROM site_sessions").get() as { n: number }).n, 0);

  console.log(fails ? `\n${fails} failed` : "\nall passed");
  if (fails) process.exit(1);
}

main();
