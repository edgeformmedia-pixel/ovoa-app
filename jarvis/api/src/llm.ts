import { asksForAction, changesSomething, CLAIM_NUDGE, claimsDone, doesSomething } from "./claims";
import { generate as geminiGenerate, grounded as geminiGrounded, quickThinking, type Turn } from "./gemini";

// The reply engines: which model answers, in what order, and what each call
// cost. Every model call goes through here, web search grounding included
// (searchGrounded; web.ts asks it). Each one asks the gate first (setModelGate,
// below): the person's plan, the day's spend and their consent are checked
// before an engine is chosen or a byte is sent. test/gate.test.ts fails if a
// model host or gemini.ts is reached from anywhere else.
//
// Three engines and two orders (2026-09-23). Spoken turns try Workers AI first
// (VOICE_ENGINE), then the typed order. Typed turns and everything in the
// background (memory and summaries, the setup conversation, app design, agent
// jobs, food) try GLM on Z.ai, then Gemini, then Workers AI as the last resort.
// The providers are temporary choices; both GLM engines run the same model.
//
//   glm      GLM 5.3 Flash on Z.ai, through the OpenAI-compatible path below
//            (OPENAI_PROVIDERS). The id stays "glm" whatever it runs on: the
//            usage history, server_settings rows and the GLM_PRICE_* vars use it.
//   gemini   Google's own API, with the model the caller names (CHAT_MODEL or
//            MEMORY_MODEL in wrangler.jsonc). It answers 403 PERMISSION_DENIED
//            on 2026-09-23, so for now it is cooling down more than it answers,
//            and Workers AI is what keeps things answering when Z.ai fails.
//   workers  GLM 5.3 Flash on Cloudflare Workers AI (WORKERS_MODEL), through
//            the AI binding: no key, it runs on OVOA's own account. It takes
//            the same OpenAI-style messages and tools as glm, so a paused turn
//            can move between the two.
//
// Why spoken turns go to Workers AI: the same model, probed from here on
// 2026-09-23 with a 6.7K-token prompt carrying 15 tools (Z.ai's row is first
// content per round on the real spoken body, from production):
//
//   host         thinking field                           reasoning     first word
//   Z.ai         reasoning_effort "low" (it can't go off)  yes           4.5-6.6 s
//   Workers AI   reasoning_effort "low"                    none          0.66-1.5 s
//   Workers AI   none (its default)                        yes           1.8-5 s
//   Workers AI   thinking {type: "disabled"}               yes           1.8-5 s
//   Workers AI   chat_template_kwargs enable_thinking off  in the reply  (never used)
//
// On Workers AI with "low", tool calls (alarm_set, web_search) were complete in
// 1.0-1.8 s, and three calls at once were no slower than one. Per token it
// costs more ($0.15 in, $0.03 cached, $0.50 out per million, against Z.ai's
// $0.06 and $0.20), but the stable front of the prompt is cached (a person's
// calls share an x-session-affinity), so a spoken turn costs about the same.
// docs/voice-latency.md has the measurements and what came before them.
//
// An engine without its key (for Workers AI, its binding) does not exist: it
// is never tried, skipped or mentioned. A failing engine is skipped for a while
// (coolDown), but never so that nothing is left: the last engine able to answer
// is only rested for a few seconds after a failure that can pass (a key or
// credit refusal keeps its full rest), and when every engine is cooling down
// the one back soonest is tried anyway (engineOrder). When no engine exists, or
// every one tried failed before it wrote a word or ran a tool, a call throws
// AiUnreachable. A person's turn is then told plainly that OVOA can't reach the
// AI right now (index.ts); a background call fails quietly, as it always did.
// `fast` doesn't change the order: it only means "think as little as the model
// allows".
//
// Adding an OpenAI-compatible provider is config plus a few lines:
//   1. An entry in OPENAI_PROVIDERS: its name, the names of the vars that hold
//      its key, base URL, model and thinking level, and defaults for the base
//      URL and the model. A provider serving a model that doesn't think sets
//      `thinking: "none"`, so no thinking field is sent at all.
//   2. Its id in OpenAiEngine and in ENGINES, at the place in the order where
//      it should be tried.
//   3. Its vars in wrangler.jsonc (and in types.ts Env, for the record), its key
//      as a secret, and its price in pricing.ts LLM_PRICES under its model id.
// How much it thinks is spelled for its host (hostFlavor, thinkingFields): Z.ai
// and OpenRouter have their own fields, Workers AI has its own rule, and any
// other host gets the plain OpenAI `reasoning_effort`, unless the provider's
// `thinking` says otherwise.

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
   * Thinking is billed as output tokens. Spoken and quick calls ask for "off",
   * but Z.ai can't switch GLM 5.3 off (thinkingFields), so there they still
   * think at "low", and the first word takes 4.5-6.6 s: the reason spoken
   * turns go to Workers AI first.
   */
  GLM_THINKING?: string;
  /**
   * "off" stops asking Z.ai to stream a tool call's arguments as they are
   * written (tool_stream). Unset: on. Left out of wrangler.jsonc's vars on
   * purpose, so `wrangler secret put GLM_TOOL_STREAM` can try it either way
   * without a deploy (a var and a secret can't share a name).
   */
  GLM_TOOL_STREAM?: string;
  /**
   * The Workers AI binding ("ai" in wrangler.jsonc). Workers AI exists when the
   * binding does: there is no key, it runs on OVOA's own Cloudflare account.
   * Optional here only because the unit tests run without one.
   */
  AI?: Ai;
  /** The Workers AI model (OPENAI_PROVIDERS.workers). Priced by this id in pricing.ts. */
  WORKERS_MODEL?: string;
  /**
   * The order every typed and background call tries, e.g. "gemini,glm". Unset:
   * ENGINES' order. The runtime settings (server_settings.engine_order)
   * override it without a deploy.
   */
  ENGINE_ORDER?: string;
  /**
   * Who answers spoken turns first: an engine name, or "keyed" for the same
   * order as typed turns. Unset: Workers AI (DEFAULT_VOICE_ENGINE). The runtime
   * settings (server_settings.voice_engine) override it without a deploy.
   */
  VOICE_ENGINE?: string;
  /**
   * How long an engine has to send its first byte, and how long a stream may go
   * quiet once it has started. Read from the environment so a model that is
   * legitimately slow one week can be given more room with `wrangler secret`
   * rather than a deploy. Defaults below.
   */
  MODEL_CONNECT_MS?: string;
  MODEL_IDLE_MS?: string;
  /**
   * How long a spoken turn waits for Workers AI's first word (or first tool
   * call) before moving on to the next engine (abandonSilentEngine). Only
   * Workers AI's: it is sized for that host. Like the two above, a secret
   * rather than a var, so it can be tuned without a deploy.
   */
  VOICE_FIRST_CONTENT_MS?: string;
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
  /**
   * A call a spoken turn is waiting on (the check that a line in the room was
   * meant for OVOA): tried in the spoken order, Workers AI first, like the turn.
   */
  voice?: boolean;
  /** Called once per engine tried or skipped. See EngineAttempt. */
  onAttempt?: OnAttempt;
  /**
   * Whose call this is and what for, so the tokens land against the right
   * person and the gate knows whose plan to ask. Required: a call nobody is
   * named on can't be checked. See LlmUsage and GateCall.
   */
  usage: UsageTag;
  /** Receives every model call's token counts. When set, the default sink is not called. */
  onUsage?: OnUsage;
  /** This caller's own engine choices, over the runtime settings and the vars. See EnginePrefs. */
  prefer?: EnginePrefs;
  /**
   * Calls the call off. The request in flight is aborted, no other engine is
   * tried, nothing is cooled down, and the call throws the signal's reason. For
   * a caller that learns midway that the answer isn't wanted.
   */
  signal?: AbortSignal;
};

export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };

// ---------- The gate ----------
//
// "Before anything is sent to a model, OVOA checks the plan" (the v1 release,
// 2026-09-23). No one function carries every model call, so each door into a
// model asks first: generateText, chatWithTools (before its resume branch) and
// searchGrounded. The check comes before an engine is chosen, so a refused call
// costs nothing and tries nothing.
//
// This file stays free of the database, so the rules are handed in, the way the
// usage sink is: index.ts registers plans.ts modelGate once per isolate. With
// no gate registered (the unit tests) every call goes ahead.
//
// A refusal is a ModelRefused, never an ordinary failure: a person's turn turns
// it into one plain sentence (index.ts), a route into a 402, 403 or 429 with
// that sentence (plans.ts refusedResponse), and the crons into a skip (their
// own pre-checks, blockedFor and friends, usually stop them sooner).

/** Why a model call wasn't made: no plan with AI, today's spend used up, or no consent yet. */
export type Refusal = "needs_plan" | "allowance" | "needs_consent";

/** What the gate is asked about one call. */
export type GateCall = UsageTag & {
  /**
   * The second half of a turn that was already let in: a paused turn resumed
   * with what the phone looked up (chatWithTools `resume`). Its plan and
   * consent are asked again; its spend isn't, because the turn was allowed
   * when it began and refusing its second half would leave the phone's answer
   * with nobody to hear it.
   */
  continuing?: boolean;
};

export type ModelGate = (env: LlmEnv, call: GateCall) => Promise<Refusal | null>;

let modelGate: ModelGate | null = null;

/** The rules every model call asks first (plans.ts modelGate). Set once by index.ts. */
export function setModelGate(gate: ModelGate | null) {
  modelGate = gate;
}

/** A model call the gate refused. Nothing was sent. `reason` says why. */
export class ModelRefused extends Error {
  constructor(
    readonly reason: Refusal,
    purpose: string,
  ) {
    super(`No model call for ${purpose}: ${reason}`);
    this.name = "ModelRefused";
  }
}

export const isModelRefused = (err: unknown): err is ModelRefused =>
  err instanceof ModelRefused || (err instanceof Error && err.name === "ModelRefused" && "reason" in err);

