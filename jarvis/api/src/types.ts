export type Env = {
  DB: D1Database;
  /** Gemini, the second engine (llm.ts), and web search grounding (web.ts). */
  GEMINI_API_KEY?: string;
  /** The order every model call tries (llm.ts ENGINES, GLM then Gemini, when unset). server_settings.engine_order overrides it. */
  ENGINE_ORDER?: string;
  /**
   * How long an engine has to answer before the turn moves on: time to the first
   * byte, and the longest a started stream may go quiet (llm.ts, 20 s / 25 s by
   * default). Set as vars so a model that turns out to need longer can be given
   * it without a deploy.
   */
  MODEL_CONNECT_MS?: string;
  MODEL_IDLE_MS?: string;
  /** The Gemini model for replies, agent jobs and web search grounding. */
  CHAT_MODEL: string;
  /** Secret for the /debug routes; unset turns them off. */
  DEBUG_KEY?: string;
  /**
   * GLM 5.3 Flash from the user's own provider, the first engine (llm.ts
   * OPENAI_PROVIDERS). Without GLM_API_KEY the engine does not exist. The prices
   * are dollars per million tokens and override the defaults in pricing.ts,
   * because the provider, and so the price, is the user's choice.
   */
  GLM_API_KEY?: string;
  GLM_BASE_URL?: string;
  GLM_MODEL?: string;
  GLM_THINKING?: string;
  GLM_PRICE_IN_PER_M?: string;
  GLM_PRICE_OUT_PER_M?: string;
  GLM_PRICE_CACHED_PER_M?: string;
  /** The Gemini model for memory, summaries, setup, app design and briefs (the `fast` calls). */
  MEMORY_MODEL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET?: string;
  TOKEN_ENC_KEY: string;
  /** "on" answers every request 503 and skips the crons while data moves between accounts (maintenance.ts). */
  MAINTENANCE?: string;
  PUBLIC_URL: string;
  /** Signs shortcuts the assistant writes (see shortcuts/sign.ts). Without it, shortcut writing is off. */
  SHORTCUT_SIGNING_URL?: string;
  SHORTCUT_SIGNING_TOKEN?: string;
  /** Deepgram key for OVOA's voice (text to speech; speech to text is on the phone). Without it, /voice/speak returns 503. */
  DEEPGRAM_API_KEY?: string;
  /** Which engine voices replies (voice.ts TTS_ENGINES). server_settings.tts_engine overrides it without a deploy. */
  TTS_ENGINE?: string;
  /** Which web search route goes first (web.ts): "auto" (Gemini grounding when keyed, else DuckDuckGo), "gemini", or "duckduckgo". */
  SEARCH_ENGINE?: string;
  /**
   * The site's membership API (plans.ts, docs/paywall/SPEC.md §2). The key is a
   * secret; until it is set everyone is treated as pro. The URL is a var so it
   * can point at the site's test Worker.
   */
  MEMBERSHIP_API_KEY?: string;
  MEMBERSHIP_URL?: string;
  /**
   * Emails from no-reply@ovoa.ai through Resend: the sign-in and sign-up codes
   * for ovoa.ai (emailauth.ts). The key is a secret; without it no code can be
   * sent. EMAIL_FROM replaces the sender; RESEND_API_BASE is for local tests.
   */
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  RESEND_API_BASE?: string;
  /** More Google OAuth clients whose sign-ins count, comma-separated, beside GOOGLE_CLIENT_ID (emailauth.ts). */
  GOOGLE_SIGNIN_CLIENT_IDS?: string;
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
export type Vars = {
  userId: string;
  token: string;
  requestId: string;
  /** The voice engine for this person's request, resolved once after sign-in (voice.ts). */
  ttsEngine?: import("./voice").TtsEngine;
  /** The person's plan, when the route needed one (plans.ts requirePlan). */
  plan?: import("./plans").Plan;
};
