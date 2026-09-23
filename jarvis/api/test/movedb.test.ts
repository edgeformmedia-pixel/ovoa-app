// The SQL-writing half of scripts/move-db.mjs (move-db-lib.mjs), the copy of
// the old account's database into the new one at the v1 move. Nothing here runs
// wrangler: which tables go, how a page is read, what may appear after VALUES,
// how an export file is read, and that nothing secret reaches the screen.
// The whole copy was also rehearsed between two local D1s (see the commit), and
// the INSERTs it writes for long multi-line text go into a real D1 at the end.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  chunkStatements,
  countStatements,
  dataChanges,
  dataFile,
  exportRiskStatements,
  formatCommand,
  insertSql,
  insertsFromRows,
  isSqlLiteral,
  isWithoutRowid,
  oneLine,
  pageSql,
  parseJsonc,
  parseWranglerJson,
  planTables,
  qid,
  readExport,
  redact,
  resetFile,
  rowSizeStatements,
  skipReason,
} from "../scripts/move-db-lib.mjs";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(got)}${ok ? "" : `  (wanted ${JSON.stringify(want)})`}`);
}
function throws(label: string, fn: () => unknown, pattern: RegExp) {
  let message = "";
  try {
    fn();
  } catch (err) {
    message = (err as Error).message;
  }
  eq(label, pattern.test(message), true);
}

// ---------- Which tables ----------

const oldTables = [
  { name: "_cf_KV", sql: "CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID" },
  { name: "account_profiles", sql: "CREATE TABLE account_profiles (account_id TEXT PRIMARY KEY)" },
  { name: "context_blocks", sql: "CREATE TABLE context_blocks (id TEXT PRIMARY KEY)" },
  { name: "context_search", sql: "CREATE VIRTUAL TABLE context_search USING fts5(title, content='context_blocks')" },
  { name: "context_search_config", sql: "CREATE TABLE 'context_search_config'(k PRIMARY KEY, v) WITHOUT ROWID" },
  { name: "context_search_data", sql: "CREATE TABLE 'context_search_data'(id INTEGER PRIMARY KEY, block BLOB)" },
  { name: "cron_lock", sql: "CREATE TABLE cron_lock (name TEXT PRIMARY KEY, until INTEGER NOT NULL) WITHOUT ROWID" },
  { name: "d1_migrations", sql: "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)" },
  { name: "device_logs", sql: "CREATE TABLE device_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT)" },
  { name: "google_accounts", sql: "CREATE TABLE google_accounts (id TEXT PRIMARY KEY)" },
  { name: "oauth_states", sql: "CREATE TABLE oauth_states (state TEXT PRIMARY KEY)" },
  { name: "old_gone", sql: "CREATE TABLE old_gone (id TEXT)" },
  { name: "sqlite_sequence", sql: "CREATE TABLE sqlite_sequence(name,seq)" },
  { name: "usage_daily", sql: "CREATE TABLE usage_daily (user_id TEXT, day TEXT, PRIMARY KEY (user_id, day)) WITHOUT ROWID" },
  { name: "users", sql: "CREATE TABLE users (id TEXT PRIMARY KEY)" },
];
const newNames = oldTables.map((t) => t.name).filter((n) => n !== "old_gone");
const plan = planTables(oldTables, newNames);
eq("copied: only the ordinary tables both sides have", plan.copy, ["context_blocks", "device_logs", "usage_daily", "users"]);
eq(
  "left out, all of the brief's list plus cron_lock and the dropped table",
  plan.skipped.map((s: { name: string }) => s.name),
  ["_cf_KV", "account_profiles", "context_search", "context_search_config", "context_search_data", "cron_lock", "d1_migrations", "google_accounts", "oauth_states", "old_gone", "sqlite_sequence"],
);
eq("each with a reason", plan.skipped.every((s: { reason: string }) => s.reason.length > 5), true);
eq("the dropped table's reason", skipReason("old_gone") ?? plan.skipped.find((s: { name: string }) => s.name === "old_gone").reason, "not in the new database");
eq("a virtual table under another name is left out too", skipReason("notes_fts", "CREATE VIRTUAL TABLE notes_fts USING fts5(x)"), "a virtual table");
eq("an ordinary table is copied", skipReason("messages", "CREATE TABLE messages (id TEXT)"), null);

eq("WITHOUT ROWID seen", isWithoutRowid("CREATE TABLE a (k TEXT PRIMARY KEY)\n) WITHOUT ROWID;"), true);
eq("WITHOUT ROWID seen, lower case, STRICT too", isWithoutRowid("create table a (k text primary key) strict, without rowid"), true);
eq("an ordinary table has a rowid", isWithoutRowid("CREATE TABLE a (note TEXT DEFAULT 'without rowid')"), false);

// ---------- Literals: only what quote() gives back ----------

for (const ok of ["NULL", "0", "-42", "9007199254740993", "3.14159265358979", "1.0e+20", "-9.0e+999", "1.5e-07", "''", "'it''s'", "'line\none'", "'😀 日本'", "X''", "X'00FF10'", "x'00ff'"]) {
  eq(`literal ${JSON.stringify(ok)}`, isSqlLiteral(ok), true);
}
for (const bad of ["", "null ", "'it's'", "'open", "1; DROP TABLE users", "X'0'", "X'GG'", "1e", "abc", "'a' || 'b'", "NULL, NULL"]) {
  eq(`not a literal ${JSON.stringify(bad)}`, isSqlLiteral(bad), false);
}
eq("a number isn't a literal until quote() wrote it", isSqlLiteral(42 as unknown as string), false);

// ---------- Statements ----------

eq("identifier", qid("users"), '"users"');
eq("identifier with a quote in it", qid('we"ird'), '"we""ird"');
eq(
  "INSERT names its columns",
  insertSql("device_logs", ["id", "text", "detail"], ["7", "'it''s; fine'", "NULL"]),
  `INSERT INTO "device_logs" ("id", "text", "detail") VALUES (7, 'it''s; fine', NULL);`,
);
eq(
  "a text with line breaks goes on one line, exactly",
  insertSql("m", ["content"], ["'one\n''two''\r\nthree \\n stays'"]),
  `INSERT INTO "m" ("content") VALUES (((('one' || char(10)) || '''two''') || ((char(13) || char(10)) || 'three \\n stays')));`,
);
// D1 refuses an expression more than 100 deep, and a flat chain of pieces was one level each.
const depth = (sql: string) => {
  let deepest = 0;
  let open = 0;
  for (const ch of sql.replace(/'(?:[^']|'')*'/g, "''").replace(/char\(1[03]\)/g, "c")) {
    if (ch === "(") deepest = Math.max(deepest, ++open);
    else if (ch === ")") open--;
  }
  return deepest;
};
eq("a thousand line breaks stay shallow", depth(oneLine(`'${"line\r\n".repeat(1000)}'`)) <= 13, true);
eq("a text that is only a line break", oneLine("'\n'"), "(char(10))");
eq("a text without one is left alone", oneLine("'plain ''x'''"), "'plain ''x'''");
eq("numbers and blobs are left alone", [oneLine("-9.0e+999"), oneLine("X'0A'"), oneLine("NULL")], ["-9.0e+999", "X'0A'", "NULL"]);
throws("a raw value is refused", () => insertSql("t", ["a"], ["it's"]), /not a SQL literal \(text of 4 characters\)/);
throws("the refusal never shows the value", () => insertSql("t", ["a"], ["secret-token-value"]), /^(?!.*secret-token-value)/);
throws("a missing value is refused", () => insertSql("t", ["a", "b"], ["1"]), /1 values for 2 columns/);
eq(
  "rows from a page become INSERTs",
  insertsFromRows("u", ["id", "n"], [
    { r: "1", c0: "'a'", c1: "1" },
    { r: "2", c0: "'b'", c1: "NULL" },
  ]),
  [`INSERT INTO "u" ("id", "n") VALUES ('a', 1);`, `INSERT INTO "u" ("id", "n") VALUES ('b', NULL);`],
);
throws("a row missing a column is refused", () => insertsFromRows("u", ["id", "n"], [{ c0: "'a'" }]), /u\.n: not a SQL literal \(undefined\)/);
eq("the file defers foreign keys to the end", dataFile(["A;", "B;"]), "PRAGMA defer_foreign_keys = TRUE;\nA;\nB;\n");

// ---------- Pages ----------

eq(
  "first page by rowid",
  pageSql({ table: "device_logs", columns: ["id", "text"], limit: 1000 }),
  `SELECT CAST(rowid AS TEXT) AS "r", quote("id") AS "c0", quote("text") AS "c1" FROM "device_logs" ORDER BY rowid LIMIT 1000`,
);
eq(
  "next page after the last rowid",
  pageSql({ table: "device_logs", columns: ["id"], limit: 2, after: "9007199254740993" }),
  `SELECT CAST(rowid AS TEXT) AS "r", quote("id") AS "c0" FROM "device_logs" WHERE rowid > 9007199254740993 ORDER BY rowid LIMIT 2`,
);
eq(
  "WITHOUT ROWID pages by its key",
  pageSql({ table: "usage_daily", columns: ["user_id", "day", "n"], pk: ["user_id", "day"], withoutRowid: true, limit: 50, offset: 100 }),
  `SELECT quote("user_id") AS "c0", quote("day") AS "c1", quote("n") AS "c2" FROM "usage_daily" ORDER BY "user_id", "day" LIMIT 50 OFFSET 100`,
);
eq(
  "a column called rowid pages by offset",
  pageSql({ table: "t", columns: ["rowid", "x"], limit: 5 }).includes("OFFSET 0"),
  true,
);
throws("a rowid that isn't a number is refused", () => pageSql({ table: "t", columns: ["a"], limit: 5, after: "1 OR 1=1" }), /bad rowid/);
throws("a page of nothing is refused", () => pageSql({ table: "t", columns: ["a"], limit: 0 }), /bad page size/);

const many = Array.from({ length: 95 }, (_, i) => `t${i}`);
const counts = countStatements(many);
eq("counts: 40 tables to a statement", counts.map((c: { tables: string[] }) => c.tables.length), [40, 40, 15]);
eq("counts: numbered per statement", counts[2].sql.startsWith(`SELECT (SELECT count(*) FROM "t80") AS "n0"`), true);
const chunks = chunkStatements(Array.from({ length: 10 }, () => "x".repeat(4000)), 12_000);
eq("commands stay under the length", chunks.map((c: string[]) => c.length), [2, 2, 2, 2, 2]);
eq("one statement too long still goes alone", chunkStatements(["y".repeat(20_000)], 12_000).length, 1);

// ---------- Reading an export ----------

const exported = [
  "PRAGMA defer_foreign_keys=TRUE;",
  `INSERT INTO "users" ("id","name") VALUES('u1','A');`,
  `INSERT INTO "users" ("id","name") VALUES('u2','line one`,
  `INSERT INTO fake VALUES (1)');`,
  `INSERT INTO "device_logs" ("id","text") VALUES(1,'x');`,
].join("\n");
const read = readExport(exported);
eq("export: tables found (a text line that looks like an INSERT counts, and is said to)", [...read.tables.entries()], [["users", 2], ["fake", 1], ["device_logs", 1]]);
eq("export: a positional INSERT is noticed", read.positional, true);
eq("export: no schema", read.schema, false);
eq("export: schema noticed", readExport(`CREATE TABLE x (a);\nINSERT INTO "x" ("a") VALUES(1);`).schema, true);
eq("export: column-listed only", readExport(`INSERT INTO "a" ("x") VALUES(1);\nINSERT INTO "b" ("y") VALUES(2);`).positional, false);

