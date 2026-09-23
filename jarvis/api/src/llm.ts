import { generate as geminiGenerate, type Turn } from "./gemini";

export type { Turn };

export type LlmEnv = {
  AI: Ai;
  GEMINI_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_MODEL: string;
  /**
   * How much DeepSeek thinks on a typed turn: "off", "low" or "on" (its own
   * default, which is a lot). Thinking is billed as output at four times the
   * input price, and DeepSeek thinks hard unless told otherwise. Spoken turns
   * never think: the wait before the first word is the whole experience there.
   */
  DEEPSEEK_THINKING?: string;
  /** The Workers AI model, and the last resort when everything keyed has failed. */
  FALLBACK_MODEL: string;
  CHAT_MODEL?: string;
  /**
   * GLM 5.3 Flash from the user's own provider. Without the key the engine does
   * not exist: it is never tried, never skipped, never mentioned. The base URL
   * is any OpenAI-compatible endpoint (Z.ai's by default; OpenRouter and the
   * like work too, and the thinking fields are shaped for whichever it is).
   */
  GLM_API_KEY?: string;
  GLM_BASE_URL?: string;
  GLM_MODEL?: string;
  /** Like DEEPSEEK_THINKING, for GLM: "off", "low" (the default) or "on". */
  GLM_THINKING?: string;
  /** Which keyed engine typed turns try first: "gemini", "deepseek" or "glm". */
  PRIMARY_ENGINE?: string;
  /**
   * The whole order, e.g. "glm,deepseek,gemini,workers". Overrides
   * PRIMARY_ENGINE. Workers AI stays last as the safety net unless it is named.
   */
  ENGINE_ORDER?: string;
  /**
   * Which engine answers spoken turns first. "workers" (the default) because on
   * the wrist the wait before the first word is the whole experience, and the
   * measured first token is 1.0-2.9 s on Workers AI against 4.3-14.1 s on the
   * free-tier Gemini key (device_logs, 2026-09-21). "keyed" restores the usual
   * order for everything, and an engine name puts that engine first.
   */
  VOICE_PRIMARY?: string;
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
   * Quick yes/no calls: tried on Workers AI first so they don't spend the
   * Gemini/DeepSeek quota, and every engine skips most of its thinking.
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
 * OpenAI-style usage. DeepSeek splits the prompt into cache hits and misses;
 * OpenAI, OpenRouter and Z.ai put the hits under prompt_tokens_details;
 * Workers AI sends the plain three. All of them count thinking in
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
  /**
   * Whose turn this is. Workers AI keeps a prompt it has just read on the model
   * server that read it, and routes requests carrying the same x-session-affinity
   * there, so one person's next turn skips re-reading everything it has in common
   * with their last. Without it, turns land on any server and the cache is luck.
   */
  affinity?: string;
};

export type Engine = "gemini" | OpenAiEngine;

/** Every engine there is, in the order they are tried when nothing says otherwise. */
export const ENGINES: Engine[] = ["gemini", "deepseek", "glm", "workers"];
export const isEngine = (name: string): name is Engine => (ENGINES as string[]).includes(name);

const ENGINE_NAMES: Record<Engine, string> = { gemini: "Gemini", deepseek: "DeepSeek", glm: "GLM", workers: "Workers AI" };

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
  if (engine === "workers") {
    // The last resort is always tried, unless its free daily allocation is used up (4006):
    // then skip it until it resets at midnight UTC, so quick calls go to the others instead.
    if (/4006|daily free allocation/.test(text)) cooldownUntil.set(engine, new Date().setUTCHours(24, 0, 0, 0));
    return;
  }
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
//   1. The vars in wrangler.jsonc (PRIMARY_ENGINE, ENGINE_ORDER, VOICE_PRIMARY).
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
  /** "glm,deepseek,gemini,workers": the order typed turns try. Unknown names are ignored. */
  order?: string;
  /** "workers" | "keyed" | an engine name: who answers spoken turns first. */
  voice?: string;
  /** The Workers AI model to use instead of FALLBACK_MODEL. */
  workersModel?: string;
};

