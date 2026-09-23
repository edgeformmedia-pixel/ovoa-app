// The copy behind move-db.mjs: choosing the tables, writing the SQL, running
// wrangler, and the copy itself. It knows nothing about which accounts are
// involved. move-db.mjs builds the two sides (folder, profile, account,
// database) and calls move(). They're kept apart so test/movedb.test.ts can
// check the SQL without running anything, and so the whole copy can be
// rehearsed between two local D1s with the same code that runs at cutover.
//
// A side is { label, cwd, env, show, db, execFlags, exportFlags }:
//   cwd, env     where wrangler runs and with what environment;
//   show         the environment worth printing (profile and account, never a token);
//   db           the database as wrangler is told it (name or uuid);
//   execFlags    added to `d1 execute`, e.g. ["--remote"];
//   exportFlags  added to `d1 export`, e.g. ["--remote"].

import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// ---------- Which tables ----------

/** Why a table of the old database is not copied, or null when it is. */
export function skipReason(name, sql = "") {
  if (/^sqlite_/i.test(name)) return "SQLite's own bookkeeping";
  if (/^_cf_/i.test(name)) return "D1's own bookkeeping";
  if (name === "d1_migrations") return "the new database keeps its own list of applied migrations";
  if (name === "context_search" || name.startsWith("context_search_")) {
    return "the full-text index; rebuilt from context_blocks after the copy";
  }
  if (/^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(sql ?? "")) return "a virtual table";
  if (name === "google_accounts" || name === "oauth_states") {
    return "Google tokens: the new TOKEN_ENC_KEY can't read them, so everyone reconnects";
  }
  if (name === "account_profiles") return "learned from the Google accounts, which aren't copied";
  // Not in the brief's list: a lease the old Worker held when it was replaced
  // would hold the new Worker's first ticks back until it ran out.
  if (name === "cron_lock") return "cron leases: the new Worker takes its own";
  return null;
}

/**
 * The tables to copy, in the old database's order, and the ones left out with
 * why. oldTables is sqlite_master's rows ({ name, sql }); newNames the new
 * database's table names. A table the new database doesn't have is left out.
 */
export function planTables(oldTables, newNames) {
  const have = new Set(newNames);
  const copy = [];
  const skipped = [];
  for (const { name, sql } of oldTables) {
    const reason = skipReason(name, sql) ?? (have.has(name) ? null : "not in the new database");
    if (reason) skipped.push({ name, reason });
    else copy.push(name);
  }
  return { copy, skipped };
}

/** True for a table declared WITHOUT ROWID: it has no rowid to page by. */
export function isWithoutRowid(sql) {
  const s = String(sql ?? "");
  return /\bWITHOUT\s+ROWID\b/i.test(s.slice(s.lastIndexOf(")")));
}

// ---------- Writing SQL ----------

/** A quoted SQLite identifier: "name", with any " doubled. */
export function qid(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * What SQLite's quote() gives back, and so the only things allowed after VALUES:
 * NULL, an integer, a real (1.5, 1.0e+20, -9.0e+999 for minus infinity), a text
 * in single quotes with any ' doubled, or a blob as X'..'.
 */
const LITERAL = /^(?:NULL|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|'(?:[^']|'')*'|X'(?:[0-9a-f]{2})*')$/i;

export function isSqlLiteral(value) {
  return typeof value === "string" && LITERAL.test(value);
}

/**
 * One page of a table, every value already written as a SQL literal by SQLite
 * itself (quote()), so nothing is lost on the way through JSON: integers past
 * 2^53, reals, blobs and text all come back as text that means exactly them.
 * Columns come back as c0, c1, ... in the order asked for.
 *
 * Ordinary tables page by rowid (after = the last rowid seen, as text). Tables
 * WITHOUT ROWID page by their primary key with OFFSET, which is steady because
 * the old database doesn't change while this runs.
 */
