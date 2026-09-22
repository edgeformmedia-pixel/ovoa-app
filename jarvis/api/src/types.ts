export type Env = {
  DB: D1Database;
  AI: Ai;
  GEMINI_API_KEY?: string;
  /** Second choice when Gemini fails or runs out; before Workers AI. */
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_MODEL: string;
  /** "deepseek": try DeepSeek first, Gemini after it. */
  PRIMARY_ENGINE?: string;
  /** Which engine answers spoken turns first. "workers" by default; "keyed" restores the usual order. */
  VOICE_PRIMARY?: string;
  /**
   * How long an engine has to answer before the turn moves on: time to the first
   * byte, and the longest a started stream may go quiet (llm.ts, 20 s / 25 s by
   * default). Set as vars so a model that turns out to need longer can be given
   * it without a deploy.
   */
  MODEL_CONNECT_MS?: string;
  MODEL_IDLE_MS?: string;
  CHAT_MODEL: string;
  /** Secret for the /debug routes; unset turns them off. */
  DEBUG_KEY?: string;
  /**
   * GLM 5.3 Flash from the user's own provider (llm.ts, Phase 2 of the cost
   * pass). Without GLM_API_KEY the engine does not exist. The prices are dollars
   * per million tokens and override the defaults in pricing.ts, because the
   * provider, and so the price, is the user's choice.
   */
  GLM_API_KEY?: string;
  GLM_BASE_URL?: string;
  GLM_MODEL?: string;
  GLM_THINKING?: string;
  GLM_PRICE_IN_PER_M?: string;
  GLM_PRICE_OUT_PER_M?: string;
  GLM_PRICE_CACHED_PER_M?: string;
  MEMORY_MODEL: string;
  FALLBACK_MODEL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET?: string;
  TOKEN_ENC_KEY: string;
  PUBLIC_URL: string;
  /** Signs shortcuts the assistant writes (see shortcuts/sign.ts). Without it, shortcut writing is off. */
  SHORTCUT_SIGNING_URL?: string;
  SHORTCUT_SIGNING_TOKEN?: string;
  /** Deepgram key for speech to text and text to speech. Without it, voice routes return 503. */
  DEEPGRAM_API_KEY?: string;
  /** Comma-separated account emails allowed the dev-only capture-everything flag. */
  DEV_EMAILS?: string;
  /** For "ask Claude" (claude.ts). Without it that tool says it isn't set up. */
  ANTHROPIC_API_KEY?: string;
  /** Rate limits (wrangler.jsonc "ratelimits", limits.ts). Optional: a missing one allows everything. */
  RL_AUTH?: RateLimit;
  RL_TURN?: RateLimit;
  RL_SPEAK?: RateLimit;
  RL_LOGS?: RateLimit;
};

/**
 * `requestId` is Cloudflare's own cf-ray, set by observe() before anything else
 * runs. It is the id the Workers Logs entry carries, so a row in error_events
 * can be looked up in the dashboard while it is still retained there.
 */
export type Vars = { userId: string; token: string; requestId: string };