let runtime: EnginePrefs = {};

/** The runtime settings (server_settings) for this isolate. index.ts sets them on every request and tick. */
export function setRuntimeEngines(prefs: EnginePrefs) {
  runtime = prefs;
}

export type OrderInput = {
  /** Which engines have what they need to be called at all. Workers AI always does. */
  available: Record<Engine, boolean>;
  /** Engines being skipped, and until when. */
  cooling: Partial<Record<Engine, number>>;
  now: number;
  voice: boolean;
  /** A quick yes/no call: Workers AI first, whatever else is set. */
  fast: boolean;
  primary?: string;
  order?: string;
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
 * The engines to try, first to last. Pure.
 *
 * An explicit order names the keyed engines in the order wanted; PRIMARY_ENGINE
 * only moves one to the front. Either way, an engine without its key is left
 * out (it does not exist, so it is not "skipped"), Workers AI closes the list
 * unless it was placed on purpose, and an engine cooling down from a failure
 * waits its turn out. With nothing left to try, Workers AI is tried anyway:
 * a 4006 from it is a better answer than silence.
 *
 * Spoken turns go to whichever engine reaches the first word soonest, which is
 * Workers AI unless VOICE_PRIMARY names another or says "keyed".
 */
export function engineOrder(i: OrderInput): Engine[] {
  const usable = (e: Engine) => i.available[e] && (i.cooling[e] ?? 0) <= i.now;
  let list: Engine[];
  const explicit = parseOrder(i.order);
  if (explicit.length) {
    list = explicit;
    if (!list.includes("workers")) list.push("workers");
  } else {
    const keyed: Engine[] = ["gemini", "deepseek", "glm"];
    const primary = (i.primary ?? "").trim().toLowerCase();
    if (isEngine(primary) && primary !== "workers") list = [primary, ...keyed.filter((e) => e !== primary)];
    else list = keyed;
    list.push("workers");
  }
  let ready = list.filter(usable);
  if (!ready.length) return ["workers"];
  const first = (e: Engine) => (ready.includes(e) ? [e, ...ready.filter((x) => x !== e)] : ready);
  if (i.fast) return first("workers");
  if (i.voice) {
    const want = (i.voicePrimary ?? "workers").trim().toLowerCase();
    if (want === "keyed") return ready;
    // A named engine that is missing or cooling: Workers AI answers, as it
    // would have with nothing set, rather than whatever happens to be first.
    if (isEngine(want) && ready.includes(want)) return first(want);
    return first("workers");
  }
  return ready;
}

/** Which engines have what they need. Workers AI is a binding, always there. */
function availableEngines(env: LlmEnv): Record<Engine, boolean> {
  return { gemini: !!env.GEMINI_API_KEY, deepseek: !!env.DEEPSEEK_API_KEY, glm: !!env.GLM_API_KEY, workers: true };
}

function coolingNow(): Partial<Record<Engine, number>> {
  const out: Partial<Record<Engine, number>> = {};
  const now = Date.now();
  for (const [engine, until] of cooldownUntil) if (until > now) out[engine] = until;
  return out;
}

/** The order for one call: the vars, the runtime settings and the caller's own preferences, in that order of precedence. */
function engines(env: LlmEnv, voice = false, fast = false, prefer?: EnginePrefs): Engine[] {
  return engineOrder({
    available: availableEngines(env),
    cooling: coolingNow(),
    now: Date.now(),
    voice,
    fast,
    primary: env.PRIMARY_ENGINE,
    order: prefer?.order ?? runtime.order ?? env.ENGINE_ORDER,
    voicePrimary: prefer?.voice ?? runtime.voice ?? env.VOICE_PRIMARY,
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
        name: ENGINE_NAMES[engine],
        key: engine === "workers" ? "not needed" : available[engine] ? "set" : "missing",
        model: available[engine] ? modelFor(env, engine, env.CHAT_MODEL ?? "", prefer) : null,
        coolingForS: until > now ? Math.round((until - now) / 1000) : 0,
        lastError: lastFailure.get(engine) ?? null,
      };
    }),
    typedOrder: engines(env, false, false, prefer),
    voiceOrder: engines(env, true, false, prefer),
    settings: { vars: { PRIMARY_ENGINE: env.PRIMARY_ENGINE, ENGINE_ORDER: env.ENGINE_ORDER, VOICE_PRIMARY: env.VOICE_PRIMARY, FALLBACK_MODEL: env.FALLBACK_MODEL }, runtime, ...(prefer && { mine: prefer }) },
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
    .map(([engine]) => `${ENGINE_NAMES[engine]}: ${lastFailure.get(engine) ?? "unknown"}`);
}

