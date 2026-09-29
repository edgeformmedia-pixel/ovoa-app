import type { CallTool, ToolSpec } from "./llm";
import type { Env } from "./types";

// "Here's what I know about you" (2026-09-29): the memories that ride on every
// turn, shown and edited by the person, from a text as much as from the app's
// Settings. The memory pass (index.ts updateMemories) still learns on its own;
// these are for when they want to see the list, fix a line or drop one. An
// edited or added line is kept as 'asked', so the 14-day purge of learned
// memories (retention.ts) leaves it alone.

const TOOLS: ToolSpec[] = [
  {
    name: "memory_list",
    description:
      "Everything you remember about them, numbered. Use when they ask what you know about them, what you remember, or to see or fix it. Show it as a short numbered list and say they can text a number to fix or forget it.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "memory_forget",
    description: "Forgets memories by their number from memory_list (or all of them when they clearly say everything).",
    parameters: {
      type: "object",
      properties: {
        numbers: { type: "array", items: { type: "integer" }, description: "Numbers from memory_list" },
        everything: { type: "boolean", description: "Only when they plainly asked to forget everything" },
      },
    },
  },
  {
    name: "memory_edit",
    description: "Rewrites one memory (by its number from memory_list), or adds a new one when no number is given. One short third-person sentence.",
    parameters: {
      type: "object",
      properties: {
        number: { type: "integer" },
        text: { type: "string", description: "The memory, like 'Thomas's girlfriend is Maria.'" },
      },
      required: ["text"],
    },
  },
];

const NAMES = new Set(TOOLS.map((t) => t.name));
export const isMemoryTool = (name: string) => NAMES.has(name);

/** Their memories, oldest first, as memory_list numbers them. */
async function numbered(db: D1Database, userId: string) {
  const { results } = await db
    .prepare("SELECT id, content FROM memories WHERE user_id = ? ORDER BY created_at ASC LIMIT 200")
    .bind(userId)
    .all<{ id: string; content: string }>();
  return results;
}

export function memoryAssistant(env: Env, userId: string) {
  const db = env.DB;
  const callTool: CallTool = async (name, args) => {
    const list = await numbered(db, userId);
    if (name === "memory_list") {
      if (!list.length) return { memories: 0, note: "You don't remember anything about them yet. Say so, and that they can tell you things to remember." };
      return { memories: list.map((m, i) => `${i + 1}. ${m.content}`) };
    }
    if (name === "memory_forget") {
      if (args.everything === true) {
        await db.prepare("DELETE FROM memories WHERE user_id = ?").bind(userId).run();
        return { forgot: list.length };
      }
      const nums = (Array.isArray(args.numbers) ? args.numbers : []).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= list.length);
      if (!nums.length) return { error: `numbers: from memory_list, 1 to ${list.length}. Call memory_list first if you don't have them.` };
      const ids = [...new Set(nums)].map((n) => list[n - 1].id);
      await db.batch(ids.map((id) => db.prepare("DELETE FROM memories WHERE id = ? AND user_id = ?").bind(id, userId)));
      return { forgot: nums.map((n) => list[n - 1].content) };
    }
    if (name === "memory_edit") {
      const text = String(args.text ?? "").trim().slice(0, 200);
      if (!text) return { error: "text is needed" };
      const n = Number(args.number);
      if (args.number != null && Number.isInteger(n)) {
        if (n < 1 || n > list.length) return { error: `number: 1 to ${list.length}` };
        await db.prepare("UPDATE memories SET content = ?, source = 'asked' WHERE id = ? AND user_id = ?").bind(text, list[n - 1].id, userId).run();
        return { changed: { from: list[n - 1].content, to: text } };
      }
      await db
        .prepare("INSERT INTO memories (id, user_id, content, source, created_at) VALUES (?, ?, ?, 'asked', ?)")
        .bind(crypto.randomUUID(), userId, text, Date.now())
        .run();
      return { added: text };
    }
    return { error: `Unknown tool ${name}` };
  };
  return {
    tools: TOOLS,
    callTool,
    prompt:
      "They can see and edit what you remember about them: memory_list shows it numbered, memory_forget and memory_edit change it. When they ask what you know about them, show it rather than summarizing.",
  };
}
