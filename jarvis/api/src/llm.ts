import { generate as geminiGenerate, quickThinking, type Turn } from "./gemini";

// The reply engines: which model answers, in what order, and what each call
// cost. Every model call goes through here, apart from web search grounding
// (web.ts calls Gemini itself) and Ask Claude (claude.ts).
//
// Two engines, and one order for every use: typed and spoken turns, memory and
// summaries, the setup conversation, app design, agent jobs and food all try
// GLM first and Gemini second (the v1 release, 2026-09-23). Both are temporary
// choices; the provider will change.
//
//   glm     GLM 5.3 Flash on Z.ai, through the OpenAI-compatible path below
//           (OPENAI_PROVIDERS). The id stays "glm" whatever it runs on: the
//           usage history, server_settings rows and the GLM_PRICE_* vars use it.
//   gemini  Google's own API, with the model the caller names (CHAT_MODEL or
//           MEMORY_MODEL in wrangler.jsonc).
//
// An engine without its key does not exist: it is never tried, skipped or
// mentioned. When nothing can answer (every engine that exists failed before
// it said anything, or is cooling down, or no engine has a key) a call throws
// AiUnreachable. A person's turn is then told plainly that OVOA can't reach the
// AI right now (index.ts); a background call fails quietly, as it always did.
// `fast` no longer changes the order: it only means "think as little as the
// model allows".
//
// Adding an OpenAI-compatible provider is config plus a few lines:
//   1. An entry in OPENAI_PROVIDERS: its name, the names of the vars that hold
//      its key, base URL, model and thinking level, and defaults for the base
//      URL and the model.
//   2. Its id in OpenAiEngine and in ENGINES, at the place in the order where
//      it should be tried.
//   3. Its vars in wrangler.jsonc (and in types.ts Env, for the record), its key
//      as a secret, and its price in pricing.ts LLM_PRICES under its model id.
// How much it thinks is spelled for its host (hostFlavor, thinkingFields): Z.ai
// and OpenRouter have their own fields, and any other host gets the plain
// OpenAI `reasoning_effort`.

export type { Turn };

export type LlmEnv = {
  GEMINI_API_KEY?: string;
  CHAT_MODEL?: string;
  /**
   * GLM 5.3 Flash from the user's own provider (OPENAI_PROVIDERS.glm). Without
   * the key the engine does not exist. The base URL is any OpenAI-compatible
   * endpoint (Z.ai's by default; OpenRouter and the like work too, and the
   * thinking fields are shaped for whichever it is).
   */
  GLM_API_KEY?: string;
  GLM_BASE_URL?: string;
  GLM_MODEL?: string;
  /**
   * How much GLM thinks on a typed turn: "off", "low" (the default) or "on".
   * Thinking is billed as output tokens. Spoken turns never think: the wait
   * before the first word is the whole experience there.
   */
  GLM_THINKING?: string;
  /**
   * The order every call tries, e.g. "gemini,glm". Unset: ENGINES' order. The
   * runtime settings (server_settings.engine_order) override it without a deploy.
   */
  ENGINE_ORDER?: string;
  /**
   * How long an engine has to send its first byte, and how long a stream may go
   * quiet once it has started. Read from the environment so a model that is
   * legitimately slow one week can be given more room with `wrangler secret`
   * rather than a deploy. Defaults below.
   */
  MODEL_CONNECT_MS?: string;
  MODEL_IDLE_MS?: string;
};

type Options = {
  model: string;
  system: string;
  turns: Turn[];
  json?: { schema: Record<string, unknown> };
  /**
   * Quick calls (a yes/no, a memory update, a setup answer): every engine
   * thinks as little as its model allows. Tried in the same order as any call.
   */
  fast?: boolean;
  /** Called once per engine tried or skipped. See EngineAttempt. */
  onAttempt?: OnAttempt;
  /** Whose call this is and what for, so the tokens land against the right person. See LlmUsage. */
  usage?: UsageTag;
  /** Receives every model call's token counts. When set, the default sink is not called. */
  onUsage?: OnUsage;
  /** This caller's own engine choices, over the runtime settings and the vars. See EnginePrefs. */
  prefer?: EnginePrefs;
};

export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };

// ---------- Usage ----------
//
// Every engine says, in its own words, how many tokens a call read and wrote.
// Those numbers are the only honest measure of what a reply cost, and until
// now they were thrown away with the response. Each call reports them through
// a callback, the same way onAttempt reports engine attempts; this file stays
// free of the database, and the caller (usage.ts) prices and stores them.
//
// A call site that has no callback of its own is still counted: index.ts
// registers one sink for the whole isolate, and a call is tagged with the
// person and purpose it was for so the sink knows where to file it.

/** Who a call is for, and why. Filed against user_id in usage_daily. */
export type UsageTag = { userId: string | null; purpose: string };

/** One model call's token counts, as the engine reported them. */
export type LlmUsage = {
  engine: Engine;
  model: string;
  /** Every prompt token, including the cached ones. */
  inputTokens: number;
  /** How many of inputTokens the provider had already and charged less for. */
  cachedTokens: number;
  /** Everything written, thinking included: that is how every provider bills it. */
  outputTokens: number;
  /** The part of outputTokens that was thinking, where the engine says. */
  reasoningTokens: number;
  ms: number;
  userId: string | null;
  purpose: string;
};

export type OnUsage = (usage: LlmUsage) => void;

type UsageSink = (env: LlmEnv, usage: LlmUsage) => void;
let usageSink: UsageSink | null = null;

/** Where calls without their own onUsage are reported. Set once by index.ts. */
export function setUsageSink(sink: UsageSink | null) {
  usageSink = sink;
}

/** The counts a provider sent, in whichever field names it uses. Zero when it sent none. */
export type TokenUsage = { input: number; cached: number; output: number; reasoning: number };

const NO_USAGE: TokenUsage = { input: 0, cached: 0, output: 0, reasoning: 0 };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * OpenAI-style usage. OpenAI, OpenRouter and Z.ai put the cache hits under
 * prompt_tokens_details; DeepSeek-style hosts split the prompt into hits and
 * misses; some send only the plain three. All of them count thinking in
 * completion_tokens, and some say how much of it was thinking.
 */
export function readOpenAiUsage(usage: any): TokenUsage | null {
  if (!usage || typeof usage !== "object") return null;
  const hit = num(usage.prompt_cache_hit_tokens);
  const miss = num(usage.prompt_cache_miss_tokens);
  const input = num(usage.prompt_tokens) || hit + miss;
  const cached = hit || num(usage.prompt_tokens_details?.cached_tokens);
  return {
    input,
    cached: Math.min(cached, input),
    output: num(usage.completion_tokens),
    reasoning: num(usage.completion_tokens_details?.reasoning_tokens),
  };
}

