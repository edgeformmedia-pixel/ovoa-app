// Which engine answers, in what order, and how each is told how much to think.
// Pure functions, so the whole switchboard is checked without a key, a
// failure or a deploy. A wrong order here is a slow turn or a bill; a wrong
// thinking field is a 400 from a provider in production.

import { engineOrder, glmEndpoint, glmFlavor, isEngine, thinkingFields, thinkingLevelFor, type Engine, type OrderInput } from "../src/llm";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${got}${ok ? "" : `  (wanted ${want})`}`);
}

const now = 1_758_412_800_000;
const all: Record<Engine, boolean> = { gemini: true, deepseek: true, glm: true, workers: true };
const order = (over: Partial<OrderInput>) =>
  engineOrder({ available: all, cooling: {}, now, voice: false, fast: false, ...over }).join(",");

// ---------- Typed turns ----------

eq("nothing set: the keyed ones, then Workers AI last", order({}), "gemini,deepseek,glm,workers");
eq("PRIMARY_ENGINE moves one to the front", order({ primary: "deepseek" }), "deepseek,gemini,glm,workers");
eq("PRIMARY_ENGINE can be glm", order({ primary: "glm" }), "glm,gemini,deepseek,workers");
eq("PRIMARY_ENGINE workers is ignored (it is the net, not the first)", order({ primary: "workers" }), "gemini,deepseek,glm,workers");
eq("an unknown primary is ignored, not fatal", order({ primary: "claude" }), "gemini,deepseek,glm,workers");
eq("an explicit order wins", order({ order: "glm,deepseek,gemini,workers", primary: "deepseek" }), "glm,deepseek,gemini,workers");
eq("Workers AI is appended when the order leaves it out", order({ order: "glm,deepseek" }), "glm,deepseek,workers");
eq("Workers AI stays where it was put", order({ order: "workers,glm" }), "workers,glm");
eq("unknown names in the order are skipped", order({ order: "glm, claude ,deepseek" }), "glm,deepseek,workers");
eq("spaces and case don't matter", order({ order: " GLM , DeepSeek " }), "glm,deepseek,workers");
eq("a name twice counts once", order({ order: "glm,glm,workers" }), "glm,workers");
eq("an order of only rubbish falls back to the default", order({ order: "claude,gpt" }), "gemini,deepseek,glm,workers");

// ---------- Keys ----------

const noGlm = { ...all, glm: false };
eq("no GLM key: GLM does not exist", order({ available: noGlm, order: "glm,deepseek,gemini" }), "deepseek,gemini,workers");
eq("no GLM key and it was primary: silently the next one", order({ available: noGlm, primary: "glm" }), "gemini,deepseek,workers");
eq("no keys at all: Workers AI alone", order({ available: { gemini: false, deepseek: false, glm: false, workers: true } }), "workers");

// ---------- Cooldowns ----------

eq("a cooling engine waits its turn out", order({ primary: "deepseek", cooling: { deepseek: now + 60_000 } }), "gemini,glm,workers");
eq("a cooldown that has passed is over", order({ primary: "deepseek", cooling: { deepseek: now - 1 } }), "deepseek,gemini,glm,workers");
eq("everything cooling: Workers AI is tried anyway", order({ cooling: { gemini: now + 1, deepseek: now + 1, glm: now + 1, workers: now + 1 } }), "workers");
eq("Workers AI cooling (4006): the keyed ones without it", order({ cooling: { workers: now + 3_600_000 } }), "gemini,deepseek,glm");

// ---------- Spoken turns ----------

eq("spoken: Workers AI first by default", order({ voice: true, primary: "deepseek" }), "workers,deepseek,gemini,glm");
eq("spoken with VOICE_PRIMARY keyed: the typed order", order({ voice: true, primary: "deepseek", voicePrimary: "keyed" }), "deepseek,gemini,glm,workers");
eq("spoken with VOICE_PRIMARY naming an engine", order({ voice: true, voicePrimary: "glm" }), "glm,gemini,deepseek,workers");
eq("spoken naming an engine with no key: Workers AI first", order({ voice: true, voicePrimary: "glm", available: noGlm }), "workers,gemini,deepseek");
eq("spoken naming a cooling engine: Workers AI first", order({ voice: true, voicePrimary: "glm", cooling: { glm: now + 1 } }), "workers,gemini,deepseek");
eq("spoken with an unknown VOICE_PRIMARY: the default", order({ voice: true, voicePrimary: "claude" }), "workers,gemini,deepseek,glm");
eq("spoken and Workers AI is out: the keyed order", order({ voice: true, primary: "deepseek", cooling: { workers: now + 1 } }), "deepseek,gemini,glm");

// ---------- Quick calls ----------

eq("a quick call goes to Workers AI first whatever is set", order({ fast: true, order: "glm,deepseek" }), "workers,glm,deepseek");
eq("a quick call with Workers AI out: the rest", order({ fast: true, cooling: { workers: now + 1 } }), "gemini,deepseek,glm");

// ---------- Names ----------

eq("glm is an engine", isEngine("glm"), true);
eq("Claude is not", isEngine("claude"), false);

// ---------- Where GLM lives ----------

eq("no base: Z.ai", glmFlavor(undefined), "zai");
eq("Z.ai's url", glmFlavor("https://api.z.ai/api/paas/v4"), "zai");
eq("OpenRouter", glmFlavor("https://openrouter.ai/api/v1"), "openrouter");
eq("anything else is plain OpenAI-style", glmFlavor("https://api.deepinfra.com/v1/openai"), "openai");
eq("the default endpoint", glmEndpoint(undefined), "https://api.z.ai/api/paas/v4/chat/completions");
eq("a base with a trailing slash", glmEndpoint("https://openrouter.ai/api/v1/"), "https://openrouter.ai/api/v1/chat/completions");
eq("a base that already has the path", glmEndpoint("https://x.example/v1/chat/completions"), "https://x.example/v1/chat/completions");

// ---------- How much to think ----------

const env = { DEEPSEEK_THINKING: undefined, GLM_THINKING: undefined };
eq("spoken never thinks", thinkingLevelFor(env, "deepseek", "deepseek-flash", true), "off");
eq("typed DeepSeek thinks a little by default", thinkingLevelFor(env, "deepseek", "deepseek-flash", false), "low");
eq("typed GLM thinks a little by default", thinkingLevelFor(env, "glm", "glm-5.3-flash", false), "low");
eq("the var can turn it up", thinkingLevelFor({ ...env, GLM_THINKING: "on" }, "glm", "glm-5.3-flash", false), "on");
eq("the var can turn it off", thinkingLevelFor({ ...env, DEEPSEEK_THINKING: "off" }, "deepseek", "deepseek-flash", false), "off");
eq("a garbage var keeps the default", thinkingLevelFor({ ...env, DEEPSEEK_THINKING: "lots" }, "deepseek", "deepseek-flash", false), "low");
eq("gpt-oss typed keeps its own default", thinkingLevelFor(env, "workers", "@cf/openai/gpt-oss-120b", false), "on");
eq("GLM on Workers AI follows the GLM var", thinkingLevelFor(env, "workers", "@cf/zai-org/glm-5.3-flash", false), "low");

const fields = (engine: "deepseek" | "glm" | "workers", model: string, level: "off" | "low" | "on", flavor?: "zai" | "openrouter" | "openai") =>
  JSON.stringify(thinkingFields(engine, model, level, flavor));

// gpt-oss: today's behaviour exactly.
eq("gpt-oss spoken: reasoning_effort low", fields("workers", "@cf/openai/gpt-oss-120b", "off"), '{"reasoning_effort":"low"}');
eq("gpt-oss typed: nothing added", fields("workers", "@cf/openai/gpt-oss-120b", "on"), "{}");
// GLM on Workers AI: the template flag switches it off.
eq("Workers GLM off", fields("workers", "@cf/zai-org/glm-5.3-flash", "off"), '{"chat_template_kwargs":{"enable_thinking":false}}');
eq("Workers GLM low", fields("workers", "@cf/zai-org/glm-5.3-flash", "low"), '{"reasoning_effort":"low"}');
eq("an unknown Workers model gets nothing", fields("workers", "@cf/meta/llama", "off"), "{}");
// DeepSeek: "none" is off.
eq("DeepSeek off", fields("deepseek", "deepseek-flash", "off"), '{"reasoning_effort":"none"}');
eq("DeepSeek low", fields("deepseek", "deepseek-flash", "low"), '{"reasoning_effort":"low"}');
eq("DeepSeek on: its own default", fields("deepseek", "deepseek-flash", "on"), "{}");
// Z.ai: 5.3 cannot be switched off, so off means low.
eq("Z.ai GLM 5.3 off is really low", fields("glm", "glm-5.3-flash", "off", "zai"), '{"thinking":{"type":"enabled"},"reasoning_effort":"low"}');
eq("Z.ai GLM 5.3 on is high, not its max default", fields("glm", "glm-5.3-flash", "on", "zai"), '{"thinking":{"type":"enabled"},"reasoning_effort":"high"}');
eq("Z.ai GLM 5.2 can be switched off", fields("glm", "glm-5.2", "off", "zai"), '{"thinking":{"type":"disabled"}}');
eq("Z.ai GLM 4.7 has only the switch", fields("glm", "glm-4.7-flash", "low", "zai"), '{"thinking":{"type":"enabled"}}');
// OpenRouter: a reasoning object, kept out of the reply.
eq("OpenRouter GLM 5.3 off is low and hidden", fields("glm", "z-ai/glm-5.3-flash", "off", "openrouter"), '{"reasoning":{"effort":"low","exclude":true}}');
eq("OpenRouter GLM 4.7 can be disabled", fields("glm", "z-ai/glm-4.7-flash", "off", "openrouter"), '{"reasoning":{"enabled":false}}');
eq("OpenRouter on", fields("glm", "z-ai/glm-5.3-flash", "on", "openrouter"), '{"reasoning":{"effort":"high","exclude":true}}');
// Anyone else: the plain field.
eq("a plain host gets reasoning_effort", fields("glm", "glm-5.3-flash", "off", "openai"), '{"reasoning_effort":"low"}');

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
