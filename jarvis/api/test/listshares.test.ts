// Shared lists with Friends (lists.ts, network.ts shareLists, migration 0075):
// shared only with a connected Friend whose access allows it; the Friend's OVOA
// reads, adds and ticks but never replaces or deletes; a lower level, a
// disconnect or an unshare shuts it; adding tells the owner only if asked.

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { listsAssistant } from "../src/lists";
import { ACCESS_LEVELS, levelOf, networkAssistant } from "../src/network";
import { namedTools } from "../src/toolbelt";
import type { Env } from "../src/types";

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
    batch: async (list: ReturnType<typeof statement>[]) => {
      const out = [];
      for (const s of list) out.push(await s.run());
      return out;
    },
  } as unknown as D1Database;
}

const migrations = readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort();
const SHARES = "0075_list_shares.sql";

// The backfill: connections already at Best friend, Partner or Full access keep reading as that level.
{
  const old = new DatabaseSync(":memory:");
  for (const file of migrations.filter((f) => f < SHARES)) old.exec(readFileSync(`migrations/${file}`, "utf8"));
  old.exec("PRAGMA foreign_keys = OFF");
  const cols = "share_free_busy, take_reminders, auto_accept_meetings, auto_answer_questions, calendar_details, share_location, answer_from_memory";
  const presets: [string, number[]][] = [
    ["basic", [1, 1, 0, 0, 0, 0, 0]],
    ["best_friend", [1, 1, 1, 1, 0, 0, 0]],
    ["partner", [1, 1, 1, 1, 1, 1, 0]],
    ["full", [1, 1, 1, 1, 1, 1, 1]],
    ["custom", [1, 1, 1, 0, 0, 0, 0]],
  ];
  for (const [id, v] of presets) {
    old.prepare(`INSERT INTO connection_perms (connection_id, user_id, ${cols}, updated_at) VALUES (?, 'u', ?, ?, ?, ?, ?, ?, ?, 0)`).run(id, ...v);
  }
  old.exec(readFileSync(`migrations/${SHARES}`, "utf8"));
  const after = old.prepare("SELECT connection_id, share_lists FROM connection_perms ORDER BY rowid").all() as { connection_id: string; share_lists: number }[];
  eq("backfill: best friend and up get lists, basic and custom don't", after.map((r) => [r.connection_id, r.share_lists]), [
    ["basic", 0],
    ["best_friend", 1],
    ["partner", 1],
    ["full", 1],
    ["custom", 0],
  ]);
}

eq("presets still read as themselves", (Object.keys(ACCESS_LEVELS) as (keyof typeof ACCESS_LEVELS)[]).map((l) => levelOf(ACCESS_LEVELS[l])), ["basic", "best_friend", "partner", "full"]);
eq("lists come with Best friend, not Basic", [ACCESS_LEVELS.basic.shareLists, ACCESS_LEVELS.best_friend.shareLists, ACCESS_LEVELS.partner.shareLists], [false, true, true]);

const sqlite = new DatabaseSync(":memory:");
for (const file of migrations) sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
sqlite.exec("PRAGMA foreign_keys = ON");
for (const [id, name] of [["tigh", "Tigh Ray"], ["maria", "Maria Lopez"], ["jake", "Jake Kim"], ["zoe", "Zoe Park"]]) {
  sqlite.prepare("INSERT INTO users (id, email, password_hash, password_salt, name, username, created_at) VALUES (?, ?, '', '', ?, ?, 0)").run(id, `${id}@example.com`, name, id);
}
// Tigh and Maria are Friends; Tigh and Jake too; Zoe is nobody's Friend.
for (const [id, a, b] of [["c1", "tigh", "maria"], ["c2", "tigh", "jake"]]) {
  sqlite.prepare("INSERT INTO connections (id, requester_id, addressee_id, status, created_at, decided_at) VALUES (?, ?, ?, 'accepted', 0, 0)").run(id, a, b);
  for (const u of [a, b]) sqlite.prepare("INSERT INTO connection_perms (connection_id, user_id, updated_at) VALUES (?, ?, 0)").run(id, u);
}
const env = { DB: d1(sqlite) } as unknown as Env;
const told: [string, string][] = [];
const io = { tell: async (_env: Env, ownerId: string, text: string) => void told.push([ownerId, text]) };
const tigh = listsAssistant(env, "tigh", io);
const maria = listsAssistant(env, "maria", io);
const jake = listsAssistant(env, "jake", io);
const zoe = listsAssistant(env, "zoe", io);
const tighNet = networkAssistant(env, "tigh", "America/New_York");