/** Gemini's usageMetadata. promptTokenCount includes the cached part; thoughts are billed as output. */
export function readGeminiUsage(meta: any): TokenUsage | null {
  if (!meta || typeof meta !== "object") return null;
  const input = num(meta.promptTokenCount);
  const thoughts = num(meta.thoughtsTokenCount);
  return {
    input,
    cached: Math.min(num(meta.cachedContentTokenCount), input),
    output: num(meta.candidatesTokenCount) + thoughts,
    reasoning: thoughts,
  };
}

function reportUsage(
  env: LlmEnv,
  opts: { usage?: UsageTag; onUsage?: OnUsage },
  engine: Engine,
  model: string,
  counts: TokenUsage | null,
  ms: number,
) {
  const c = counts ?? NO_USAGE;
  const usage: LlmUsage = {
    engine,
    model,
    inputTokens: c.input,
    cachedTokens: c.cached,
    outputTokens: c.output,
    reasoningTokens: c.reasoning,
    ms,
    userId: opts.usage?.userId ?? null,
    purpose: opts.usage?.purpose ?? "other",
  };
  try {
    if (opts.onUsage) opts.onUsage(usage);
    else usageSink?.(env, usage);
  } catch (err) {
    // Counting must never fail the call it counts.
    console.error("ovoa.err usage report failed", err);
  }
}
export type CallTool = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/** A CallTool returns this to pause the turn until the app supplies the result (see `resume`). */
export const DEFER = Symbol("defer");

export type DeferredCall = { id: string; name: string; args: Record<string, unknown> };

/** A paused tool loop. Plain JSON, so it can be stored between requests. */
export type LoopState =
  | { engine: "gemini"; round: number; contents: any[]; slots: { id: string; part: number }[] }
  | { engine: OpenAiEngine; round: number; messages: any[]; slots: { id: string; index: number }[] };

export type ChatOutcome =
  | { kind: "reply"; text: string; engine: Engine }
  | { kind: "paused"; state: LoopState; calls: DeferredCall[]; engine: Engine };

/**
 * Receives the reply as it's written. Returning false stops the model early
 * (a spoken reply that has gone on long enough, or is repeating itself).
 */
export type OnText = (delta: string) => boolean | void;

/**
 * One try at one engine, reported whether it worked or not -- including the
 * ones that were skipped without being tried. The caller writes these down
 * (obs.ts noteEngines); llm.ts stays free of the database.
 */
export type EngineAttempt = { engine: Engine; model: string; outcome: string; ms: number; error?: string };

export type OnAttempt = (attempt: EngineAttempt) => void;

type ToolLoopOptions = {
  model: string;
  system: string;
  turns: Turn[];
  tools: ToolSpec[];
  callTool: CallTool;
  /** Spoken turn: think less, answer sooner. */
  voice?: boolean;
  /** Stream the reply: called with each piece of text as the model writes it. */
  onText?: OnText;
  /** Called once per engine tried or skipped, so the day's engine health is recordable. */
  onAttempt?: OnAttempt;
  /** Whose turn this is and what for, for the usage table. See LlmUsage. */
  usage?: UsageTag;
  /** Every model round's token counts. When set, the default sink is not called. */
  onUsage?: OnUsage;
  /** This person's own engine choices, over the runtime settings and the vars. See EnginePrefs. */
  prefer?: EnginePrefs;
};

export type Engine = "gemini" | OpenAiEngine;

/** Every engine there is, in the order they are tried when nothing says otherwise. */
export const ENGINES: Engine[] = ["glm", "gemini"];
export const isEngine = (name: string): name is Engine => (ENGINES as string[]).includes(name);
const isOpenAiEngine = (name: string): name is OpenAiEngine => Object.hasOwn(OPENAI_PROVIDERS, name);

/** What people and the logs call an engine. */
function nameOf(engine: Engine) {
  return engine === "gemini" ? "Gemini" : OPENAI_PROVIDERS[engine].name;
}

/**
 * The engines there were before v1: DeepSeek, and Workers AI as the last
 * resort. server_settings rows copied from the old database may still name
 * them. An order that does was written for the engines of its time, so it is
 * ignored whole (usableOrder) rather than read as, say, "gemini first".
 */
const RETIRED_ENGINES = ["deepseek", "workers"];

const MAX_TOOL_ROUNDS = 8;
// Halved 2026-09-22: every character here is read again on every later round of
// the turn, and the replies that needed the second half of a 12,000-character
// result were not found. The tools trim their own results first (Google mail and
// calendar lists); this is the backstop.
const MAX_TOOL_RESULT_CHARS = 6_000;

const stripThinking = (text: string) => text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