export function pageSql({ table, columns, withoutRowid = false, pk = [], limit, after = null, offset = 0 }) {
  if (!columns.length) throw new Error(`${table} has no columns to copy`);
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`bad page size ${limit}`);
  const values = columns.map((c, i) => `quote(${qid(c)}) AS "c${i}"`).join(", ");
  const rowidClash = columns.some((c) => ["rowid", "_rowid_", "oid"].includes(String(c).toLowerCase()));
  if (!withoutRowid && !rowidClash) {
    if (after !== null && !/^-?\d+$/.test(String(after))) throw new Error(`bad rowid ${after}`);
    const where = after === null ? "" : ` WHERE rowid > ${after}`;
    return `SELECT CAST(rowid AS TEXT) AS "r", ${values} FROM ${qid(table)}${where} ORDER BY rowid LIMIT ${limit}`;
  }
  if (!Number.isInteger(offset) || offset < 0) throw new Error(`bad offset ${offset}`);
  const order = (pk.length ? pk : columns).map(qid).join(", ");
  return `SELECT ${values} FROM ${qid(table)} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`;
}

/**
 * A text literal with line breaks in it, rewritten onto one line the way
 * SQLite's own .dump does, but exactly: 'a' || char(10) || 'b'. Every INSERT
 * then sits on one line of the file, whatever reads it. Anything else comes
 * back unchanged. A '' pair never straddles a line break, so the pieces stay
 * valid literals.
 *
 * The pieces are joined as a balanced tree, ((a || b) || (c || d)), not a flat
 * chain: SQLite refuses an expression deeper than its limit (100 on D1,
 * "Expression tree is too large"), and a chain is one level per piece, so a
 * text with 50 line breaks (a device log's stack) failed the whole import. A
 * tree is about log2(pieces) deep.
 */
export function oneLine(literal) {
  if (!literal.startsWith("'") || !/[\r\n]/.test(literal)) return literal;
  const parts = literal
    .slice(1, -1)
    .split(/(\r|\n)/)
    .filter((part) => part !== "")
    .map((part) => (part === "\n" ? "char(10)" : part === "\r" ? "char(13)" : `'${part}'`));
  return parts.length === 1 ? `(${parts[0]})` : concat(parts);
}

/** `a || b || ...`, split in half again and again. */
function concat(parts) {
  if (parts.length === 1) return parts[0];
  const mid = Math.ceil(parts.length / 2);
  return `(${concat(parts.slice(0, mid))} || ${concat(parts.slice(mid))})`;
}

/** One column-listed INSERT on one line. Every value must already be a SQL literal; nothing is escaped here. */
export function insertSql(table, columns, literals) {
  if (literals.length !== columns.length) {
    throw new Error(`${table}: ${literals.length} values for ${columns.length} columns`);
  }
  literals.forEach((value, i) => {
    if (!isSqlLiteral(value)) {
      // Says what it was, never the value: it could be anyone's message.
      const what = typeof value === "string" ? `text of ${value.length} characters` : typeof value;
      throw new Error(`${table}.${columns[i]}: not a SQL literal (${what})`);
    }
  });
  return `INSERT INTO ${qid(table)} (${columns.map(qid).join(", ")}) VALUES (${literals.map(oneLine).join(", ")});`;
}

/**
 * Per table, one count of the values D1's export would write back changed.
 * Its dump (the same code as miniflare's dumpSql) prints numbers through
 * JavaScript, so a whole number past 2^53 comes back rounded; and it puts a
 * text with line breaks on one line with replace(..., '\n', char(10)), which
 * also turns any backslash-n the text already had into a line break. Text
 * with a backslash and a line break is counted, which is a little wider than
 * that, on purpose.
 */
export function exportRiskStatements(tables, columnsOf) {
  return tables.map((t) => {
    const checks = columnsOf(t).map((name) => {
      const c = qid(name);
      return (
        `(typeof(${c}) = 'integer' AND (${c} > 9007199254740991 OR ${c} < -9007199254740991)) OR ` +
        `(typeof(${c}) = 'text' AND instr(${c}, '\\') > 0 AND (instr(${c}, char(10)) > 0 OR instr(${c}, char(13)) > 0))`
      );
    });
    return `SELECT count(*) AS "n" FROM ${qid(t)} WHERE ${checks.length ? checks.join(" OR ") : "0"}`;
  });
}

/** D1 refuses one statement longer than this (SQLITE_TOOBIG), and each row is one INSERT. */
export const STATEMENT_LIMIT = 100_000;

