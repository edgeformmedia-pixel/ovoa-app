// What a refusal for good does to the cooldowns, on an isolate where nothing
// has failed yet (llm.test.ts leaves engines cooling, so this can't follow it).
//
// A scripted run of llm.ts (2026-09-23): Workers AI stumbled once and rested
// 15 s, a typed call then found GLM failing (15 s) and Gemini refusing its key
// (403). Gemini, the last engine left, was rested only the 3 s a last engine
// gets, came back first, and engineOrder's "the one back soonest" sent every
// call on the isolate to it, and to its 403, for the next 12 s.

import { chatWithTools, engineStatus, generateText, isAiUnreachable, type EngineAttempt, type LlmEnv } from "../src/llm";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${got}${ok ? "" : `  (wanted ${want})`}`);
}

const encoder = new TextEncoder();
const sse = (chunks: unknown[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      c.enqueue(encoder.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
/** An answer as each host gives it: streamed as server-sent events when asked to stream, else whole. */
const reply = (text: string, stream: boolean) => (stream ? sse([{ choices: [{ delta: { content: text } }] }]) : { choices: [{ message: { content: text } }] });

// Workers AI's binding: out of capacity until it is told otherwise.
let workersUp = false;
const ai = {
  run: async (_model: string, inputs: { stream?: boolean }) => {
    if (!workersUp) throw new Error("3040: Capacity temporarily exceeded, please try again.");
    return reply("Workers AI here.", !!inputs.stream);
  },
} as unknown as Ai;

// Z.ai answers until it is told to fail; Gemini always refuses its key.
let glmUp = true;
const asked = { glm: 0, gemini: 0 };
globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
  if (String(url).includes("googleapis")) {
    asked.gemini++;
    return new Response('{"error":{"code":403,"status":"PERMISSION_DENIED"}}', { status: 403 });
  }
  asked.glm++;
  if (!glmUp) return new Response("upstream went away", { status: 500 });
  const out = reply("GLM here.", !!JSON.parse(String(init?.body)).stream);
  return new Response(out instanceof ReadableStream ? out : JSON.stringify(out), { status: 200 });
}) as typeof fetch;

const env: LlmEnv = { AI: ai, GLM_API_KEY: "k", GEMINI_API_KEY: "g" };
const usage = { userId: "u1", purpose: "test" };
const typed = async (attempts: EngineAttempt[]) => {
  try {
    return await generateText(env, { model: "gemini-3.5-flash-lite", system: "s", turns: [{ role: "user", text: "hi" }], usage, onAttempt: (a) => attempts.push(a) });
  } catch (err) {
    return err;
  }
};

// 1. A spoken turn: Workers AI is out of capacity, GLM answers. Workers AI rests 15 s.
const spoken = await chatWithTools(env, {
  model: "gemini-3.5-flash-lite",
  system: "s",
  turns: [{ role: "user", text: "When's my alarm?" }],
  tools: [],
  callTool: async () => ({}),
  usage,
  voice: true,
  onText: () => {},
});
eq("Workers AI out of capacity: GLM answers the spoken turn", spoken.kind === "reply" && spoken.engine, "glm");

// 2. A typed call: GLM fails (a 5xx, 15 s), then Gemini, the last engine, refuses its key.
glmUp = false;
const second: EngineAttempt[] = [];
eq("GLM failing and Gemini refused: the AI is out of reach", isAiUnreachable(await typed(second)), true);
eq("Workers AI resting, both others tried", second.map((a) => `${a.engine}:${a.outcome}`).join(","), "workers:skipped,glm:upstream_5xx,gemini:bad_key");
const gemini = engineStatus(env).engines.find((e) => e.engine === "gemini");
eq("Gemini's 403 keeps its full 10 min, though it was the last engine", (gemini?.coolingForS ?? 0) >= 590, true);
const next = engineStatus(env).typedOrder;
eq("so the one back soonest is an engine that only stumbled", next.length === 1 && next[0] !== "gemini", true);

// 3. The next call goes to that engine, and it answers.
glmUp = true;
workersUp = true;
const third: EngineAttempt[] = [];
const answer = await typed(third);
eq("the next call is answered", typeof answer === "string" && /here\./.test(answer), true);
eq("and Gemini isn't asked again", asked.gemini, 1);

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
