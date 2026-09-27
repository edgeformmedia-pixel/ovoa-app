// Page watchers (watches.ts): set up by a tool, checked on the cron with a
// public-only fetch, an unchanged page skips the model, the owner is told once
// when it happens, pages that won't load end the watch, and nothing is ever
// bought, booked or sent to anyone else.

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { blocksAssistant } from "../src/blocks";
import type { Env } from "../src/types";
import { MAX_WATCHES, watchesTick, watchesWaiting } from "../src/watches";

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
sqlite
  .prepare("INSERT INTO users (id, email, password_hash, password_salt, name, created_at, ai_consent_at, ai_consent_version) VALUES ('sam', 'sam@example.com', '', '', 'Sam', 0, 1, 99)")
  .run();
const env = { DB: d1(sqlite) } as unknown as Env;

async function main() {
  const sam = blocksAssistant(env, "sam", "UTC");
  eq("tools", sam.tools.filter((t) => t.name.startsWith("watch_")).map((t) => t.name), ["watch_add", "watch_list", "watch_remove"]);
  eq("private links refused at the ask", await sam.callTool("watch_add", { url: "http://localhost/admin", looking_for: "x" }), { error: "That address isn't public." });
  const added = (await sam.callTool("watch_add", { url: "https://tickets.example.com/show", looking_for: "Saturday tickets are available", how_often: "hourly", days: 7 })) as { id: string; checks: string; forDays: number };
  eq("added", [added.checks, added.forDays], ["hourly", 7]);
  const start = Date.now();
  eq("due right away", await watchesWaiting(env.DB, start + 1), true);

  // The page, the judge and the notifier, all fakes.
  let page = "<p>Saturday: sold out</p>";
  let reads = 0;
  const fakeFetch = (async () => {
    reads++;
    return new Response(page, { headers: { "content-type": "text/html" } });
  }) as unknown as typeof fetch;
  const judged: string[] = [];
  const judge = async (_row: unknown, text: string) => {
    judged.push(text);
    return text.includes("available") ? { met: true, note: "Saturday tickets are on sale now" } : { met: false, note: "Saturday is sold out" };
  };
  const told: string[] = [];
  const tell = (async (_env: Env, _user: string, r: { text: string; asked?: boolean }) => {
    // What they asked to be told isn't held back like news (reach.ts).
    if (!r.asked) told.push("NOT ASKED");
    told.push(r.text);
    return "text";
  }) as never;

  let at = start + 1;
  eq("first check: not yet", await watchesTick(env, at, { fetch: fakeFetch, judge, tell }), { checked: 1, met: 0 });
  eq("not due again until the hour", await watchesWaiting(env.DB, at + 30 * 60_000), false);
  at += 61 * 60_000;
  await watchesTick(env, at, { fetch: fakeFetch, judge, tell });
  eq("an unchanged page skips the model", judged.length, 1);
  page = "<p>Saturday: tickets available, $40</p>";
  at += 61 * 60_000;
  eq("it happened", await watchesTick(env, at, { fetch: fakeFetch, judge, tell }), { checked: 1, met: 1 });
  eq("the owner is told, with the link, no em dashes", told, ["Heads up: Saturday tickets are on sale now. https://tickets.example.com/show"]);
  at += 61 * 60_000;
  await watchesTick(env, at, { fetch: fakeFetch, judge, tell });
  eq("and only once: the watch is done", [told.length, reads], [1, 3]);
  const listed = (await sam.callTool("watch_list", {})) as { watches: { status: string; lastSaw: string }[] };
  eq("listed as happened", listed.watches.map((w) => [w.status, w.lastSaw]), [["happened", "Saturday tickets are on sale now"]]);

  // A page that won't load ends after a few tries, and they're told once.
  const broken = (await sam.callTool("watch_add", { url: "https://gone.example.com/", looking_for: "anything", how_often: "hourly" })) as { id: string };
  const down = (async () => {
    throw new Error("network");
  }) as unknown as typeof fetch;
  for (let i = 0; i < 6; i++) {
    at += 61 * 60_000;
    await watchesTick(env, at, { fetch: down, judge, tell });
  }
  const row = sqlite.prepare("SELECT status, fails FROM page_watches WHERE id = ?").get(broken.id) as { status: string; fails: number };
  eq("ended after 6 failed reads", [row.status, row.fails], ["failed", 6]);
  eq("told once that it stopped", told.filter((t) => t.startsWith("I stopped watching gone.example.com")).length, 1);

  // Removing, the cap, and the time limit.
  const third = (await sam.callTool("watch_add", { url: "https://shop.example.com/jacket", looking_for: "under $120" })) as { id: string };
  eq("remove", await sam.callTool("watch_remove", { id: third.id }), { stopped: true });
  for (let i = 0; i < MAX_WATCHES; i++) await sam.callTool("watch_add", { url: `https://shop.example.com/${i}`, looking_for: "in stock", how_often: "daily" });
  eq("at most 10 active", ((await sam.callTool("watch_add", { url: "https://shop.example.com/11", looking_for: "x" })) as { error?: string }).error?.startsWith("They're already watching 10"), true);
  await watchesTick(env, start + 61 * 86_400_000, { fetch: fakeFetch, judge, tell });
  eq("past their days, watches end", (sqlite.prepare("SELECT COUNT(*) AS n FROM page_watches WHERE status = 'active'").get() as { n: number }).n, 0);

  // Someone who hasn't agreed to AI (the same gate as the agent's jobs): saved, but nothing is read.
  // (A new person: consent is remembered per isolate for a few minutes, consent.ts.)
  sqlite.prepare("INSERT INTO users (id, email, password_hash, password_salt, name, created_at) VALUES ('lee', 'lee@example.com', '', '', 'Lee', 0)").run();
  const lee = blocksAssistant(env, "lee", "UTC");
  const waitReads = reads;
  await lee.callTool("watch_add", { url: "https://tickets.example.com/other", looking_for: "x" });
  await watchesTick(env, Date.now() + 1, { fetch: fakeFetch, judge, tell });
  eq("no consent: nothing read", reads, waitReads);
  eq("and it's still there for later", (sqlite.prepare("SELECT status FROM page_watches WHERE user_id = 'lee'").get() as { status: string }).status, "active");

  // The app's Watching screen: the list and Stop, the owner's only, and free on every plan.
  sqlite.prepare("UPDATE page_watches SET status = 'ended'").run();
  const { Hono } = await import("hono");
  const { blockRoutes } = await import("../src/blocks");
  const { tierForRoute: routeTier } = await import("../src/plans");
  const appFor = (who: string) => {
    const app = new Hono<{ Bindings: Env; Variables: { userId: string } }>();
    app.use("*", async (c, next) => {
      c.set("userId", who);
      await next();
    });
    app.route("/", blockRoutes as never);
    return app;
  };
  const shown = (await sam.callTool("watch_add", { url: "https://shop.example.com/boots", looking_for: "boots under $90", how_often: "daily", days: 3 })) as { id: string };
  const done = (await sam.callTool("watch_add", { url: "https://shop.example.com/hat", looking_for: "hat back in stock" })) as { id: string };
  sqlite.prepare("UPDATE page_watches SET status = 'met', last_note = 'In stock now' WHERE id = ?").run(done.id);
  type Listed = { id: string; lookingFor: string; checks: string; status: string; lastSaw: string | null; until: number; url: string };
  const onScreen = ((await (await appFor("sam").request("/watches", {}, env)).json()) as { watches: Listed[] }).watches;
  eq("GET /watches: watching first, then what happened", onScreen.map((w) => [w.lookingFor, w.checks, w.status, w.lastSaw]), [
    ["boots under $90", "daily", "watching", null],
    ["hat back in stock", "hourly", "happened", "In stock now"],
  ]);
  eq("with the page and until when", [onScreen[0]!.url, onScreen[0]!.until > Date.now() + 2 * 86_400_000], ["https://shop.example.com/boots", true]);
  eq("someone else sees none of them", await (await appFor("lee").request("/watches", {}, env)).json(), { watches: [] });
  eq("someone else can't stop one", (await appFor("lee").request(`/watches/${shown.id}`, { method: "DELETE" }, env)).status, 404);
  eq("still watching", (sqlite.prepare("SELECT status FROM page_watches WHERE id = ?").get(shown.id) as { status: string }).status, "active");
  eq("DELETE /watches/:id", (await appFor("sam").request(`/watches/${shown.id}`, { method: "DELETE" }, env)).status, 204);
  eq("stopped", (sqlite.prepare("SELECT status FROM page_watches WHERE id = ?").get(shown.id) as { status: string }).status, "ended");
  eq("stopping it twice is 404", (await appFor("sam").request(`/watches/${shown.id}`, { method: "DELETE" }, env)).status, 404);
  eq("one that happened clears off the list", (await appFor("sam").request(`/watches/${done.id}`, { method: "DELETE" }, env)).status, 204);
  eq("list empty", await (await appFor("sam").request("/watches", {}, env)).json(), { watches: [] });
  eq("free on every plan", [routeTier("GET", "/watches"), routeTier("DELETE", `/watches/${done.id}`)], ["free", "free"]);

  console.log(fails ? `\n${fails} failed` : "\nall passed");
  if (fails) process.exit(1);
}

main();
