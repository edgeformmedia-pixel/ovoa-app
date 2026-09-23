// The model-call gate (llm.ts setModelGate, plans.ts modelGate): nothing is
// sent to a model before the gate has said yes, and nothing reaches a model
// without going through it.
//
// Two halves. The first reads the source: no file under src/ outside the engine
// module (llm.ts and gemini.ts, which holds the low-level Gemini calls and the
// search grounding) may name a model host, import gemini.ts, or import a model
// SDK, and llm.ts must not export its low-level senders. The second runs the
// three doors into a model (generateText, chatWithTools with and without a
// resume, searchGrounded) against a gate that says no, with fetch watched, and
// checks nothing was sent. The rules themselves are tested in plans.test.ts.
//
// Run by `npm test` from jarvis/api, so src/ is found from the working
// directory (scripts/test.mjs bundles this file elsewhere first).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  chatWithTools,
  generateText,
  isAiUnreachable,
  isModelRefused,
  searchGrounded,
  setModelGate,
  type GateCall,
  type LlmEnv,
} from "../src/llm";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const g = typeof got === "object" ? JSON.stringify(got) : got;
  const w = typeof want === "object" ? JSON.stringify(want) : want;
  const ok = g === w;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${g}${ok ? "" : `  (wanted ${w})`}`);
}

// ---------- The source ----------

const SRC = join(process.cwd(), "src");
if (!existsSync(join(SRC, "llm.ts"))) {
  console.error(`FAIL can't find src/llm.ts under ${process.cwd()}: run this with npm test from jarvis/api`);
  process.exit(1);
}

/** Every .ts file under src/, as a path relative to src/ with forward slashes. */
function sources(dir = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return name.endsWith(".ts") ? [relative(SRC, full).split(sep).join("/")] : [];
  });
}

/** The engine module: the only files allowed to talk to a model. */
const ENGINE = new Set(["llm.ts", "gemini.ts"]);

const MODEL_HOSTS = ["api.z.ai", "open.bigmodel.cn", "generativelanguage.googleapis.com", "api.deepseek.com", "api.anthropic.com"];
const MODEL_SDKS = ["@anthropic-ai/sdk", "openai", "@google/genai", "@google/generative-ai"];

const files = sources();
eq("found the source", files.length > 20 && files.includes("llm.ts") && files.includes("plans.ts"), true);

const outside: string[] = [];
for (const file of files) {
  if (ENGINE.has(file)) continue;
  const text = readFileSync(join(SRC, file), "utf8");
  for (const host of MODEL_HOSTS) if (text.includes(host)) outside.push(`${file} names ${host}`);
  // gemini.ts is the low-level Gemini caller: only llm.ts may import it (Turn is re-exported there).
  if (/from\s+["'](\.\.?\/)+gemini["']/.test(text)) outside.push(`${file} imports gemini.ts`);
  for (const sdk of MODEL_SDKS) if (new RegExp(`from\\s+["']${sdk.replace(/[/.]/g, "\\$&")}["']`).test(text)) outside.push(`${file} imports ${sdk}`);
  // Workers AI went in the v1 release; a call to it would be a model the gate never saw.
  if (/\bAI\.run\(/.test(text)) outside.push(`${file} calls Workers AI (env.AI.run)`);
}
eq("no model is reached from outside the engine module", outside, []);

// llm.ts keeps its senders to itself: only the three doors, which ask the gate, are exported.
const llm = readFileSync(join(SRC, "llm.ts"), "utf8");
const LOW_LEVEL = ["geminiRound", "geminiToolLoop", "openAiCall", "openAiRound", "openAiGenerate", "openAiToolLoop", "fetchWithDeadline", "sseData"];
eq(
  "llm.ts exports none of its low-level senders",
  LOW_LEVEL.filter((name) => new RegExp(`export\\s+(async\\s+)?function\\*?\\s+${name}\\b`).test(llm)),
  [],
);
// And each door asks the gate before it does any of the things that lead to a send.
const DOORS: Record<string, string[]> = {
  generateText: ["applyDeadlines(", "engines(", "geminiGenerate(", "openAiGenerate("],
  chatWithTools: ["applyDeadlines(", "if (opts.resume)", "engines(", "geminiToolLoop(", "openAiToolLoop("],
  searchGrounded: ["geminiGrounded("],
};
for (const [door, later] of Object.entries(DOORS)) {
  const start = llm.indexOf(`export async function ${door}(`);
  const end = llm.indexOf("\nexport ", start + 1);
  const body = llm.slice(start, end < 0 ? undefined : end);
  const gate = body.indexOf("await askGate(");
  const early = later.filter((step) => body.includes(step) && body.indexOf(step) < gate);
  eq(`${door} asks the gate first`, start >= 0 && gate > 0 && !early.length ? "first" : `after ${early.join(", ") || "nothing: no gate"}`, "first");
}
const gemini = readFileSync(join(SRC, "gemini.ts"), "utf8");
eq("the grounding call lives in gemini.ts", /export async function grounded\(/.test(gemini), true);
eq("and web.ts no longer calls Gemini itself", readFileSync(join(SRC, "web.ts"), "utf8").includes("generativelanguage"), false);

// ---------- Nothing is sent before the gate says yes ----------

const sent: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  sent.push(String(input instanceof Request ? input.url : input));
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: "Sunny." }] }, groundingMetadata: { groundingChunks: [{ web: { uri: "https://example.com", title: "Example" } }] } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}) as typeof fetch;