/**
 * What went wrong, in one word, so a day's failures group into a handful of
 * rows instead of a thousand distinct strings. The status is read the same way
 * coolDown reads it, because the messages are built as
 * "DeepSeek deepseek-flash 402: …" a few functions below. The two text tests
 * are the failures that carry no status: Workers AI's 4006 and DeepSeek's
 * "Insufficient Balance".
 */
export function classifyEngineError(err: unknown): string {
  const text = String(err instanceof Error ? err.message : err);
  if (/4006|daily free allocation/.test(text)) return "out_of_free";
  if (/Insufficient Balance/i.test(text)) return "no_credit";
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
 * Why nothing could answer, as a sentence a person can read. Pure, so the
 * wording is testable without faking a failed engine.
 *
 * The phone has no way to see the Worker's console, so when every engine is
 * down this is the only place the reason can come from. The alternative is what
 * 2026-09-21 looked like: 166 identical "couldn't get a reply" lines and no
 * indication anywhere that the answer was "the DeepSeek account is empty".
 */
export function troubleFrom(down: EngineDown[], now: number): string | null {
  if (!down.length) return null;
  const why = (text: string) => {
    if (/4006|daily free allocation/.test(text)) return "out of free usage until midnight UTC";
    if (/Insufficient Balance/i.test(text) || / 402:/.test(text)) return "out of credit";
    if (/ 429:/.test(text)) return /quota/i.test(text) ? "out of quota for today" : "rate limited";
    if (/ 401:| 403:/.test(text)) return "not accepting its key";
    if (/ 404:/.test(text)) return "missing its model";
    return "failing";
  };
  const parts = down.map((d) => `${ENGINE_NAMES[d.engine]} is ${why(d.error)}`);
  const wait = Math.max(0, Math.min(...down.map((d) => d.until)) - now);
  const mins = Math.max(1, Math.round(wait / 60_000));
  const when = mins >= 120 ? `${Math.round(mins / 60)} hours` : `${mins} minute${mins === 1 ? "" : "s"}`;
  return `${parts.join(", and ")}. The soonest any of them is tried again is about ${when} from now.`;
}

/**
 * troubleFrom, fed the live cooldown state — but only when there is nothing left
 * to try. One engine cooling down while another answers is not trouble, it is
 * the fallback working; saying otherwise turned every unrelated 500 on every
 * route into "OVOA can't reach an AI model right now".
 */
export function engineTrouble(env: LlmEnv) {
  const now = Date.now();
  const available = availableEngines(env);
  // Trouble is when every engine that exists is cooling down, Workers AI included.
  // (engines() would still hand back Workers AI as a last resort, so it cannot
  // be asked; this asks the cooldowns directly.)
  const anyReady = ENGINES.some((e) => available[e] && (cooldownUntil.get(e) ?? 0) <= now);
  if (anyReady) return null;
  const down: EngineDown[] = [];
  for (const [engine, until] of cooldownUntil) {
    if (until > now) down.push({ engine, until, error: lastFailure.get(engine) ?? "" });
  }
  return troubleFrom(down, now);
}

/** The Workers AI model: the runtime setting or a person's own choice, else the var. */
function workersModel(env: LlmEnv, prefer?: EnginePrefs) {
  return prefer?.workersModel || runtime.workersModel || env.FALLBACK_MODEL;
}

/** Which model each engine is actually about to call, for the record. */
function modelFor(env: LlmEnv, engine: Engine, model: string, prefer?: EnginePrefs) {
  switch (engine) {
    case "gemini":
      return model;
    case "deepseek":
      return env.DEEPSEEK_MODEL;
    case "glm":
      return env.GLM_MODEL || "glm-5.3-flash";
    default:
      return workersModel(env, prefer);
  }
}

/**
 * The engines that were not even tried this turn. Reported alongside the ones
 * that were, so "which were dead" and "which answered" come out of the same
 * table rather than one being a console line that expires in three days.
 */
function reportSkipped(env: LlmEnv, model: string, onAttempt?: OnAttempt, prefer?: EnginePrefs) {
  if (!onAttempt) return;
  const now = Date.now();
  for (const [engine, until] of cooldownUntil) {
    if (until > now) {
      onAttempt({ engine, model: modelFor(env, engine, model, prefer), outcome: "skipped", ms: 0, error: lastFailure.get(engine) });
    }
  }
}

/** The last engine's error, naming what the earlier ones failed with. */
function finalError(err: unknown, failures: string[]) {
  const now = Date.now();
  for (const [engine, until] of cooldownUntil) {
    if (until > now && engine !== "workers") failures.push(`${ENGINE_NAMES[engine]} skipped, it failed with ${lastFailure.get(engine)}`);
  }
  if (!failures.length) return err;
  const brief = (e: unknown) => String(e instanceof Error ? e.message : e).slice(0, 200);
  return new Error(`${brief(err)} (earlier: ${failures.join("; ")})`);
}

function logFallback(from: Engine, to: Engine, err: unknown) {
  coolDown(from, err);
  console.error(`${ENGINE_NAMES[from]} failed, using ${ENGINE_NAMES[to]} fallback`, err);
}

export async function generateText(env: LlmEnv, opts: Options): Promise<string> {
  applyDeadlines(env);
  const order = engines(env, false, !!opts.fast, opts.prefer);
  const failures: string[] = [];
  reportSkipped(env, opts.model, opts.onAttempt, opts.prefer);
  for (const [i, engine] of order.entries()) {
    const at = Date.now();
    const model = modelFor(env, engine, opts.model, opts.prefer);
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
        throw finalError(err, failures);
      }
      failures.push(`${ENGINE_NAMES[engine]}: ${brief.slice(0, 200)}`);
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
        // Out of quota halfway through: finish the turn on Workers AI with what's been looked up.
        if (streamed || (cooldownUntil.get("workers") ?? 0) > Date.now()) {
          coolDown("gemini", err);
          throw err;
        }
        logFallback("gemini", "workers", err);
        const messages = geminiToOpenAi(opts.system, state.contents);
        return openAiToolLoop(env, "workers", opts, { engine: "workers", round: state.round, messages, slots: [] });
      }
    }
    for (const slot of state.slots) state.messages[slot.index].content = toolResultText(result(slot.id));
    return openAiToolLoop(env, state.engine, opts, state);
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
  const order = engines(env, !!opts.voice, false, opts.prefer);
  const failures: string[] = [];
  reportSkipped(env, opts.model, opts.onAttempt, opts.prefer);
  for (const [i, engine] of order.entries()) {
    const at = Date.now();
    const model = modelFor(env, engine, opts.model, opts.prefer);
    try {
      const run = { ...opts, callTool: tracked, onText };
      const outcome = engine === "gemini" ? await geminiToolLoop(env, run) : await openAiToolLoop(env, engine, run);
      opts.onAttempt?.({ engine, model, outcome: outcome.kind === "paused" ? "paused" : "ok", ms: Date.now() - at });
      return outcome;
    } catch (err) {
      const brief = String(err instanceof Error ? err.message : err).slice(0, 300);
      opts.onAttempt?.({ engine, model, outcome: classifyEngineError(err), ms: Date.now() - at, error: brief });
      if (committed || i === order.length - 1) {
        coolDown(engine, err);
        throw finalError(err, failures);
      }
      failures.push(`${ENGINE_NAMES[engine]}: ${brief.slice(0, 200)}`);
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
        // Spoken replies are short: a little thinking is plenty, and much faster.
        // ("minimal" would be faster still, but gemini-3.8-flash rejects it: 400,
        // "Thinking level MINIMAL is not supported for this model", 2026-09-21.)
        ...(voice && { generationConfig: { thinkingConfig: { thinkingLevel: "low" } } }),
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

// ---------- OpenAI-style engines (DeepSeek, GLM, Workers AI) ----------

type OpenAiEngine = "deepseek" | "glm" | "workers";

type OpenAiOut = {
  response?: string | object;
  choices?: { message?: { content?: string | null; reasoning_content?: string; tool_calls?: any[] } }[];
  usage?: unknown;
};

/** The request body: the standard fields plus whatever thinkingFields adds for the model. */
type OpenAiBody = { messages: any[]; tools?: any[]; max_tokens: number } & Record<string, unknown>;

/** One assistant message, however it arrived, with the counts the provider attached. */
type OpenAiMessage = { content: string; reasoning_content?: string; tool_calls: any[]; usage: TokenUsage | null };

// ---------- Thinking ----------
//
// Every reasoning model bills its thinking as output tokens, at the output
// price, and thinks a lot by default: DeepSeek at "high", GLM 5.3 Flash at
// "max". On a spoken turn that is seconds of silence before the first word,
// paid for. So thinking is off for spoken and quick calls and low for typed
// ones, and each provider is told in the words it understands, because they
// all differ: gpt-oss takes reasoning_effort, DeepSeek takes it too but with
// "none" to switch off, Z.ai's GLM 5.3 cannot switch off at all (its floor is
// "low"), OpenRouter wants a `reasoning` object, and Workers AI's GLM takes a
// template flag. Keyed off the model id, not the engine, because
// FALLBACK_MODEL may itself be a GLM.

export type ThinkingLevel = "off" | "low" | "on";

/** Which OpenAI-compatible host GLM is on. Decides how thinking is spelled. */
export type GlmFlavor = "zai" | "openrouter" | "openai";

export function glmFlavor(baseUrl: string | undefined): GlmFlavor {
  const url = (baseUrl ?? "").toLowerCase();
  if (!url || /(^|\/\/|\.)(api\.)?z\.ai(\/|$)/.test(url) || url.includes("bigmodel.cn")) return "zai";
  if (url.includes("openrouter.ai")) return "openrouter";
  return "openai";
}

/** The chat-completions endpoint for GLM: Z.ai's unless the var says otherwise. Accepts a base with or without the path. */
export function glmEndpoint(baseUrl: string | undefined) {
  const base = (baseUrl?.trim() || "https://api.z.ai/api/paas/v4").replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
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

/**
 * How much this call should think. Spoken and quick calls never do; typed turns
 * do a little, or what the engine's var says. gpt-oss keeps today's behaviour:
 * low when spoken, its own default when typed.
 */
export function thinkingLevelFor(env: Pick<LlmEnv, "DEEPSEEK_THINKING" | "GLM_THINKING">, engine: OpenAiEngine, model: string, voiceOrFast: boolean): ThinkingLevel {
  if (voiceOrFast) return "off";
  if (engine === "deepseek") return parseThinking(env.DEEPSEEK_THINKING, "low");
  if (engine === "glm" || /glm/i.test(model)) return parseThinking(env.GLM_THINKING, "low");
  return "on";
}

/**
 * The request fields that ask for `level` of thinking from `model` on `engine`.
 * Pure, so every provider's spelling is checked by a test rather than by a 400
 * in production.
 */
export function thinkingFields(engine: OpenAiEngine, model: string, level: ThinkingLevel, flavor: GlmFlavor = "zai"): Record<string, unknown> {
  const m = model.toLowerCase();
  if (engine === "workers") {
    if (/gpt-oss/.test(m)) return level === "on" ? {} : { reasoning_effort: "low" };
    if (/glm/.test(m)) {
      if (level === "off") return { chat_template_kwargs: { enable_thinking: false } };
      return level === "low" ? { reasoning_effort: "low" } : {};
    }
    return {};
  }
  if (engine === "deepseek") {
    // "none" switches thinking off; low/high/max set the effort; the default is high.
    return level === "off" ? { reasoning_effort: "none" } : level === "low" ? { reasoning_effort: "low" } : {};
  }
  // GLM, on whichever host.
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

async function openAiCall(
  env: LlmEnv,
  engine: OpenAiEngine,
  body: OpenAiBody,
  stream: boolean,
  affinity?: string,
  prefer?: EnginePrefs,
): Promise<any> {
  if (engine === "workers") {
    // AiOptions carries a signal, so the binding gets the same deadline the two
    // raw fetches have. Without it a hung Workers AI call is invisible until the
    // phone's own 60 s abort.
    return env.AI.run(
      workersModel(env, prefer) as keyof AiModels,
      // include_usage: the token counts ride on a last chunk, and Workers AI's
      // chat-completions input types the option the same way OpenAI does.
      { ...body, ...(stream && { stream: true, stream_options: { include_usage: true } }) } as never,
      {
        signal: AbortSignal.timeout(connectMs),
        // Documented for the binding as extraHeaders (Workers AI "prompt caching").
        ...(affinity && { extraHeaders: { "x-session-affinity": `ovoa-${affinity}` } }),
      },
    );
  }
  if (engine === "glm") {
    const model = modelFor(env, "glm", "", prefer);
    const flavor = glmFlavor(env.GLM_BASE_URL);
    const res = await fetchWithDeadline(glmEndpoint(env.GLM_BASE_URL), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.GLM_API_KEY}` },
      body: JSON.stringify({
        model,
        ...body,
        // Z.ai sends the token counts on its last chunk without being asked and
        // documents no stream_options; it does take tool_stream, which streams a
        // tool call's arguments as they are written rather than all at the end.
        ...(stream && { stream: true, ...(flavor === "zai" ? { tool_stream: true } : { stream_options: { include_usage: true } }) }),
      }),
    });
    // "GLM <model> <status>:" is the shape coolDown and classifyEngineError read.
    if (!res.ok) throw new Error(`GLM ${model} ${res.status}: ${(await res.text()).slice(0, 500)}`);
    return stream ? res.body : res.json();
  }
  const res = await fetchWithDeadline("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model: env.DEEPSEEK_MODEL,
      ...body,
      // A stream ends with the token counts only when asked (OpenAI's stream_options).
      ...(stream && { stream: true, stream_options: { include_usage: true } }),
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek ${env.DEEPSEEK_MODEL} ${res.status}: ${(await res.text()).slice(0, 500)}`);
  return stream ? res.body : res.json();
}

function openAiText(out: OpenAiOut) {
  const text =
    typeof out.response === "string"
      ? out.response
      : out.response
        ? JSON.stringify(out.response)
        : (out.choices?.[0]?.message?.content ?? "");
  return stripThinking(text);
}

/** One model turn. Streamed when `onText` is set; either way returns the whole message. */
async function openAiRound(
  env: LlmEnv,
  engine: OpenAiEngine,
  body: OpenAiBody,
  onText?: OnText,
  affinity?: string,
  prefer?: EnginePrefs,
): Promise<OpenAiMessage> {
  if (!onText) {
    const out = (await openAiCall(env, engine, body, false, affinity, prefer)) as OpenAiOut;
    const message = out.choices?.[0]?.message;
    return {
      content: openAiText(out),
      reasoning_content: message?.reasoning_content,
      tool_calls: message?.tool_calls ?? [],
      usage: readOpenAiUsage(out.usage),
    };
  }
  const stream = (await openAiCall(env, engine, body, true, affinity, prefer)) as ReadableStream<Uint8Array>;
  let content = "";
  let reasoning = "";
  let usage: TokenUsage | null = null;
  const calls: any[] = [];
  for await (const data of sseData(stream)) {
    const chunk = JSON.parse(data);
    // The counts ride on the last chunk (Workers AI always; DeepSeek when asked
    // with stream_options). Stopping a reply early gives up the counts too.
    usage = readOpenAiUsage(chunk.usage) ?? usage;
    const delta = chunk.choices?.[0]?.delta;
    // Workers AI ends with {"response": "", usage}; older models stream only `response`.
    const text: string = delta?.content ?? (typeof chunk.response === "string" ? chunk.response : "");
    if (delta?.reasoning_content) reasoning += delta.reasoning_content;
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
  return { content: stripThinking(content), reasoning_content: reasoning || undefined, tool_calls: calls.filter(Boolean), usage };
}

async function openAiGenerate(env: LlmEnv, engine: OpenAiEngine, opts: Options): Promise<string> {
  const { system, turns, json, fast } = opts;
  const systemText = json
    ? `${system}\n\nRespond with only a JSON object matching this JSON schema, no other text:\n${JSON.stringify(json.schema)}`
    : system;

  const at = Date.now();
  const model = modelFor(env, engine, opts.model, opts.prefer);
  const { content, usage } = await openAiRound(
    env,
    engine,
    {
      messages: [
        { role: "system", content: systemText },
        ...turns.map((t) => ({ role: t.role === "model" ? "assistant" : "user", content: t.text })),
      ],
      max_tokens: 2048,
      ...thinkingFields(engine, model, thinkingLevelFor(env, engine, model, !!fast), glmFlavor(env.GLM_BASE_URL)),
    },
    undefined,
    undefined,
    opts.prefer,
  );
  reportUsage(env, opts, engine, model, usage, Date.now() - at);

  let text = content;
  if (json) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`${ENGINE_NAMES[engine]} returned no JSON: ${text.slice(0, 200)}`);
    text = match[0];
  }
  if (!text) throw new Error(`${ENGINE_NAMES[engine]} returned no text`);
  return text;
}

async function openAiToolLoop(
  env: LlmEnv,
  engine: OpenAiEngine,
  opts: ToolLoopOptions,
  paused?: Extract<LoopState, { engine: OpenAiEngine }>,
): Promise<ChatOutcome> {
  const { system, turns, tools, callTool, voice, onText, affinity, prefer } = opts;
  const messages: any[] = paused?.messages ?? [
    { role: "system", content: system },
    ...turns.map((t) => ({ role: t.role === "model" ? "assistant" : "user", content: t.text })),
  ];
  const model = modelFor(env, engine, opts.model, prefer);
  // Measured on gpt-oss-120b: about 4x faster to a spoken answer with thinking
  // kept low, and tool calls still work. See thinkingFields for the others.
  const thinking = thinkingFields(engine, model, thinkingLevelFor(env, engine, model, !!voice), glmFlavor(env.GLM_BASE_URL));
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
      affinity,
      prefer,
    );
    reportUsage(env, opts, engine, model, message.usage, Date.now() - at);

    const calls = message.tool_calls;
    if (!calls.length) {
      if (!message.content) throw new Error(`${ENGINE_NAMES[engine]} returned no text`);
      return { kind: "reply", text: message.content, engine };
    }

    // Workers AI rejects null content on assistant turns. DeepSeek requires its
    // reasoning sent back on every later round of a turn with tools (400
    // otherwise); GLM's hosts neither need it nor promise to accept it, so it
    // stays out there. It is never spoken or shown.
    messages.push({
      role: "assistant",
      content: message.content ?? "",
      tool_calls: calls,
      ...(message.reasoning_content && engine !== "glm" && { reasoning_content: message.reasoning_content }),
    });
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
