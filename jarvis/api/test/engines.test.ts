// Which engine answers, in what order, and how each is told how much to think.
// Pure functions, so the whole switchboard is checked without a key, a
// failure or a deploy. A wrong order here is a slow turn or a bill; a wrong
// thinking field is a 400 from a provider in production.

import { quickThinking } from "../src/gemini";
import {
  abandonSilentEngine,
  AI_UNREACHABLE,
  AiUnreachable,
  chatCompletionsUrl,
  chatWithTools,
  cleanOrder,
  engineOrder,
  generateText,
  hostFlavor,
  isAiUnreachable,
  isEngine,
  OPENAI_PROVIDERS,
  thinkingFields,
  thinkingLevelFor,
  usableOrder,
  usableVoice,
  type Engine,
  type EngineAttempt,
  type OrderInput,
} from "../src/llm";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${got}${ok ? "" : `  (wanted ${want})`}`);
}

const now = 1_758_412_800_000;
const all: Record<Engine, boolean> = { glm: true, gemini: true, workers: true };
const order = (over: Partial<OrderInput>) => engineOrder({ available: all, cooling: {}, now, voice: false, ...over }).join(",");

// ---------- Typed and background calls ----------

eq("nothing set: GLM, then Gemini, then Workers AI", order({}), "glm,gemini,workers");
eq("an order puts its engine first", order({ order: "gemini" }), "gemini,glm,workers");
eq("the ones it leaves out follow, so there is always a fallback", order({ order: "gemini,glm" }), "gemini,glm,workers");
eq("unknown names in the order are skipped", order({ order: "claude, gemini" }), "gemini,glm,workers");
eq("spaces and case don't matter", order({ order: " Gemini , GLM " }), "gemini,glm,workers");
eq("a name twice counts once", order({ order: "gemini,gemini" }), "gemini,glm,workers");
eq("an order of only rubbish is the usual order", order({ order: "claude,gpt" }), "glm,gemini,workers");
eq("Workers AI can be put first for everything", order({ order: "workers" }), "workers,glm,gemini");

// ---------- Keys ----------

eq("no GLM key: GLM does not exist", order({ available: { ...all, glm: false } }), "gemini,workers");
eq("no GLM key and it was first: silently the next one", order({ available: { ...all, glm: false }, order: "glm" }), "gemini,workers");
eq("no Gemini key: GLM, then Workers AI", order({ available: { ...all, gemini: false } }), "glm,workers");
eq("no AI binding: Workers AI does not exist", order({ available: { ...all, workers: false } }), "glm,gemini");
eq("no keys at all: nothing to try", order({ available: { glm: false, gemini: false, workers: false } }), "");

// ---------- Cooldowns ----------

eq("a cooling engine waits its turn out", order({ cooling: { glm: now + 60_000 } }), "gemini,workers");
eq("Gemini refusing (403) leaves GLM, then Workers AI", order({ cooling: { gemini: now + 600_000 } }), "glm,workers");
eq("a cooldown that has passed is over", order({ cooling: { glm: now - 1 } }), "glm,gemini,workers");
eq(
  "everything cooling: the one back soonest is tried anyway, never nothing",
  order({ cooling: { glm: now + 5_000, gemini: now + 600_000, workers: now + 3_000 } }),
  "workers",
);
eq(
  "the soonest among the ones that exist",
  order({ available: { ...all, workers: false }, cooling: { glm: now + 3_000, gemini: now + 600_000, workers: now + 1 } }),
  "glm",
);
eq("a lone engine cooling down is still tried", order({ available: { glm: true, gemini: false, workers: false }, cooling: { glm: now + 60_000 } }), "glm");

// ---------- Spoken turns ----------

// engineOrder is handed the spoken engine; llm.ts engines() makes it Workers AI
// when neither the VOICE_ENGINE var nor server_settings.voice_engine says otherwise.
eq("spoken on Workers AI: it first, then the typed order", order({ voice: true, voicePrimary: "workers" }), "workers,glm,gemini");
eq("spoken with voice_engine keyed: the typed order", order({ voice: true, voicePrimary: "keyed" }), "glm,gemini,workers");
eq("spoken with nothing named: the typed order", order({ voice: true }), "glm,gemini,workers");
eq("spoken with voice_engine naming another engine", order({ voice: true, voicePrimary: "gemini" }), "gemini,glm,workers");
eq("spoken on Workers AI, after a typed order", order({ voice: true, voicePrimary: "workers", order: "gemini" }), "workers,gemini,glm");
eq("spoken on Workers AI without the binding: the typed order", order({ voice: true, voicePrimary: "workers", available: { ...all, workers: false } }), "glm,gemini");
eq("spoken on Workers AI while it cools: GLM answers", order({ voice: true, voicePrimary: "workers", cooling: { workers: now + 1 } }), "glm,gemini");
eq("voice_engine is for spoken turns only", order({ voicePrimary: "workers" }), "glm,gemini,workers");
eq("spoken with an unknown voice_engine: the typed order", order({ voice: true, voicePrimary: "deepseek" }), "glm,gemini,workers");

// ---------- A spoken turn's first word ----------

// Workers AI, first on a spoken turn, gets VOICE_FIRST_CONTENT_MS to write a
// word or start a tool call; after that the turn moves to the next engine.
const ready = { cooling: false, refused: false };
const silent = { voice: true, engine: "workers" as Engine, index: 0, later: [ready, ready], heard: false, elapsedMs: 6_000, limitMs: 6_000 };
eq("spoken, Workers AI first, silent at the limit: move on", abandonSilentEngine(silent), true);
eq("not before the limit", abandonSilentEngine({ ...silent, elapsedMs: 5_999 }), false);
eq("not once it has written a word or started a tool call", abandonSilentEngine({ ...silent, heard: true }), false);
eq("not on a typed turn", abandonSilentEngine({ ...silent, voice: false }), false);
eq("not when it is the only engine: nothing to move to", abandonSilentEngine({ ...silent, later: [] }), false);
eq("not for the engine it moved to", abandonSilentEngine({ ...silent, index: 1 }), false);
// The limit is Workers AI's: Z.ai's ordinary first word (4.5-6.6 s) sits right at it.
eq("not GLM on Z.ai first (Workers AI cooling, or voice_engine glm)", abandonSilentEngine({ ...silent, engine: "glm" }), false);
eq("nor Gemini first", abandonSilentEngine({ ...silent, engine: "gemini" }), false);
// Moving on is only worth it when an engine after it can take the turn.
eq("not when every engine after it last refused for good (Gemini's 403)", abandonSilentEngine({ ...silent, later: [{ cooling: false, refused: true }] }), false);
eq("not when every engine after it has cooled down since", abandonSilentEngine({ ...silent, later: [{ cooling: true, refused: false }, { cooling: false, refused: true }] }), false);
eq("one that can take it is enough", abandonSilentEngine({ ...silent, later: [{ cooling: false, refused: true }, ready] }), true);

// ---------- Names ----------

eq("glm is an engine", isEngine("glm"), true);
eq("gemini is an engine", isEngine("gemini"), true);
eq("Workers AI is again", isEngine("workers"), true);
eq("DeepSeek is not", isEngine("deepseek"), false);
eq("nor Claude", isEngine("claude"), false);
eq("GLM is an OpenAI-compatible provider", OPENAI_PROVIDERS.glm.keyVar, "GLM_API_KEY");
eq("Workers AI is reached through its binding", `${OPENAI_PROVIDERS.workers.binding} ${OPENAI_PROVIDERS.workers.keyVar}`, "true AI");
eq("running GLM 5.3 Flash", OPENAI_PROVIDERS.workers.defaultModel, "@cf/zai-org/glm-5.3-flash");

// ---------- Stored settings ----------

// Writes: an order keeps its known engines.
eq("an order naming Workers AI keeps it", cleanOrder("glm,gemini,workers"), "glm,gemini,workers");
eq("DeepSeek is dropped", cleanOrder("deepseek,gemini,workers"), "gemini,workers");
eq("an order of nothing known is empty (refused)", cleanOrder("claude,deepseek"), "");
eq("case and spaces are tidied", cleanOrder(" Gemini ,GLM"), "gemini,glm");
// Reads: a copied row that names DeepSeek was written for the engines before v1.
eq("a copied order naming DeepSeek is ignored whole", usableOrder("deepseek,gemini,glm,workers"), undefined);
eq("one naming Workers AI is read", usableOrder("glm,workers"), "glm,workers");
eq("a current order is kept", usableOrder("gemini,glm"), "gemini,glm");
eq("nothing is nothing", usableOrder(""), undefined);
eq("a voice_engine of workers is kept", usableVoice("workers"), "workers");
eq("keyed is kept", usableVoice("keyed"), "keyed");
eq("an engine is kept", usableVoice(" GLM "), "glm");
eq("DeepSeek is not", usableVoice("deepseek"), undefined);

// ---------- Where a provider lives ----------

eq("Z.ai's url", hostFlavor("https://api.z.ai/api/paas/v4"), "zai");
eq("the default GLM host is Z.ai", hostFlavor(OPENAI_PROVIDERS.glm.defaultBaseUrl!), "zai");
eq("OpenRouter", hostFlavor("https://openrouter.ai/api/v1"), "openrouter");
eq("anything else is plain OpenAI-style", hostFlavor("https://api.deepinfra.com/v1/openai"), "openai");
eq("the default endpoint", chatCompletionsUrl(OPENAI_PROVIDERS.glm.defaultBaseUrl!), "https://api.z.ai/api/paas/v4/chat/completions");
eq("a base with a trailing slash", chatCompletionsUrl("https://openrouter.ai/api/v1/"), "https://openrouter.ai/api/v1/chat/completions");
eq("a base that already has the path", chatCompletionsUrl("https://x.example/v1/chat/completions"), "https://x.example/v1/chat/completions");

// ---------- How much to think ----------

const env = { GLM_THINKING: undefined };
eq("spoken asks for no thinking", thinkingLevelFor(env, "glm", true), "off");
eq("typed GLM thinks a little by default", thinkingLevelFor(env, "glm", false), "low");
eq("the var can turn it up", thinkingLevelFor({ GLM_THINKING: "on" }, "glm", false), "on");
eq("the var can turn it off", thinkingLevelFor({ GLM_THINKING: "off" }, "glm", false), "off");
eq("a garbage var keeps the default", thinkingLevelFor({ GLM_THINKING: "lots" }, "glm", false), "low");
eq("GLM's var is GLM's alone", thinkingLevelFor({ GLM_THINKING: "on" }, "workers", false), "low");
eq("spoken on Workers AI asks for none too", thinkingLevelFor(env, "workers", true), "off");

const fields = (model: string, level: "off" | "low" | "on", flavor: "zai" | "openrouter" | "openai" | "workers" | "none") =>
  JSON.stringify(thinkingFields(model, level, flavor));

// Z.ai: 5.3 cannot be switched off, so off means low.
eq("Z.ai GLM 5.3 off is really low", fields("glm-5.3-flash", "off", "zai"), '{"thinking":{"type":"enabled"},"reasoning_effort":"low"}');
eq("Z.ai GLM 5.3 on is high, not its max default", fields("glm-5.3-flash", "on", "zai"), '{"thinking":{"type":"enabled"},"reasoning_effort":"high"}');
eq("Z.ai GLM 5.2 can be switched off", fields("glm-5.2", "off", "zai"), '{"thinking":{"type":"disabled"}}');
eq("Z.ai GLM 4.7 has only the switch", fields("glm-4.7-flash", "low", "zai"), '{"thinking":{"type":"enabled"}}');
// Workers AI: "low" is the one field that stops GLM reasoning (probe, 2026-09-23),
// and chat_template_kwargs, which moves the reasoning into the reply, is never sent.
for (const level of ["off", "low", "on"] as const) {
  const sent = fields("@cf/zai-org/glm-5.3-flash", level, "workers");
  eq(`Workers AI GLM ${level} is reasoning_effort low`, sent, '{"reasoning_effort":"low"}');
  eq(`Workers AI GLM ${level} never sends chat_template_kwargs`, sent.includes("chat_template_kwargs"), false);
  eq(`Workers AI GLM ${level} never sends Z.ai's thinking switch`, sent.includes('"thinking"'), false);
}
eq("another model on Workers AI gets the plain field", fields("@cf/openai/gpt-oss-120b", "on", "workers"), '{"reasoning_effort":"high"}');
// OpenRouter: a reasoning object, kept out of the reply.
eq("OpenRouter GLM 5.3 off is low and hidden", fields("z-ai/glm-5.3-flash", "off", "openrouter"), '{"reasoning":{"effort":"low","exclude":true}}');
eq("OpenRouter GLM 4.7 can be disabled", fields("z-ai/glm-4.7-flash", "off", "openrouter"), '{"reasoning":{"enabled":false}}');
eq("OpenRouter on", fields("z-ai/glm-5.3-flash", "on", "openrouter"), '{"reasoning":{"effort":"high","exclude":true}}');
// Anyone else: the plain field.
eq("a plain host gets reasoning_effort", fields("glm-5.3-flash", "off", "openai"), '{"reasoning_effort":"low"}');
eq("so does another provider's model there", fields("some-model", "on", "openai"), '{"reasoning_effort":"high"}');
// A provider whose model doesn't think (OpenAiProvider.thinking "none"): nothing, whatever the level.
eq("a non-thinking provider gets no field when off", fields("some-model", "off", "none"), "{}");
eq("nor when thinking is on", fields("some-model", "on", "none"), "{}");