/** Throws ModelRefused when the gate says no. First thing in every door into a model. */
async function askGate(env: LlmEnv, call: GateCall) {
  if (!modelGate) return;
  const refusal = await modelGate(env, call);
  if (refusal) throw new ModelRefused(refusal, call.purpose);
}

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

/**
 * Who a call is for, and why. Filed against user_id in usage_daily, and the
 * person whose plan the gate asks about. userId is null only on a DEBUG_KEY
 * route (logs.ts /debug/ambient), where there is no person to check or charge.
 */
export type UsageTag = { userId: string | null; purpose: string };

/**
 * When each part of one streamed model round arrived, in ms from the moment
 * the request went out. Workers' clock only moves on I/O, so each mark is taken
 * right after the read that brought it in: a first word at the same ms as the
 * end means both came in one read, not that nothing streamed before it. Apart,
 * the marks tell a slow host (late headers), queueing (a late first event) and
 * hidden reasoning (reasoning well before the first word) from one another,
 * which the old single first-token mark could not (2026-09-23).
 */
export type RoundTiming = {
  /** The response headers: fetch resolving, or the Workers AI binding handing back its stream. */
  headersMs: number;
  /** The first server-sent event of any kind. */
  firstEventMs?: number;
  /** The first piece of reasoning, where the host streams it (delta.reasoning_content or delta.reasoning). */
  firstReasoningMs?: number;
  /** The first word of the reply. */
  firstContentMs?: number;
  /** The first piece of a tool call. */
  firstToolMs?: number;
  /** The stream ending, or being stopped early. */
  endMs: number;
  /** How much reasoning streamed, in characters. A host that doesn't count its reasoning tokens still shows it here. */
  reasoningChars: number;
};

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
  /** The round's timing marks, when it was streamed from an OpenAI-style engine. See RoundTiming. */
  timing?: RoundTiming;
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
 * OpenAI-style usage. OpenAI, OpenRouter, Z.ai and Workers AI put the cache
 * hits under prompt_tokens_details; DeepSeek-style hosts split the prompt into
 * hits and misses; some send only the plain three. All of them count thinking
 * in completion_tokens, and some say how much of it was thinking.
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
  opts: { usage: UsageTag; onUsage?: OnUsage },
  engine: Engine,
  model: string,
  counts: TokenUsage | null,
  ms: number,
  timing?: RoundTiming,
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
    userId: opts.usage.userId,
    purpose: opts.usage.purpose,
    ...(timing && { timing }),
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

/**
 * A paused tool loop. Plain JSON, so it can be stored between requests.
 * `model` is the model it paused on, so the turn carries on with the same one
 * even if a var or setting changed in between. Turns paused before 2026-09-23
 * don't have it, and take their engine's model of the moment.
 */
export type LoopState =
  | { engine: "gemini"; model?: string; round: number; contents: any[]; slots: { id: string; part: number }[]; claim?: ClaimInRepair }
  | { engine: OpenAiEngine; model?: string; round: number; messages: any[]; slots: { id: string; index: number }[]; claim?: ClaimInRepair };

/**
 * A claim's repair (repairClaim) under way in a tool loop: the reply it is
 * making true, and whether a tool has changed something yet. A paused one
 * rides in its LoopState, so the resumed turn finishes the repair: its tools
 * run as any turn's, its outcome says how the repair went, and a last round
 * that writes nothing (as the nudge asked) ends with this reply rather than
 * failing the turn after its action was already queued.
 */
export type ClaimInRepair = { reply: string; repaired?: true };

/**
 * What became of a reply that said something was done when no tool had run
 * (chatWithTools `repairClaims`, claims.ts): "repaired" when the extra round
 * ran a tool that changed something, "unrepaired" when it didn't (no tool,
 * only lookups, only failed ones, or the round itself failed) and the claim
 * stands as it was said, "pending" when it paused on a phone lookup before
 * changing anything, and the resumed turn's outcome says which.
 */
export type ClaimRepair = "repaired" | "unrepaired" | "pending";

export type ChatOutcome =
  | { kind: "reply"; text: string; engine: Engine; claim?: ClaimRepair }
  | { kind: "paused"; state: LoopState; calls: DeferredCall[]; engine: Engine; claim?: ClaimRepair };

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
  /** Spoken turn: tried in the spoken order, thinks as little as the host allows, and gets a first-word deadline on Workers AI. */
  voice?: boolean;
  /** Stream the reply: called with each piece of text as the model writes it. */
  onText?: OnText;
  /** Called once per engine tried or skipped, so the day's engine health is recordable. */
  onAttempt?: OnAttempt;
  /** Whose turn this is and what for, for the usage table and the gate. Required. See LlmUsage. */
  usage: UsageTag;
  /** Every model round's token counts. When set, the default sink is not called. */
  onUsage?: OnUsage;
  /** This person's own engine choices, over the runtime settings and the vars. See EnginePrefs. */
  prefer?: EnginePrefs;
  /**
   * Calls the turn off. The request in flight is aborted, no other engine is
   * tried, nothing is cooled down, and the call throws the signal's reason. For
   * a caller that learns midway that the turn isn't wanted.
   */
  signal?: AbortSignal;
  /**
   * A person's own turn: when the turn ran no tool, the request asked for
   * something to be done and the reply says it was ("Noted — milk and eggs."),
   * the engine that answered is told that nothing happened and to call the
   * tool now, and gets up to REPAIR_ROUNDS to do it (claims.ts has the why).
   * Its tools run through callTool like any others, so the phone's actions
   * still wait for approval; nothing it writes is passed to onText, since the
   * claim was heard already; and the reply stays the one that was given. The
   * outcome's `claim` says how it went. Passed for a person's own turns, not
   * for agent jobs. A resumed turn isn't checked again (it ran the phone's
   * lookup); one whose repair paused on the phone finishes that repair
   * (LoopState.claim).
   */
  repairClaims?: boolean;
};

/**
 * What the tool loops run with: the caller's options, plus onOutput, which
 * chatWithTools uses to see an engine start its answer (a word, or the first
 * piece of a tool call) for the spoken first-word deadline, and repair for a
 * claim's repair (repairClaim): the loop ends once a round's tools have run,
 * without going back to the model for words, since what the person was told
 * is said (repairEnds has when).
 */
type LoopRun = ToolLoopOptions & { onOutput?: () => void; repair?: boolean };

export type Engine = "gemini" | OpenAiEngine;

/** Every engine there is, in the order typed and background calls try them when nothing says otherwise. */
export const ENGINES: Engine[] = ["glm", "gemini", "workers"];
export const isEngine = (name: string): name is Engine => (ENGINES as string[]).includes(name);
const isOpenAiEngine = (name: string): name is OpenAiEngine => Object.hasOwn(OPENAI_PROVIDERS, name);

/** What people and the logs call an engine. */
function nameOf(engine: Engine) {
  return engine === "gemini" ? "Gemini" : OPENAI_PROVIDERS[engine].name;
}

/**
 * The engine there was before v1 and isn't any more: DeepSeek. server_settings
 * rows copied from the old database may still name it. An order that does was
 * written for the engines of its time, so it is ignored whole (usableOrder)
 * rather than read as, say, "gemini first". Workers AI went with it in v1 and
 * came back on 2026-09-23 as the spoken engine, so a row naming it counts again.
 */
const RETIRED_ENGINES = ["deepseek"];

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

/**
 * Engines whose last call was refused for good (a key, credit or model problem,
 * or the day's quota used up), until one answers again. lastFailure can't say
 * this: it keeps an engine's last error, for the record, after it recovers. A spoken
 * turn asks it before giving up on a silent Workers AI (abandonSilentEngine):
 * moving on to an engine that will only refuse throws the turn away.
 */
const refusedForGood = new Set<Engine>();

/**
 * The longest the last engine able to answer is skipped for after a failure
 * that can pass (a timeout, a 5xx, a 429 short of the quota). One Z.ai timeout,
 * 5xx or 429 used to cool GLM for 15 s to 30 min while it was the only engine
 * that worked (Gemini was answering 403), and in that time every turn on the
 * isolate was told at once that the AI was out of reach, with nothing tried.
 * A failure that won't pass keeps its full rest even then: capped, Gemini's 403
 * came back before the engines that had only stumbled, engineOrder tried it
 * first as "the one back soonest", and every call on the isolate went to it and
 * was refused for the next 12 s (a scripted run of this file, 2026-09-23).
 */
const LAST_ENGINE_COOL_MS = 3_000;

function coolDown(env: LlmEnv, engine: Engine, err: unknown) {
  const text = String(err);
  lastFailure.set(engine, text.slice(0, 200));
  const status = Number(/ (\d{3}):/.exec(text)?.[1] ?? 0);
  // 429: rate limited, back soon, unless the (daily) quota is used up. 401/402/403/404: key,
  // credit or model problems. Those four and a used-up quota won't fix themselves (lasting).
  const lasting = [401, 402, 403, 404].includes(status) || (status === 429 && /quota/i.test(text));
  if (lasting) refusedForGood.add(engine);
  else refusedForGood.delete(engine);
  const ms = status === 429 ? (lasting ? 30 * 60_000 : 60_000) : lasting ? 10 * 60_000 : 15_000;
  const now = Date.now();
  const available = availableEngines(env);
  const othersReady = ENGINES.some((e) => e !== engine && available[e] && (cooldownUntil.get(e) ?? 0) <= now);
  cooldownUntil.set(engine, now + (othersReady || lasting ? ms : Math.min(ms, LAST_ENGINE_COOL_MS)));
}

/** An engine answered (or paused a turn for the phone): whatever refused it before has passed. */
function answered(engine: Engine) {
  refusedForGood.delete(engine);
}

/**
 * A failure that belongs to one request, not to the engine: an empty reply, a
 * turn that went round too many times, a request the host refused (a 400 such
 * as Z.ai's content filter). Cooling the engine down for those took it away
 * from every other call on the isolate over one bad request, so they only move
 * this request on to the next engine.
 */