function toolResultText(result: unknown) {
  const text = JSON.stringify(result ?? null);
  return text.length > MAX_TOOL_RESULT_CHARS ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}…(truncated)` : text;
}

async function safeCall(callTool: CallTool, name: string, args: Record<string, unknown>) {
  try {
    return await callTool(name, args);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------- Engine health ----------
//
// A failing engine (out of quota, out of credit, bad key) is skipped for a while
// instead of being tried, and failing, before every single reply. Per isolate,
// which is enough: a busy isolate serves many requests.

const cooldownUntil = new Map<Engine, number>();
const lastFailure = new Map<Engine, string>();

function coolDown(engine: Engine, err: unknown) {
  const text = String(err);
  lastFailure.set(engine, text.slice(0, 200));
  const status = Number(/ (\d{3}):/.exec(text)?.[1] ?? 0);
  // 429: rate limited, back soon, unless the (daily) quota is used up. 401/402/403/404: key,
  // credit or model problems that won't fix themselves.
  const ms =
    status === 429
      ? /quota/i.test(text)
        ? 30 * 60_000
        : 60_000
      : [401, 402, 403, 404].includes(status)
        ? 10 * 60_000
        : 15_000;
  cooldownUntil.set(engine, Date.now() + ms);
}

// ---------- Which engine, in what order ----------
//
// Three layers say what to try first, each overriding the one below:
//
//   1. ENGINES' own order (GLM, then Gemini), or the ENGINE_ORDER var if set.
//   2. The runtime settings in the server_settings table, read once a minute
//      and handed here by index.ts (setRuntimeEngines), so an engine can be
//      switched without a deploy.
//   3. A person's own settings (`prefer` on a call), so a developer can try an
//      engine without changing what everyone else gets.
//
// The order itself is worked out by engineOrder, a pure function of those
// choices plus which keys exist and which engines are cooling down, so it can
// be tested without an engine ever having failed.

/** Engine choices from the runtime settings or from one person. Any field may be absent. */
export type EnginePrefs = {
  /** "gemini,glm": who every call tries first. Unknown names are ignored; the engines left out follow in the usual order. */
  order?: string;
  /** "keyed" or an engine name: who answers spoken turns first. Unset or "keyed": the same order as everything else. */
  voice?: string;
};

let runtime: EnginePrefs = {};

/** The runtime settings (server_settings) for this isolate. index.ts sets them on every request and tick. */
export function setRuntimeEngines(prefs: EnginePrefs) {
  runtime = prefs;
}

export type OrderInput = {
  /** Which engines have what they need to be called at all: their key. */
  available: Record<Engine, boolean>;
  /** Engines being skipped, and until when. */
  cooling: Partial<Record<Engine, number>>;
  now: number;
  voice: boolean;
  /** Who goes first, as a comma list of engine names. */
  order?: string;
  /** Spoken turns only: an engine to put first. "keyed" or unset: the same order. */
  voicePrimary?: string;
};

/** A comma list of engine names, cleaned: lowercase, trimmed, known, each once. */
function parseOrder(raw: string | undefined): Engine[] {
  const out: Engine[] = [];
  for (const part of (raw ?? "").split(",")) {
    const name = part.trim().toLowerCase();
    if (isEngine(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * An order as it is stored: its known engines, each once, in the order given.
 * Unknown and retired names are dropped without complaint, because Dev tools
 * in builds from before v1 add ",workers" to every order they send. Empty when
 * it names no engine at all. Pure.
 */
export function cleanOrder(raw: string): string {
  return parseOrder(raw).join(",");
}

/** A stored order, or undefined when it is empty or names a retired engine (RETIRED_ENGINES). Pure. */
export function usableOrder(raw: string | undefined): string | undefined {
  const names = (raw ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!names.length || names.some((n) => RETIRED_ENGINES.includes(n))) return undefined;
  return raw;
}

/** A stored choice for spoken turns: "keyed" or an engine name. Anything else ("workers", from before v1) is ignored. Pure. */
export function usableVoice(raw: string | undefined): string | undefined {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "keyed" || isEngine(v) ? v : undefined;
}

/**
 * The engines to try, first to last. Pure.
 *
 * An order names who goes first; the engines it leaves out follow in their
 * usual order (ENGINES), so there is always a fallback. An engine without its
 * key is left out (it does not exist, so it is not "skipped"), and one cooling
 * down from a failure waits its turn out. With nothing left the list is empty,
 * and the call says it can't reach the AI (AiUnreachable) rather than trying
 * an engine that has just failed.
 *
 * Spoken turns follow the same order, unless voice_engine names an engine to
 * put first (Dev tools, for trying one out on the wrist).
 */
export function engineOrder(i: OrderInput): Engine[] {
  const named = parseOrder(i.order);
  let list = [...named, ...ENGINES.filter((e) => !named.includes(e))];
  const want = i.voice ? (i.voicePrimary ?? "").trim().toLowerCase() : "";
  if (isEngine(want)) list = [want, ...list.filter((e) => e !== want)];
  return list.filter((e) => i.available[e] && (i.cooling[e] ?? 0) <= i.now);
}

/** Which engines have what they need: each one's key. */
function availableEngines(env: LlmEnv): Record<Engine, boolean> {
  const out = {} as Record<Engine, boolean>;
  for (const engine of ENGINES) out[engine] = !!varOf(env, keyVarOf(engine));
  return out;
}

function coolingNow(): Partial<Record<Engine, number>> {
  const out: Partial<Record<Engine, number>> = {};
  const now = Date.now();
  for (const [engine, until] of cooldownUntil) if (until > now) out[engine] = until;
  return out;
}

/**
 * The order for one call: the vars, the runtime settings and the caller's own
 * preferences, in that order of precedence. A stored choice that names a
 * retired engine is passed over, so the next layer down decides.
 */
function engines(env: LlmEnv, voice = false, prefer?: EnginePrefs): Engine[] {
  return engineOrder({
    available: availableEngines(env),
    cooling: coolingNow(),
    now: Date.now(),
    voice,
    order: usableOrder(prefer?.order) ?? usableOrder(runtime.order) ?? usableOrder(env.ENGINE_ORDER),
    voicePrimary: usableVoice(prefer?.voice) ?? usableVoice(runtime.voice),
  });
}

/**
 * Where each engine stands right now, for /debug/engines and the Dev tools
 * picker: whether its key is set, which model it would call, whether it is
 * cooling down and what it last failed with. The orders are what a typed and
 * a spoken turn would try this minute.
 */
export function engineStatus(env: LlmEnv, prefer?: EnginePrefs) {
  const available = availableEngines(env);
  const now = Date.now();
  return {
    engines: ENGINES.map((engine) => {
      const until = cooldownUntil.get(engine) ?? 0;
      return {
        engine,
        name: nameOf(engine),
        key: available[engine] ? "set" : "missing",
        model: available[engine] ? modelFor(env, engine, env.CHAT_MODEL ?? "") : null,
        coolingForS: until > now ? Math.round((until - now) / 1000) : 0,
        lastError: lastFailure.get(engine) ?? null,
      };
    }),
    typedOrder: engines(env, false, prefer),
    voiceOrder: engines(env, true, prefer),
    settings: { vars: { ENGINE_ORDER: env.ENGINE_ORDER }, runtime, ...(prefer && { mine: prefer }) },
  };
}

/**
 * Engines being skipped right now, and what each last failed with. Goes into a
 * turn's meta: from the phone there is no way to read the Worker's console, so
 * "why was that slow" was previously unanswerable without `wrangler tail`.
 */
export function coolingEngines() {
  const now = Date.now();
  return [...cooldownUntil]
    .filter(([, until]) => until > now)
    .map(([engine]) => `${nameOf(engine)}: ${lastFailure.get(engine) ?? "unknown"}`);
}

/**
 * What went wrong, in one word, so a day's failures group into a handful of
 * rows instead of a thousand distinct strings. The status is read the same way
 * coolDown reads it, because the messages are built as
 * "GLM glm-5.3-flash 429: …" a few functions below.
 */
export function classifyEngineError(err: unknown): string {
  const text = String(err instanceof Error ? err.message : err);
  if (/No AI engine has its key set/.test(text)) return "no_engine";
  if (/cooling down/.test(text)) return "skipped";
  if (/returned no text|returned no JSON/.test(text)) return "empty";
  if (/Too many tool rounds/.test(text)) return "too_many_rounds";
  if (/aborted|Timed out|No output from the model/i.test(text)) return "timeout";
  const status = Number(/ (\d{3}):/.exec(text)?.[1] ?? 0);
  if (status === 429) return /quota/i.test(text) ? "quota" : "rate_limited";
  if (status === 402) return "no_credit";
  if (status === 401 || status === 403) return "bad_key";
  if (status === 404) return "no_model";
  if (status >= 500) return "upstream_5xx";
  if (status) return `http_${status}`;
  return "failed";
}

export type EngineDown = { engine: Engine; until: number; error: string };

/**
 * Why nothing could answer, as a sentence a developer can read. Pure, so the
 * wording is testable without faking a failed engine.
 *
 * The phone has no way to see the Worker's console, so when every engine is
 * down this is the only place the reason can come from. The alternative is what
 * 2026-09-21 looked like: 166 identical "couldn't get a reply" lines and no
 * indication anywhere that the answer was "the DeepSeek account is empty".
 * A person is told AI_UNREACHABLE instead; this rides along as the detail.
 */
export function troubleFrom(down: EngineDown[], now: number): string | null {
  if (!down.length) return null;
  const why = (text: string) => {
    if (/ 402:/.test(text)) return "out of credit";
    if (/ 429:/.test(text)) return /quota/i.test(text) ? "out of quota for today" : "rate limited";
    if (/ 401:| 403:/.test(text)) return "not accepting its key";
    if (/ 404:/.test(text)) return "missing its model";
    return "failing";
  };
  const parts = down.map((d) => `${nameOf(d.engine)} is ${why(d.error)}`);
  const wait = Math.max(0, Math.min(...down.map((d) => d.until)) - now);
  const mins = Math.max(1, Math.round(wait / 60_000));
  const when = mins >= 120 ? `${Math.round(mins / 60)} hours` : `${mins} minute${mins === 1 ? "" : "s"}`;
  return `${parts.join(", and ")}. The soonest any of them is tried again is about ${when} from now.`;
}

/**
 * troubleFrom, fed the live cooldown state — but only when every engine that
 * exists is cooling down. One engine cooling down while another answers is not
 * trouble, it is the fallback working; saying otherwise turned every unrelated
 * 500 on every route into "OVOA can't reach an AI model right now". A server
 * with no keys at all is not this either: AiUnreachable says that one.
 */
export function engineTrouble(env: LlmEnv) {
  const now = Date.now();
  const available = availableEngines(env);
  const exists = ENGINES.filter((e) => available[e]);
  if (!exists.length || exists.some((e) => (cooldownUntil.get(e) ?? 0) <= now)) return null;
  const down: EngineDown[] = exists.map((engine) => ({ engine, until: cooldownUntil.get(engine) ?? now, error: lastFailure.get(engine) ?? "" }));
  return troubleFrom(down, now);
}

// ---------- When nothing can answer ----------

/**
 * Thrown when nothing could answer: every engine that exists failed before it
 * wrote a word or ran a tool, or was already cooling down, or no engine has a
 * key. The message is the reason, for the logs and error_events; a person is
 * told AI_UNREACHABLE instead (index.ts). A turn that fails after it has
 * started answering throws the engine's own error: that is the turn failing,
 * not the AI being out of reach.
 */
export class AiUnreachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiUnreachable";
  }
}

export const isAiUnreachable = (err: unknown): err is AiUnreachable =>
  err instanceof AiUnreachable || (err instanceof Error && err.name === "AiUnreachable");

/** What a person hears or reads when no engine could answer their turn. Plain, and no engine names. */
export const AI_UNREACHABLE = "Sorry, I can't reach the AI right now. Please try again in a little while.";

/**
 * Nothing to try: every engine is missing its key or cooling down. The ones
 * without a key are reported (the cooling ones already were, by
 * reportSkipped), so the engine table says why this call got no answer.
 */
function nothingToTry(env: LlmEnv, model: string, onAttempt?: OnAttempt) {
  const available = availableEngines(env);
  for (const engine of ENGINES) {
    if (!available[engine]) onAttempt?.({ engine, model: modelFor(env, engine, model), outcome: "no_key", ms: 0 });
  }
  return new AiUnreachable(engineTrouble(env) ?? `No AI engine has its key set (${ENGINES.map(keyVarOf).join(", ")}).`);
}

/** Which model each engine is actually about to call, for the record. Gemini's is the caller's (CHAT_MODEL or MEMORY_MODEL). */
function modelFor(env: LlmEnv, engine: Engine, model: string) {
  if (engine === "gemini") return model;
  const provider = OPENAI_PROVIDERS[engine];
  return varOf(env, provider.modelVar) ?? provider.defaultModel;
}

/**
 * The engines that were not even tried this turn. Reported alongside the ones
 * that were, so "which were dead" and "which answered" come out of the same
 * table rather than one being a console line that expires in three days.
 */
function reportSkipped(env: LlmEnv, model: string, onAttempt?: OnAttempt) {
  if (!onAttempt) return;
  const now = Date.now();
  for (const [engine, until] of cooldownUntil) {
    if (until > now) {
      onAttempt({ engine, model: modelFor(env, engine, model), outcome: "skipped", ms: 0, error: lastFailure.get(engine) });
    }
  }
}

/** The last engine's error, naming what the earlier ones failed with, and the ones this call skipped. */
function finalError(err: unknown, failures: string[], tried: Engine[]) {
  const now = Date.now();
  for (const [engine, until] of cooldownUntil) {
    if (until > now && !tried.includes(engine)) failures.push(`${nameOf(engine)} skipped, it failed with ${lastFailure.get(engine)}`);
  }
  if (!failures.length) return err;
  const brief = (e: unknown) => String(e instanceof Error ? e.message : e).slice(0, 200);
  return new Error(`${brief(err)} (earlier: ${failures.join("; ")})`);
}

/** finalError as AiUnreachable: every engine there was has failed. */
function unreachable(err: unknown, failures: string[], tried: Engine[]) {
  const last = finalError(err, failures, tried);
  return new AiUnreachable(last instanceof Error ? last.message : String(last));
}

function logFallback(from: Engine, to: Engine, err: unknown) {
  coolDown(from, err);
  console.error(`${nameOf(from)} failed, using ${nameOf(to)} fallback`, err);
}

export async function generateText(env: LlmEnv, opts: Options): Promise<string> {
  applyDeadlines(env);
  const order = engines(env, false, opts.prefer);
  const failures: string[] = [];
  reportSkipped(env, opts.model, opts.onAttempt);
  if (!order.length) throw nothingToTry(env, opts.model, opts.onAttempt);
  for (const [i, engine] of order.entries()) {
    const at = Date.now();
    const model = modelFor(env, engine, opts.model);
    try {
      let text: string;
      if (engine === "gemini") {
        const got = await geminiGenerate({ apiKey: env.GEMINI_API_KEY!, ...opts });
        reportUsage(env, opts, engine, model, readGeminiUsage(got.usage), Date.now() - at);
        text = got.text;
      } else {
        text = await openAiGenerate(env, engine, opts);
      }
      opts.onAttempt?.({ engine, model, outcome: "ok", ms: Date.now() - at });
      return text;
    } catch (err) {
      const brief = String(err instanceof Error ? err.message : err).slice(0, 300);
      opts.onAttempt?.({ engine, model, outcome: classifyEngineError(err), ms: Date.now() - at, error: brief });
      if (i === order.length - 1) {
        coolDown(engine, err);
        throw unreachable(err, failures, order);
      }
      failures.push(`${nameOf(engine)}: ${brief.slice(0, 200)}`);
      logFallback(engine, order[i + 1], err);
    }
  }
  throw new Error("No engines");
}

/**
 * Chat that may call tools. Moves to the next engine only if one fails before
 * any tool ran and before any text was streamed.
 * Pass `resume` to continue a paused turn with the results of its deferred calls.
 */
export async function chatWithTools(
  env: LlmEnv,
  opts: ToolLoopOptions & { resume?: { state: LoopState; results: Record<string, unknown> } },
): Promise<ChatOutcome> {
  applyDeadlines(env);
  if (opts.resume) {
    const { state, results } = opts.resume;
    const result = (id: string) => results[id] ?? { error: "The app returned no result" };
    // Where a paused turn goes when its own engine can't carry on: the first
    // OpenAI-style engine that is ready now. Its messages are OpenAI-style.
    const openAiNow = () => engines(env, !!opts.voice, opts.prefer).find((e) => isOpenAiEngine(e)) as OpenAiEngine | undefined;
    if (state.engine === "gemini") {
      const last = state.contents[state.contents.length - 1];
      for (const slot of state.slots) {
        last.parts[slot.part].functionResponse.response = geminiResponse(result(slot.id));
      }
      let streamed = false;
      const onText: OnText | undefined = opts.onText
        ? (delta) => {
            streamed = true;
            return opts.onText!(delta);
          }
        : undefined;
      try {
        if ((cooldownUntil.get("gemini") ?? 0) > Date.now()) throw new Error("Gemini is cooling down");
        return await geminiToolLoop(env, { ...opts, onText }, state);
      } catch (err) {
        // Out of quota halfway through: finish the turn on an OpenAI-style
        // engine with what's been looked up, if one is ready.
        const next = openAiNow();
        if (streamed || !next) {
          coolDown("gemini", err);
          throw err;
        }
        logFallback("gemini", next, err);
        const messages = geminiToOpenAi(opts.system, state.contents);
        return openAiToolLoop(env, next, opts, { engine: next, round: state.round, messages, slots: [] });
      }
    }
    const paused = state as Extract<LoopState, { engine: OpenAiEngine }>;
    for (const slot of paused.slots) paused.messages[slot.index].content = toolResultText(result(slot.id));
    // Paused on an engine retired since (DeepSeek or Workers AI, before v1; a
    // paused turn keeps for ten minutes): the one there is now carries on.
    if (!isOpenAiEngine(paused.engine as string)) {
      const next = openAiNow();
      if (!next) throw new Error("That turn was paused on an engine OVOA no longer uses. Ask again.");
      const messages = paused.messages.map(({ reasoning_content: _, ...message }) => message);
      return openAiToolLoop(env, next, opts, { ...paused, engine: next, messages });
    }
    return openAiToolLoop(env, paused.engine, opts, paused);
  }

  let committed = false;
  const tracked: CallTool = (name, args) => {
    committed = true;
    return opts.callTool(name, args);
  };
  const onText: OnText | undefined = opts.onText
    ? (delta) => {
        committed = true;
        return opts.onText!(delta);
      }
    : undefined;
  const order = engines(env, !!opts.voice, opts.prefer);
  const failures: string[] = [];
  reportSkipped(env, opts.model, opts.onAttempt);
  if (!order.length) throw nothingToTry(env, opts.model, opts.onAttempt);
  for (const [i, engine] of order.entries()) {
    const at = Date.now();
    const model = modelFor(env, engine, opts.model);
    try {
      const run = { ...opts, callTool: tracked, onText };
      const outcome = engine === "gemini" ? await geminiToolLoop(env, run) : await openAiToolLoop(env, engine, run);
      opts.onAttempt?.({ engine, model, outcome: outcome.kind === "paused" ? "paused" : "ok", ms: Date.now() - at });
      return outcome;
    } catch (err) {
      const brief = String(err instanceof Error ? err.message : err).slice(0, 300);
      opts.onAttempt?.({ engine, model, outcome: classifyEngineError(err), ms: Date.now() - at, error: brief });
      if (committed) {
        // Something was already said or done: this turn failed, the AI was reachable.
        coolDown(engine, err);
        throw finalError(err, failures, order);
      }
      if (i === order.length - 1) {
        coolDown(engine, err);
        throw unreachable(err, failures, order);
      }
      failures.push(`${nameOf(engine)}: ${brief.slice(0, 200)}`);
      logFallback(engine, order[i + 1], err);
    }
  }
  throw new Error("No engines");
}

// ---------- Deadlines ----------
//
// Nothing here used to wait for anything. A model that accepted the request and
// then said nothing held the turn open until the phone gave up at 60 s
// ("POST /chat stalled after 60029 ms", device_logs 2026-09-21) and the Worker
// never found out it had happened. Giving up at 20 s and losing the turn is
// worse than a fast answer, but it is far better than silence: the error names
// the engine, cools it down, and the next engine gets the turn.

/** How long an engine has to send its first byte. */
const DEFAULT_CONNECT_MS = 20_000;
/** How long a stream may go quiet once it has started. */
const DEFAULT_IDLE_MS = 25_000;

let connectMs = DEFAULT_CONNECT_MS;
let idleMs = DEFAULT_IDLE_MS;

/**
 * Both deadlines are read from the environment on every turn, so a model that
 * turns out to need 30 s can be given it with `wrangler secret put` in half a
 * minute. Hard-coding them would mean a deploy to undo a bad guess, with every
 * turn failing until it landed.
 */
function applyDeadlines(env: LlmEnv) {
  const read = (raw: string | undefined, fallback: number) => {
    const ms = Number(raw);
    return Number.isFinite(ms) && ms >= 1000 ? ms : fallback;
  };
  connectMs = read(env.MODEL_CONNECT_MS, DEFAULT_CONNECT_MS);
  idleMs = read(env.MODEL_IDLE_MS, DEFAULT_IDLE_MS);
}

/**
 * fetch with a deadline on the headers only. The timer is cleared once they
 * arrive, because the same signal would otherwise abort a long reply midway
 * through; the body is watched by withIdleDeadline instead.
 */
async function fetchWithDeadline(url: string, init: RequestInit) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error(`Timed out after ${connectMs / 1000} s waiting for the model`)), connectMs);
  try {
    return await fetch(url, { ...init, signal: abort.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Rejects if one read takes too long. A stream that goes quiet is the 60 s stall. */
function withIdleDeadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    work.finally(() => {
      if (timer !== null) clearTimeout(timer);
    }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`No output from the model for ${idleMs / 1000} s`)), idleMs);
    }),
  ]);
}

// ---------- Streaming ----------

/** The `data:` payloads of a server-sent-events stream. */
async function* sseData(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const payload = (line: string) => {
    const l = line.trim();
    if (!l.startsWith("data:")) return null;
    const data = l.slice(5).trim();
    return data && data !== "[DONE]" ? data : null;
  };
  try {
    while (true) {
      const { done, value } = await withIdleDeadline(reader.read());
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const data = payload(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        if (data) yield data;
      }
    }
    const data = payload(buffer);
    if (data) yield data;
  } finally {
    // Stopping early (a long-enough spoken reply) also stops the model upstream.
    reader.cancel().catch(() => {});
  }
}

// ---------- Gemini ----------

/** Gemini wants an object; oversized results go as truncated text. */
function geminiResponse(result: unknown) {
  const text = toolResultText(result);
  return { result: text.length > MAX_TOOL_RESULT_CHARS ? text : (result ?? null) };
}

/**
 * One model turn. Streamed when `onText` is set; either way returns the full
 * turn, with the token counts Gemini attached to it (usageMetadata: sent whole
 * on a plain call, and on every streamed chunk with the last one being the total).
 */
async function geminiRound(
  apiKey: string,
  model: string,
  body: unknown,
  onText?: OnText,
): Promise<{ content: { role: string; parts: any[] }; usage: TokenUsage | null }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${onText ? "streamGenerateContent?alt=sse" : "generateContent"}`;
  const res = await fetchWithDeadline(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Gemini ${model} ${res.status}: ${(await res.text()).slice(0, 500)}`);
  if (!onText) {
    const data = (await res.json()) as any;
    return { content: data.candidates?.[0]?.content ?? { role: "model", parts: [] }, usage: readGeminiUsage(data.usageMetadata) };
  }
  // Keep every part as it arrived: function calls carry thought signatures Gemini wants back.
  const parts: any[] = [];
  let usage: TokenUsage | null = null;
  for await (const data of sseData(res.body!)) {
    const chunk = JSON.parse(data);
    usage = readGeminiUsage(chunk.usageMetadata) ?? usage;
    let stop = false;
    for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
      parts.push(part);
      if (part.text && !part.thought && onText(part.text) === false) stop = true;
    }
    if (stop) break;
  }
  return { content: { role: "model", parts }, usage };
}

async function geminiToolLoop(
  env: LlmEnv,
  opts: ToolLoopOptions,
  paused?: Extract<LoopState, { engine: "gemini" }>,
): Promise<ChatOutcome> {
  const { model, system, turns, tools, callTool, voice, onText } = opts;
  const contents: any[] = paused?.contents ?? turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] }));

  for (let round = paused?.round ?? 0; round <= MAX_TOOL_ROUNDS; round++) {
    const at = Date.now();
    const { content, usage } = await geminiRound(
      env.GEMINI_API_KEY!,
      model,
      {
        systemInstruction: { parts: [{ text: system }] },
        contents,
        // No tools on the last round, so the model has to answer.
        ...(round < MAX_TOOL_ROUNDS && tools.length && { tools: [{ functionDeclarations: tools }] }),
        // Spoken replies are short: as little thinking as the model takes, which
        // is much faster (gemini.ts quickThinking says how little that is).
        ...(voice && { generationConfig: { thinkingConfig: { thinkingLevel: quickThinking(model) } } }),
      },
      onText,
    );
    reportUsage(env, opts, "gemini", model, usage, Date.now() - at);
    const parts: any[] = content.parts ?? [];
    const calls = parts.filter((p) => p.functionCall);

    if (!calls.length) {
      const text = parts
        .filter((p) => p.text && !p.thought)
        .map((p) => p.text)
        .join("");
      if (!text) throw new Error(`Gemini ${model} returned no text`);
      return { kind: "reply", text, engine: "gemini" };
    }

    // Send the model's turn back verbatim: it carries thought signatures Gemini requires.
    contents.push(content);
    const responses = [];
    const slots: { id: string; part: number }[] = [];
    const deferred: DeferredCall[] = [];
    for (const { functionCall: fc } of calls) {
      const args = fc.args ?? {};
      const result = await safeCall(callTool, fc.name, args);
      let response;
      if (result === DEFER) {
        const id = crypto.randomUUID();
        slots.push({ id, part: responses.length });
        deferred.push({ id, name: fc.name, args });
        response = { result: null }; // filled in on resume
      } else {
        response = geminiResponse(result);
      }
      responses.push({ functionResponse: { ...(fc.id && { id: fc.id }), name: fc.name, response } });
    }
    contents.push({ role: "user", parts: responses });
    if (deferred.length) {
      return { kind: "paused", state: { engine: "gemini", round: round + 1, contents, slots }, calls: deferred, engine: "gemini" };
    }
  }
  throw new Error("Too many tool rounds");
}

/** A Gemini conversation (with its tool calls and results) as OpenAI-style messages. */
function geminiToOpenAi(system: string, contents: any[]): any[] {
  const messages: any[] = [{ role: "system", content: system }];
  let callCount = 0;
  const pending: string[] = []; // ids of calls waiting for their results, in order
  for (const content of contents) {
    const parts: any[] = content.parts ?? [];
    const text = parts
      .filter((p) => p.text && !p.thought)
      .map((p) => p.text)
      .join("");
    const calls = parts.filter((p) => p.functionCall);
    const results = parts.filter((p) => p.functionResponse);
    if (content.role === "model") {
      const toolCalls = calls.map((p) => {
        const id = `call_${callCount++}`;
        pending.push(id);
        return { id, type: "function", function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) } };
      });
      messages.push({ role: "assistant", content: text, ...(toolCalls.length && { tool_calls: toolCalls }) });
    } else if (results.length) {
      for (const p of results) {
        messages.push({ role: "tool", tool_call_id: pending.shift() ?? `call_${callCount++}`, content: toolResultText(p.functionResponse.response) });
      }
    } else {
      messages.push({ role: "user", content: text });
    }
  }
  return messages;
}

// ---------- OpenAI-compatible engines ----------

/** The engines reached through an OpenAI-compatible chat-completions API (OPENAI_PROVIDERS). */
type OpenAiEngine = "glm";

/**
 * One OpenAI-compatible provider, as the names of the vars that configure it,
 * so a new one is an entry here plus its vars (see the top of this file).
 */
type OpenAiProvider = {
  /**
   * What people and the logs call it. Its errors start "<name> <model> <status>:",
   * which is the shape coolDown and classifyEngineError read.
   */
  name: string;
  /** The secret holding its key. Without it the engine does not exist. */
  keyVar: string;
  /** The var holding its base URL (with or without /chat/completions), and the URL when it is unset. */
  baseUrlVar: string;
  defaultBaseUrl: string;
  /** The var holding the model id, as the provider knows it, and the id when it is unset. Priced by this id (pricing.ts). */
  modelVar: string;
  defaultModel: string;
  /** The var saying how much it thinks on a typed turn: "off", "low" (the default) or "on". */
  thinkingVar: string;
};

export const OPENAI_PROVIDERS: Record<OpenAiEngine, OpenAiProvider> = {
  // GLM 5.3 Flash on the user's own Z.ai account. OpenRouter calls it
  // z-ai/glm-5.3-flash; its price is GLM_PRICE_* or pricing.ts's default.
  glm: {
    name: "GLM",
    keyVar: "GLM_API_KEY",
    baseUrlVar: "GLM_BASE_URL",
    defaultBaseUrl: "https://api.z.ai/api/paas/v4",
    modelVar: "GLM_MODEL",
    defaultModel: "glm-5.3-flash",
    thinkingVar: "GLM_THINKING",
  },
};

/**
 * A var by its name, trimmed; undefined when unset or blank. The providers'
 * vars are read this way, so a new provider needs no new field in LlmEnv.
 */
function varOf(env: LlmEnv, name: string): string | undefined {
  const value = (env as Record<string, unknown>)[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** The secret an engine needs to exist. */
function keyVarOf(engine: Engine) {
  return engine === "gemini" ? "GEMINI_API_KEY" : OPENAI_PROVIDERS[engine].keyVar;
}

/** Where a provider is: its base URL var, else its default. */
function baseUrlOf(env: LlmEnv, engine: OpenAiEngine) {
  return varOf(env, OPENAI_PROVIDERS[engine].baseUrlVar) ?? OPENAI_PROVIDERS[engine].defaultBaseUrl;
}

type OpenAiOut = {
  choices?: { message?: { content?: string | null; tool_calls?: any[] } }[];
  usage?: unknown;
};

/** The request body: the standard fields plus whatever thinkingFields adds for the model. */
type OpenAiBody = { messages: any[]; tools?: any[]; max_tokens: number } & Record<string, unknown>;

/** One assistant message, however it arrived, with the counts the provider attached. */
type OpenAiMessage = { content: string; tool_calls: any[]; usage: TokenUsage | null };

// ---------- Thinking ----------
//
// Every reasoning model bills its thinking as output tokens, at the output
// price, and thinks a lot by default: GLM 5.3 Flash at "max". On a spoken turn
// that is seconds of silence before the first word, paid for. So thinking is
// off for spoken and quick calls and low for typed ones, and each host is told
// in the words it understands, because they differ: Z.ai's GLM 5.3 cannot
// switch off at all (its floor is "low"), OpenRouter wants a `reasoning`
// object, and any other OpenAI-compatible host gets the plain OpenAI field.
// Keyed off the host and the model id.

export type ThinkingLevel = "off" | "low" | "on";

/** Which kind of OpenAI-compatible host a provider is on. Decides how thinking is spelled. */
export type HostFlavor = "zai" | "openrouter" | "openai";

export function hostFlavor(baseUrl: string): HostFlavor {
  const url = baseUrl.toLowerCase();
  if (/(^|\/\/|\.)(api\.)?z\.ai(\/|$)/.test(url) || url.includes("bigmodel.cn")) return "zai";
  if (url.includes("openrouter.ai")) return "openrouter";
  return "openai";
}

/** The chat-completions endpoint under a base URL, given with or without the path. */
export function chatCompletionsUrl(baseUrl: string) {
  const base = baseUrl.trim().replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
  return `${base}/chat/completions`;
}

/** "off" | "low" | "on" from a var, with a few spellings people use; anything else is the default. */
function parseThinking(raw: string | undefined, fallback: ThinkingLevel): ThinkingLevel {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "off" || v === "none" || v === "false" || v === "0") return "off";
  if (v === "low" || v === "minimal") return "low";
  if (v === "on" || v === "high" || v === "max" || v === "true" || v === "1") return "on";
  return fallback;
}

/** How much this call should think. Spoken and quick calls never do; typed turns do a little, or what the provider's var says. */
export function thinkingLevelFor(env: LlmEnv, engine: OpenAiEngine, voiceOrFast: boolean): ThinkingLevel {
  if (voiceOrFast) return "off";
  return parseThinking(varOf(env, OPENAI_PROVIDERS[engine].thinkingVar), "low");
}

/**
 * The request fields that ask for `level` of thinking from `model` on a host
 * of this flavor. Pure, so every host's spelling is checked by a test rather
 * than by a 400 in production.
 */
export function thinkingFields(model: string, level: ThinkingLevel, flavor: HostFlavor): Record<string, unknown> {
  const m = model.toLowerCase();
  if (flavor === "zai") {
    // GLM 5.3 (and 5.3 Flash) refuse thinking.type "disabled"; "low" is their floor.
    // reasoning_effort exists from GLM 5.2 up; older models only have the switch.
    const cannotDisable = /glm-5\.3/.test(m);
    const hasEffort = /glm-5\.[2-9]|glm-[6-9]/.test(m);
    if (level === "off" && !cannotDisable) return { thinking: { type: "disabled" } };
    if (!hasEffort) return { thinking: { type: "enabled" } };
    return { thinking: { type: "enabled" }, reasoning_effort: level === "on" ? "high" : "low" };
  }
  if (flavor === "openrouter") {
    // `exclude` keeps the reasoning out of the reply (it is still billed).
    const mandatory = /glm-5\.3/.test(m);
    if (level === "off" && !mandatory) return { reasoning: { enabled: false } };
    return { reasoning: { effort: level === "on" ? "high" : "low", exclude: true } };
  }
  // Any other OpenAI-compatible host: the plain OpenAI field, and nothing exotic.
  return { reasoning_effort: level === "on" ? "high" : "low" };
}

async function openAiCall(env: LlmEnv, engine: OpenAiEngine, body: OpenAiBody, stream: boolean): Promise<any> {
  const provider = OPENAI_PROVIDERS[engine];
  const model = modelFor(env, engine, "");
  const base = baseUrlOf(env, engine);
  const flavor = hostFlavor(base);
  const res = await fetchWithDeadline(chatCompletionsUrl(base), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${varOf(env, provider.keyVar)}` },
    body: JSON.stringify({
      model,
      ...body,
      // A stream ends with the token counts only when asked (OpenAI's
      // stream_options). Z.ai sends them on its last chunk without being asked
      // and documents no stream_options; it does take tool_stream, which streams
      // a tool call's arguments as they are written rather than all at the end.
      ...(stream && { stream: true, ...(flavor === "zai" ? { tool_stream: true } : { stream_options: { include_usage: true } }) }),
    }),
  });
  // "<name> <model> <status>:" is the shape coolDown and classifyEngineError read.
  if (!res.ok) throw new Error(`${provider.name} ${model} ${res.status}: ${(await res.text()).slice(0, 500)}`);
  return stream ? res.body : res.json();
}