// ---------- Values D1's export would change ----------

const risk = exportRiskStatements(["device_logs", "t"], (t: string) => (t === "t" ? [] : ["seq", "detail"]));
eq(
  "one count per table, every column checked",
  risk[0],
  `SELECT count(*) AS "n" FROM "device_logs" WHERE ` +
    `(typeof("seq") = 'integer' AND ("seq" > 9007199254740991 OR "seq" < -9007199254740991)) OR ` +
    `(typeof("seq") = 'text' AND instr("seq", '\\') > 0 AND (instr("seq", char(10)) > 0 OR instr("seq", char(13)) > 0)) OR ` +
    `(typeof("detail") = 'integer' AND ("detail" > 9007199254740991 OR "detail" < -9007199254740991)) OR ` +
    `(typeof("detail") = 'text' AND instr("detail", '\\') > 0 AND (instr("detail", char(10)) > 0 OR instr("detail", char(13)) > 0))`,
);
eq("the SQL holds one backslash, as SQL spells it", risk[0].includes(`instr("seq", '\\')`) && !risk[0].includes(`'\\\\'`), true);
eq("a table with no columns to copy counts nothing", risk[1], `SELECT count(*) AS "n" FROM "t" WHERE 0`);

// ---------- Backfills in migrations the old database never had ----------