type R = Record<string, unknown>;
const err = (r: unknown) => String((r as R).error ?? "");

async function main() {
  await tigh.callTool("list_save", { name: "Groceries", rows: [{ item: "eggs" }, { item: "milk" }] });

  // Access too low: Basic doesn't include lists.
  eq("Basic can't be shared with", err(await tigh.callTool("list_share", { name: "groceries", username: "maria" })).includes("doesn't include lists"), true);
  eq("nobody's Friend", err(await tigh.callTool("list_share", { name: "groceries", username: "zoe" })).startsWith("They aren't Friends with @zoe"), true);
  eq("not a list of theirs", err(await tigh.callTool("list_share", { name: "nope", username: "maria" })).startsWith("They have no list"), true);

  // Best friend: shared.
  await tighNet.callTool("ovoa_perms", { username: "maria", level: "best_friend" });
  const shared = (await tigh.callTool("list_share", { name: "groceries", username: "@maria" })) as R;
  eq("shared", [shared.shared, shared.with, shared.tellMe], ["Groceries", "@maria", false]);
  eq("owner sees who has it", (await tigh.callTool("list_read", {})) as R, { lists: [{ name: "Groceries", rows: 2, sharedWith: ["@maria"] }] });

  // The Friend's side: read, add, tick.
  eq("her lists name it", ((await maria.callTool("list_read", {})) as R).sharedWithThem, [{ name: "Groceries", from: "@tigh", rows: 2 }]);
  const read = (await maria.callTool("list_read", { name: "groceries" })) as R;
  eq("she reads it by name", [read.sharedBy, read.total], ["@tigh", 2]);
  eq("or with from", ((await maria.callTool("list_read", { name: "groceries", from: "tigh" })) as R).total, 2);
  eq("she adds", await maria.callTool("list_save", { name: "groceries", rows: [{ item: "limes" }], mode: "append" }), { name: "Groceries", rows: 3, sharedBy: "@tigh" });
  eq("adding tells no one unless asked", told.length, 0);
  eq("she can't replace it", err(await maria.callTool("list_save", { name: "groceries", rows: [], from: "tigh" })).includes("can only add to it"), true);
  const tick = (await maria.callTool("list_tick", { name: "groceries", match: "MILK" })) as R;
  eq("she ticks milk", [tick.index, tick.done, tick.sharedBy], [1, true, "@tigh"]);
  const back = (await tigh.callTool("list_read", { name: "groceries" })) as { rows: R[] };
  eq("the owner sees her row and tick", back.rows, [{ item: "eggs" }, { item: "milk", done: true }, { item: "limes" }]);
  eq("the owner ticks too, by index", ((await tigh.callTool("list_tick", { name: "groceries", index: 1, done: false })) as R).done, false);
  eq("a tick needs a row", err(await tigh.callTool("list_tick", { name: "groceries", match: "bread" })).includes("matches"), true);
  eq("she can't delete it", err(await maria.callTool("list_delete", { name: "groceries" })).startsWith("They have no list"), true);
  eq("she can't reshare it", err(await maria.callTool("list_share", { name: "groceries", username: "tigh" })).includes("of their own"), true);

  // Her own list by the same name comes first; from reaches his.
  await maria.callTool("list_save", { name: "groceries", rows: [{ item: "hers" }] });
  eq("her own first", ((await maria.callTool("list_read", { name: "groceries" })) as R).total, 1);
  eq("his with from", ((await maria.callTool("list_read", { name: "groceries", from: "@tigh" })) as R).total, 3);
  eq("appending without from goes to hers", ((await maria.callTool("list_save", { name: "groceries", rows: [{ item: "x" }], mode: "append" })) as R).rows, 2);
  await maria.callTool("list_delete", { name: "groceries" });

  // Told when asked.
  await tigh.callTool("list_share", { name: "groceries", username: "maria", tellMe: true });
  await maria.callTool("list_save", { name: "groceries", rows: [{ item: "rice" }, { item: "beans" }], mode: "append" });
  eq("the owner asked to be told", told, [["tigh", "Maria added 2 things to your Groceries list."]]);

  // Not shared with Jake, not reachable by Zoe: nothing shows.
  eq("a Friend it isn't shared with", err(await jake.callTool("list_read", { name: "groceries" })), 'They have no list called "groceries".');
  eq("with from", err(await jake.callTool("list_read", { name: "groceries", from: "tigh" })).startsWith("No list called"), true);
  eq("a stranger", err(await zoe.callTool("list_read", { name: "groceries", from: "tigh" })).startsWith("No list called"), true);
  eq("a stranger can't add", ((await zoe.callTool("list_save", { name: "groceries", rows: [{ item: "spam" }], mode: "append", from: "tigh" })) as R).error !== undefined, true);
  eq("his list untouched by her", ((await tigh.callTool("list_read", { name: "groceries" })) as R).total, 5);

  // Level lowered: she reads nothing, adds nothing, at once.
  await tighNet.callTool("ovoa_perms", { username: "maria", level: "basic" });
  eq("Basic again: she reads nothing", err(await maria.callTool("list_read", { name: "groceries" })), 'They have no list called "groceries".');
  eq("and her lists don't name it", ((await maria.callTool("list_read", {})) as R).sharedWithThem, undefined);
  eq("adding makes her own list instead", ((await maria.callTool("list_save", { name: "groceries", rows: [{ item: "x" }], mode: "append" })) as R).sharedBy, undefined);
  eq("his stays as it was", ((await tigh.callTool("list_read", { name: "groceries" })) as R).total, 5);
  await maria.callTool("list_delete", { name: "groceries" });

  // The single switch under Advanced gives it back without the rest of Best friend.
  const perms = ((await tighNet.callTool("ovoa_perms", { username: "maria", shareLists: true })) as { perms: R }).perms;
  eq("the switch alone is custom", [perms.shareLists, perms.autoAcceptMeetings, perms.level], [true, false, "custom"]);
  eq("and she reads it again", ((await maria.callTool("list_read", { name: "groceries" })) as R).total, 5);

  // Unshare.
  eq("unshare", await tigh.callTool("list_unshare", { name: "groceries", username: "maria" }), { unshared: "Groceries", with: "@maria" });
  eq("gone for her", err(await maria.callTool("list_read", { name: "groceries" })), 'They have no list called "groceries".');
  eq("unshare twice", err(await tigh.callTool("list_unshare", { name: "groceries", username: "maria" })).includes("isn't shared"), true);

  // Disconnect: shared at Partner, then they stop being Friends.
  await tighNet.callTool("ovoa_perms", { username: "maria", level: "partner" });
  await tigh.callTool("list_share", { name: "groceries", username: "maria" });
  eq("shared again", ((await maria.callTool("list_read", { name: "groceries" })) as R).total, 5);
  await tighNet.callTool("ovoa_disconnect", { username: "maria" });
  eq("disconnected: she reads nothing", err(await maria.callTool("list_read", { name: "groceries" })), 'They have no list called "groceries".');
  eq("or with from", err(await maria.callTool("list_read", { name: "groceries", from: "tigh" })).startsWith("No list called"), true);
  eq("he can still unshare her", (await tigh.callTool("list_unshare", { name: "groceries", username: "maria" })) as R, { unshared: "Groceries" });

  // Caps as lists.ts: a Friend's add can't push past the row cap.
  await tighNet.callTool("ovoa_perms", { username: "jake", level: "best_friend" });
  await tigh.callTool("list_share", { name: "groceries", username: "jake" });
  const many = Array.from({ length: 5_000 }, (_, i) => ({ i }));
  eq("the row cap holds for a Friend", err(await jake.callTool("list_save", { name: "groceries", rows: many, mode: "append" })).startsWith("A list holds up to"), true);

  // Deleting the list takes the shares with it.
  await tigh.callTool("list_delete", { name: "groceries" });
  eq("shares go with the list", (sqlite.prepare("SELECT COUNT(*) AS n FROM list_shares").get() as { n: number }).n, 0);

  // Plain asks reach the new tools.
  const catalogue = [...tigh.tools, { name: "watch_add", description: "", parameters: {} }];
  eq("'share my grocery list with Maria' names list_share", namedTools(catalogue, "share my grocery list with Maria")[0]?.name, "list_share");
  eq("'tickets' doesn't name list_tick", namedTools(catalogue, "let me know when tickets drop").map((t) => t.name).includes("list_tick"), false);

  console.log(fails ? `\n${fails} failed` : "\nall passed");
  if (fails) process.exit(1);
}

main();