/**
 * Per table, its largest row roughly as its INSERT will carry it: each value's
 * bytes, a blob twice (it's written as hex), and about 24 more for each line
 * break in a text (' || char(10) || ' and the brackets around it).
 */
export function rowSizeStatements(tables, columnsOf) {
  return tables.map((t) => {
    const sizes = columnsOf(t).map((name) => {
      const c = qid(name);
      return (
        `COALESCE(length(CAST(${c} AS BLOB)) * (1 + (typeof(${c}) = 'blob')) + ` +
        `(typeof(${c}) = 'text') * 24 * (length(${c}) - length(replace(replace(${c}, char(10), ''), char(13), ''))), 0)`
      );
    });
    return `SELECT max(${sizes.length ? sizes.join(" + ") : "0"}) AS "n" FROM ${qid(t)}`;
  });
}

/** The INSERTs for a page of rows from pageSql(). */
export function insertsFromRows(table, columns, rows) {
  return rows.map((row) =>
    insertSql(
      table,
      columns,
      columns.map((_, i) => row[`c${i}`]),
    ),
  );
}

/** The file both methods produce: foreign keys checked once, at the end, so the order of tables doesn't matter. */
export function dataFile(statements) {
  return `PRAGMA defer_foreign_keys = TRUE;\n${statements.join("\n")}\n`;
}

/**
 * The copied tables of the new database emptied, to start a copy again after
 * it went wrong. Foreign keys are checked at the end, as for the copy. Only
 * for a new database whose Worker is still in maintenance: then everything in
 * these tables came from the copy.
 */
export function resetFile(tables) {
  return `PRAGMA defer_foreign_keys = TRUE;\n${tables.map((t) => `DELETE FROM ${qid(t)};`).join("\n")}\n`;
}

/** Row counts for many tables in as few statements as fit: one SELECT per group, n0, n1, ... */
export function countStatements(tables, perStatement = 40) {
  const out = [];
  for (let i = 0; i < tables.length; i += perStatement) {
    const group = tables.slice(i, i + perStatement);
    out.push({ tables: group, sql: `SELECT ${group.map((t, j) => `(SELECT count(*) FROM ${qid(t)}) AS "n${j}"`).join(", ")}` });
  }
  return out;
}

/** Groups statements so each group, joined into one command, stays under maxChars (a Windows command line is 32K). */
export function chunkStatements(statements, maxChars = 12_000) {
  const chunks = [];
  let current = [];
  let length = 0;
  for (const item of statements) {
    const size = item.length + 2;
    if (current.length && length + size > maxChars) {
      chunks.push(current);
      current = [];
      length = 0;
    }
    current.push(item);
    length += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/** Runs many single statements, several to a command, and returns each one's rows in order. */
function queryMany(query, side, statements) {
  const out = [];
  for (const group of chunkStatements(statements)) {
    const results = query(side, group.join(";\n"), { quiet: true });
    if (results.length !== group.length) throw new Error(`sent ${group.length} statements, got ${results.length} results`);
    out.push(...results);
  }
  return out;
}

/**
 * What a D1 export file holds: which tables it inserts into, how many INSERTs
 * each (counted by lines that start one, so a text value with a line starting
 * "INSERT INTO" would add one), whether any INSERT goes by position instead of
 * naming its columns, and whether any schema came along.
 */
export function readExport(text) {
  const tables = new Map();
  let positional = false;
  const re = /^INSERT\s+INTO\s+("(?:[^"]|"")+"|[^\s("]+)\s*(\(|VALUES)/gim;
  for (let m; (m = re.exec(text)); ) {
    const raw = m[1];
    const name = raw.startsWith('"') ? raw.slice(1, -1).replace(/""/g, '"') : raw;
    tables.set(name, (tables.get(name) ?? 0) + 1);
    if (m[2].toUpperCase() === "VALUES") positional = true;
  }
  const schema = /^\s*(CREATE|DROP|ALTER)\s/im.test(text);
  return { tables, positional, schema };
}

