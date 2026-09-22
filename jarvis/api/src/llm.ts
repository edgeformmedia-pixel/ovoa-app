import { generate as geminiGenerate, type Turn } from "./gemini";

export type { Turn };

export type LlmEnv = {
  AI: Ai;
  GEMINI_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_MODEL: string;
  FALLBACK_MODEL: string;
  /** "deepseek" tries DeepSeek before Gemini. Anything else: Gemini first. */
  PRIMARY_ENGINE?: string;
  /**
   * Which engine answers spoken turns first. "workers" (the default) because on
   * the wrist the wait before the first word is the whole experience, and the
   * measured first token is 1.0-2.9 s on Workers AI against 4.3-14.1 s on the
   * free-tier Gemini key (device_logs, 2026-09-21). "keyed" restores the usual
   * order for everything.
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
  /**
   * Whose turn this is. Workers AI keeps a prompt it has just read on the model
   * server that read it, and routes requests carrying the same x-session-affinity
   * there, so one person's next turn skips re-reading everything it has in common
   * with their last. Without it, turns land on any server and the cache is luck.
   */
  affinity?: string;
};

export type Engine = "gemini" | OpenAiEngine;

const ENGINE_NAMES: Record<Engine, string> = { gemini: "Gemini", deepseek: "DeepSeek", workers: "Workers AI" };

const MAX_TOOL_ROUNDS = 8;
const MAX_TOOL_RESULT_CHARS = 12_000;

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

/**
 * Engines in the order they're tried: Gemini and DeepSeek when their keys are set
 * (and they haven't just failed), then Cloudflare Workers AI, so chat keeps working
 * if the others fail or run out.
 */
function engines(env: LlmEnv, voice = false): Engine[] {
  const now = Date.now();
  const keyed: (Engine | false)[] = [!!env.GEMINI_API_KEY && "gemini", !!env.DEEPSEEK_API_KEY && "deepseek"];
  // PRIMARY_ENGINE (wrangler.jsonc) puts one keyed engine first; the rest keep their order.
  if (env.PRIMARY_ENGINE === "deepseek") keyed.reverse();
  const ready = [...keyed, "workers" as const].filter((e): e is Engine => !!e && (cooldownUntil.get(e) ?? 0) < now);
  if (!ready.length) return ["workers"];
  // A spoken turn answers on whichever engine reaches the first word soonest, not
  // on whichever is nominally primary. Workers AI has a free daily allocation, and
  // when it runs out it cools down (4006) and the keyed engines take the turn.
  if (voice && env.VOICE_PRIMARY !== "keyed" && ready.includes("workers")) {
    return ["workers", ...ready.filter((e) => e !== "workers")];
  }
  return ready;
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
  if (engines(env).length) return null;
  const now = Date.now();
  const down: EngineDown[] = [];
  for (const [engine, until] of cooldownUntil) {
    if (until > now) down.push({ engine, until, error: lastFailure.get(engine) ?? "" });
  }
  return troubleFrom(down, now);
}