// Gemini: the least thinking each model takes.
eq("Flash-Lite goes down to minimal", quickThinking("gemini-3.5-flash-lite"), "minimal");
eq("3.8 Flash refuses minimal, so low", quickThinking("gemini-3.8-flash"), "low");

// ---------- When nothing can answer ----------

eq("the sentence a person gets names no engine", /GLM|Gemini|DeepSeek|Workers/.test(AI_UNREACHABLE), false);
eq("the error is recognised by name too", isAiUnreachable(Object.assign(new Error("x"), { name: "AiUnreachable" })), true);
eq("an ordinary error is not it", isAiUnreachable(new Error("GLM glm-5.3-flash 500: boom")), false);

// With no key or binding anywhere there is nothing to try: the call throws
// AiUnreachable at once (no fetch is made) and says, in the engine table, why.
const attempts: EngineAttempt[] = [];
let thrown: unknown = null;
try {
  await generateText({}, {
    model: "gemini-3.5-flash-lite",
    system: "s",
    turns: [{ role: "user", text: "hi" }],
    usage: { userId: "u1", purpose: "test" },
    onAttempt: (a) => attempts.push(a),
  });
} catch (err) {
  thrown = err;
}
eq("no keys: AiUnreachable", thrown instanceof AiUnreachable, true);
eq("which says which keys are missing", String((thrown as Error)?.message).includes("GLM_API_KEY"), true);
eq("and that the AI binding is", String((thrown as Error)?.message).includes("the AI binding"), true);
eq("and each engine is written down as having no key", attempts.map((a) => `${a.engine}:${a.outcome}`).join(","), "glm:no_key,gemini:no_key,workers:no_key");