function openAiText(out: OpenAiOut) {
  return stripThinking(out.choices?.[0]?.message?.content ?? "");
}

/** One model turn. Streamed when `onText` is set; either way returns the whole message. */
async function openAiRound(env: LlmEnv, engine: OpenAiEngine, body: OpenAiBody, onText?: OnText): Promise<OpenAiMessage> {
  if (!onText) {
    const out = (await openAiCall(env, engine, body, false)) as OpenAiOut;
    return {
      content: openAiText(out),
      tool_calls: out.choices?.[0]?.message?.tool_calls ?? [],
      usage: readOpenAiUsage(out.usage),
    };
  }
  const stream = (await openAiCall(env, engine, body, true)) as ReadableStream<Uint8Array>;
  let content = "";
  let usage: TokenUsage | null = null;
  const calls: any[] = [];
  for await (const data of sseData(stream)) {
    const chunk = JSON.parse(data);
    // The counts ride on the last chunk (Z.ai always; other hosts when asked
    // with stream_options). Stopping a reply early gives up the counts too.
    usage = readOpenAiUsage(chunk.usage) ?? usage;
    const delta = chunk.choices?.[0]?.delta;
    const text: string = delta?.content ?? "";
    for (const tc of delta?.tool_calls ?? []) {
      const slot = (calls[tc.index ?? 0] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.function.name += tc.function.name;
      if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
    }
    if (text) {
      content += text;
      if (onText(text) === false) break;
    }
  }
  return { content: stripThinking(content), tool_calls: calls.filter(Boolean), usage };
}

async function openAiGenerate(env: LlmEnv, engine: OpenAiEngine, opts: Options): Promise<string> {
  const { system, turns, json, fast } = opts;
  const systemText = json
    ? `${system}\n\nRespond with only a JSON object matching this JSON schema, no other text:\n${JSON.stringify(json.schema)}`
    : system;

  const at = Date.now();
  const model = modelFor(env, engine, opts.model);
  const { content, usage } = await openAiRound(env, engine, {
    messages: [
      { role: "system", content: systemText },
      ...turns.map((t) => ({ role: t.role === "model" ? "assistant" : "user", content: t.text })),
    ],
    max_tokens: 2048,
    ...thinkingFields(model, thinkingLevelFor(env, engine, !!fast), hostFlavor(baseUrlOf(env, engine))),
  });
  reportUsage(env, opts, engine, model, usage, Date.now() - at);

  let text = content;
  if (json) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`${nameOf(engine)} returned no JSON: ${text.slice(0, 200)}`);
    text = match[0];
  }
  if (!text) throw new Error(`${nameOf(engine)} returned no text`);
  return text;
}