const perRequest = (err: unknown) => ["empty", "too_many_rounds", "http_400", "http_413", "http_422"].includes(classifyEngineError(err));

/** coolDown, except for a failure that belongs to the one request. */
function coolDownAfter(env: LlmEnv, engine: Engine, err: unknown) {
  if (!perRequest(err)) coolDown(env, engine, err);
}

/**
 * Whether an engine is being skipped right now after a failure. For a caller
 * that picks its own route by it (web search can skip Gemini's grounding while
 * Gemini is cooling down).
 */
export function isCooling(engine: Engine) {
  return (cooldownUntil.get(engine) ?? 0) > Date.now();
}

// ---------- Which engine, in what order ----------
//
// Three layers say what to try first, each overriding the one below:
//
//   1. ENGINES' own order (GLM, Gemini, Workers AI) and, for spoken turns,
//      Workers AI in front (DEFAULT_VOICE_ENGINE), or the ENGINE_ORDER and
//      VOICE_ENGINE vars if set.
//   2. The runtime settings in the server_settings table, read once a minute
//      and handed here by index.ts (setRuntimeEngines), so an engine can be
//      switched without a deploy.
//   3. A person's own settings (`prefer` on a call), so a developer can try an
//      engine without changing what everyone else gets.
//
// The order itself is worked out by engineOrder, a pure function of those
// choices plus which keys exist and which engines are cooling down, so it can
// be tested without an engine ever having failed.

/**
 * Who answers spoken turns first when nothing says otherwise: Workers AI, whose
 * first word comes in 0.66-1.5 s where Z.ai's takes 4.5-6.6 s (the top of this
 * file). The VOICE_ENGINE var and server_settings.voice_engine override it.
 */
const DEFAULT_VOICE_ENGINE = "workers";

/** Engine choices from the runtime settings or from one person. Any field may be absent. */
export type EnginePrefs = {
  /** "gemini,glm": who every call tries first. Unknown names are ignored; the engines left out follow in the usual order. */
  order?: string;
  /** "keyed" or an engine name: who answers spoken turns first. "keyed": the same order as everything else. */
  voice?: string;
};

let runtime: EnginePrefs = {};

/** The runtime settings (server_settings) for this isolate. index.ts sets them on every request and tick. */
export function setRuntimeEngines(prefs: EnginePrefs) {
  runtime = prefs;
}

export type OrderInput = {
  /** Which engines have what they need to be called at all: their key, or their binding. */
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
 * Unknown and retired names are dropped without complaint. Empty when it names
 * no engine at all. Pure.
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

/** A stored choice for spoken turns: "keyed" or an engine name. Anything else is ignored. Pure. */
export function usableVoice(raw: string | undefined): string | undefined {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "keyed" || isEngine(v) ? v : undefined;
}

/**
 * The engines to try, first to last. Pure.
 *
 * An order names who goes first; the engines it leaves out follow in their
 * usual order (ENGINES), so there is always a fallback. A spoken turn puts its
 * own engine (voicePrimary) in front of that; "keyed" leaves the order as it
 * is. An engine without its key is left out (it does not exist, so it is not
 * "skipped"), and one cooling down from a failure waits its turn out.
 *
 * While any engine exists the list is never empty: when every one is cooling
 * down, the one whose cooldown ends first is tried anyway. Trying an engine
 * that failed a moment ago is a better answer than telling a person, without
 * trying anything, that the AI is out of reach. With no engine at all the list
 * is empty, and the call says so (AiUnreachable).
 */
export function engineOrder(i: OrderInput): Engine[] {
  const named = parseOrder(i.order);
  let list = [...named, ...ENGINES.filter((e) => !named.includes(e))];
  const want = i.voice ? (i.voicePrimary ?? "").trim().toLowerCase() : "";
  if (isEngine(want)) list = [want, ...list.filter((e) => e !== want)];
  const present = list.filter((e) => i.available[e]);
  const ready = present.filter((e) => (i.cooling[e] ?? 0) <= i.now);
  if (ready.length || !present.length) return ready;
  return [present.reduce((soonest, e) => ((i.cooling[e] ?? 0) < (i.cooling[soonest] ?? 0) ? e : soonest))];
}

/** Whether an engine has what it needs to be called at all: its key, or for Workers AI its binding. */
function engineExists(env: LlmEnv, engine: Engine) {
  if (engine === "gemini") return !!varOf(env, "GEMINI_API_KEY");
  const provider = OPENAI_PROVIDERS[engine];
  return provider.binding ? !!(env as Record<string, unknown>)[provider.keyVar] : !!varOf(env, provider.keyVar);
}

/** What an engine needs to exist, as a message naming the missing ones says it. */
function needsOf(engine: Engine) {
  if (engine === "gemini") return "GEMINI_API_KEY";
  const provider = OPENAI_PROVIDERS[engine];
  return provider.binding ? `the ${provider.keyVar} binding` : provider.keyVar;
}

/** Which engines have what they need. */
function availableEngines(env: LlmEnv): Record<Engine, boolean> {
  const out = {} as Record<Engine, boolean>;
  for (const engine of ENGINES) out[engine] = engineExists(env, engine);
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
    voicePrimary: usableVoice(prefer?.voice) ?? usableVoice(runtime.voice) ?? usableVoice(env.VOICE_ENGINE) ?? DEFAULT_VOICE_ENGINE,
  });
}

/**
 * Where each engine stands right now, for /debug/engines and the Dev tools
 * picker: whether its key (or binding) is there, which model it would call,
 * whether it is cooling down and what it last failed with. The orders are what
 * a typed and a spoken turn would try this minute.
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
    settings: {
      vars: { ENGINE_ORDER: env.ENGINE_ORDER, VOICE_ENGINE: env.VOICE_ENGINE, WORKERS_MODEL: env.WORKERS_MODEL },
      runtime,
      ...(prefer && { mine: prefer }),
    },
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
  if (isModelRefused(err)) return "refused";
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
  const exist = ENGINES.filter((e) => available[e]);
  if (!exist.length || exist.some((e) => (cooldownUntil.get(e) ?? 0) <= now)) return null;
  const down: EngineDown[] = exist.map((engine) => ({ engine, until: cooldownUntil.get(engine) ?? now, error: lastFailure.get(engine) ?? "" }));
  return troubleFrom(down, now);
}

// ---------- When nothing can answer ----------

/**
 * Thrown when nothing could answer: every engine that exists failed before it
 * wrote a word or ran a tool, or no engine has what it needs. The message is
 * the reason, for the logs and error_events; a person is told AI_UNREACHABLE
 * instead (index.ts). A turn that fails after it has started answering throws
 * the engine's own error: that is the turn failing, not the AI being out of
 * reach.
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
 * Nothing to try: no engine has its key, or (a paused Gemini turn with nothing
 * OpenAI-style to move to) the ones there are are cooling down. The ones
 * without a key are reported (the cooling ones already were, by reportSkipped),
 * so the engine table says why this call got no answer.
 */
function nothingToTry(env: LlmEnv, model: string, onAttempt?: OnAttempt) {
  const available = availableEngines(env);
  for (const engine of ENGINES) {
    if (!available[engine]) onAttempt?.({ engine, model: modelFor(env, engine, model), outcome: "no_key", ms: 0 });
  }
  const exist = ENGINES.filter((e) => available[e]);
  if (!exist.length) return new AiUnreachable(`No AI engine has its key set (${ENGINES.map(needsOf).join(", ")}).`);
  // Every engine that exists is cooling down. The message is what each last failed with, and no countdown:
  // it goes to error_events, where a minute-by-minute number made a new fingerprint every minute, and
  // classifyEngineError reads the " 402:" / " 429:" in it. (engineTrouble's sentence rides along as the detail.)
  return new AiUnreachable(`All engines unavailable: ${exist.map((e) => `${nameOf(e)}: ${lastFailure.get(e) ?? "unknown"}`).join("; ")}`);
}

/** Which model each engine is actually about to call, for the record. Gemini's is the caller's (CHAT_MODEL or MEMORY_MODEL). */
function modelFor(env: LlmEnv, engine: Engine, model: string) {
  if (engine === "gemini") return model;
  const provider = OPENAI_PROVIDERS[engine];
  return varOf(env, provider.modelVar) ?? provider.defaultModel;
}

/**
 * The engines that were not even tried this call. Reported alongside the ones
 * that were, so "which were dead" and "which answered" come out of the same
 * table rather than one being a console line that expires in three days. One
 * cooling down but tried anyway (the soonest back, engineOrder) isn't skipped.
 */
