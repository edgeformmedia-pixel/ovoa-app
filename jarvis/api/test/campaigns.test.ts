// Campaigns (campaigns.ts, blocks.ts): one approval, many targets. Nothing runs
// before the approval, the cron works a few items per tick only in the daytime,
// caps and the do-not-contact list hold in code, and the app routes read,
// stop and export (formula-safe) only the owner's campaigns.

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { blockRoutes, blocksAssistant, isBlockTool } from "../src/blocks";
import {
  campaignsTick,
  campaignsWaiting,
  checkPlan,
  csvCell,
  EMAILS_PER_DAY,
  inDaytime,
  ITEMS_PER_TICK,
  MAX_ITEMS,
  placeholders,
  render,
  type CampaignIo,
} from "../src/campaigns";
import { approveAction } from "../src/google/assistant";
import { ModelRefused } from "../src/llm";
import { tierForRoute } from "../src/plans";
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
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (list: { run: () => Promise<unknown> }[]) => {
      for (const s of list) await s.run();
      return [];
    },
  } as unknown as D1Database;
}

const sqlite = new DatabaseSync(":memory:");
for (const file of readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort()) {
  sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
}
sqlite.exec("PRAGMA foreign_keys = ON");
for (const id of ["sam", "alex"]) {
  sqlite.prepare("INSERT INTO users (id, email, password_hash, password_salt, name, created_at) VALUES (?, ?, '', '', ?, 0)").run(id, `${id}@example.com`, id);
  sqlite.prepare("INSERT INTO settings (user_id, updated_at, time_zone) VALUES (?, 0, 'America/New_York')").run(id);
}
const env = { DB: d1(sqlite), CAMPAIGNS: "1" } as unknown as Env;
const off = { DB: d1(sqlite) } as unknown as Env;

// Noon and 2 AM in New York.
const NOON = Date.parse("2026-09-28T16:00:00Z");
const NIGHT = Date.parse("2026-09-28T06:00:00Z");

let clock = NOON;
const sent: { to: string; subject: string; body: string }[] = [];
const told: string[] = [];
const pushes: string[] = [];
let researchRefuses = false;
const io: CampaignIo = {
  sendEmail: async (_e, _u, mail) => {
    if (mail.to === "broken@example.com") throw new Error("Gmail said no");
    sent.push(mail);
  },
  research: async (_e, _u, query) => {
    if (researchRefuses) throw new ModelRefused("allowance", "campaign");
    return `answer for ${query}`;
  },
  tellFriend: async (_e, _u, username, text) => (username === "stranger" ? { error: "Their OVOA isn't connected to @stranger's." } : (told.push(`${username}: ${text}`), { ok: true })),
  push: async (_e, _u, m) => (pushes.push(m.body), 1),
  now: () => clock,
};

const status = (id: string) => (sqlite.prepare("SELECT status FROM campaigns WHERE id = ?").get(id) as { status: string }).status;
const itemCounts = (id: string) =>
  Object.fromEntries(
    (sqlite.prepare("SELECT status, COUNT(*) AS n FROM campaign_items WHERE campaign_id = ? GROUP BY status").all(id) as { status: string; n: number }[]).map((r) => [r.status, r.n]),
  );

function appFor(userId: string) {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();
  app.use("*", async (c, next) => {
    c.set("userId", userId);
    await next();
  });
  app.route("/", blockRoutes);
  return (path: string, init?: RequestInit) => app.request(path, init, env);
}