/**
 * The statements in a migration that change rows rather than schema (UPDATE,
 * INSERT, DELETE, REPLACE), ignoring comments, quoted text and trigger bodies.
 * A migration the old database never had runs on the new database while it is
 * still empty, so a backfill in it never touches the copied rows.
 *
 * Read once, left to right, so each thing is what it is where it starts: an
 * apostrophe in a comment ("-- don't") is part of the comment, not the start
 * of a string that swallows the statements after it. Then, statement by
 * statement, the first word; a CREATE TRIGGER's body is skipped to its own END
 * (CASE ... END inside it counted), since it runs later, on rows written then.
 */
export function dataChanges(sql) {
  const text = String(sql ?? "");
  let bare = "";
  for (let i = 0; i < text.length; ) {
    const ch = text[i];
    const two = text.slice(i, i + 2);
    if (ch === "'" || ch === '"') {
      // A string, or a quoted name: to its closing quote, a doubled one inside it.
      let j = i + 1;
      for (;;) {
        const k = text.indexOf(ch, j);
        if (k < 0) {
          j = text.length;
          break;
        }
        if (text[k + 1] === ch) j = k + 2;
        else {
          j = k + 1;
          break;
        }
      }
      bare += " x ";
      i = j;
    } else if (two === "--") {
      const k = text.indexOf("\n", i);
      i = k < 0 ? text.length : k;
    } else if (two === "/*") {
      const k = text.indexOf("*/", i + 2);
      i = k < 0 ? text.length : k + 2;
      bare += " ";
    } else {
      bare += ch;
      i++;
    }
  }
  const verbs = new Set();
  let head = [];
  /** 0: not in a trigger; 1: a CREATE TRIGGER before its BEGIN; 2: inside its body. */
  let trigger = 0;
  let cases = 0;
  for (const token of bare.match(/[A-Za-z_]\w*|;/g) ?? []) {
    const word = token.toUpperCase();
    if (trigger === 2) {
      if (word === "CASE") cases++;
      else if (word === "END") {
        if (cases) cases--;
        else trigger = 0;
      }
      continue;
    }
    if (word === ";") {
      head = [];
      trigger = 0;
      continue;
    }
    if (!head.length && ["UPDATE", "INSERT", "DELETE", "REPLACE"].includes(word)) verbs.add(word);
    head.push(word);
    if (trigger === 1 && word === "BEGIN") trigger = 2;
    else if (word === "TRIGGER" && head[0] === "CREATE" && head.length <= 3) trigger = 1;
  }
  return [...verbs];
}

// ---------- Reading wrangler.jsonc ----------

/** JSON with comments and trailing commas, as wrangler.jsonc is written. */
export function parseJsonc(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i++;
      } else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else if (ch === "}" || ch === "]") {
      // A trailing comma: outside any string here, so the tail can't be inside one.
      out = out.replace(/,\s*$/, "") + ch;
    } else out += ch;
  }
  return JSON.parse(out);
}

// ---------- Running wrangler ----------

/** `d1 execute` with SQL, answering in JSON. */
export function execArgs(side, sql) {
  return ["d1", "execute", side.db, ...side.execFlags, "--json", "--command", sql];
}

/** `d1 export` of the rows alone (no schema) of these tables, into one file. */
export function exportArgs(side, tables, output) {
  return ["d1", "export", side.db, ...side.exportFlags, "--no-schema", "-y", "--output", output, ...tables.flatMap((t) => ["--table", t])];
}

/** `d1 execute --file`: remotely, one upload applied as one transaction. */
export function importArgs(side, file) {
  return ["d1", "execute", side.db, ...side.execFlags, "--yes", "--file", file];
}