async function openAiToolLoop(
  env: LlmEnv,
  engine: OpenAiEngine,
  opts: ToolLoopOptions,
  paused?: Extract<LoopState, { engine: OpenAiEngine }>,
): Promise<ChatOutcome> {
  const { system, turns, tools, callTool, voice, onText } = opts;
  const messages: any[] = paused?.messages ?? [
    { role: "system", content: system },
    ...turns.map((t) => ({ role: t.role === "model" ? "assistant" : "user", content: t.text })),
  ];
  const model = modelFor(env, engine, opts.model);
  // Spoken turns think as little as the host allows: much sooner to the first
  // word, and tool calls still work. See thinkingFields.
  const thinking = thinkingFields(model, thinkingLevelFor(env, engine, !!voice), hostFlavor(baseUrlOf(env, engine)));
  for (let round = paused?.round ?? 0; round <= MAX_TOOL_ROUNDS; round++) {
    // Built each round rather than once: a spoken turn starts with a handful of
    // tools and sends for more mid-turn (toolbelt.ts), and those have to be in
    // front of the model on the step after it asked for them. Gemini's loop
    // already re-read the array; this one used to freeze it.
    const toolDefs = tools.map((t) => ({ type: "function", function: t }));
    const at = Date.now();
    const message = await openAiRound(
      env,
      engine,
      {
        messages,
        ...(round < MAX_TOOL_ROUNDS && toolDefs.length && { tools: toolDefs }),
        max_tokens: 4096,
        ...thinking,
      },
      onText,
    );
    reportUsage(env, opts, engine, model, message.usage, Date.now() - at);

    const calls = message.tool_calls;
    if (!calls.length) {
      if (!message.content) throw new Error(`${nameOf(engine)} returned no text`);
      return { kind: "reply", text: message.content, engine };
    }

    // Content is never null on an assistant turn (some hosts reject it). The
    // model's reasoning is not sent back: GLM's hosts neither need it nor
    // promise to accept it, and it is never spoken or shown.
    messages.push({ role: "assistant", content: message.content ?? "", tool_calls: calls });
    const slots: { id: string; index: number }[] = [];
    const deferred: DeferredCall[] = [];
    for (const call of calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function?.arguments || "{}");
      } catch {}
      const result = await safeCall(callTool, call.function?.name, args);
      let content = "";
      if (result === DEFER) {
        const id = crypto.randomUUID();
        slots.push({ id, index: messages.length }); // filled in on resume
        deferred.push({ id, name: call.function?.name, args });
      } else {
        content = toolResultText(result);
      }
      messages.push({ role: "tool", tool_call_id: call.id, content });
    }
    if (deferred.length) {
      return { kind: "paused", state: { engine, round: round + 1, messages, slots }, calls: deferred, engine };
    }
  }
  throw new Error("Too many tool rounds");
}
