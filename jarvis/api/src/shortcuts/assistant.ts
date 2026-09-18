import { Hono } from "hono";
import { parkAction, type PendingAction } from "../google/assistant";
import type { CallTool, ToolSpec } from "../llm";
import type { Env } from "../types";
import { actionCount, describeAction, getAction, searchActions, shortActionId } from "./catalog";
import { COLORS, CompileError, compileShortcut, GLOBAL_NAMES, MAX_ACTIONS } from "./compile";
import { signingConfigured, signShortcut, SigningUnavailable } from "./sign";

/**
 * Lets the assistant write its own iPhone shortcuts: it looks up actions,
 * writes a program, and the Worker compiles and signs it. The user installs it
 * from an approval card, which opens the Shortcuts app's import screen.
 */

const DOWNLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SAVED = 50;

const str = (description: string) => ({ type: "string", description });

const toolSpecs: ToolSpec[] = [
  {
    name: "shortcut_actions_search",
    description: `Look up iPhone Shortcuts actions (${actionCount} built-in actions) and their exact parameters before writing a shortcut. Search by keywords, or pass exact action ids.`,
    parameters: {
      type: "object",
      properties: {
        query: str("Keywords, e.g. 'send message', 'weather', 'timer', 'get contents of url'"),
        ids: { type: "array", items: { type: "string" }, description: "Exact action ids to describe, e.g. ['gettext', 'notification']" },
      },
    },
  },
  {
    name: "shortcut_create",
    description:
      "Write a new iPhone shortcut. It's compiled and signed, then the app shows the user an Add Shortcut card. Returns errors to fix if the program is invalid.",
    parameters: {
      type: "object",
      properties: {
        name: str("Shortcut name, as the user will say it to Siri, e.g. 'Morning Briefing'"),
        color: str(`Icon color: ${Object.keys(COLORS).join(", ")}`),
        steps_json: str("The program: a JSON array of steps, in the format from the system prompt"),
      },
      required: ["name", "steps_json"],
    },
  },
  {
    name: "shortcut_list",
    description: "List the shortcuts you have written for this user (newest first).",
    parameters: { type: "object", properties: { query: str("Optional text to filter names by") } },
  },
  {
    name: "shortcut_get",
    description: "Get the program of a shortcut you wrote earlier, to change it or explain it.",
    parameters: { type: "object", properties: { id: str("id from shortcut_list") }, required: ["id"] },
  },
  {
    name: "shortcut_install",
    description: "Show the Add Shortcut card again for a shortcut you wrote earlier.",
    parameters: { type: "object", properties: { id: str("id from shortcut_list") }, required: ["id"] },
  },
];

const TOOL_NAMES = new Set(toolSpecs.map((t) => t.name));
export const isShortcutTool = (name: string) => TOOL_NAMES.has(name);

const PROGRAM_GUIDE = `
Writing shortcuts: first call shortcut_actions_search to get exact action ids and parameter names (never guess them), then call shortcut_create with steps_json, a JSON array of steps:
- {"action": "<id>", "params": {"<ParamName>": value}, "id": "<name>"}: "id" is optional and names the action's result.
- {"if": {"input": "{{x}}", "condition": "is", "value": "yes"}, "then": [...], "else": [...]}. Conditions: is, is not, contains, does not contain, begins with, ends with, >, >=, <, <=, is between (add "value2"), has any value, does not have any value.
- {"repeat": 3, "do": [...]} and {"repeat_each": "{{list}}", "do": [...]}. Inside loops use {{RepeatItem}} and {{RepeatIndex}}.
- {"menu": "Prompt", "options": [{"label": "A", "do": [...]}]}
- {"set": "varName", "to": value}, {"add_to": "varName", "value": value}, {"comment": "text"}
Values: text can include {{id}} (an earlier step's result), {{varName}}, {{id.key}} (a dictionary key), or ${GLOBAL_NAMES.map((g) => `{{${g}}}`).join(", ")}. Numbers and true/false are plain JSON. Dictionary params take a JSON object. Amounts (timer duration, health values) look like {"magnitude": 5, "unit": "min"}. Apps take a bundle id like "com.apple.mobilesafari". Message and email recipients must be written-out numbers or addresses. A step's "id" or a control block's "id" can be referenced later ({{id}} of an if/menu/repeat is its result).
Example: [{"action": "weather.currentconditions", "id": "weather"}, {"action": "speaktext", "params": {"WFText": "It's {{weather}} right now."}}]
Limits: up to ${MAX_ACTIONS} actions, built-in actions only. Never put passwords, API keys, or the user's OVOA keys in a shortcut. Shortcuts can't make themselves run on a schedule; the user sets that up in Shortcuts > Automation. After shortcut_create succeeds, tell the user to tap Approve, then Add Shortcut in the Shortcuts app; then they can run it by name or with "Hey Siri, <name>".`.trim();

