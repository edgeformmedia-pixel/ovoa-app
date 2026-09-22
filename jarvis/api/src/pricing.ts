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
// Checked 2026-09-22 against:
//   https://developers.cloudflare.com/workers-ai/platform/pricing/
//   https://deepgram.com/pricing
//   https://api-docs.deepseek.com/quick_start/pricing
//   https://ai.google.dev/gemini-api/docs/pricing
//   https://docs.z.ai/guides/overview/pricing

export const PRICES_CHECKED_ON = "2026-09-22";

/** Dollars per million tokens. `cachedIn` is the price of an input token the provider already had. */
export type TokenPrice = { in: number; out: number; cachedIn?: number };

/**
 * Reply engines, by the model id the engine actually calls (llm.ts modelFor).
 * Workers AI bills in neurons and publishes the token equivalent; the token
 * prices are used because they are what the usage object counts in.
 */
export const LLM_PRICES: Record<string, TokenPrice> = {
  // DeepSeek. Thinking is on by default and its tokens are billed as output.
  "deepseek-flash": { in: 0.3, cachedIn: 0.006, out: 1.2 },
  // Gemini, paid tier. The current key is on the free tier, which costs nothing
  // and answers about 20 requests a day; this is what it would cost if funded.
  "gemini-3.8-flash": { in: 0.75, cachedIn: 0.075, out: 3.75 },
  // Workers AI. gpt-oss-120b is today's last-resort engine.
  "@cf/openai/gpt-oss-120b": { in: 0.35, out: 0.75 },
  "@cf/openai/gpt-oss-20b": { in: 0.2, out: 0.3 },
  // GLM 5.3 Flash on Workers AI: needs the paid plan, supports tool calls.
  "@cf/zai-org/glm-5.3-flash": { in: 0.15, cachedIn: 0.03, out: 0.5 },
};

/**
 * GLM 5.3 Flash from the user's own cheap provider (Phase 2). The provider
 * isn't decided, so the price is a default that the GLM_PRICE_* vars override.
 */
export const GLM_DEFAULT_PRICE: TokenPrice = { in: 0.06, cachedIn: 0.06, out: 0.2 };

/**
 * Gemini's paid prices double on this date (announced with the 3.8 pricing).
 * Applied by date so the estimate is right in January without a deploy.
 */
export const GEMINI_PRICE_DOUBLES_ON = "2027-01-01";

/**
 * DeepSeek charges half price outside its busy hours. The windows are UTC and
 * apply on weekdays; weekends are off-peak throughout. Kept as data so a change
 * to the hours is a one-line edit.
 */
export const DEEPSEEK_PEAK_UTC: { from: number; to: number }[] = [
  { from: 1, to: 4 },
  { from: 6, to: 10 },
];
export const DEEPSEEK_OFF_PEAK_DISCOUNT = 0.5;

/** Text to speech, dollars per 1,000 characters. */
export const TTS_PRICES_PER_1K_CHARS: Record<string, number> = {
  "deepgram-aura-2": 0.03,
  "workers-aura-2": 0.03,
  "workers-aura-1": 0.015,
  // MeloTTS is priced per minute of audio ($0.0002). Speech runs about 900
  // characters a minute, so per thousand characters it is about $0.0002 too.
  "workers-melotts": 0.0002,
  // The phone's own voices.
  device: 0,
};

/** Speech to text, dollars per minute of audio. */
export const STT_PRICES_PER_MINUTE: Record<string, number> = {
  // Nova-3 live, direct from the phone. Promo price; the regular price is $0.0077.
  "deepgram-nova-3-live": 0.0048,
  "deepgram-nova-3-clip": 0.0043,
  "workers-whisper-turbo": 0.0005,
};

/**
 * Workers AI gives this many neurons a day before charging $0.011 per thousand.
 * Shared by the whole account, not per person, so it is left out of the per-call
 * estimate and mentioned in the report instead.
 */
export const WORKERS_FREE_NEURONS_PER_DAY = 10_000;
export const WORKERS_USD_PER_1K_NEURONS = 0.011;

export const MICRO_PER_USD = 1_000_000;

export type TokenCounts = { input: number; cached?: number; output: number };

/** Whether `at` falls in DeepSeek's discounted hours. Pure, so it can be tested on fixed dates. */
export function deepseekOffPeak(at: Date) {
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return true;
  const hour = at.getUTCHours() + at.getUTCMinutes() / 60;
  return !DEEPSEEK_PEAK_UTC.some((w) => hour >= w.from && hour < w.to);
}

/** The price of a model, adjusted for the date: Gemini's doubling, DeepSeek's off-peak hours. */
export function priceFor(model: string, at: Date, override?: TokenPrice): TokenPrice | null {
  const base = override ?? LLM_PRICES[model];
  if (!base) return null;
  let factor = 1;
  if (model.startsWith("gemini") && at.toISOString().slice(0, 10) >= GEMINI_PRICE_DOUBLES_ON) factor = 2;
  if (model.startsWith("deepseek") && deepseekOffPeak(at)) factor = DEEPSEEK_OFF_PEAK_DISCOUNT;
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