eq("schema only: nothing to rerun", dataChanges("CREATE TABLE a (x TEXT);\nALTER TABLE b ADD COLUMN y TEXT NOT NULL DEFAULT 'learned';"), []);
eq("a backfill is found", dataChanges("ALTER TABLE m ADD COLUMN source TEXT;\nUPDATE m SET source = 'learned';"), ["UPDATE"]);
eq("so is a data move", dataChanges("CREATE TABLE n (id TEXT);\nINSERT INTO n SELECT id FROM o;\nDELETE FROM o;"), ["INSERT", "DELETE"]);
eq(
  "trigger bodies, comments and quoted words don't count",
  dataChanges(
    "-- UPDATE nothing here\n/* DELETE FROM x; */\nCREATE TABLE t (k TEXT DEFAULT 'insert');\n" +
      "CREATE TRIGGER t_ai AFTER INSERT ON t BEGIN\n  INSERT INTO f(rowid) VALUES (new.rowid);\nEND;",
  ),
  [],
);
eq(
  "an apostrophe in a comment doesn't hide what follows",
  dataChanges("-- OVOA's guess\nALTER TABLE memories ADD COLUMN source TEXT;\nUPDATE memories SET source = 'learned';"),
  ["UPDATE"],
);
eq("the repo's alarms migration, with \"don't\" in its comments, has its backfill found", dataChanges(readFileSync("migrations/0026_alarms.sql", "utf8")), ["UPDATE"]);
eq(
  "a trigger body with CASE ... END in it is skipped to its own END",
  dataChanges("CREATE TRIGGER t_au AFTER UPDATE ON t BEGIN\n  UPDATE u SET n = CASE WHEN new.x THEN 1 ELSE 0 END;\n  DELETE FROM v;\nEND;\nCREATE INDEX i ON t (x);"),
  [],
);
eq("the repo's FTS migration has no backfill",dataChanges("CREATE TRIGGER context_blocks_ad AFTER DELETE ON context_blocks BEGIN\n  INSERT INTO context_search(context_search, rowid) VALUES ('delete', old.rowid);\nEND;"), []);