function parseSteps(json: unknown) {
  if (typeof json !== "string") throw new CompileError("steps_json must be a JSON array in a string");
  if (json.length > 100_000) throw new CompileError("steps_json is too long");
  try {
    return JSON.parse(json) as unknown[];
  } catch (err) {
    throw new CompileError(`steps_json isn't valid JSON: ${(err as Error).message}`);
  }
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const fileName = (name: string) => `${name.replace(/[^\w .-]/g, "").trim() || "Shortcut"}.shortcut`;

type SavedShortcut = { id: string; name: string; summary: string; warnings: string };

/** Shortcut tools for one chat request. Installs are parked as phone actions for the app to open. */
export function shortcutAssistant(env: Env, userId: string, autoApprove: boolean) {
  const pending: PendingAction[] = [];
  const db = env.DB;

  if (!signingConfigured(env)) {
    return {
      tools: [] as ToolSpec[],
      pending,
      callTool: (async () => ({ error: "Shortcut building isn't set up" })) as CallTool,
      prompt:
        "You can't write new iPhone shortcuts yet: the server has no shortcut signing service set up (it needs a Mac or a RoutineHub HubSign membership). If asked, say so. You can still run the user's existing shortcuts by name with phone_shortcut_run.",
    };
  }

  /** Parks the Add Shortcut card with a fresh download link. */
  async function offerInstall(s: SavedShortcut) {
    const token = randomToken();
    await db
      .prepare("UPDATE shortcuts SET download_token = ?, download_expires_at = ? WHERE id = ? AND user_id = ?")
      .bind(token, Date.now() + DOWNLOAD_TTL_MS, s.id, userId)
      .run();
    const url = `${env.PUBLIC_URL}/shortcuts/file/${token}/${encodeURIComponent(fileName(s.name))}`;
    const warnings: string[] = JSON.parse(s.warnings);
    const summary = [
      `Add shortcut: ${s.name}`,
      s.summary,
      warnings.length ? `\nThis shortcut can ${warnings.join(", ")}.` : "",
    ]
      .filter(Boolean)
      .join("\n");
    pending.push(
      await parkAction(env, userId, "phone_shortcut_install", { shortcutId: s.id, name: s.name, url }, summary, autoApprove),
    );
    return {
      status: autoApprove ? "opening_shortcuts_app" : "waiting_for_user_approval",
      note: "The user still has to tap Add Shortcut in the Shortcuts app. It isn't installed yet.",
      steps: s.summary,
    };
  }

  const callTool: CallTool = async (name, args) => {
    switch (name) {
      case "shortcut_actions_search": {
        const ids = Array.isArray(args.ids) ? args.ids.map((i) => shortActionId(String(i))).slice(0, 20) : [];
        const exact = ids.flatMap((id): object[] => {
          const a = getAction(id);
          return a ? [describeAction(id, a)] : [{ action: id, error: "No such action" }];
        });
        const found = typeof args.query === "string" ? searchActions(args.query) : [];
        const results = [...exact, ...found.filter((f) => !ids.includes(f.action))];
        return results.length ? { results } : { results: [], note: "Nothing matched. Try other keywords." };
      }

      case "shortcut_create": {
        const shortcutName = String(args.name ?? "").trim();
        const color = typeof args.color === "string" && args.color ? args.color.toLowerCase() : undefined;
        let compiled;
        try {
          const steps = parseSteps(args.steps_json);
          compiled = compileShortcut({ name: shortcutName, color, steps });
        } catch (err) {
          if (err instanceof CompileError) return { error: `Fix the program and try again. ${err.message}` };
          throw err;
        }
        let file: ArrayBuffer;
        try {
          file = await signShortcut(env, shortcutName, compiled.xml);
        } catch (err) {
          if (err instanceof SigningUnavailable) return { error: `Couldn't sign the shortcut: ${err.message}` };
          throw err;
        }

        const saved: SavedShortcut = {
          id: crypto.randomUUID(),
          name: shortcutName,
          summary: compiled.summary,
          warnings: JSON.stringify(compiled.warnings),
        };
        await db.batch([
          db
            .prepare(
              "INSERT INTO shortcuts (id, user_id, name, color, steps, summary, warnings, file, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(saved.id, userId, saved.name, color ?? null, args.steps_json as string, saved.summary, saved.warnings, file, Date.now()),
          db
            .prepare(
              `DELETE FROM shortcuts WHERE user_id = ? AND id NOT IN (
                 SELECT id FROM shortcuts WHERE user_id = ? ORDER BY created_at DESC LIMIT ?
               )`,
            )
            .bind(userId, userId, MAX_SAVED),
        ]);
        return { id: saved.id, actions: compiled.actionCount, ...(await offerInstall(saved)) };
      }

      case "shortcut_list": {
        const query = typeof args.query === "string" ? args.query.trim() : "";
        const { results } = await db
          .prepare(
            "SELECT id, name, created_at FROM shortcuts WHERE user_id = ? AND instr(lower(name), lower(?)) > 0 ORDER BY created_at DESC LIMIT ?",
          )
          .bind(userId, query, MAX_SAVED)
          .all<{ id: string; name: string; created_at: number }>();
        return {
          shortcuts: results.map((r) => ({ id: r.id, name: r.name, created: new Date(r.created_at).toISOString() })),
        };
      }

      case "shortcut_get": {
        const row = await db
          .prepare("SELECT id, name, color, steps, summary FROM shortcuts WHERE id = ? AND user_id = ?")
          .bind(String(args.id ?? ""), userId)
          .first<{ id: string; name: string; color: string | null; steps: string; summary: string }>();
        return row ? { ...row, steps_json: row.steps, steps: undefined } : { error: "No shortcut with that id" };
      }

      case "shortcut_install": {
        const row = await db
          .prepare("SELECT id, name, summary, warnings FROM shortcuts WHERE id = ? AND user_id = ?")
          .bind(String(args.id ?? ""), userId)
          .first<SavedShortcut>();
        return row ? offerInstall(row) : { error: "No shortcut with that id" };
      }
    }
    return { error: `Unknown tool ${name}` };
  };

  return {
    tools: toolSpecs,
    pending,
    callTool,
    prompt: `You can write new iPhone shortcuts for the user with the shortcut_ tools, and run existing ones by name with phone_shortcut_run. Offer to build a shortcut when the user wants something automated on their iPhone.\n${PROGRAM_GUIDE}`,
  };
}

// ---------- Download (public: the Shortcuts app fetches it without our login) ----------

export const shortcutFiles = new Hono<{ Bindings: Env }>();

shortcutFiles.get("/shortcuts/file/:token/:filename", async (c) => {
  const row = await c.env.DB
    .prepare("SELECT name, file FROM shortcuts WHERE download_token = ? AND download_expires_at > ?")
    .bind(c.req.param("token"), Date.now())
    .first<{ name: string; file: ArrayBuffer | number[] }>();
  if (!row) return c.text("This link expired. Ask the assistant for the shortcut again.", 404);
  // D1 has returned BLOBs both as ArrayBuffers and as arrays of bytes.
  return new Response(new Uint8Array(row.file), {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${fileName(row.name)}"`,
      "cache-control": "no-store",
    },
  });
});