async function main() {
  // Off unless CAMPAIGNS is "1": no tools, and the cron does nothing.
  eq("off: no tools", blocksAssistant(off, "sam", "UTC").tools.some((t) => t.name.startsWith("campaign_")), false);
  eq("off: cron idle", await campaignsTick(off, io), {});
  eq("recognized by name", ["campaign_start", "campaign_status", "campaign_stop"].map(isBlockTool), [true, true, true]);
  eq("on: tools offered", blocksAssistant(env, "sam", "UTC").tools.filter((t) => t.name.startsWith("campaign_")).map((t) => t.name), ["campaign_start", "campaign_status", "campaign_stop"]);

  // Pure pieces.
  eq("placeholders", placeholders("Hi {name}, about { city } and {name}"), ["name", "city"]);
  eq("render", render("Hi {name} in {city}{missing}", { name: "Kim", city: "Austin" }), "Hi Kim in Austin");
  eq("csv formula-safe", ["=SUM(A1)", "+1", "-2", "@x", "plain", 'a "q", b'].map(csvCell), ["'=SUM(A1)", "'+1", "'-2", "'@x", "plain", '"a ""q"", b"']);
  eq("daytime noon", inDaytime(NOON, "America/New_York", 1320, 420), true);
  eq("not at 2 AM", inDaytime(NIGHT, "America/New_York", 1320, 420), false);
  eq("not in quiet hours", inDaytime(NOON, "America/New_York", 600, 840), false);

  // What a plan needs.
  const err = (args: Record<string, unknown>, items: unknown[] | null) => {
    const r = checkPlan(args, items as never);
    return "error" in r ? r.error.split(" ").slice(0, 4).join(" ") : "ok";
  };
  eq("bad mode", err({ mode: "sms", title: "x", instructions: "y" }, [{}]), "mode must be email,");
  eq("research cap", err({ mode: "research", title: "x", instructions: "y" }, Array.from({ length: MAX_ITEMS.research + 1 }, () => ({}))), "A research campaign can");
  eq("email needs an address", err({ mode: "email", title: "x", subject: "s", instructions: "hi" }, [{ email: "a@b.co" }, { email: "nope" }]), "1 of the items");
  eq("email needs a subject", err({ mode: "email", title: "x", instructions: "hi" }, [{ email: "a@b.co" }]), "subject is required for");
  eq("unknown placeholder", err({ mode: "research", title: "x", instructions: "hours of {place}" }, [{ name: "a" }]), "No item has {place}.");
  eq("friends need usernames", err({ mode: "friends", title: "x", instructions: "hi" }, [{ name: "a" }]), "1 of the items");

  // Starting one parks ONE approval with the count and cost, and runs nothing.
  const sam = blocksAssistant(env, "sam", "America/New_York");
  const people = [
    { name: "Kim", email: "kim@example.com" },
    { name: "Diaz", email: "diaz@example.com", phone: "(512) 555-0101" },
    { name: "Ng", email: "broken@example.com" },
    ...Array.from({ length: 6 }, (_, i) => ({ name: `P${i}`, email: `p${i}@example.com` })),
  ];
  const started = (await sam.callTool("campaign_start", {
    mode: "email",
    title: "Lease note",
    subject: "Hi {name}",
    instructions: "Hey {name} — is the unit still open?",
    items: people,
  })) as { status: string; campaignId: string; items: number };
  eq("waiting for approval", [started.status, started.items], ["waiting_for_user_approval", 9]);
  const id = started.campaignId;
  eq("one pending action handed to the app", sam.pending.length, 1);
  const card = sam.pending[0]!.summary;
  eq("card says count, cost and daytime", [card.includes("email 9 people"), card.includes("Estimated cost"), card.includes("daytime")], [true, true, true]);
  eq("card shows the first one filled in, no dashes", [card.includes("Hey Kim, is the unit still open?"), /[–—]/.test(card)], [true, false]);
  eq("proposed, not running", status(id), "proposed");
  eq("cron doesn't see it yet", await campaignsWaiting(env), false);
  // Even forced to running without an approval, the cron won't touch it.
  sqlite.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(id);
  eq("no approved_at, nothing worked", (await campaignsTick(env, io)).worked ?? 0, 0);
  sqlite.prepare("UPDATE campaigns SET status = 'proposed' WHERE id = ?").run(id);

  // Someone else can't approve it.
  eq("another person's approve does nothing", await approveAction(env, "alex", sam.pending[0]!.id), null);
  const approved = await approveAction(env, "sam", sam.pending[0]!.id);
  eq("approved", [approved?.content.startsWith("Done:"), status(id)], [true, "running"]);
  eq("cron sees it", await campaignsWaiting(env), true);

  // Night: nothing. Day: a few per tick. The do-not-contact number is skipped.
  sqlite.prepare("INSERT INTO do_not_contact (phone, reason, created_at) VALUES ('+15125550101', 'texted STOP', 0)").run();
  clock = NIGHT;
  eq("nothing at night", [(await campaignsTick(env, io)).night, sent.length], [1, 0]);
  clock = NOON;
  const first = await campaignsTick(env, io);
  eq("first tick", [first.worked, first.skipped, first.failed, sent.length], [3, 1, 1, 3]);
  eq("at most a few per tick", ITEMS_PER_TICK, 5);
  eq("email filled in, no dashes", sent[0], { to: "kim@example.com", subject: "Hi Kim", body: "Hey Kim, is the unit still open?" });
  await campaignsTick(env, io);
  eq("done after the second tick", [status(id), itemCounts(id)], ["done", { done: 7, failed: 1, skipped: 1 }]);
  const summary = sqlite.prepare("SELECT content FROM messages WHERE user_id = 'sam' ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { content: string };
  eq("one summary", [summary.content, pushes.length], ['Finished "Lease note": 7 sent, 1 skipped (do not contact), 1 didn\'t work. Ask me for the results anytime.', 1]);
  await campaignsTick(env, io);
  eq("no second summary", pushes.length, 1);

  // Email: at most EMAILS_PER_DAY in any 24 hours across their campaigns.
  const big = (await sam.callTool("campaign_start", {
    mode: "email",
    title: "More",
    subject: "Hi",
    instructions: "Hello {name}",
    items: [{ name: "A", email: "a@example.com" }],
  })) as { campaignId: string };
  await approveAction(env, "sam", sam.pending[1]!.id);
  const filler = sqlite.prepare("INSERT INTO campaign_items (campaign_id, idx, data, status, done_at) VALUES (?, ?, '{}', 'done', ?)");
  for (let i = 100; i < 100 + EMAILS_PER_DAY; i++) filler.run(id, i, NOON - 3_600_000);
  const before = sent.length;
  eq("capped for the day", [(await campaignsTick(env, io)).capped, sent.length - before, status(big.campaignId)], [1, 0, "running"]);
  clock = NOON + 24 * 3_600_000;
  await campaignsTick(env, io);
  eq("goes out the next day", [sent.length - before, status(big.campaignId)], [1, "done"]);

  // Research: a model refusal puts the item back and waits.
  clock = NOON;
  const research = (await sam.callTool("campaign_start", {
    mode: "research",
    title: "Hours",
    instructions: "opening hours of {place} in Austin",
    items: [{ place: "Kerbey Lane" }, { place: "Juan in a Million" }],
  })) as { campaignId: string };
  eq("research card has a cost", sam.pending[2]!.summary.includes("of your plan's AI spend"), true);
  await approveAction(env, "sam", sam.pending[2]!.id);
  researchRefuses = true;
  eq("refused waits", [(await campaignsTick(env, io)).refused, itemCounts(research.campaignId)], [1, { pending: 2 }]);
  researchRefuses = false;
  await campaignsTick(env, io);
  const detail = (await sam.callTool("campaign_status", { id: research.campaignId })) as { status: string; results: { result: string }[] };
  eq("research results kept", [detail.status, detail.results[0]!.result], ["done", "answer for opening hours of Kerbey Lane in Austin"]);

  // Friends: through the OVOA-to-OVOA path; a non-friend fails there.
  const friends = (await sam.callTool("campaign_start", {
    mode: "friends",
    title: "Party moved",
    instructions: "Party moved to Saturday, {name}",
    items: [
      { username: "@jo", name: "Jo" },
      { username: "stranger", name: "S" },
    ],
  })) as { campaignId: string };
  await approveAction(env, "sam", sam.pending[3]!.id);
  await campaignsTick(env, io);
  eq("friends", [told, itemCounts(friends.campaignId)], [["jo: Party moved to Saturday, Jo"], { done: 1, failed: 1 }]);

  // Stopping one that's still waiting takes its Approve button with it.
  const waiting = (await sam.callTool("campaign_start", { mode: "research", title: "Later", instructions: "x {a}", items: [{ a: 1 }] })) as { campaignId: string };
  eq("stop", await sam.callTool("campaign_stop", { id: waiting.campaignId }), { stopped: "Later" });
  eq("approval gone", await approveAction(env, "sam", sam.pending[4]!.id), null);
  eq("stays stopped", status(waiting.campaignId), "stopped");

  // Only a few at once.
  for (let i = 0; i < 3; i++) await sam.callTool("campaign_start", { mode: "research", title: `Q${i}`, instructions: "x {a}", items: [{ a: 1 }] });
  eq("active cap", ((await sam.callTool("campaign_start", { mode: "research", title: "Q4", instructions: "x {a}", items: [{ a: 1 }] })) as { error: string }).error.startsWith("They already have 3"), true);

  // A saved list works as the items.
  sqlite.prepare("DELETE FROM campaigns WHERE status = 'proposed'").run();
  await sam.callTool("list_save", { name: "spots", rows: [{ place: "Zilker" }] });
  eq("from a saved list", ((await sam.callTool("campaign_start", { mode: "research", title: "Spots", instructions: "{place} hours", list: "spots" })) as { items: number }).items, 1);

  // The app: the owner's only; CSV can't run formulas.
  sqlite.prepare("UPDATE campaign_items SET result = '=HYPERLINK(\"x\")' WHERE campaign_id = ? AND idx = 0").run(id);
  const asSam = appFor("sam");
  const asAlex = appFor("alex");
  const list = (await (await asSam("/campaigns")).json()) as { campaigns: { id: string }[] };
  eq("list", list.campaigns.some((c) => c.id === id), true);
  eq("alex sees none", ((await (await asAlex("/campaigns")).json()) as { campaigns: unknown[] }).campaigns.length, 0);
  eq("alex can't read it", (await asAlex(`/campaigns/${id}`)).status, 404);
  eq("alex can't export it", (await asAlex(`/campaigns/${id}/export.csv`)).status, 404);
  const one = (await (await asSam(`/campaigns/${id}`)).json()) as { counts: Record<string, number> };
  eq("detail counts", one.counts.skipped, 1);
  const csv = await asSam(`/campaigns/${id}/export.csv`);
  const text = await csv.text();
  eq("csv", [csv.headers.get("content-type"), text.split("\r\n")[0], text.includes(`'=HYPERLINK`)], ["text/csv; charset=utf-8", "#,name,email,phone,status,result", true]);
  eq("alex can't stop it", (await asAlex(`/campaigns/${research.campaignId}/stop`, { method: "POST" })).status, 404);
  eq("can't stop a finished one", (await asSam(`/campaigns/${research.campaignId}/stop`, { method: "POST" })).status, 404);

  // Plans: reading, exporting and stopping are free.
  eq("tiers", [tierForRoute("GET", "/campaigns"), tierForRoute("GET", "/campaigns/x/export.csv"), tierForRoute("POST", "/campaigns/x/stop")], ["free", "free", "free"]);

  // Gone with the account.
  sqlite.prepare("DELETE FROM users WHERE id = 'sam'").run();
  eq("gone with the account", (sqlite.prepare("SELECT COUNT(*) AS n FROM campaign_items").get() as { n: number }).n, 0);

  console.log(fails ? `${fails} failed` : "all passed");
  process.exit(fails ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
