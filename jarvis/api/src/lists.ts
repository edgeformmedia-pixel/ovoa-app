// Saved lists: named rows OVOA keeps for someone between steps and across days.
//
// A request like "find every dentist near me that takes new patients" is a list
// built over several steps (search, read pages, check each), and the next ask
// ("text me the top three", "which ones did we call") needs it again. The model
// can't hold that in one turn; this holds it. Plain objects only, capped so one
// list can't grow without end, and read back in pages under the 6,000-character
// tool-result cap (llm.ts).

import type { CallTool, ToolSpec } from "./llm";
import type { Env } from "./types";

export const MAX_LIST_ROWS = 5_000;
export const MAX_LIST_BYTES = 1_000_000;
export const MAX_LISTS = 100;
const READ_CHARS = 5_000;

type Row = Record<string, unknown>;

const TOOLS: ToolSpec[] = [
  {
    name: "list_save",
    description:
      "Saves rows (plain objects, e.g. {name, phone, notes}) to one of their named lists, to keep for later steps or later days. mode 'replace' (default) overwrites the list, 'append' adds to it.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short name for the list, e.g. 'austin dentists'." },
        rows: { type: "array", items: { type: "object" }, description: "The rows." },
        mode: { type: "string", enum: ["replace", "append"] },
      },
      required: ["name", "rows"],
    },
  },
  {
    name: "list_read",
    description:
      "Reads one of their saved lists by name (in parts: pass offset=nextOffset for more), or with no name, the names of all their lists.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        offset: { type: "number", description: "Row to start from." },
      },
    },
  },
  {
    name: "list_delete",
    description: "Deletes one of their saved lists by name.",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
];

const NAMES = new Set(TOOLS.map((t) => t.name));
export const isListTool = (name: string) => NAMES.has(name);

const cleanName = (value: unknown) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

function plainRows(value: unknown): Row[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((r): r is Row => !!r && typeof r === "object" && !Array.isArray(r));
}

function parseRows(text: string): Row[] {
  try {
    return plainRows(JSON.parse(text)) ?? [];
  } catch {
    return [];
  }
}

/** Saves a list. Returns the row count, or an error the model can say. */
export async function saveList(
  db: D1Database,
  userId: string,
  name: string,
  rows: Row[],
  mode: "replace" | "append",
  now = Date.now(),
): Promise<{ name: string; rows: number } | { error: string }> {
  const existing = await db
    .prepare("SELECT rows FROM user_lists WHERE user_id = ? AND name = ?")
    .bind(userId, name)
    .first<{ rows: string }>();
  if (!existing) {
    const count = await db.prepare("SELECT COUNT(*) AS n FROM user_lists WHERE user_id = ?").bind(userId).first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_LISTS) return { error: `They already have ${MAX_LISTS} lists. Delete one first.` };
  }
  const all = mode === "append" && existing ? [...parseRows(existing.rows), ...rows] : rows;
  if (all.length > MAX_LIST_ROWS) return { error: `A list holds up to ${MAX_LIST_ROWS} rows; that would be ${all.length}.` };
  const json = JSON.stringify(all);
  if (json.length > MAX_LIST_BYTES) return { error: "That list is too big to keep. Save fewer or shorter rows." };
  await db
    .prepare(
      "INSERT INTO user_lists (user_id, name, rows, row_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, name) DO UPDATE SET rows = excluded.rows, row_count = excluded.row_count, updated_at = excluded.updated_at",
    )
    .bind(userId, name, json, all.length, now, now)
    .run();
  return { name, rows: all.length };
}

export async function readList(db: D1Database, userId: string, name: string) {
  const row = await db
    .prepare("SELECT name, rows FROM user_lists WHERE user_id = ? AND name = ?")
    .bind(userId, name)
    .first<{ name: string; rows: string }>();
  return row ? { name: row.name, rows: parseRows(row.rows) } : null;
}

export function listsAssistant(env: Env, userId: string) {
  const db = env.DB;

  const callTool: CallTool = async (name, args) => {
    if (name === "list_save") {
      const listName = cleanName(args.name);
      const rows = plainRows(args.rows);
      if (!listName) return { error: "name is required" };
      if (!rows) return { error: "rows must be a list of objects" };
      return saveList(db, userId, listName, rows, args.mode === "append" ? "append" : "replace");
    }
    if (name === "list_read") {
      const listName = cleanName(args.name);
      if (!listName) {
        const { results } = await db
          .prepare("SELECT name, row_count FROM user_lists WHERE user_id = ? ORDER BY updated_at DESC")
          .bind(userId)
          .all<{ name: string; row_count: number }>();
        return { lists: results.map((r) => ({ name: r.name, rows: r.row_count })) };
      }
      const list = await readList(db, userId, listName);
      if (!list) return { error: `They have no list called "${listName}".` };
      const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
      const out: Row[] = [];
      let size = 0;
      for (let i = offset; i < list.rows.length; i++) {
        const piece = JSON.stringify(list.rows[i]).length + 1;
        if (out.length && size + piece > READ_CHARS) break;
        out.push(list.rows[i]!);
        size += piece;
      }
      const next = offset + out.length;
      return { name: list.name, total: list.rows.length, offset, nextOffset: next < list.rows.length ? next : null, rows: out };
    }
    if (name === "list_delete") {
      const listName = cleanName(args.name);
      const done = await db.prepare("DELETE FROM user_lists WHERE user_id = ? AND name = ?").bind(userId, listName).run();
      return done.meta.changes ? { deleted: listName } : { error: `They have no list called "${listName}".` };
    }
    return { error: `Unknown tool ${name}` };
  };

  return {
    tools: TOOLS,
    callTool,
    prompt:
      "Saved lists: when you build up a set of things over several steps (places, people, options, results), keep it with list_save so the next step or the next day can use it (list_read). Say the list's name once so they can ask for it.",
  };
}