function reportSkipped(env: LlmEnv, model: string, order: Engine[], onAttempt?: OnAttempt) {
  if (!onAttempt) return;
  const now = Date.now();
  for (const [engine, until] of cooldownUntil) {
    if (until > now && !order.includes(engine)) {
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

function logFallback(env: LlmEnv, from: Engine, to: Engine, err: unknown) {
  coolDownAfter(env, from, err);
  console.error(`${nameOf(from)} failed, using ${nameOf(to)} fallback`, err);
}

export async function generateText(env: LlmEnv, opts: Options): Promise<string> {
  await askGate(env, opts.usage);
  opts.signal?.throwIfAborted();
  applyDeadlines(env);
  const order = engines(env, !!opts.voice, opts.prefer);
  const failures: string[] = [];
  reportSkipped(env, opts.model, order, opts.onAttempt);
  if (!order.length) throw nothingToTry(env, opts.model, opts.onAttempt);
  for (const [i, engine] of order.entries()) {
    const at = Date.now();
    const model = modelFor(env, engine, opts.model);
    try {
      let text: string;
      if (engine === "gemini") {
        // opts carries the signal, which stops gemini.ts's request; unlessAborted stops the wait at once, as started() does.
        const got = await unlessAborted(geminiGenerate({ apiKey: env.GEMINI_API_KEY!, ...opts }), opts.signal);
        reportUsage(env, opts, engine, model, readGeminiUsage(got.usage), Date.now() - at);
        text = got.text;
      } else {
        text = await openAiGenerate(env, engine, model, opts);
      }
      answered(engine);
      opts.onAttempt?.({ engine, model, outcome: "ok", ms: Date.now() - at });
      return text;
    } catch (err) {
      // Called off by the caller: not the engine's failure, and nothing else is wanted.
      if (opts.signal?.aborted) throw opts.signal.reason ?? err;
      const brief = String(err instanceof Error ? err.message : err).slice(0, 300);
      opts.onAttempt?.({ engine, model, outcome: classifyEngineError(err), ms: Date.now() - at, error: brief });
      if (i === order.length - 1) {
        coolDownAfter(env, engine, err);
        throw unreachable(err, failures, order);
      }
      failures.push(`${nameOf(engine)}: ${brief.slice(0, 200)}`);
      logFallback(env, engine, order[i + 1], err);
    }
  }
  throw new Error("No engines");
}

/**
 * Whether a spoken turn stops waiting for the engine it is on and moves to the
 * next (chatWithTools). Workers AI's first word comes in 0.66-1.5 s; one still
 * silent at VOICE_FIRST_CONTENT_MS is stuck or queued, and without this the
 * person sat through the 20 s connect deadline in silence (error_events last_ms
 * 20113, 2026-09-23). Pure.
 *
 * Only Workers AI, the engine the limit was measured on. GLM on Z.ai normally
 * says its first word at 4.5-6.6 s, so the same limit cut it off just before it
 * spoke, and the turn went on to Gemini's 403 and failed (a scripted run of this
 * file, 2026-09-23); with voice_engine "glm" or "keyed" that was every slow Z.ai
 * turn. Only when it is first, before the person has waited on another engine;
 * only before it has written a word or started a tool call, so before anything
 * was said or done; and only when an engine after it can take the turn: one
 * that isn't cooling down and wasn't last refused for good. Otherwise waiting
 * is the only way the turn gets an answer.
 *
 * Workers AI left this way is first asked once more (silentRetry), and only
 * rests like any timeout (15 s, coolDown) if that goes silent too. For typed
 * calls it is only the last resort, so they barely notice.
 */
export function abandonSilentEngine(s: {
  voice: boolean;
  engine: Engine;
  /** Where the engine is in the turn's order. */
  index: number;
  /** The engines after it in the order, as they stand now. */
  later: { cooling: boolean; refused: boolean }[];
  /** The engine has written a word or started a tool call, or the turn has said or done anything. */
  heard: boolean;
  elapsedMs: number;
  limitMs: number;
}): boolean {
  const canTakeOver = s.later.some((e) => !e.cooling && !e.refused);
  return s.voice && s.engine === "workers" && s.index === 0 && canTakeOver && !s.heard && s.elapsedMs >= s.limitMs;
}

/**
 * Whether a spoken turn asks Workers AI again, rather than moving on, after it
 * was left for going silent (abandonSilentEngine): the first time in a turn,
 * yes, without cooling it down; a second silence, no. Moving on meant GLM on
 * Z.ai, which took 13.6 s to start and 28 s in all ("On it — I'll buzz you",
 * 22 s after the question, device_logs 2026-09-24), and resting Workers AI
 * for 15 s sent every spoken turn after it the same way (27 skipped in one
 * hour, engine_stats 2026-09-24T02). A silence is mostly one stuck request:
 * the same hour answered 155 turns. Pure.
 */
export function silentRetry(s: { silent: boolean; retrying: boolean }) {
  return s.silent && !s.retrying;
}

/**
 * Chat that may call tools. Moves to the next engine only if one fails before
 * any tool ran and before any text was streamed, or (spoken turns) when Workers
 * AI, first, is still silent at VOICE_FIRST_CONTENT_MS (abandonSilentEngine).
 * Pass `resume` to continue a paused turn with the results of its deferred calls.
 */
export async function chatWithTools(
  env: LlmEnv,
  opts: ToolLoopOptions & { resume?: { state: LoopState; results: Record<string, unknown> } },
): Promise<ChatOutcome> {
  // Before the resume branch: a resumed turn is asked about too (GateCall.continuing).
  await askGate(env, { ...opts.usage, continuing: !!opts.resume });
  opts.signal?.throwIfAborted();
  applyDeadlines(env);
  if (opts.resume) {
    const { state, results } = opts.resume;
    const result = (id: string) => results[id] ?? { error: "The app returned no result" };
    // Where a paused turn goes when its own engine can't carry on: the first
    // OpenAI-style engine that is ready now, other than one that just failed.
    // Its messages are OpenAI-style.
    const openAiNow = (except?: Engine) =>
      engines(env, !!opts.voice, opts.prefer).find((e) => isOpenAiEngine(e) && e !== except) as OpenAiEngine | undefined;
    // As for a new turn: a failure after something was said or done is the
    // turn failing; before that, with nothing left to carry it on, the AI is
    // out of reach (AiUnreachable, which /chat/resume answers plainly).
    let committed = false;
    // A claim's repair that paused on the phone (repairClaim) is finished by
    // this turn: what its tools change says how it went (claimOutcome).
    const claim = state.claim;
    const tally = repairTally();
    const callTool: CallTool = async (name, args) => {
      committed = true;
      const result = await safeCall(opts.callTool, name, args);
      tally.note(name, result);
      return result;
    };
    const onText: OnText | undefined = opts.onText
      ? (delta) => {
          committed = true;
          return opts.onText!(delta);
        }
      : undefined;
    const run: LoopRun = { ...opts, callTool, onText };
    const finish = (outcome: ChatOutcome) => (claim ? claimOutcome(outcome, claim, tally, opts, true) : outcome);
    const failures: string[] = [];
    const tried: Engine[] = [];
    /** One engine's go at carrying the turn on: its outcome, or the error to move on with. */
    const attempt = async (
      engine: Engine,
      model: string,
      go: () => Promise<ChatOutcome>,
    ): Promise<{ outcome: ChatOutcome } | { err: unknown }> => {
      tried.push(engine);
      const at = Date.now();
      try {
        const outcome = await go();
        answered(engine);
        opts.onAttempt?.({ engine, model, outcome: outcome.kind === "paused" ? "paused" : "ok", ms: Date.now() - at });
        return { outcome };
      } catch (err) {
        if (opts.signal?.aborted) throw opts.signal.reason ?? err;
        const brief = String(err instanceof Error ? err.message : err).slice(0, 300);
        opts.onAttempt?.({ engine, model, outcome: classifyEngineError(err), ms: Date.now() - at, error: brief });
        coolDownAfter(env, engine, err);
        if (committed) throw finalError(err, failures, tried);
        return { err };
      }
    };
    if (state.engine === "gemini") {
      const last = state.contents[state.contents.length - 1];
      for (const slot of state.slots) {
        last.parts[slot.part].functionResponse.response = geminiResponse(result(slot.id));
      }
      // Gemini cooling down (or without its key now) isn't tried, and isn't cooled
      // down again either: that would cut a long quota or credit cooldown to 15 seconds.
      const cooling = !availableEngines(env).gemini || isCooling("gemini");
      let err: unknown = null;
      if (!cooling) {
        const got = await attempt("gemini", state.model ?? opts.model, () => geminiToolLoop(env, run, state));
        if ("outcome" in got) return finish(got.outcome);
        err = got.err;
      }
      // Out of quota halfway through: finish the turn on an OpenAI-style
      // engine with what's been looked up, if one is ready.
      const next = openAiNow();
      if (!next) throw cooling ? nothingToTry(env, opts.model, opts.onAttempt) : unreachable(err, failures, tried);
      if (!cooling) {
        failures.push(`Gemini: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`);
        console.error(`Gemini failed, using ${nameOf(next)} fallback`, err);
      }
      const messages = geminiToOpenAi(opts.system, state.contents);
      const got = await attempt(next, modelFor(env, next, opts.model), () =>
        openAiToolLoop(env, next, run, { engine: next, round: state.round, messages, slots: [], ...(claim && { claim }) }),
      );
      if ("outcome" in got) return finish(got.outcome);
      throw unreachable(got.err, failures, tried);
    }
    const paused = state as Extract<LoopState, { engine: OpenAiEngine }>;
    for (const slot of paused.slots) paused.messages[slot.index].content = toolResultText(result(slot.id));
    // It carries on where it paused: the same engine, and the same model (LoopState.model).
    const own = isOpenAiEngine(paused.engine as string) && availableEngines(env)[paused.engine] ? paused.engine : null;
    let err: unknown = new Error(`That turn was paused on ${paused.engine}, which can't carry it on now, and no other engine is ready.`);
    if (own) {
      const got = await attempt(own, paused.model ?? modelFor(env, own, opts.model), () => openAiToolLoop(env, own, run, paused));
      if ("outcome" in got) return finish(got.outcome);
      err = got.err;
    }
    // Its engine is gone (DeepSeek, retired with v1; a key removed since) or
    // failed before it said anything more: another OpenAI-style engine carries
    // the turn on with what has been looked up, on that engine's own model.
    // GLM on Z.ai and on Workers AI is the same model, so the turn reads the
    // same. A turn paused before v1 may carry DeepSeek's reasoning, which no
    // other host takes back, so it is dropped.
    const next = openAiNow(own ?? undefined);
    if (!next) throw unreachable(err, failures, tried);
    if (own) {
      failures.push(`${nameOf(own)}: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`);
      console.error(`${nameOf(own)} failed, using ${nameOf(next)} fallback`, err);
    }
    const messages = paused.messages.map(({ reasoning_content: _, ...message }) => message);
    const got = await attempt(next, modelFor(env, next, opts.model), () =>
      openAiToolLoop(env, next, run, { ...paused, engine: next, model: undefined, messages }),
    );
    if ("outcome" in got) return finish(got.outcome);
    throw unreachable(got.err, failures, tried);
  }

  let committed = false;
  // Whether a tool did something this turn (claims.ts doesSomething): a reply
  // saying something was done in a turn where none did is repairClaims' case.
  let acted = false;
  const tracked: CallTool = (name, args) => {
    committed = true;
    if (doesSomething(name)) acted = true;
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
  reportSkipped(env, opts.model, order, opts.onAttempt);
  if (!order.length) throw nothingToTry(env, opts.model, opts.onAttempt);
  // Workers AI went silent once this turn and is being asked again (silentRetry).
  let retrying = false;
  for (let i = 0; i < order.length; i++) {
    const engine = order[i];
    const at = Date.now();
    const model = modelFor(env, engine, opts.model);
    // This engine's own signal: the caller's, and the spoken first-word deadline.
    const abort = new AbortController();
    const follow = () => abort.abort(opts.signal?.reason);
    opts.signal?.addEventListener("abort", follow, { once: true });
    let heard = false;
    let silent = false;
    const limitMs = retrying ? Math.min(voiceFirstMs, VOICE_RETRY_FIRST_CONTENT_MS) : voiceFirstMs;
    // The engines after it are read when the timer fires: another call may have cooled one down since.
    const timer =
      opts.voice && engine === "workers" && i === 0
        ? setTimeout(() => {
            const later = order.slice(i + 1).map((e) => ({ cooling: isCooling(e), refused: refusedForGood.has(e) }));
            const s = { voice: true, engine, index: i, later, heard: heard || committed, elapsedMs: Date.now() - at, limitMs };
            if (!abandonSilentEngine(s)) return;
            silent = true;
            abort.abort(new Error(`Timed out after ${limitMs / 1000} s with no first word from ${nameOf(engine)}`));
          }, limitMs)
        : null;
    let outcome: ChatOutcome | null = null;
    try {
      const onOutput = () => {
        heard = true;
      };
      const run: LoopRun = { ...opts, callTool: tracked, onText, signal: abort.signal, onOutput };
      outcome = engine === "gemini" ? await geminiToolLoop(env, run) : await openAiToolLoop(env, engine, run);
      answered(engine);
      opts.onAttempt?.({ engine, model, outcome: outcome.kind === "paused" ? "paused" : "ok", ms: Date.now() - at });
    } catch (err) {
      // Called off by the caller: not the engine's failure, and nothing else is wanted.
      if (opts.signal?.aborted) throw opts.signal.reason ?? err;
      const brief = String(err instanceof Error ? err.message : err).slice(0, 300);
      opts.onAttempt?.({ engine, model, outcome: classifyEngineError(err), ms: Date.now() - at, error: brief });
      if (committed) {
        // Something was already said or done: this turn failed, the AI was reachable.
        coolDownAfter(env, engine, err);
        throw finalError(err, failures, order);
      }
      if (silentRetry({ silent, retrying })) {
        // Not cooled down, and not handed on: see silentRetry.
        retrying = true;
        console.log(`ovoa.engine_silent_retry engine=${engine} after_ms=${Date.now() - at}`);
        i--;
        continue;
      }
      retrying = false;
      if (i === order.length - 1) {
        coolDownAfter(env, engine, err);
        throw unreachable(err, failures, order);
      }
      failures.push(`${nameOf(engine)}: ${brief.slice(0, 200)}`);
      logFallback(env, engine, order[i + 1], err);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", follow);
    }
    // After the engine's own deadlines are cleared: the reply is given, and this is a round of its own.
    if (outcome) {
      if (!opts.repairClaims || acted || !claimedNotDone(opts.turns, outcome)) return outcome;
      // The claim's last sentence goes out now. sentences.ts lets a sentence go
      // only once something follows its full stop, and nothing would until the
      // turn ended: "Noted — milk and eggs." sat silent through the whole repair
      // (a round and its tool, 1-2 s on Workers AI, 4-6 s typed on Z.ai), and
      // "Reminder set for Friday at 9:00 am — submit the report." was heard to
      // its dash, then nothing (2026-09-23). A line break ends it, as before a
      // round's tool calls.
      onText?.("\n");
      return repairClaim(env, engine, opts, outcome.text);
    }
  }
  throw new Error("No engines");
}

/** A reply saying something was done, to a request that asked for it (claims.ts). The caller knows no tool did it. */
function claimedNotDone(turns: Turn[], outcome: ChatOutcome): outcome is Extract<ChatOutcome, { kind: "reply" }> {
  const request = [...turns].reverse().find((t) => t.role === "user")?.text ?? "";
  return outcome.kind === "reply" && asksForAction(request) && claimsDone(outcome.text);
}

/**
 * The most rounds a claim's repair takes: more_tools for the tool the claim
 * needs (a spoken turn carries few, toolbelt.ts), the lookup it needs an id
 * from (alarm_cancel's from alarm_list), then the tool itself.
 */
const REPAIR_ROUNDS = 3;

/**
 * Whether a claim's repair ends after a round that called `tools`, its
 * `rounds`th: once one of them changed something (claims.ts changesSomething),
 * or at REPAIR_ROUNDS. A round that only looked something up or sent for tools
 * goes on to the one that uses what it brought. It used to end there, so a
 * repair that fetched alarm_list or more_tools was logged as repaired, or could
 * never be, while nothing changed (review, 2026-09-23).
 */
const repairEnds = (tools: string[], rounds: number) => tools.some(changesSomething) || rounds >= REPAIR_ROUNDS;

/** What a claim's repair has run: tools that changed something, ones that failed, ones that only looked up (claims.ts). */
function repairTally() {
  const changed: string[] = [];
  const failed: string[] = [];
  const read: string[] = [];
  return {
    changed,
    read,
    note(tool: string, result: unknown) {
      if (!doesSomething(tool)) return;
      if (!changesSomething(tool)) read.push(tool);
      else if (result && typeof result === "object" && "error" in result) failed.push(tool);
      else changed.push(tool);
    },
    /** Why nothing changed, for ovoa.claim_unrepaired. */
    why: () => (failed.length ? `tool_failed failed=${failed.join(",")}` : read.length ? `lookup_only read=${read.join(",")}` : "no_tool"),
  };
}

type RepairTally = ReturnType<typeof repairTally>;

/** A line about a claim's repair: ovoa.claim_repaired, ovoa.claim_unrepaired or ovoa.claim_repair_paused. */
const logClaim = (event: string, engine: Engine, opts: ToolLoopOptions, detail: string) =>
  console.log(`ovoa.${event} engine=${engine} purpose=${opts.usage.purpose} user=${opts.usage.userId?.slice(0, 8) ?? "-"} ${detail}`);

/**
 * How a claim's repair stands after `outcome`, logged as it settles:
 * ovoa.claim_repaired when a tool first changes something, ovoa.claim_unrepaired
 * when the repair ends without one, ovoa.claim_repair_paused while it waits on
 * the phone with nothing changed yet. A paused one carries the claim on in its
 * state. The reply is the claim, which was heard; a resumed turn's is what it
 * streamed, or the claim when it wrote nothing (the tool loops).
 */
function claimOutcome(outcome: ChatOutcome, claim: ClaimInRepair, tally: RepairTally, opts: ToolLoopOptions, resumed: boolean): ChatOutcome {
  const repaired = !!claim.repaired || tally.changed.length > 0;
  const log = (event: string, detail: string) => logClaim(event, outcome.engine, opts, `${detail}${resumed ? " resumed=1" : ""}`);
  if (!claim.repaired && tally.changed.length) log("claim_repaired", `tools=${tally.changed.join(",")}${outcome.kind === "paused" ? " paused=1" : ""}`);
  if (outcome.kind === "paused") {
    if (!repaired) log("claim_repair_paused", `read=${tally.read.join(",") || "-"}`);
    const state = { ...outcome.state, claim: { reply: claim.reply, ...(repaired && { repaired: true as const }) } };
    return { ...outcome, state, claim: repaired ? "repaired" : "pending" };
  }
  if (!repaired) log("claim_unrepaired", `why=${tally.why()}`);
  return { ...outcome, text: resumed ? outcome.text : claim.reply, claim: repaired ? "repaired" : "unrepaired" };
}

/**
 * repairClaims: more rounds on the engine that answered, with its reply and
 * CLAIM_NUDGE after it, so the tool the reply spoke for is called now. Nothing
 * it writes is streamed (the claim already was), and the reply stays the one
 * given. It ends once a round's tools have changed something (repairEnds). A
 * lookup it defers to the phone pauses the turn as any would, and the turn
 * finishes the repair when the phone answers (ClaimInRepair).
 *
 * The round is built from the turn and the reply, not from the loop's own
 * messages: a turn that ran no tool had one round, or rounds that only sent for
 * more tools (more_tools), and those are in `tools` now, which grows in place.
 * It never fails the turn: the reply was given, and a round that fails leaves
 * it standing, like one that calls no tool or only tools that fail. Each way is
 * logged (claimOutcome), and the outcome's `claim` says which, for the turn's
 * meta.
 */
async function repairClaim(env: LlmEnv, engine: Engine, opts: ToolLoopOptions, reply: string): Promise<ChatOutcome> {
  const tally = repairTally();
  const callTool: CallTool = async (name, args) => {
    const result = await safeCall(opts.callTool, name, args);
    tally.note(name, result);
    return result;
  };
  // Streamed to nobody rather than not streamed, so its tool calls are read by
  // the same parser as every other round of a person's turn.
  const run: LoopRun = { ...opts, callTool, onText: () => {}, onOutput: undefined, repair: true };
  const claim: ClaimInRepair = { reply };
  try {
    const outcome =
      engine === "gemini"
        ? await geminiToolLoop(env, run, {
            engine,
            model: opts.model,
            round: 1,
            contents: [...geminiTurns(opts.turns), { role: "model", parts: [{ text: reply }] }, { role: "user", parts: [{ text: CLAIM_NUDGE }] }],
            slots: [],
            claim,
          })
        : await openAiToolLoop(env, engine, run, {
            engine,
            model: modelFor(env, engine, opts.model),
            round: 1,
            messages: [...openAiTurns(opts.system, opts.turns), { role: "assistant", content: reply }, { role: "user", content: CLAIM_NUDGE }],
            slots: [],
            claim,
          });
    return claimOutcome(outcome, claim, tally, opts, false);
  } catch (err) {
    if (opts.signal?.aborted) throw opts.signal.reason ?? err;
    // No round that failed follows one that changed something: the repair ends there.
    logClaim("claim_unrepaired", engine, opts, `why=${classifyEngineError(err)}`);
    return { kind: "reply", text: reply, engine, claim: "unrepaired" };
  }
}

// ---------- Web search ----------

/**
 * A question answered by Gemini with Google Search turned on, and the pages it
 * used (web.ts web_search asks this first, and DuckDuckGo when it fails). A
 * model call like any other, so it asks the gate first. Its cost is filed by
 * the caller as a search (usage.ts searchRow), not through the usage sink.
 */
export async function searchGrounded(env: LlmEnv, opts: { query: string; today: string; usage: UsageTag }) {
  await askGate(env, opts.usage);
  if (!env.GEMINI_API_KEY) throw new Error("Gemini search has no key (GEMINI_API_KEY)");
  return geminiGrounded({ apiKey: env.GEMINI_API_KEY, model: env.CHAT_MODEL ?? "", query: opts.query, today: opts.today });
}

// ---------- Deadlines ----------
//
// Nothing here used to wait for anything. A model that accepted the request and
// then said nothing held the turn open until the phone gave up at 60 s
// ("POST /chat stalled after 60029 ms", device_logs 2026-09-21) and the Worker
// never found out it had happened. Giving up at 20 s and losing the turn is
// worse than a fast answer, but it is far better than silence: the error names
// the engine, cools it down, and the next engine gets the turn. A spoken turn
// has a shorter one for Workers AI when it goes first (abandonSilentEngine).

/** How long an engine has to send its first byte. */
const DEFAULT_CONNECT_MS = 20_000;
/** How long a stream may go quiet once it has started. */
const DEFAULT_IDLE_MS = 25_000;
/**
 * How long a spoken turn waits for Workers AI's first word. Four times its
 * slowest probe (1.5 s), and about when Z.ai, the next engine, would have been
 * speaking already. Never applied to Z.ai itself, whose ordinary first word
 * (4.5-6.6 s) sits right at it.
 */
const DEFAULT_VOICE_FIRST_CONTENT_MS = 6_000;
/**
 * The second go at Workers AI after a silence (silentRetry) gets less: its
 * first event comes in 0.7-1 s and its first word in 2.1-2.9 s (device_logs,
 * 2026-09-24), so one silent at 4 s is stuck too, and the person has already
 * waited out the first try.
 */
const VOICE_RETRY_FIRST_CONTENT_MS = 4_000;

let connectMs = DEFAULT_CONNECT_MS;
let idleMs = DEFAULT_IDLE_MS;
let voiceFirstMs = DEFAULT_VOICE_FIRST_CONTENT_MS;

/**
 * The deadlines are read from the environment on every turn, so a model that
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
  voiceFirstMs = read(env.VOICE_FIRST_CONTENT_MS, DEFAULT_VOICE_FIRST_CONTENT_MS);
}

/**
 * Starts a request with a deadline on its start only: the headers, or the
 * Workers AI binding handing back its stream. The timer is cleared once it has
 * started, because the same signal would otherwise abort a long reply midway
 * through; the body is watched by withIdleDeadline instead. The caller's signal
 * stays tied to the request for its whole life, so calling it off stops the
 * body too. Rejects with the reason it was aborted for, not a bare AbortError,
 * and without waiting for a request that doesn't honour its signal to notice.
 */
async function started<T>(signal: AbortSignal | undefined, start: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error(`Timed out after ${connectMs / 1000} s waiting for the model`)), connectMs);
  const follow = () => abort.abort(signal!.reason);
  if (signal?.aborted) follow();
  else signal?.addEventListener("abort", follow, { once: true });
  try {
    return await unlessAborted(start(abort.signal), abort.signal);
  } catch (err) {
    throw abort.signal.aborted ? abort.signal.reason : err;
  } finally {
    clearTimeout(timer);
  }
}

/** fetch, started with `started`'s deadline. */
function fetchWithDeadline(url: string, init: RequestInit, signal?: AbortSignal) {
  return started(signal, (s) => fetch(url, { ...init, signal: s }));
}

/** `work`, or the signal's reason once it aborts, whichever comes first. For a wait that takes no signal of its own. */
function unlessAborted<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Rejects if one read takes too long (a stream that goes quiet is the 60 s
 * stall) or the signal aborts: a binding's stream isn't guaranteed to stop
 * with its signal, so the read is let go of here and sseData cancels it.
 */
function withIdleDeadline<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    unlessAborted(work, signal).finally(() => {
      if (timer !== null) clearTimeout(timer);
    }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`No output from the model for ${idleMs / 1000} s`)), idleMs);
    }),
  ]);
}