const keyed: LlmEnv = { GEMINI_API_KEY: "test-key", GLM_API_KEY: "test-key", CHAT_MODEL: "gemini-3.5-flash-lite" };
const asked: GateCall[] = [];
setModelGate(async (_env, call) => {
  asked.push(call);
  return "needs_plan";
});

const usage = { userId: "u1", purpose: "chat" };
async function refused(label: string, run: () => Promise<unknown>) {
  const before = sent.length;
  let err: unknown = null;
  try {
    await run();
  } catch (e) {
    err = e;
  }
  eq(`${label}: refused`, isModelRefused(err) ? (err as { reason: string }).reason : String(err), "needs_plan");
  eq(`${label}: nothing sent`, sent.length - before, 0);
}

await refused("generateText", () => generateText(keyed, { model: "gemini-3.5-flash-lite", system: "s", turns: [{ role: "user", text: "hi" }], usage }));
await refused("chatWithTools", () =>
  chatWithTools(keyed, { model: "gemini-3.5-flash-lite", system: "s", turns: [{ role: "user", text: "hi" }], tools: [], callTool: async () => null, usage }),
);
await refused("a resumed turn", () =>
  chatWithTools(keyed, {
    model: "gemini-3.5-flash-lite",
    system: "s",
    turns: [],
    tools: [],
    callTool: async () => null,
    usage,
    resume: { state: { engine: "glm", round: 1, messages: [{ role: "user", content: "hi" }], slots: [] }, results: {} },
  }),
);
await refused("web search grounding", () => searchGrounded(keyed, { query: "weather", today: "Wednesday", usage: { userId: "u1", purpose: "search" } }));

eq("the gate was asked each time, about the person", asked.map((a) => a.userId).join(","), "u1,u1,u1,u1");
eq("and what for", asked.map((a) => a.purpose).join(","), "chat,chat,chat,search");
eq("a resumed turn says it's continuing", asked.map((a) => !!a.continuing).join(","), "false,false,true,false");

// With the gate saying yes, the same doors go through.
setModelGate(async () => null);
const grounded = await searchGrounded(keyed, { query: "weather", today: "Wednesday", usage: { userId: "u1", purpose: "search" } });
eq("allowed: the search is sent", sent.length, 1);
eq("to Gemini", sent[0].startsWith("https://generativelanguage.googleapis.com/"), true);
eq("and answers with its sources", `${grounded.answer} ${grounded.sources.length}`, "Sunny. 1");
let unreachable: unknown = null;
await generateText({}, { model: "m", system: "s", turns: [{ role: "user", text: "hi" }], usage }).catch((e) => (unreachable = e));
eq("allowed with no keys: past the gate, to 'can't reach the AI'", isAiUnreachable(unreachable), true);

setModelGate(null);
globalThis.fetch = realFetch;

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
