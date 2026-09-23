// Copies OVOA's data from the old Cloudflare account's jarvis-db into the new
// account's (v1 release, Phase 1). Run once, at cutover, in this order:
//
//   cd jarvis/api
//   1. The new database gets the schema, and the new Worker goes up in
//      maintenance (every request answers 503, the crons do nothing):
//        XDG_CONFIG_HOME=C:/Users/thoma/.wrangler-ovoa npm run db:migrate
//        XDG_CONFIG_HOME=C:/Users/thoma/.wrangler-ovoa npx wrangler deploy --var MAINTENANCE:on
//   2. The old Worker is replaced by the forwarder, which freezes the old
//      database (nothing can write to it any more):
//        XDG_CONFIG_HOME=C:/Users/thoma/.wrangler-edgeformmedia npx wrangler deploy -c ../forwarder/wrangler.jsonc
//   3. The copy (this):
//        node scripts/move-db.mjs
//   4. The new Worker again, out of maintenance:
//        XDG_CONFIG_HOME=C:/Users/thoma/.wrangler-ovoa npx wrangler deploy
//
// No XDG_CONFIG_HOME is needed for this script: it sets each side's own.
//
//   node scripts/move-db.mjs --dry-run   print every command in order; run nothing
//   node scripts/move-db.mjs --check     read both databases and report; copy nothing
//   --method export|select               how the rows leave the old database (default:
//                                        export when it is exact, else select)
//   --page N                             rows per SELECT page (default 1000)
//   --keep-file                          keep the SQL file after a copy that matched
//
// What it does (move-db-lib.mjs has the details):
//   - copies every ordinary table of the old database except SQLite's and D1's
//     own, d1_migrations, the full-text index context_search and its shadow
//     tables, Google's tables (google_accounts, oauth_states, account_profiles:
//     the new TOKEN_ENC_KEY can't read the old tokens, so everyone reconnects),
//     cron_lock (leases; a copied one could hold the first ticks back), and any
//     table the new database doesn't have;
//   - first with one `d1 export --remote --no-schema --table ...` of all of them
//     into one file. It reads every table with SELECTs paged by rowid and
//     writes column-listed INSERTs itself instead when D1 won't export (it
//     refuses databases with virtual tables, and the full-text index is one),
//     when the new database dropped a column, or when the old data holds a
//     value D1's export would write back changed: its dump prints numbers
//     through JavaScript (whole numbers past 2^53 get rounded) and rewrites
//     line breaks with replace(..., '\n', char(10)), which also turns a
//     backslash-n already in the text into a line break. The SELECT route
//     has SQLite write every value (quote()), so it is exact;
//   - imports that one file into the new database with `d1 execute --file`,
//     which applies it as one transaction: whole or not at all, with foreign
//     keys checked at the end (PRAGMA defer_foreign_keys), so the order of
//     tables doesn't matter;
//   - rebuilds the full-text index, then counts every table on both sides and
//     exits non-zero if any differs;
//   - Migrations the old database never had ran on the new one while it was
//     empty. It names any of them that changes rows (an UPDATE backfill, say):
//     the copied rows never went through those, so run those statements on the
//     new database after the copy, before step 4. --check shows this early.
//
// Keeping the two accounts apart:
//   - Every command for the OLD account runs from a new temporary folder with
//     no wrangler config in it or above it. A config's account_id beats
//     CLOUDFLARE_ACCOUNT_ID, and jarvis/api/wrangler.jsonc pins the NEW
//     account, so an old-account command run from there would quietly read the
//     new database instead. It runs with the old profile and account id, and
//     names the old database by its uuid, which resolves on no other account.
//   - Every command for the NEW account runs from jarvis/api, whose
//     wrangler.jsonc pins the account and names jarvis-db by id. Both are
//     checked before anything runs.
//   - Any Cloudflare token, key or account already in the environment is
//     dropped, and it stops if jarvis/api's .env files set one (wrangler
//     loads those) or a ~/.wrangler folder exists (wrangler prefers it to
//     XDG_CONFIG_HOME), so each side's profile login is the one used.
//
// Nothing is written to the old database. The new one must be migrated and
// empty. What wrangler prints is filtered, so the export's signed download
// link never reaches the screen, and no token is ever printed. The SQL file
// holds everyone's data: it's deleted after a copy whose counts match, and kept
// (with a note saying where) otherwise.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execArgs, exportArgs, formatCommand, importArgs, makeRunner, move, pageSql, parseJsonc } from "./move-db-lib.mjs";