// ---------- Streaming ----------

/** The `data:` payloads of a server-sent-events stream. */
async function* sseData(body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
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
      const { done, value } = await withIdleDeadline(reader.read(), signal);
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
    // Stopping early (a long-enough spoken reply, a call called off) also stops the model upstream.
    reader.cancel().catch(() => {});
  }
}

/** How one model round is sent and heard, besides its body. */
type RoundIo = {
  /** Stream the round, and hand it each piece of the reply as it is written. */
  onText?: OnText;
  /** The round has started its answer: its first word, or the first piece of a tool call. */
  onOutput?: () => void;
  signal?: AbortSignal;
  /** Whose call it is, for Workers AI's prompt cache (openAiCall). */
  affinity?: string | null;
};

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
  io: RoundIo,
): Promise<{ content: { role: string; parts: any[] }; usage: TokenUsage | null }> {
  const { onText, onOutput, signal } = io;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${onText ? "streamGenerateContent?alt=sse" : "generateContent"}`;
  const res = await fetchWithDeadline(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
    },
    signal,
  );
  if (!res.ok) throw new Error(`Gemini ${model} ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const answers = (part: any) => (part.text && !part.thought) || part.functionCall;
  if (!onText) {
    const data = (await res.json()) as any;
    const content = data.candidates?.[0]?.content ?? { role: "model", parts: [] };
    if ((content.parts ?? []).some(answers)) onOutput?.();
    return { content, usage: readGeminiUsage(data.usageMetadata) };
  }
  // Keep every part as it arrived: function calls carry thought signatures Gemini wants back.
  const parts: any[] = [];
  let usage: TokenUsage | null = null;
  for await (const data of sseData(res.body!, signal)) {
    const chunk = JSON.parse(data);
    usage = readGeminiUsage(chunk.usageMetadata) ?? usage;
    let stop = false;
    for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
      parts.push(part);
      if (answers(part)) onOutput?.();
      if (part.text && !part.thought && onText(part.text) === false) stop = true;
    }
    if (stop) break;
  }
  return { content: { role: "model", parts }, usage };
}

