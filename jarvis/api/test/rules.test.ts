// Standing approvals (rules.ts): "don't ask before emailing my wife". A rule
// covers one kind for one recipient or anyone; every recipient must be covered;
// a calendar event with guests needs each guest covered; deletes are never
// covered; and on the phone path a covered action runs like Approve for me.

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { blockRoutes, blocksAssistant } from "../src/blocks";
import { phoneAssistant } from "../src/google/assistant";
import { kindOfTool, normalRecipient, recipientsOf, ruleAllows, rulesFor } from "../src/rules";
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
const DB = d1(sqlite);
const env = { DB } as unknown as Env;

async function main() {
  // Pure.
  eq("email lowercased", normalRecipient("  Wife@Example.COM "), "wife@example.com");
  eq("name <email>", normalRecipient("Jo Lee <Jo@x.co>"), "jo@x.co");
  eq("phone digits", normalRecipient("+1 (586) 555-0100"), "5865550100");
  eq("a name", normalRecipient("  Mom "), "mom");
  eq("recipients from to + cc", recipientsOf({ to: "a@x.co, B@x.co", cc: ["c@x.co"] }), ["a@x.co", "b@x.co", "c@x.co"]);
  eq("kinds", ["gmail_send", "phone_message_compose", "phone_call", "calendar_create_event", "gmail_trash", "calendar_delete_event", "phone_calendar_delete_event"].map(kindOfTool), ["email", "text", "call", "calendar", null, null, null]);

  const sam = blocksAssistant(env, "sam", "UTC");
  eq("tools offered", sam.tools.filter((t) => t.name.startsWith("rule_")).map((t) => t.name), ["rule_add", "rule_list", "rule_remove"]);
  eq("add: email to wife", await sam.callTool("rule_add", { kind: "email", recipient: "Wife@Example.com" }), { kind: "email", recipient: "wife@example.com", label: "email to wife@example.com without asking" });
  eq("bad kind", await sam.callTool("rule_add", { kind: "purchase" }), { error: "kind must be one of email, text, call, calendar" });

  // Every recipient covered.
  eq("email to wife goes", await ruleAllows(DB, "sam", "gmail_send", { to: "wife@example.com", subject: "hi", body: "x" }), true);
  eq("email to wife + boss asks", await ruleAllows(DB, "sam", "gmail_send", { to: "wife@example.com, boss@work.com" }), false);
  eq("email to someone else asks", await ruleAllows(DB, "sam", "gmail_send", { to: "boss@work.com" }), false);
  eq("a text isn't an email", await ruleAllows(DB, "sam", "phone_message_compose", { to: ["wife@example.com"] }), false);
  eq("trashing is never covered", await ruleAllows(DB, "sam", "gmail_trash", { to: "wife@example.com" }), false);
  eq("another person's rules don't apply", await ruleAllows(DB, "alex", "gmail_send", { to: "wife@example.com" }), false);

  // Anyone rules, and calendar guests.
  await sam.callTool("rule_add", { kind: "calendar" });
  eq("calendar event, no guests", await ruleAllows(DB, "sam", "calendar_create_event", { summary: "Gym" }), true);
  eq("calendar event with a guest still asks", await ruleAllows(DB, "sam", "calendar_create_event", { summary: "Dinner", attendees: ["friend@x.co"] }), false);
  await sam.callTool("rule_add", { kind: "calendar", recipient: "friend@x.co" });
  eq("unless that guest has a rule", await ruleAllows(DB, "sam", "calendar_create_event", { summary: "Dinner", attendees: ["friend@x.co"] }), true);

  // The phone path: a covered text runs like Approve for me; others wait.
  await sam.callTool("rule_add", { kind: "text", recipient: "Mom" });
  const caps = { lookups: true, capabilities: [] };
  const phone = phoneAssistant(env, "sam", caps, false, false, rulesFor(env, "sam"));
  const toMom = (await phone.callTool("phone_message_compose", { to: ["Mom"], body: "On my way" })) as { status: string };
  eq("text to Mom runs", toMom.status, "running_on_phone");
  const toBoss = (await phone.callTool("phone_message_compose", { to: ["Boss"], body: "Late" })) as { status: string };
  eq("text to someone else waits", toBoss.status, "waiting_for_user_approval");
  const noRules = phoneAssistant(env, "sam", caps, false, false, null);
  eq("no rules passed (the agent's own turns): waits", ((await noRules.callTool("phone_message_compose", { to: ["Mom"], body: "x" })) as { status: string }).status, "waiting_for_user_approval");

  // List, remove, routes.
  const listed = (await sam.callTool("rule_list", {})) as { rules: { id: string; kind: string; recipient: string }[] };
  eq("listed", listed.rules.map((r) => `${r.kind}:${r.recipient}`), ["email:wife@example.com", "calendar:anyone", "calendar:friend@x.co", "text:mom"]);
  eq("remove", await sam.callTool("rule_remove", { id: listed.rules[0]!.id }), { removed: true });
  eq("email to wife asks again", await ruleAllows(DB, "sam", "gmail_send", { to: "wife@example.com" }), false);

  const app = new Hono<{ Bindings: Env; Variables: Vars }>();
  app.use("*", async (c, next) => {
    c.set("userId", "alex");
    await next();
  });
  app.route("/", blockRoutes);
  const post = await app.request("/approval-rules", { method: "POST", body: JSON.stringify({ kind: "call", recipient: "+1 555 010 0199" }), headers: { "content-type": "application/json" } }, env);
  eq("POST /approval-rules", post.status, 201);
  const got = (await (await app.request("/approval-rules", {}, env)).json()) as { rules: { id: string; recipient: string }[] };
  eq("GET /approval-rules is theirs only", got.rules.map((r) => r.recipient), ["5550100199"]);
  eq("can't delete another person's rule", (await app.request(`/approval-rules/${listed.rules[1]!.id}`, { method: "DELETE" }, env)).status, 404);
  eq("DELETE their own", (await app.request(`/approval-rules/${got.rules[0]!.id}`, { method: "DELETE" }, env)).status, 204);

  console.log(fails ? `\n${fails} failed` : "\nall passed");
  if (fails) process.exit(1);
}

main();