/** Signed download links (the export prints one, valid for an hour) never reach the screen. */
export function redact(text) {
  return String(text ?? "").replace(/https?:\/\/[^\s"'<>]*\?[^\s"'<>]*/g, "<link hidden>");
}

/** The JSON wrangler prints with --json, found even if something else was printed before it. */
export function parseWranglerJson(stdout) {
  const text = String(stdout ?? "").trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.search(/^[[{]/m);
    if (start < 0) throw new Error("wrangler printed no JSON");
    return JSON.parse(text.slice(start));
  }
}

/** How a command reads, for the screen: the side's folder and profile, SQL cut short. */
export function formatCommand(side, args) {
  const shown = args.map((a) => {
    const s = String(a);
    const cut = s.length > 160 ? `${s.slice(0, 150)}… (${s.length} chars)` : s;
    return /[\s"'();*<>|&]/.test(cut) ? `"${cut.replace(/"/g, '\\"')}"` : cut;
  });
  const env = Object.entries(side.show ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  return `[${side.label}] cd ${side.cwd} && ${env ? `${env} ` : ""}npx wrangler ${shown.join(" ")}`;
}

function failure(args, res) {
  let why = "";
  try {
    const parsed = parseWranglerJson(res.stdout);
    why = parsed?.error?.text ?? parsed?.error?.message ?? "";
    const notes = parsed?.error?.notes?.map((n) => n.text).join(" ") ?? "";
    if (notes) why += ` ${notes}`;
  } catch {
    // not JSON; the tail of what it printed says more
  }
  if (!why) why = `${res.stderr ?? ""}\n${res.stdout ?? ""}`.trim().split("\n").slice(-15).join("\n");
  return new Error(`wrangler ${args.slice(0, 2).join(" ")} failed (exit ${res.status}): ${redact(why)}`);
}

/**
 * Makes a runner for wrangler at `bin` (node_modules/wrangler/bin/wrangler.js).
 * run(side, args) returns what it printed and throws when it fails; nothing it
 * prints reaches the screen unredacted.
 */
export function makeRunner(bin, { echo = (line) => console.log(line) } = {}) {
  function run(side, args, { quiet = false } = {}) {
    if (!quiet) echo(formatCommand(side, args));
    const res = spawnSync(process.execPath, [bin, ...args], {
      cwd: side.cwd,
      env: side.env,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 1024,
      windowsHide: true,
    });
    if (res.error) throw new Error(`couldn't start wrangler: ${res.error.message}`);
    if (res.status !== 0) throw failure(args, res);
    return res;
  }

  /** Runs SQL (one or more statements) and returns each statement's rows. */
  function query(side, sql, opts) {
    const res = run(side, execArgs(side, sql), opts);
    const parsed = parseWranglerJson(res.stdout);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.map((r) => {
      if (r && r.success === false) throw new Error(`query failed: ${redact(JSON.stringify(r.error ?? r))}`);
      return r?.results ?? [];
    });
  }

  return { run, query };
}

// ---------- The copy ----------

/**
 * Copies every copyable table from side `from` to side `to`, then rebuilds the
 * full-text index and compares row counts. Returns the exit code: 0 when every
 * count matches, 1 otherwise. Throws on anything unexpected.
 *
 *   method       "auto" (export, falling back to select), "export" or "select"
 *   pageSize     rows per page for select
 *   check        read and report only; copy nothing
 *   dataPath     where the SQL file is written (it holds everyone's data)
 *   keepFile     keep it after a copy that matched
 *   migrations   the migration files ({ name, sql }) the new database must have applied
 */
export async function move({ from, to, runner, log = console.log, method = "auto", pageSize = 1000, check = false, dataPath, keepFile = false, migrations = [] }) {
  const { run, query } = runner;
  const tablesSql = "SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name";

  // 1. What each side has.
  log("\n1. Tables on both sides");
  const [oldTables] = query(from, tablesSql);
  const [newTables] = query(to, tablesSql);
  const newNames = newTables.map((t) => t.name);

  // The new database must be fully migrated first, or most tables would be
  // "not in the new database" and the copy would quietly leave them out.
  if (!newNames.includes("d1_migrations")) {
    throw new Error("the new database has no d1_migrations table: apply the migrations to it first (npm run db:migrate)");
  }
  const [applied] = query(to, "SELECT name FROM d1_migrations ORDER BY id");
  const appliedNames = new Set(applied.map((r) => r.name));
  const missing = migrations.filter((m) => !appliedNames.has(m.name)).map((m) => m.name);
  if (missing.length) {
    throw new Error(`the new database is missing ${missing.length} migration(s) (${missing.join(", ")}): run npm run db:migrate first`);
  }
  // Migrations the old database never had ran on the new one while it was
  // empty. Schema is fine that way; a backfill (an UPDATE over existing rows)
  // never saw the copied rows, and has to be run again after the copy.
  const oldApplied = oldTables.some((t) => t.name === "d1_migrations")
    ? new Set(query(from, "SELECT name FROM d1_migrations ORDER BY id")[0].map((r) => r.name))
    : new Set();
  const pending = migrations.filter((m) => !oldApplied.has(m.name));
  if (pending.length) log(`   migrations the old database never had (they ran on the empty new one): ${pending.map((m) => m.name).join(", ")}`);
  for (const m of pending) {
    const verbs = dataChanges(m.sql);
    if (verbs.length) {
      log(
        `   NOTE: ${m.name} changes rows (${verbs.join(", ")}), and the copied rows never went through it. ` +
          "Run those statements on the new database after the copy, before the Worker leaves maintenance.",
      );
    }
  }

  const { copy, skipped } = planTables(oldTables, newNames);
  log(`   copying ${copy.length}: ${copy.join(", ")}`);
  for (const s of skipped) log(`   not copying ${s.name}: ${s.reason}`);
  if (!copy.length) throw new Error("nothing to copy");

  // 2. Columns: the copy names them, so a column the new database added gets
  // its default, and one it dropped is left behind (said out loud).
  log("\n2. Columns");
  const oldCols = tableInfo(query, from, copy);
  const newCols = tableInfo(query, to, copy);
  const columns = new Map();
  let dropsColumns = false;
  for (const table of copy) {
    const olds = oldCols.get(table) ?? [];
    const news = newCols.get(table) ?? [];
    const newNamesSet = new Set(news.map((c) => c.name));
    const oldNamesSet = new Set(olds.map((c) => c.name));
    const kept = olds.filter((c) => newNamesSet.has(c.name));
    const dropped = olds.filter((c) => !newNamesSet.has(c.name)).map((c) => c.name);
    const added = news.filter((c) => !oldNamesSet.has(c.name));
    const stuck = added.filter((c) => c.notnull && c.dflt_value === null && !c.pk).map((c) => c.name);
    if (stuck.length) {
      throw new Error(`${table}: the new database requires ${stuck.join(", ")} (NOT NULL, no default), which the old rows don't have`);
    }
    if (dropped.length) {
      dropsColumns = true;
      log(`   ${table}: the new database has no ${dropped.join(", ")}; those values stay behind in the old one`);
    }
    if (added.length) log(`   ${table}: new column(s) ${added.map((c) => c.name).join(", ")} take their defaults`);
    columns.set(table, {
      names: kept.map((c) => c.name),
      pk: kept.filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name),
      sameOrder: olds.length === news.length && olds.every((c, i) => c.name === news[i].name),
    });
  }
  log("   checked");

  // 3. Counts before. The new side must be empty, or the copy would collide
  // with (or add to) what's there and the counts would prove nothing.
  log("\n3. Rows before the copy");
  const before = { old: counts(query, from, copy), new: counts(query, to, copy) };
  const occupied = copy.filter((t) => before.new.get(t) > 0);
  printCounts(log, copy, before.old, before.new, "old", "new now");

  // Each row is one INSERT, and D1 refuses a statement over 100 KB: a row near
  // that would fail the whole import (it's one transaction), so it's said now.
  const sizes = queryMany(query, from, rowSizeStatements(copy, (t) => columns.get(t).names));
  const largest = copy.map((t, i) => [t, Number(sizes[i]?.[0]?.n ?? 0)]).sort((a, b) => b[1] - a[1]);
  if (largest.length && largest[0][1] > 0) log(`   largest row: about ${largest[0][1]} bytes, in ${largest[0][0]}`);
  const tooBig = largest.filter(([, n]) => n >= 0.8 * STATEMENT_LIMIT);
  if (tooBig.length) {
    log(
      `   WARNING: ${tooBig.map(([t, n]) => `${t} (about ${n} bytes)`).join(", ")} ` +
        `${tooBig.length === 1 ? "has a row" : "have rows"} near D1's ${STATEMENT_LIMIT}-byte statement limit; the import may be refused.`,
    );
  }

  // How the rows will leave. The export is one command, but it can't leave
  // columns out, and it writes a few kinds of value back changed
  // (exportRiskStatements); for either, the rows are read with SELECT instead,
  // which copies them exactly.
  const oldTotal = copy.reduce((n, t) => n + before.old.get(t), 0);
  let how = method === "auto" ? (dropsColumns ? "select" : "export") : method;
  if (method === "auto" && dropsColumns) log("\n   A table lost columns, so the rows will be read with SELECT rather than exported.");
  if (how === "export") {
    const risks = queryMany(query, from, exportRiskStatements(copy, (t) => columns.get(t).names));
    const risky = copy.map((t, i) => [t, Number(risks[i]?.[0]?.n ?? 0)]).filter(([, n]) => n > 0);
    if (risky.length) {
      const where = `${risky.map(([t, n]) => `${t} ${n}`).join(", ")}: whole numbers past 2^53, or text with a backslash and a line break`;
      if (method === "export") log(`\n   WARNING: the export will change some values (${where}).`);
      else {
        log(`\n   The export would change some values (${where}),`);
        log("   so the rows will be read with SELECT, which copies them exactly.");
        how = "select";
      }
    }
  }

  if (check) {
    log(
      occupied.length
        ? `\n--check: the new database already has rows in ${occupied.join(", ")}; the copy would refuse.`
        : `\n--check: nothing copied. The new database is empty and ready; the rows would go by ${how}.`,
    );
    return 0;
  }
  if (occupied.length) {
    throw new Error(
      `the new database already has rows in ${occupied.join(", ")}. It must be empty (the new Worker in maintenance, nothing written) before the copy.`,
    );
  }

  // 4. The old rows, into one SQL file.
  if (how === "export") {
    log(`\n4. Exporting ${oldTotal} rows from the old database`);
    try {
      rmSync(dataPath, { force: true });
      run(from, exportArgs(from, copy, dataPath));
      const found = readExport(readFileSync(dataPath, "utf8"));
      const stray = [...found.tables.keys()].filter((t) => !copy.includes(t));
      const reordered = copy.filter((t) => !columns.get(t).sameOrder && found.tables.has(t));
      if (found.schema) throw new Error("the export has schema statements in it despite --no-schema");
      if (stray.length) throw new Error(`the export has rows for tables that weren't asked for: ${stray.join(", ")}`);
      if (found.positional && reordered.length) {
        throw new Error(`the export inserts by position, and ${reordered.join(", ")} has different columns in the new database`);
      }
      const inserts = [...found.tables.values()].reduce((a, b) => a + b, 0);
      log(`   ${inserts} INSERTs for ${found.tables.size} tables (tables with no rows have none)`);
      if (inserts < oldTotal) throw new Error(`the export has ${inserts} INSERTs for ${oldTotal} rows`);
    } catch (err) {
      if (method === "export") throw err;
      log(`   the export didn't work: ${redact(err.message)}`);
      log("   reading the rows with SELECT instead");
      how = "select";
    }
  }
  if (how === "select") {
    log(`\n4. Reading ${oldTotal} rows from the old database, ${pageSize} at a time`);
    const statements = dumpTables({ query, side: from, copy, columns, oldTables, pageSize, log, expected: before.old });
    writeFileSync(dataPath, dataFile(statements));
  }

  // 5. Into the new database, in one go: the import is one transaction, so it
  // lands whole or not at all.
  log(`\n5. Importing into the new database (${how})`);
  const imported = run(to, importArgs(to, dataPath));
  const summary = redact(imported.stdout).split("\n").filter((l) => /Executed|rows written|Rows written/i.test(l));
  for (const line of summary) log(`   ${line.trim()}`);

  // 6. The full-text index over context_blocks, rebuilt from the copied rows.
  if (newNames.includes("context_search")) {
    log("\n6. Rebuilding the full-text index");
    query(to, "INSERT INTO context_search(context_search) VALUES('rebuild')");
  }

  // 7. Counts after, both sides counted again.
  log("\n7. Rows after the copy");
  const after = { old: counts(query, from, copy), new: counts(query, to, copy) };
  const bad = printCounts(log, copy, after.old, after.new, "old", "new");
  // The old database was meant to be frozen. If it moved, something still
  // writes to it (a request or a cron run the old Worker started before the
  // forwarder replaced it), and that, not the copy, is what to fix.
  const moved = copy.filter((t) => after.old.get(t) !== before.old.get(t));
  if (moved.length) {
    log(
      `\nThe OLD database changed while this ran (${moved.map((t) => `${t} ${before.old.get(t)} -> ${after.old.get(t)}`).join(", ")}). ` +
        "Something still writes to it: wait until two --check runs a minute apart show the same old counts, then start again.",
    );
  }
  if (bad.length || moved.length) {
    // The way back: the copied tables emptied again, in one transaction. Only
    // while the new Worker is still in maintenance, when nothing but this copy
    // has written there.
    const resetPath = join(dirname(dataPath), "reset-new.sql");
    writeFileSync(resetPath, resetFile(copy));
    log(`\n${bad.length ? `MISMATCH in ${bad.join(", ")}. ` : ""}The SQL that was imported is kept at ${dataPath} (it holds everyone's data; delete it when done).`);
    log("To start again, with the new Worker still in maintenance, empty what was copied, then run this again:");
    log(`   ${formatCommand(to, importArgs(to, resetPath))}`);
    return 1;
  }
  if (keepFile) log(`\nAll ${copy.length} tables match. The SQL is kept at ${dataPath} (it holds everyone's data; delete it when done).`);
  else {
    rmSync(dataPath, { force: true });
    log(`\nAll ${copy.length} tables match (${oldTotal} rows).`);
  }
  return 0;
}

/** PRAGMA table_info for each table, as few commands as fit. Map table -> [{ name, pk, notnull, dflt_value }]. */
function tableInfo(query, side, tables) {
  const results = queryMany(query, side, tables.map((t) => `PRAGMA table_info(${qid(t)})`));
  return new Map(
    tables.map((t, i) => [
      t,
      results[i].map((c) => ({ name: c.name, pk: Number(c.pk) || 0, notnull: Number(c.notnull) === 1, dflt_value: c.dflt_value ?? null })),
    ]),
  );
}

/** Row counts for the tables on one side. Map table -> number. */
function counts(query, side, tables) {
  const out = new Map();
  const statements = countStatements(tables);
  const results = queryMany(query, side, statements.map((s) => s.sql));
  statements.forEach((s, i) => {
    const row = results[i]?.[0] ?? {};
    s.tables.forEach((t, j) => out.set(t, Number(row[`n${j}`])));
  });
  return out;
}

function printCounts(log, tables, left, right, leftLabel, rightLabel) {
  const width = Math.max(...tables.map((t) => t.length), 5);
  log(`   ${"table".padEnd(width)}  ${leftLabel.padStart(8)}  ${rightLabel.padStart(8)}`);
  const bad = [];
  for (const t of tables) {
    const a = left.get(t);
    const b = right.get(t);
    const same = a === b;
    if (!same) bad.push(t);
    log(`   ${t.padEnd(width)}  ${String(a).padStart(8)}  ${String(b).padStart(8)}${same ? "" : "  <- differs"}`);
  }
  return bad;
}

/**
 * Every row of every table as column-listed INSERTs. First pages go several
 * tables to a command; a table that fills its page is then read page by page.
 */
function dumpTables({ query, side, copy, columns, oldTables, pageSize, log, expected }) {
  const sqlOf = new Map(oldTables.map((t) => [t.name, t.sql]));
  const spec = (table) => ({
    table,
    columns: columns.get(table).names,
    pk: columns.get(table).pk,
    withoutRowid: isWithoutRowid(sqlOf.get(table)),
    limit: pageSize,
  });
  const statements = [];
  const firstPages = queryMany(
    query,
    side,
    copy.map((t) => pageSql(spec(t))),
  );
  copy.forEach((table, i) => {
    const s = spec(table);
    let rows = firstPages[i];
    let got = 0;
    let pages = 1;
    for (;;) {
      statements.push(...insertsFromRows(table, s.columns, rows));
      got += rows.length;
      if (rows.length < pageSize) break;
      const last = rows[rows.length - 1];
      const sql = s.withoutRowid || last.r === undefined ? pageSql({ ...s, offset: got }) : pageSql({ ...s, after: last.r });
      [rows] = query(side, sql, { quiet: true });
      pages++;
    }
    if (got !== expected.get(table)) throw new Error(`${table}: read ${got} rows, but it has ${expected.get(table)}`);
    if (got) log(`   ${table}: ${got} rows${pages > 1 ? ` (${pages} pages)` : ""}`);
  });
  return statements;
}