/** A conversation as Gemini's contents. */
const geminiTurns = (turns: Turn[]): any[] => turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] }));

async function geminiToolLoop(env: LlmEnv, opts: LoopRun, paused?: Extract<LoopState, { engine: "gemini" }>): Promise<ChatOutcome> {
  const { system, turns, tools, callTool, voice, onText, onOutput, signal } = opts;
  // A resumed turn carries on with the model it paused on (LoopState.model).
  const model = paused?.model ?? opts.model;
  const contents: any[] = paused?.contents ?? geminiTurns(turns);
  const first = paused?.round ?? 0;

  for (let round = first; round <= MAX_TOOL_ROUNDS; round++) {
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
      { onText, onOutput, signal },
    );
    reportUsage(env, opts, "gemini", model, usage, Date.now() - at);
    const parts: any[] = content.parts ?? [];
    const calls = parts.filter((p) => p.functionCall);
    const said = parts
      .filter((p) => p.text && !p.thought)
      .map((p) => p.text)
      .join("");

    if (!calls.length) {
      // A claim's repair, told to write nothing else, may do just that once its tools have run (ClaimInRepair).
      if (!said && paused?.claim) return { kind: "reply", text: paused.claim.reply, engine: "gemini" };
      if (!said) throw new Error(`Gemini ${model} returned no text`);
      return { kind: "reply", text: said, engine: "gemini" };
    }

    // The words before the calls end their sentence now, as in openAiToolLoop.
    if (onText && said.trim()) onText("\n");
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
      const state = { engine: "gemini" as const, model, round: round + 1, contents, slots, ...(paused?.claim && { claim: paused.claim }) };
      return { kind: "paused", state, calls: deferred, engine: "gemini" };
    }
    if (opts.repair && repairEnds(calls.map((p) => p.functionCall.name), round + 1 - first)) return { kind: "reply", text: said, engine: "gemini" };
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

/** The engines reached with OpenAI-style chat completions (OPENAI_PROVIDERS): over HTTP, or through a binding. */
type OpenAiEngine = "glm" | "workers";

/**
 * One OpenAI-compatible provider, as the names of the vars that configure it,
 * so a new one is an entry here plus its vars (see the top of this file).
 */
