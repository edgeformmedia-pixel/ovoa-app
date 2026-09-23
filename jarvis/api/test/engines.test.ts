// Which engine answers, in what order, and how each is told how much to think.
// Pure functions, so the whole switchboard is checked without a key, a
// failure or a deploy. A wrong order here is a slow turn or a bill; a wrong
// thinking field is a 400 from a provider in production.

import { quickThinking } from "../src/gemini";
import {
  AI_UNREACHABLE,
  AiUnreachable,
  chatCompletionsUrl,
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
const all: Record<Engine, boolean> = { glm: true, gemini: true };
const order = (over: Partial<OrderInput>) => engineOrder({ available: all, cooling: {}, now, voice: false, ...over }).join(",");

// ---------- Every call ----------

eq("nothing set: GLM, then Gemini", order({}), "glm,gemini");
eq("an order puts its engine first", order({ order: "gemini" }), "gemini,glm");
eq("the ones it leaves out follow, so there is always a fallback", order({ order: "gemini,glm" }), "gemini,glm");
eq("unknown names in the order are skipped", order({ order: "claude, gemini" }), "gemini,glm");
eq("spaces and case don't matter", order({ order: " Gemini , GLM " }), "gemini,glm");
eq("a name twice counts once", order({ order: "gemini,gemini" }), "gemini,glm");
eq("an order of only rubbish is the usual order", order({ order: "claude,gpt" }), "glm,gemini");

// ---------- Keys ----------

eq("no GLM key: GLM does not exist", order({ available: { ...all, glm: false } }), "gemini");
eq("no GLM key and it was first: silently the next one", order({ available: { ...all, glm: false }, order: "glm" }), "gemini");
eq("no Gemini key: GLM alone", order({ available: { ...all, gemini: false } }), "glm");
eq("no keys at all: nothing to try", order({ available: { glm: false, gemini: false } }), "");

// ---------- Cooldowns ----------

eq("a cooling engine waits its turn out", order({ cooling: { glm: now + 60_000 } }), "gemini");
eq("a cooldown that has passed is over", order({ cooling: { glm: now - 1 } }), "glm,gemini");
eq("everything cooling: nothing to try (the call says it can't reach the AI)", order({ cooling: { glm: now + 1, gemini: now + 1 } }), "");

// ---------- Spoken turns ----------

eq("spoken: the same order as typed", order({ voice: true }), "glm,gemini");
eq("spoken with voice_engine keyed: the same order", order({ voice: true, voicePrimary: "keyed" }), "glm,gemini");
eq("spoken with voice_engine naming an engine", order({ voice: true, voicePrimary: "gemini" }), "gemini,glm");
eq("spoken naming an engine with no key: the rest", order({ voice: true, voicePrimary: "gemini", available: { ...all, gemini: false } }), "glm");
eq("spoken naming a cooling engine: the rest", order({ voice: true, voicePrimary: "gemini", cooling: { gemini: now + 1 } }), "glm");
eq("voice_engine is for spoken turns only", order({ voicePrimary: "gemini" }), "glm,gemini");
eq("spoken with an unknown voice_engine: the usual order", order({ voice: true, voicePrimary: "workers" }), "glm,gemini");

// ---------- Names ----------

eq("glm is an engine", isEngine("glm"), true);
eq("gemini is an engine", isEngine("gemini"), true);
eq("Workers AI is not, any more", isEngine("workers"), false);
eq("nor DeepSeek", isEngine("deepseek"), false);
eq("nor Claude", isEngine("claude"), false);
eq("GLM is an OpenAI-compatible provider", OPENAI_PROVIDERS.glm.keyVar, "GLM_API_KEY");

// ---------- Stored settings from before v1 ----------

// Writes: an order keeps its known engines. Old Dev tools builds add ",workers".
eq("an old build's order loses Workers AI", cleanOrder("glm,gemini,workers"), "glm,gemini");
eq("and DeepSeek", cleanOrder("deepseek,gemini,workers"), "gemini");
eq("an order of nothing known is empty (refused)", cleanOrder("claude,workers"), "");
eq("case and spaces are tidied", cleanOrder(" Gemini ,GLM"), "gemini,glm");
// Reads: a copied row that names a retired engine was written for the old set.
eq("a copied order naming DeepSeek is ignored whole", usableOrder("deepseek,gemini,glm,workers"), undefined);
eq("one naming Workers AI too", usableOrder("glm,workers"), undefined);
eq("a current order is kept", usableOrder("gemini,glm"), "gemini,glm");
eq("nothing is nothing", usableOrder(""), undefined);
eq("a copied voice_engine of workers is ignored", usableVoice("workers"), undefined);
eq("keyed is kept", usableVoice("keyed"), "keyed");
eq("an engine is kept", usableVoice(" GLM "), "glm");

// ---------- Where a provider lives ----------

eq("Z.ai's url", hostFlavor("https://api.z.ai/api/paas/v4"), "zai");
eq("the default GLM host is Z.ai", hostFlavor(OPENAI_PROVIDERS.glm.defaultBaseUrl), "zai");
eq("OpenRouter", hostFlavor("https://openrouter.ai/api/v1"), "openrouter");
eq("anything else is plain OpenAI-style", hostFlavor("https://api.deepinfra.com/v1/openai"), "openai");
eq("the default endpoint", chatCompletionsUrl(OPENAI_PROVIDERS.glm.defaultBaseUrl), "https://api.z.ai/api/paas/v4/chat/completions");
eq("a base with a trailing slash", chatCompletionsUrl("https://openrouter.ai/api/v1/"), "https://openrouter.ai/api/v1/chat/completions");
eq("a base that already has the path", chatCompletionsUrl("https://x.example/v1/chat/completions"), "https://x.example/v1/chat/completions");

// ---------- How much to think ----------

const env = { GLM_THINKING: undefined };
eq("spoken never thinks", thinkingLevelFor(env, "glm", true), "off");
eq("typed GLM thinks a little by default", thinkingLevelFor(env, "glm", false), "low");
eq("the var can turn it up", thinkingLevelFor({ GLM_THINKING: "on" }, "glm", false), "on");
eq("the var can turn it off", thinkingLevelFor({ GLM_THINKING: "off" }, "glm", false), "off");
eq("a garbage var keeps the default", thinkingLevelFor({ GLM_THINKING: "lots" }, "glm", false), "low");

const fields = (model: string, level: "off" | "low" | "on", flavor: "zai" | "openrouter" | "openai") => JSON.stringify(thinkingFields(model, level, flavor));

// Z.ai: 5.3 cannot be switched off, so off means low.
eq("Z.ai GLM 5.3 off is really low", fields("glm-5.3-flash", "off", "zai"), '{"thinking":{"type":"enabled"},"reasoning_effort":"low"}');
eq("Z.ai GLM 5.3 on is high, not its max default", fields("glm-5.3-flash", "on", "zai"), '{"thinking":{"type":"enabled"},"reasoning_effort":"high"}');
eq("Z.ai GLM 5.2 can be switched off", fields("glm-5.2", "off", "zai"), '{"thinking":{"type":"disabled"}}');
eq("Z.ai GLM 4.7 has only the switch", fields("glm-4.7-flash", "low", "zai"), '{"thinking":{"type":"enabled"}}');
// OpenRouter: a reasoning object, kept out of the reply.
eq("OpenRouter GLM 5.3 off is low and hidden", fields("z-ai/glm-5.3-flash", "off", "openrouter"), '{"reasoning":{"effort":"low","exclude":true}}');
eq("OpenRouter GLM 4.7 can be disabled", fields("z-ai/glm-4.7-flash", "off", "openrouter"), '{"reasoning":{"enabled":false}}');
eq("OpenRouter on", fields("z-ai/glm-5.3-flash", "on", "openrouter"), '{"reasoning":{"effort":"high","exclude":true}}');
// Anyone else: the plain field.
eq("a plain host gets reasoning_effort", fields("glm-5.3-flash", "off", "openai"), '{"reasoning_effort":"low"}');
eq("so does another provider's model there", fields("some-model", "on", "openai"), '{"reasoning_effort":"high"}');

// Gemini: the least thinking each model takes.
eq("Flash-Lite goes down to minimal", quickThinking("gemini-3.5-flash-lite"), "minimal");
eq("3.8 Flash refuses minimal, so low", quickThinking("gemini-3.8-flash"), "low");

// ---------- When nothing can answer ----------

eq("the sentence a person gets names no engine", /GLM|Gemini|DeepSeek|Workers/.test(AI_UNREACHABLE), false);
eq("the error is recognised by name too", isAiUnreachable(Object.assign(new Error("x"), { name: "AiUnreachable" })), true);
eq("an ordinary error is not it", isAiUnreachable(new Error("GLM glm-5.3-flash 500: boom")), false);

// With no key anywhere there is nothing to try: the call throws AiUnreachable
// at once (no fetch is made) and says, in the engine table, why.
const attempts: EngineAttempt[] = [];
let thrown: unknown = null;
try {
  await generateText({}, { model: "gemini-3.5-flash-lite", system: "s", turns: [{ role: "user", text: "hi" }], onAttempt: (a) => attempts.push(a) });
} catch (err) {
  thrown = err;
}
eq("no keys: AiUnreachable", thrown instanceof AiUnreachable, true);
eq("which says which keys are missing", String((thrown as Error)?.message).includes("GLM_API_KEY"), true);
eq("and each engine is written down as having no key", attempts.map((a) => `${a.engine}:${a.outcome}`).join(","), "glm:no_key,gemini:no_key");

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