// ---------- Nothing secret on screen ----------

eq(
  "the export's signed link is hidden",
  redact("You can also download your export from the following URL manually: https://bucket.r2.example/x.sql?X-Amz-Signature=abc&X-Amz-Credential=def done"),
  "You can also download your export from the following URL manually: <link hidden> done",
);
eq("a plain address stays", redact("see https://api.ovoa.ai/me"), "see https://api.ovoa.ai/me");
const side = {
  label: "old",
  cwd: "C:/tmp/x",
  env: { CLOUDFLARE_API_TOKEN: "tok-should-never-show", XDG_CONFIG_HOME: "C:/p" },
  show: { XDG_CONFIG_HOME: "C:/p", CLOUDFLARE_ACCOUNT_ID: "abc" },
  db: "uuid",
  execFlags: ["--remote"],
};
const shown = formatCommand(side, ["d1", "execute", "uuid", "--remote", "--json", "--command", "SELECT 1"]);
eq("a command shows its side, folder, profile and account", shown, `[old] cd C:/tmp/x && XDG_CONFIG_HOME=C:/p CLOUDFLARE_ACCOUNT_ID=abc npx wrangler d1 execute uuid --remote --json --command "SELECT 1"`);
eq("and never the environment's token", shown.includes("tok-should-never-show"), false);
eq("long SQL is cut short on screen", formatCommand(side, ["x", "S".repeat(500)]).includes("(500 chars)"), true);

