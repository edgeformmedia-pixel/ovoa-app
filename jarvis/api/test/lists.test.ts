// Saved lists (lists.ts, blocks.ts): kept per person, capped, read back in parts,
// and reached from the chat loop through the blocks entry point.

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { blocksAssistant, isBlockTool } from "../src/blocks";
import { MAX_LIST_ROWS } from "../src/lists";
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
const env = { DB: d1(sqlite) } as unknown as Env;

async function main() {
  const sam = blocksAssistant(env, "sam", "America/New_York");
  const alex = blocksAssistant(env, "alex", "America/New_York");
  eq("offered", sam.tools.map((t) => t.name), ["list_save", "list_read", "list_delete"]);
  eq("recognized by name", ["list_save", "list_read", "list_delete", "note_add"].map(isBlockTool), [true, true, true, false]);

  const offices = [
    { name: "Rep. Kim", phone: "(202) 555-0100" },
    { name: "Rep. Diaz", phone: "(202) 555-0101" },
  ];
  eq("save", await sam.callTool("list_save", { name: "  House  offices ", rows: offices }), { name: "House offices", rows: 2 });
  eq("append", await sam.callTool("list_save", { name: "house offices", rows: [{ name: "Rep. Ng" }], mode: "append" }), { name: "house offices", rows: 3 });
  const read = (await sam.callTool("list_read", { name: "HOUSE OFFICES" })) as { total: number; rows: unknown[]; nextOffset: number | null };
  eq("read back, any case", [read.total, read.rows.length, read.nextOffset], [3, 3, null]);
  eq("names of all lists", await sam.callTool("list_read", {}), { lists: [{ name: "House offices", rows: 3 }] });
  eq("replace", await sam.callTool("list_save", { name: "house offices", rows: [{ name: "only" }] }), { name: "house offices", rows: 1 });

  // Theirs only.
  eq("another person can't see it", await alex.callTool("list_read", { name: "house offices" }), { error: 'They have no list called "house offices".' });
  eq("or delete it", await alex.callTool("list_delete", { name: "house offices" }), { error: 'They have no list called "house offices".' });

  // Bad input and caps.
  eq("rows must be objects", await sam.callTool("list_save", { name: "x", rows: "nope" }), { error: "rows must be a list of objects" });
  eq("stray values dropped", await sam.callTool("list_save", { name: "mixed", rows: [{ a: 1 }, 2, "x", [1], null] }), { name: "mixed", rows: 1 });
  const tooMany = Array.from({ length: MAX_LIST_ROWS + 1 }, (_, i) => ({ i }));
  eq("row cap", ((await sam.callTool("list_save", { name: "big", rows: tooMany })) as { error?: string }).error?.startsWith("A list holds up to"), true);

  // Long lists come back in parts under the tool-result cap.
  const long = Array.from({ length: 400 }, (_, i) => ({ name: `Office ${i}`, phone: `(202) 555-${String(1000 + i)}`, note: "takes new patients" }));
  await sam.callTool("list_save", { name: "long", rows: long });
  const first = (await sam.callTool("list_read", { name: "long" })) as { rows: unknown[]; nextOffset: number };
  eq("first part fits a tool result", JSON.stringify(first).length < 6000 && first.rows.length > 10, true);
  const second = (await sam.callTool("list_read", { name: "long", offset: first.nextOffset })) as { offset: number; rows: { name: string }[] };
  eq("second part continues", [second.offset, second.rows[0]?.name], [first.nextOffset, `Office ${first.nextOffset}`]);

  eq("delete", await sam.callTool("list_delete", { name: "long" }), { deleted: "long" });

  // An account that goes takes its lists with it.
  sqlite.prepare("DELETE FROM users WHERE id = 'sam'").run();
  eq("gone with the account", (sqlite.prepare("SELECT COUNT(*) AS n FROM user_lists").get() as { n: number }).n, 0);

  // "My lists" names them; ordinary "todo list" still goes to the todo tools first.
  const catalogue = [...sam.tools, { name: "todo_list", description: "", parameters: {} }];
  eq("'show my lists' names the list tools", namedTools(catalogue, "show me my lists").map((t) => t.name).includes("list_read"), true);
  eq("'what's on my todo list' still picks todo_list first", namedTools(catalogue, "what's on my todo list")[0]?.name, "todo_list");

  console.log(fails ? `\n${fails} failed` : "\nall passed");
  if (fails) process.exit(1);
}

main();