const OLD = {
  account: "33594882ed1877edb5cee6f495ca7fae",
  profile: "C:/Users/thoma/.wrangler-edgeformmedia",
  db: "96162569-6625-4cad-af9c-62a3f6820033",
};
const NEW = {
  account: "e58b0ec5305410f9d3cd70f461f39cb6",
  profile: "C:/Users/thoma/.wrangler-ovoa",
  db: "26ebdc31-740f-4191-905d-77a5edb97799",
  name: "jarvis-db",
};

const API_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = join(API_DIR, "node_modules", "wrangler", "bin", "wrangler.js");

// ---------- Arguments ----------

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const known = new Set(["--dry-run", "--check", "--method", "--page", "--keep-file"]);
const unknown = argv.filter((a, i) => !known.has(a) && !["--method", "--page"].includes(argv[i - 1]));
const dryRun = flag("--dry-run");
const check = flag("--check");
const keepFile = flag("--keep-file");
const method = value("--method", "auto");
const pageSize = Number(value("--page", "1000"));
if (unknown.length || !["auto", "export", "select"].includes(method) || !Number.isInteger(pageSize) || pageSize < 1) {
  console.error("usage: node scripts/move-db.mjs [--dry-run | --check] [--method export|select] [--page N] [--keep-file]");
  process.exit(2);
}

function stop(message) {
  console.error(`\nStopped: ${message}`);
  process.exit(1);
}

// ---------- Checks before anything runs ----------

/** jarvis/api/wrangler.jsonc must pin the new account and name the new jarvis-db, or a "new" command could land anywhere. */
function checkConfig() {
  const config = parseJsonc(readFileSync(join(API_DIR, "wrangler.jsonc"), "utf8"));
  if (config.account_id !== NEW.account) {
    stop(`jarvis/api/wrangler.jsonc pins account ${config.account_id ?? "(none)"}, not the new one (${NEW.account})`);
  }
  const db = (config.d1_databases ?? []).find((d) => d.database_name === NEW.name);
  if (db?.database_id !== NEW.db) {
    stop(`jarvis/api/wrangler.jsonc's ${NEW.name} is ${db?.database_id ?? "(missing)"}, not the new database (${NEW.db})`);
  }
}

/** The folder and every folder above it, as wrangler looks for a config (find-up from where it runs). */
function configAbove(dir) {
  const names = ["wrangler.json", "wrangler.jsonc", "wrangler.toml", join(".wrangler", "deploy", "config.json")];
  const { root } = parse(dir);
  for (let d = resolve(dir); ; d = dirname(d)) {
    for (const n of names) if (existsSync(join(d, n))) return join(d, n);
    if (d === root || dirname(d) === d) return null;
  }
}

/**
 * Cloudflare settings in the .env files wrangler loads from the folder it runs
 * in (.env, .env.local), which would beat the profile. Names only, never values.
 */
function envFileOverrides(dir) {
  const found = [];
  for (const file of [".env", ".env.local"]) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const name = /^\s*(?:export\s+)?((?:CLOUDFLARE_|CF_)[A-Z0-9_]*)\s*=/i.exec(line)?.[1];
      if (name) found.push(`${file}: ${name}`);
    }
  }
  return found;
}

/** The environment for one side: its profile and account, and no Cloudflare credentials from outside. */
function sideEnv(side) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CLOUDFLARE_|CF_)/i.test(k)) continue;
    env[k] = v;
  }
  env.XDG_CONFIG_HOME = side.profile;
  env.CLOUDFLARE_ACCOUNT_ID = side.account;
  env.WRANGLER_SEND_METRICS = "false";
  return env;
}

checkConfig();
if (!existsSync(WRANGLER)) stop(`no wrangler at ${WRANGLER} (npm install in jarvis/api)`);
for (const side of [OLD, NEW]) {
  if (!existsSync(join(side.profile, ".wrangler", "config", "default.toml"))) {
    stop(`no wrangler login in ${side.profile} (XDG_CONFIG_HOME=${side.profile} npx wrangler login)`);
  }
}
// Wrangler prefers a ~/.wrangler folder to XDG_CONFIG_HOME when one exists,
// which would send both sides through the same login.
if (existsSync(join(homedir(), ".wrangler"))) {
  stop(`${join(homedir(), ".wrangler")} exists, and wrangler would use its login instead of each side's profile; move it aside first`);
}
const overrides = envFileOverrides(API_DIR);
if (overrides.length) stop(`jarvis/api has Cloudflare settings that would beat the profile (${overrides.join(", ")}); move them aside first`);
const stray = configAbove(tmpdir());
if (stray) stop(`${stray} would be picked up by the old account's commands; remove it or point TEMP/TMP somewhere else`);