// ---------- Reading wrangler ----------

eq("wrangler JSON", parseWranglerJson('[{"results":[{"a":1}],"success":true}]'), [{ results: [{ a: 1 }], success: true }]);
eq("wrangler JSON after a banner", parseWranglerJson('update available\n[{"results":[],"success":true}]'), [{ results: [], success: true }]);
const jsonc = parseJsonc(`{
  // a comment with "quotes" and a URL https://x.y
  "account_id": "e58b", /* block */
  "vars": { "PUBLIC_URL": "https://api.ovoa.ai", "S": "a // not a comment", "Q": "say \\"hi\\"", },
  "list": [1, 2,],
}`);
eq("wrangler.jsonc: comments and trailing commas", [jsonc.account_id, jsonc.vars.PUBLIC_URL, jsonc.vars.S, jsonc.vars.Q, jsonc.list], ["e58b", "https://api.ovoa.ai", "a // not a comment", 'say "hi"', [1, 2]]);

// ---------- The largest row, and the way back ----------

eq(
  "a row's size counts bytes, blobs twice and line breaks",
  rowSizeStatements(["m"], () => ["t"]),
  [
    `SELECT max(COALESCE(length(CAST("t" AS BLOB)) * (1 + (typeof("t") = 'blob')) + ` +
      `(typeof("t") = 'text') * 24 * (length("t") - length(replace(replace("t", char(10), ''), char(13), ''))), 0)) AS "n" FROM "m"`,
  ],
);
eq("emptying what was copied, foreign keys checked at the end", resetFile(["a", 'b"c']), 'PRAGMA defer_foreign_keys = TRUE;\nDELETE FROM "a";\nDELETE FROM "b""c";\n');

// ---------- Into a real D1 ----------
//
// The INSERTs for long multi-line text, run in wrangler's local D1 (the same
// SQLite limits as the real one: an expression at most 100 deep, where a flat
// chain of 50 line breaks already failed), and read back exactly. Wrangler is
// loaded by path so the test bundle leaves it out; its database lives in a
// throwaway folder.

const { getPlatformProxy } = await import(pathToFileURL(resolve("node_modules/wrangler/wrangler-dist/cli.js")).href);
const scratch = mkdtempSync(join(tmpdir(), "ovoa-movedb-"));
writeFileSync(
  join(scratch, "wrangler.json"),
  JSON.stringify({ name: "movedb-test", compatibility_date: "2025-01-01", d1_databases: [{ binding: "DB", database_name: "movedb-test", database_id: "movedb-test" }] }),
);
const proxy = await getPlatformProxy({ configPath: join(scratch, "wrangler.json"), persist: { path: join(scratch, "state") } });
try {
  const db = (proxy.env as { DB: D1Database }).DB;
  await db.prepare("CREATE TABLE m (id INTEGER PRIMARY KEY, content TEXT)").run();
  const texts = [
    "a stack\n".repeat(60),
    Array.from({ length: 1000 }, (_, i) => `line ${i} 🍩 it''s "quoted" with a \\n that stays`).join("\r\n"),
    `${"\r\n".repeat(40)}${"\n\n".repeat(40)}end`,
  ];
  for (const [i, text] of texts.entries()) {
    await db.prepare(insertSql("m", ["id", "content"], [String(i + 1), `'${text.replace(/'/g, "''")}'`])).run();
  }
  const { results } = await db.prepare("SELECT content FROM m ORDER BY id").all<{ content: string }>();
  eq("long multi-line text goes into D1 and comes back exactly", results.map((r, i) => r.content === texts[i]), [true, true, true]);
} finally {
  await proxy.dispose();
  rmSync(scratch, { recursive: true, force: true });
}

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