type OpenAiProvider = {
  /**
   * What people and the logs call it. Its errors start "<name> <model>" and,
   * over HTTP, the status ("<name> <model> <status>:"), which is the shape
   * coolDown and classifyEngineError read.
   */
  name: string;
  /**
   * The secret holding its key, or for a provider reached through a binding
   * (`binding`), the binding's name. Without it the engine does not exist.
   */
  keyVar: string;
  /** Reached through the Workers AI binding named by keyVar (env.AI.run) rather than over HTTP: no key, no base URL. */
  binding?: true;
  /** Over HTTP: the var holding its base URL (with or without /chat/completions), and the URL when it is unset. */
  baseUrlVar?: string;
  defaultBaseUrl?: string;
  /** The var holding the model id, as the provider knows it, and the id when it is unset. Priced by this id (pricing.ts). */
  modelVar: string;
  defaultModel: string;
  /** The var saying how much it thinks on a typed turn: "off", "low" (the default) or "on". None: "low". */
  thinkingVar?: string;
  /**
   * How this provider is told how much to think. Unset: the flavor of its base
   * URL (hostFlavor). "workers" is Workers AI's own rule; "none" sends no
   * thinking field, for a model that doesn't think and rejects `reasoning_effort`.
   */
  thinking?: ThinkingSpelling;
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
  // The same GLM 5.3 Flash on Cloudflare Workers AI, through the AI binding
  // (wrangler.jsonc "ai"): the spoken engine, and the last resort for the rest.
  // Priced by its model id in pricing.ts. Asked for reasoning_effort "low", it
  // doesn't reason at all (thinkingFields).
  workers: {
    name: "Workers AI",
    keyVar: "AI",
    binding: true,
    modelVar: "WORKERS_MODEL",
    defaultModel: "@cf/zai-org/glm-5.3-flash",
    thinking: "workers",
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

/** Where a provider is: its base URL var, else its default. Empty for one reached through a binding. */
function baseUrlOf(env: LlmEnv, engine: OpenAiEngine) {
  const provider = OPENAI_PROVIDERS[engine];
  return (provider.baseUrlVar && varOf(env, provider.baseUrlVar)) || provider.defaultBaseUrl || "";
}

/** How a provider is told how much to think: its own `thinking`, else its host's flavor. */
function thinkingFlavorOf(env: LlmEnv, engine: OpenAiEngine): ThinkingSpelling {
  return OPENAI_PROVIDERS[engine].thinking ?? hostFlavor(baseUrlOf(env, engine));
}

/** A switch var: on unless it says off. */
const switchedOff = (raw: string | undefined) => ["off", "false", "0", "no"].includes((raw ?? "").trim().toLowerCase());

type OpenAiOut = {
  /** Workers AI's older models answer with `response` rather than `choices`. */
  response?: string | object;
  choices?: { message?: { content?: string | null; tool_calls?: any[] } }[];
  usage?: unknown;
};

/** The request body: the standard fields plus whatever thinkingFields adds for the model. */
type OpenAiBody = { messages: any[]; tools?: any[]; max_tokens: number } & Record<string, unknown>;

/** One assistant message, however it arrived, with the counts the provider attached and, when streamed, its timing. */
type OpenAiMessage = { content: string; tool_calls: any[]; usage: TokenUsage | null; timing?: RoundTiming };

// ---------- Thinking ----------
//
// Every reasoning model bills its thinking as output tokens, at the output
// price, and thinks a lot by default: GLM 5.3 Flash at "max". On a spoken turn
// that is seconds of silence before the first word, paid for. So spoken and
// quick calls ask for no thinking and typed ones for a little, and each host is
// told in the words it understands, because they differ: Z.ai's GLM 5.3 cannot
// switch off at all (its floor is "low", which still reasons for seconds),
// Workers AI's GLM stops reasoning only for reasoning_effort "low", OpenRouter
// wants a `reasoning` object, and any other OpenAI-compatible host gets the
// plain OpenAI field. Keyed off the host and the model id.

export type ThinkingLevel = "off" | "low" | "on";

/** Which kind of OpenAI-compatible host a provider is on. Decides how thinking is spelled. */
export type HostFlavor = "zai" | "openrouter" | "openai";

/** How a provider is told how much to think: its host's flavor, Workers AI's own rule, or nothing at all. */
export type ThinkingSpelling = HostFlavor | "workers" | "none";

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

/**
 * How much this call asks to think. Spoken and quick calls ask for "off";
 * typed turns for a little, or what the provider's var says. What a host does
 * with "off" is thinkingFields' business: Z.ai's GLM 5.3 still thinks at "low".
 */
export function thinkingLevelFor(env: LlmEnv, engine: OpenAiEngine, voiceOrFast: boolean): ThinkingLevel {
  if (voiceOrFast) return "off";
  const thinkingVar = OPENAI_PROVIDERS[engine].thinkingVar;
  return parseThinking(thinkingVar && varOf(env, thinkingVar), "low");
}

/**
 * The request fields that ask for `level` of thinking from `model` on a host
 * of this flavor. Pure, so every host's spelling is checked by a test rather
 * than by a 400 in production.
 */
export function thinkingFields(model: string, level: ThinkingLevel, flavor: ThinkingSpelling): Record<string, unknown> {
  // A provider whose model doesn't think (OpenAiProvider.thinking): no field at all.
  if (flavor === "none") return {};
  const m = model.toLowerCase();
  if (flavor === "workers") {
    // GLM on Workers AI: reasoning_effort "low" is the one field that stops it
    // reasoning. Probed 2026-09-23 on a 6.7K-token prompt with 15 tools: no
    // reasoning at all, first word in 0.66-1.5 s. With no field, or with Z.ai's
    // thinking {type: "disabled"}, it reasons first (first word 1.8-5 s). So
    // every level is "low", "off" included, and "on" too: it would only buy the
    // reasoning back. chat_template_kwargs {enable_thinking: false} is never
    // sent: the model then writes its reasoning into the reply itself ("The
    // user is asking two things..."), which would be spoken aloud. That is how
    // the engine before v1, which sent it for "off", came to give 761-token
    // rambling spoken replies (docs/voice-latency.md).
    if (/glm/.test(m)) return { reasoning_effort: "low" };
    // Another model on Workers AI (gpt-oss, say): the plain OpenAI field.
    return { reasoning_effort: level === "on" ? "high" : "low" };
  }
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

/** Sends one round: a stream of server-sent events when `stream`, else the parsed answer. */
async function openAiCall(env: LlmEnv, engine: OpenAiEngine, model: string, body: OpenAiBody, stream: boolean, io: RoundIo): Promise<any> {
  const provider = OPENAI_PROVIDERS[engine];
  if (provider.binding) {
    const ai = (env as Record<string, unknown>)[provider.keyVar] as Ai;
    try {
      return await started(io.signal, (signal) =>
        ai.run(
          model as keyof AiModels,
          // include_usage: the token counts ride on a last chunk, and Workers AI's
          // chat-completions input types the option the same way OpenAI does.
          { ...body, ...(stream && { stream: true, stream_options: { include_usage: true } }) } as never,
          {
            signal,
            // Workers AI keeps a prompt it has just read on the server that read
            // it, and sends requests carrying the same x-session-affinity back
            // there ("prompt caching", passed to the binding as extraHeaders).
            // Keyed on the person, so their next call reads the front it shares
            // with the last one (instructions, tools, history) at the cached
            // price, a fifth of the fresh one, and sooner.
            ...(io.affinity && { extraHeaders: { "x-session-affinity": `ovoa-${io.affinity}` } }),
          },
        ),
      );
    } catch (err) {
      // "<name> <model>:" as the HTTP errors start, so the engine table reads the same for every engine.
      throw new Error(`${provider.name} ${model}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const base = baseUrlOf(env, engine);
  const flavor = hostFlavor(base);
  const res = await fetchWithDeadline(
    chatCompletionsUrl(base),
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${varOf(env, provider.keyVar)}` },
      body: JSON.stringify({
        model,
        ...body,
        // A stream ends with the token counts only when asked (OpenAI's
        // stream_options). Z.ai sends them on its last chunk without being asked
        // and documents no stream_options; it does take tool_stream, which streams
        // a tool call's arguments as they are written rather than all at the end
        // (GLM_TOOL_STREAM "off" stops asking, to see whether it costs the first word).
        ...(stream && {
          stream: true,
          ...(flavor === "zai" ? !switchedOff(env.GLM_TOOL_STREAM) && { tool_stream: true } : { stream_options: { include_usage: true } }),
        }),
      }),
    },
    io.signal,
  );
  // "<name> <model> <status>:" is the shape coolDown and classifyEngineError read.
  if (!res.ok) throw new Error(`${provider.name} ${model} ${res.status}: ${(await res.text()).slice(0, 500)}`);
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

/**
 * The offered tool a call meant, when the model wrote more than its name.
 * Workers AI's GLM once streamed the name "money_afford</arg_value>", the tail
 * of its own call template glued on (engine-bench against production,
 * 2026-09-23), and the call went to no tool and failed. A name that isn't
 * offered becomes the longest offered name it starts with, which covers its
 * plain identifier part (/^[A-Za-z0-9_]+/) being offered. Anything else is
 * left as it came, to fail as an unknown tool. Pure.
 */
export function toolNameFor(name: string, offered: string[]): string {
  if (offered.includes(name)) return name;
  const written = name.trim();
  let meant = "";
  for (const o of offered) if (o && written.startsWith(o) && o.length > meant.length) meant = o;
  return meant || name;
}

/**
 * A tool call's arguments as an object, from whatever the host sent. Spoken
 * turns resuming after a contacts lookup failed with Workers AI's 8007
 * "Assistant tool call function.arguments must be valid JSON" (twice on
 * 2026-09-23, error_events, /chat/resume only): the call's arguments went back
 * to it exactly as they came, and they weren't JSON. Where the parse failed,
 * the tool itself had been given {} too. So: JSON as it should be; an object handed over as one; the first {...}
 * in it when a template's tail is glued on (as the name was, toolNameFor);
 * GLM's own <arg_key>/<arg_value> template; else nothing. `repaired`: it
 * wasn't plain JSON (an empty string, for a tool that takes nothing, is fine). Pure.
 */
export function toolArgsFrom(raw: unknown): { args: Record<string, unknown>; repaired: boolean } {
  const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (isObject(raw)) return { args: raw, repaired: true };
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { args: {}, repaired: raw !== undefined && raw !== null && raw !== "" };
  const parse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  const whole = parse(text);
  if (isObject(whole)) return { args: whole, repaired: false };
  // Encoded twice: "{\"query\":\"Ty\"}".
  if (typeof whole === "string" && isObject(parse(whole))) return { args: parse(whole) as Record<string, unknown>, repaired: true };
  const open = text.indexOf("{");
  const close = text.lastIndexOf("}");
  if (open >= 0 && close > open) {
    const inner = parse(text.slice(open, close + 1));
    if (isObject(inner)) return { args: inner, repaired: true };
  }
  const pairs = [...text.matchAll(/<arg_key>\s*([\s\S]*?)\s*<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g)];
  if (pairs.length) {
    const args: Record<string, unknown> = {};
    for (const [, key, value] of pairs) {
      const v = parse(value.trim());
      args[key] = v === undefined ? value.trim() : v;
    }
    return { args, repaired: true };
  }
  return { args: {}, repaired: true };
}

/** A tool call with its arguments written back as the JSON its tool was given (toolArgsFrom). */
const withArgs = (call: any, args: Record<string, unknown>) => ({ ...call, function: { ...call.function, arguments: JSON.stringify(args) } });

/** A round's tool calls, each named as the offered tool it meant (toolNameFor). A repaired name is logged. */
function namedAsOffered(engine: OpenAiEngine, body: OpenAiBody, calls: any[]) {
  const offered: string[] = (body.tools ?? []).map((t) => t.function?.name).filter(Boolean);
  for (const call of calls) {
    const name = call.function?.name ?? "";
    const meant = toolNameFor(name, offered);
    if (meant === name) continue;
    console.log(`ovoa.tool_name_repaired engine=${engine} from=${JSON.stringify(name).replace(/\s+/g, "_").slice(0, 120)} to=${meant}`);
    call.function.name = meant;
  }
  return calls;
}

/** One model turn. Streamed when `onText` is set, with its timing marks; either way returns the whole message. */
async function openAiRound(env: LlmEnv, engine: OpenAiEngine, model: string, body: OpenAiBody, io: RoundIo): Promise<OpenAiMessage> {
  const { onText, onOutput } = io;
  if (!onText) {
    const out = (await openAiCall(env, engine, model, body, false, io)) as OpenAiOut;
    const calls = namedAsOffered(engine, body, out.choices?.[0]?.message?.tool_calls ?? []);
    const message = { content: openAiText(out), tool_calls: calls, usage: readOpenAiUsage(out.usage) };
    if (message.content || message.tool_calls.length) onOutput?.();
    return message;
  }
  const at = Date.now();
  const stream = (await openAiCall(env, engine, model, body, true, io)) as ReadableStream<Uint8Array>;
  const mark = () => Date.now() - at;
  const timing: RoundTiming = { headersMs: mark(), endMs: 0, reasoningChars: 0 };
  let content = "";
  let usage: TokenUsage | null = null;
  const calls: any[] = [];
  for await (const data of sseData(stream, io.signal)) {
    timing.firstEventMs ??= mark();
    const chunk = JSON.parse(data);
    // The counts ride on the last chunk (Z.ai always; other hosts when asked
    // with stream_options). Stopping a reply early gives up the counts too.
    usage = readOpenAiUsage(chunk.usage) ?? usage;
    const delta = chunk.choices?.[0]?.delta;
    // Reasoning is never spoken or sent back, only timed: Z.ai streams it as
    // reasoning_content, and Workers AI as that or `reasoning` (2026-09-23).
    const reasoning = delta?.reasoning_content ?? delta?.reasoning;
    if (typeof reasoning === "string" && reasoning) {
      timing.firstReasoningMs ??= mark();
      timing.reasoningChars += reasoning.length;
    }
    // Workers AI ends with {"response": "", usage}; its older models stream only `response`.
    const text: string = delta?.content ?? (typeof chunk.response === "string" ? chunk.response : "");
    for (const tc of delta?.tool_calls ?? []) {
      timing.firstToolMs ??= mark();
      const slot = (calls[tc.index ?? 0] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.function.name += tc.function.name;
      // A host that hands the arguments over as an object: "" + {} was "[object Object]".
      if (tc.function?.arguments) slot.function.arguments += typeof tc.function.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function.arguments);
    }
    if (text) timing.firstContentMs ??= mark();
    if (text || delta?.tool_calls?.length) onOutput?.();
    if (text) {
      content += text;
      if (onText(text) === false) break;
    }
  }
  timing.endMs = mark();
  return { content: stripThinking(content), tool_calls: namedAsOffered(engine, body, calls.filter(Boolean)), usage, timing };
}

async function openAiGenerate(env: LlmEnv, engine: OpenAiEngine, model: string, opts: Options): Promise<string> {
  const { system, turns, json, fast } = opts;
  const systemText = json
    ? `${system}\n\nRespond with only a JSON object matching this JSON schema, no other text:\n${JSON.stringify(json.schema)}`
    : system;

  const at = Date.now();
  const { content, usage } = await openAiRound(
    env,
    engine,
    model,
    {
      messages: openAiTurns(systemText, turns),
      max_tokens: 2048,
      ...thinkingFields(model, thinkingLevelFor(env, engine, !!fast), thinkingFlavorOf(env, engine)),
    },
    { signal: opts.signal, affinity: opts.usage.userId },
  );
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

/** The system prompt and a conversation as OpenAI-style messages. */
const openAiTurns = (system: string, turns: Turn[]): any[] => [
  { role: "system", content: system },
  ...turns.map((t) => ({ role: t.role === "model" ? "assistant" : "user", content: t.text })),
];

async function openAiToolLoop(
  env: LlmEnv,
  engine: OpenAiEngine,
  opts: LoopRun,
  paused?: Extract<LoopState, { engine: OpenAiEngine }>,
): Promise<ChatOutcome> {
  const { system, turns, tools, callTool, voice, onText, onOutput, signal } = opts;
  const messages: any[] = paused?.messages ?? openAiTurns(system, turns);
  // A turn paused before its calls' arguments were cleaned up (toolArgsFrom)
  // still has them as they came: sent back like that, Workers AI refused it.
  for (const [i, m] of messages.entries()) {
    if (m?.role === "assistant" && Array.isArray(m.tool_calls)) {
      messages[i] = { ...m, tool_calls: m.tool_calls.map((call: any) => withArgs(call, toolArgsFrom(call.function?.arguments).args)) };
    }
  }
  // A resumed turn carries on with the model it paused on (LoopState.model).
  const model = paused?.model ?? modelFor(env, engine, opts.model);
  // Spoken turns ask for as little thinking as the host allows: none on Workers
  // AI's GLM, "low" on Z.ai's, which can't go lower. See thinkingFields.
  const thinking = thinkingFields(model, thinkingLevelFor(env, engine, !!voice), thinkingFlavorOf(env, engine));
  const io: RoundIo = { onText, onOutput, signal, affinity: opts.usage.userId };
  const first = paused?.round ?? 0;
  for (let round = first; round <= MAX_TOOL_ROUNDS; round++) {
    // Built each round rather than once: a spoken turn starts with a handful of
    // tools and sends for more mid-turn (toolbelt.ts), and those have to be in
    // front of the model on the step after it asked for them. Gemini's loop
    // already re-read the array; this one used to freeze it.
    const toolDefs = tools.map((t) => ({ type: "function", function: t }));
    const at = Date.now();
    const message = await openAiRound(
      env,
      engine,
      model,
      {
        messages,
        ...(round < MAX_TOOL_ROUNDS && toolDefs.length && { tools: toolDefs }),
        max_tokens: 4096,
        ...thinking,
      },
      io,
    );
    reportUsage(env, opts, engine, model, message.usage, Date.now() - at, message.timing);

    const calls = message.tool_calls;
    if (!calls.length) {
      // A claim's repair, told to write nothing else, may do just that once its tools have run (ClaimInRepair).
      if (!message.content && paused?.claim) return { kind: "reply", text: paused.claim.reply, engine };
      if (!message.content) throw new Error(`${nameOf(engine)} returned no text`);
      return { kind: "reply", text: message.content, engine };
    }

    // Each call's arguments as the tool will get them (toolArgsFrom), and sent
    // back to the model the same way.
    const parsed = calls.map((call: any) => {
      const got = toolArgsFrom(call.function?.arguments);
      if (got.repaired) {
        const raw = call.function?.arguments;
        console.log(
          `ovoa.tool_args_repaired engine=${engine} tool=${call.function?.name} raw=${JSON.stringify(typeof raw === "string" ? raw.slice(0, 120) : raw ?? null)}`,
        );
      }
      return got.args;
    });
    // Content is never null on an assistant turn (some hosts reject it). The
    // model's reasoning is not sent back: GLM's hosts neither need it nor
    // promise to accept it, and it is never spoken or shown.
    messages.push({ role: "assistant", content: message.content ?? "", tool_calls: calls.map((call: any, i: number) => withArgs(call, parsed[i])) });
    // The words the round wrote before its tool calls ("Checking the weather.")
    // are a sentence of their own. Without a line break here the next round's
    // first word was glued on to them ("…on record.Noted — 30 days", 2026-09-23),
    // and the preface waited unspoken for the tools and the whole next round
    // (4.5-7 s on Z.ai) to put a space after its full stop. sentences.ts ends a
    // sentence at a line break, so it is voiced now, while the tools run.
    if (onText && message.content.trim()) onText("\n");
    const slots: { id: string; index: number }[] = [];
    const deferred: DeferredCall[] = [];
    for (const [i, call] of calls.entries()) {
      const args = parsed[i];
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
      return { kind: "paused", state: { engine, model, round: round + 1, messages, slots, ...(paused?.claim && { claim: paused.claim }) }, calls: deferred, engine };
    }
    if (opts.repair && repairEnds(calls.map((c: any) => c.function?.name), round + 1 - first)) return { kind: "reply", text: message.content, engine };
  }
  throw new Error("Too many tool rounds");
}