// The old side's folder. With --dry-run nothing is created, so it is named, not made.
const work = dryRun ? join(tmpdir(), "ovoa-move-db-XXXXXX") : mkdtempSync(join(tmpdir(), "ovoa-move-db-"));
if (!dryRun && configAbove(work)) stop(`a wrangler config turned up at ${configAbove(work)}`);
const dataPath = join(work, "old-data.sql");

const from = {
  label: "old",
  cwd: work,
  env: sideEnv(OLD),
  show: { XDG_CONFIG_HOME: OLD.profile, CLOUDFLARE_ACCOUNT_ID: OLD.account },
  db: OLD.db,
  execFlags: ["--remote"],
  exportFlags: ["--remote"],
};
const to = {
  label: "new",
  cwd: API_DIR,
  env: sideEnv(NEW),
  show: { XDG_CONFIG_HOME: NEW.profile, CLOUDFLARE_ACCOUNT_ID: NEW.account },
  db: NEW.name,
  execFlags: ["--remote"],
  exportFlags: ["--remote"],
};
const migrations = readdirSync(join(API_DIR, "migrations"))
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((name) => ({ name, sql: readFileSync(join(API_DIR, "migrations", name), "utf8") }));

console.log(`Old: account ${OLD.account}, jarvis-db ${OLD.db}, profile ${OLD.profile}, run from ${work}`);
console.log(`New: account ${NEW.account}, jarvis-db ${NEW.db}, profile ${NEW.profile}, run from ${API_DIR}`);

// ---------- --dry-run: the commands, in order, and nothing else ----------

if (dryRun) {
  const T = "<each table to copy>";
  const show = (side, args, note = "") => console.log(`${note ? `   (${note})\n` : ""}${formatCommand(side, args)}\n`);
  console.log("\n--dry-run: these run in this order; nothing was run.\n");
  const tables = "SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name";
  show(from, execArgs(from, tables), "1. what each side has");
  show(to, execArgs(to, tables));
  show(to, execArgs(to, "SELECT name FROM d1_migrations ORDER BY id"), `the new database must have all ${migrations.length} migrations`);
  show(
    from,
    execArgs(from, "SELECT name FROM d1_migrations ORDER BY id"),
    "the ones the old database never had; any that changes rows is named, to run again after the copy",
  );
  show(from, execArgs(from, `PRAGMA table_info("${T}")`), "2. columns, several tables to a command");
  show(to, execArgs(to, `PRAGMA table_info("${T}")`));
  show(from, execArgs(from, `SELECT (SELECT count(*) FROM "${T}") AS "n0", ...`), "3. counts; the new side must be all 0");
  show(to, execArgs(to, `SELECT (SELECT count(*) FROM "${T}") AS "n0", ...`));
  if (method !== "select") {
    show(
      from,
      execArgs(from, `SELECT count(*) AS "n" FROM "${T}" WHERE <a whole number past 2^53, or text with a backslash and a line break>`),
      "values the export would write back changed, several tables to a command; any, and the rows go by SELECT",
    );
    show(from, exportArgs(from, [T], dataPath), "4. the rows, exported into one file");
  }
  if (method !== "export") {
    show(
      from,
      execArgs(from, pageSql({ table: T, columns: ["<column>", "..."], limit: pageSize })),
      `${method === "select" ? "4. the rows" : "4b. only if the export is refused: the rows"}, ${pageSize} at a time (then WHERE rowid > the last one seen), written into one file as INSERTs`,
    );
  }
  show(to, importArgs(to, dataPath), "5. the file, into the new database in one transaction");
  show(to, execArgs(to, "INSERT INTO context_search(context_search) VALUES('rebuild')"), "6. the full-text index");
  show(from, execArgs(from, `SELECT (SELECT count(*) FROM "${T}") AS "n0", ...`), "7. counts again, old against new");
  show(to, execArgs(to, `SELECT (SELECT count(*) FROM "${T}") AS "n0", ...`));
  process.exit(0);
}

// ---------- The copy ----------

let code = 1;
try {
  code = await move({
    from,
    to,
    runner: makeRunner(WRANGLER),
    method,
    pageSize,
    check,
    dataPath,
    keepFile,
    migrations,
  });
} catch (err) {
  console.error(`\nStopped: ${err.message}`);
  if (existsSync(dataPath)) console.error(`The SQL file is at ${dataPath}. It holds everyone's data; delete it when you're done.`);
}
if (code === 0 && !existsSync(dataPath)) rmSync(work, { recursive: true, force: true });
process.exit(code);
