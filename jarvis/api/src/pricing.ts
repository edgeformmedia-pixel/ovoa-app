// What each thing OVOA buys costs, in one place, with the date it was checked.
//
// Every number here is a list price copied from the provider's own page on the
// date below. They exist so the usage table (usage.ts) can say what a person's
// day cost in dollars rather than in tokens, and so a phase of the cost pass
// can be judged by the same arithmetic before and after. When a provider
// changes a price, change it here, move the date, and nothing else.
//
// Money is kept in millionths of a dollar ("micro"), as an integer, all the way
// to the database: floating-point cents drift when summed a thousand times a
// day, and integers never do. One dollar is 1,000,000 micro; a cent is 10,000.
//
// A useful coincidence: a price quoted in dollars per million tokens is exactly
// the price in micro-dollars per token. So tokens × price is the cost in micro.
//
// Checked 2026-09-22 against the pages below, and Google's again on 2026-09-23
// for Gemini 3.5 Flash-Lite and the models whose prices double in 2027:
//   https://deepgram.com/pricing
//   https://ai.google.dev/gemini-api/docs/pricing
//   https://docs.z.ai/guides/overview/pricing
//
// The DeepSeek and Workers AI rows went with those engines in the v1 release
// (2026-09-23). usage_daily rows from before then keep the cost they were
// written with; nothing here re-prices them.

export const PRICES_CHECKED_ON = "2026-09-23";

/** Dollars per million tokens. `cachedIn` is the price of an input token the provider already had. */
export type TokenPrice = { in: number; out: number; cachedIn?: number };

/**
 * Reply engines, by the model id the engine actually calls (llm.ts modelFor).
 * A model missing from here costs $0 in the estimate, so a new provider's
 * model gets a row the day it is added (llm.ts, the top of the file).
 */
export const LLM_PRICES: Record<string, TokenPrice> = {
  // Gemini 3.5 Flash-Lite, paid tier: the second engine, and the model for web
  // search grounding. Standard prices from Google's pricing page, 2026-09-23.
  "gemini-3.5-flash-lite": { in: 0.3, cachedIn: 0.03, out: 2.5 },
  // Gemini 3.8 Flash, paid tier: the model before Flash-Lite. Kept so a switch
  // back through CHAT_MODEL is still priced.
  "gemini-3.8-flash": { in: 0.75, cachedIn: 0.075, out: 3.75 },
};

/**
 * GLM 5.3 Flash from the user's own cheap provider (Z.ai for v1). The provider
 * may change, so the price is a default that the GLM_PRICE_* vars override.
 */
export const GLM_DEFAULT_PRICE: TokenPrice = { in: 0.06, cachedIn: 0.06, out: 0.2 };

/**
 * Some Gemini models' paid prices double on this date. Applied by date so the
 * estimate is right in January without a deploy.
 */
export const GEMINI_PRICE_DOUBLES_ON = "2027-01-01";

/**
 * The models Google's pricing page shows with a price "starting January 1,
 * 2027" (checked 2026-09-23). Gemini 3.5 Flash-Lite is not one of them, so it
 * keeps its price; before this list, every "gemini" id was doubled.
 */
export const GEMINI_DOUBLING_MODELS: readonly string[] = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.8-live",
  "gemini-3.8-live-extended-thinking",
  "gemini-3.1-flash-live-preview",
  "gemini-robotics-er-2-preview",
  "gemini-robotics-er-2-streaming-preview",
];

/** Text to speech, dollars per 1,000 characters. */
export const TTS_PRICES_PER_1K_CHARS: Record<string, number> = {
  "deepgram-aura-2": 0.03,
  // The phone's own voices.
  device: 0,
};

/** Speech to text, dollars per minute of audio. */
export const STT_PRICES_PER_MINUTE: Record<string, number> = {
  // Nova-3 live, direct from the phone. Promo price; the regular price is $0.0077.
  "deepgram-nova-3-live": 0.0048,
  "deepgram-nova-3-clip": 0.0043,
};

export const MICRO_PER_USD = 1_000_000;

export type TokenCounts = { input: number; cached?: number; output: number };

/** The price of a model, adjusted for the date: the 2027 doubling, for the Gemini models it applies to. */
export function priceFor(model: string, at: Date, override?: TokenPrice): TokenPrice | null {
  const base = override ?? LLM_PRICES[model];
  if (!base) return null;
  const factor = GEMINI_DOUBLING_MODELS.includes(model) && at.toISOString().slice(0, 10) >= GEMINI_PRICE_DOUBLES_ON ? 2 : 1;
  return {
    in: base.in * factor,
    out: base.out * factor,
    ...(base.cachedIn !== undefined && { cachedIn: base.cachedIn * factor }),
  };
}

/**
 * What one model call cost, in micro-dollars. `input` is every prompt token,
 * including the cached ones; `cached` is how many of those the provider had
 * already and charged less for. Unknown models cost 0 rather than throwing,
 * because an estimate must never fail the request it is estimating.
 */
export function llmCostMicro(model: string, tokens: TokenCounts, at = new Date(), override?: TokenPrice) {
  const price = priceFor(model, at, override);
  if (!price) return 0;
  const cached = Math.min(Math.max(0, tokens.cached ?? 0), Math.max(0, tokens.input));
  const fresh = Math.max(0, tokens.input) - cached;
  const cachedRate = price.cachedIn ?? price.in;
  return Math.round(fresh * price.in + cached * cachedRate + Math.max(0, tokens.output) * price.out);
}

/** What voicing `chars` characters cost on a TTS engine, in micro-dollars. */
export function ttsCostMicro(engine: string, chars: number) {
  const perK = TTS_PRICES_PER_1K_CHARS[engine];
  if (!perK) return 0;
  return Math.round((Math.max(0, chars) / 1000) * perK * MICRO_PER_USD);
}

/** What transcribing `seconds` of audio cost, in micro-dollars. */
export function sttCostMicro(engine: string, seconds: number) {
  const perMinute = STT_PRICES_PER_MINUTE[engine];
  if (!perMinute) return 0;
  return Math.round((Math.max(0, seconds) / 60) * perMinute * MICRO_PER_USD);
}

/** Micro-dollars as a string a person reads: "$0.53", "$0.0048". */
export function usd(micro: number) {
  const dollars = micro / MICRO_PER_USD;
  if (dollars === 0) return "$0";
  if (dollars >= 0.1) return `$${dollars.toFixed(2)}`;
  return `$${dollars.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
}

/**
 * The GLM price from the environment, when the user's provider is set up.
 * Each var is dollars per million tokens; a missing or unreadable one keeps
 * the default for that field only.
 */
export function glmPriceFrom(env: { GLM_PRICE_IN_PER_M?: string; GLM_PRICE_OUT_PER_M?: string; GLM_PRICE_CACHED_PER_M?: string }): TokenPrice {
  const read = (raw: string | undefined, fallback: number) => {
    const n = Number(raw);
    return raw !== undefined && Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    in: read(env.GLM_PRICE_IN_PER_M, GLM_DEFAULT_PRICE.in),
    out: read(env.GLM_PRICE_OUT_PER_M, GLM_DEFAULT_PRICE.out),
    cachedIn: read(env.GLM_PRICE_CACHED_PER_M, GLM_DEFAULT_PRICE.cachedIn!),
  };
}