/** Which model each engine is actually about to call, for the record. */
function modelFor(env: LlmEnv, engine: Engine, model: string) {
  return engine === "gemini" ? model : engine === "deepseek" ? env.DEEPSEEK_MODEL : env.FALLBACK_MODEL;
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
  const all = engines(env);
  const order: Engine[] = opts.fast && all.includes("workers") ? ["workers", ...all.filter((e) => e !== "workers")] : all;
  const failures: string[] = [];
  reportSkipped(env, opts.model, opts.onAttempt);
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
  const order = engines(env, opts.voice);
  const failures: string[] = [];
  reportSkipped(env, opts.model, opts.onAttempt);
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

// ---------- OpenAI-style engines (DeepSeek, Workers AI) ----------

type OpenAiEngine = "deepseek" | "workers";

type OpenAiOut = {
  response?: string | object;
  choices?: { message?: { content?: string | null; reasoning_content?: string; tool_calls?: any[] } }[];
  usage?: unknown;
};

type OpenAiBody = {
  messages: any[];
  tools?: any[];
  max_tokens: number;
  reasoning_effort?: "low" | "medium" | "high";
  /** Asks a streaming provider to end with a usage chunk. Not every provider takes it. */
  stream_options?: { include_usage: boolean };
};

/** One assistant message, however it arrived, with the counts the provider attached. */
type OpenAiMessage = { content: string; reasoning_content?: string; tool_calls: any[]; usage: TokenUsage | null };

/** Workers AI's gpt-oss takes `reasoning_effort`; DeepSeek gets only standard fields. */
function openAiBody(engine: OpenAiEngine, body: OpenAiBody): OpenAiBody {
  if (engine === "workers") return body;
  const { reasoning_effort: _, ...rest } = body;
  return rest;
}

async function openAiCall(env: LlmEnv, engine: OpenAiEngine, body: OpenAiBody, stream: boolean, affinity?: string): Promise<any> {
  if (engine === "workers") {
    // AiOptions carries a signal, so the binding gets the same deadline the two
    // raw fetches have. Without it a hung Workers AI call is invisible until the
    // phone's own 60 s abort.
    return env.AI.run(
      env.FALLBACK_MODEL as keyof AiModels,
      // include_usage: the token counts ride on a last chunk, and Workers AI's
      // chat-completions input types the option the same way OpenAI does.
      { ...openAiBody(engine, body), ...(stream && { stream: true, stream_options: { include_usage: true } }) } as never,
      {
        signal: AbortSignal.timeout(connectMs),
        // Documented for the binding as extraHeaders (Workers AI "prompt caching").
        ...(affinity && { extraHeaders: { "x-session-affinity": `ovoa-${affinity}` } }),
      },
    );
  }
  const res = await fetchWithDeadline("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model: env.DEEPSEEK_MODEL,
      ...openAiBody(engine, body),
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
): Promise<OpenAiMessage> {
  if (!onText) {
    const out = (await openAiCall(env, engine, body, false, affinity)) as OpenAiOut;
    const message = out.choices?.[0]?.message;
    return {
      content: openAiText(out),
      reasoning_content: message?.reasoning_content,
      tool_calls: message?.tool_calls ?? [],
      usage: readOpenAiUsage(out.usage),
    };
  }
  const stream = (await openAiCall(env, engine, body, true, affinity)) as ReadableStream<Uint8Array>;
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
  const { content, usage } = await openAiRound(env, engine, {
    messages: [
      { role: "system", content: systemText },
      ...turns.map((t) => ({ role: t.role === "model" ? "assistant" : "user", content: t.text })),
    ],
    max_tokens: 2048,
    ...(fast && { reasoning_effort: "low" as const }),
  });
  reportUsage(env, opts, engine, modelFor(env, engine, opts.model), usage, Date.now() - at);

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
  const { system, turns, tools, callTool, voice, onText, affinity } = opts;
  const messages: any[] = paused?.messages ?? [
    { role: "system", content: system },
    ...turns.map((t) => ({ role: t.role === "model" ? "assistant" : "user", content: t.text })),
  ];
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
        // Measured on gpt-oss-120b: about 4x faster to a spoken answer, and tool calls still work.
        ...(voice && { reasoning_effort: "low" as const }),
      },
      onText,
      affinity,
    );
    reportUsage(env, opts, engine, modelFor(env, engine, opts.model), message.usage, Date.now() - at);

    const calls = message.tool_calls;
    if (!calls.length) {
      if (!message.content) throw new Error(`${ENGINE_NAMES[engine]} returned no text`);
      return { kind: "reply", text: message.content, engine };
    }

    // Workers AI rejects null content on assistant turns; DeepSeek wants its reasoning sent back.
    messages.push({
      role: "assistant",
      content: message.content ?? "",
      tool_calls: calls,
      ...(message.reasoning_content && { reasoning_content: message.reasoning_content }),
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