// A paused turn resumed with nothing to carry it on is the AI out of reach too
// (/chat/resume answers it plainly), whichever engine it paused on.
const resumed = async (state: any) => {
  try {
    await chatWithTools({}, {
      model: "gemini-3.5-flash-lite",
      system: "s",
      turns: [{ role: "user", text: "what's on my calendar" }],
      tools: [],
      callTool: async () => ({}),
      usage: { userId: "u1", purpose: "test" },
      resume: { state, results: { c1: { events: [] } } },
    });
    return null;
  } catch (err) {
    return err;
  }
};
const glmPaused = {
  engine: "glm",
  round: 1,
  messages: [
    { role: "user", content: "what's on my calendar" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "calendar", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "" },
  ],
  slots: [{ id: "c1", index: 2 }],
};
const geminiPaused = {
  engine: "gemini",
  round: 1,
  contents: [
    { role: "user", parts: [{ text: "what's on my calendar" }] },
    { role: "model", parts: [{ functionCall: { name: "calendar", args: {} } }] },
    { role: "user", parts: [{ functionResponse: { name: "calendar", response: {} } }] },
  ],
  slots: [{ id: "c1", part: 0 }],
};
eq("resuming a GLM-paused turn with no engine: AiUnreachable", isAiUnreachable(await resumed(glmPaused)), true);
eq("resuming a Workers-AI-paused turn with no engine: AiUnreachable", isAiUnreachable(await resumed({ ...glmPaused, engine: "workers" })), true);
eq("resuming a Gemini-paused turn with no engine: AiUnreachable", isAiUnreachable(await resumed(geminiPaused)), true);
eq("resuming on a retired engine with none ready: AiUnreachable", isAiUnreachable(await resumed({ ...glmPaused, engine: "deepseek" })), true);

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
