export type Env = {
  DB: D1Database;
  /** Gemini, the second engine (llm.ts), and web search grounding (web.ts). */
  GEMINI_API_KEY?: string;
  /**
   * Workers AI ("ai" in wrangler.jsonc): GLM 5.3 Flash on Cloudflare, the
   * engine spoken turns try first and the last resort for everything else
   * (llm.ts OPENAI_PROVIDERS.workers). WORKERS_MODEL is the model it runs.
   */
  AI: Ai;
  WORKERS_MODEL?: string;
  /** The order typed and background calls try (llm.ts ENGINES: GLM, Gemini, Workers AI, when unset). server_settings.engine_order overrides it. */
  ENGINE_ORDER?: string;
  /** Who answers spoken turns first: an engine, or "keyed" for the typed order (llm.ts, Workers AI when unset). server_settings.voice_engine overrides it. */
  VOICE_ENGINE?: string;
  /**
   * How long an engine has to answer before the turn moves on: time to the first
   * byte, and the longest a started stream may go quiet (llm.ts, 20 s / 25 s by
   * default), and on a spoken turn how long Workers AI, when first, has to say
   * its first word (6 s). Secrets rather than vars, so a model that turns out to
   * need longer can be given it without a deploy.
   */
  MODEL_CONNECT_MS?: string;
  MODEL_IDLE_MS?: string;
  VOICE_FIRST_CONTENT_MS?: string;
  /** The Gemini model for replies, agent jobs and web search grounding. */
  CHAT_MODEL: string;
  /** Secret for the /debug routes; unset turns them off. */
  DEBUG_KEY?: string;
  /**
   * GLM 5.3 Flash from the user's own provider, the first engine for typed and
   * background calls (llm.ts OPENAI_PROVIDERS). Without GLM_API_KEY the engine does not exist. The prices
   * are dollars per million tokens and override the defaults in pricing.ts,
   * because the provider, and so the price, is the user's choice.
   */
  GLM_API_KEY?: string;
  GLM_BASE_URL?: string;
  GLM_MODEL?: string;
  GLM_THINKING?: string;
  /** "off" stops asking Z.ai to stream tool-call arguments (llm.ts). Unset: on. A secret, to try either way without a deploy. */
  GLM_TOOL_STREAM?: string;
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
  /**
   * A worker on this computer, never a deployed one: passed as
   * `--var EMAIL_CODES_TO_LOG:1` to `wrangler dev` (test/smoke.sh). Without a
   * Resend key, codes go to the worker's own log instead, and
   * /debug/email/code works. Not DEBUG_KEY, which production has too.
   */
  EMAIL_CODES_TO_LOG?: string;
  /** More Google OAuth clients whose sign-ins count, comma-separated, beside GOOGLE_CLIENT_ID (emailauth.ts). */
  GOOGLE_SIGNIN_CLIENT_IDS?: string;
  /**
   * "off" refuses Expo Go (exp://) as the way back from the app's Google
   * sign-in, leaving only the installed app's ovoa://google-signin (signin.ts
   * appReturnUrl). Unset: Expo Go on a private-network dev server is allowed.
   */
  EXPO_GO_SIGNIN?: string;
  /** Comma-separated account emails allowed the dev-only capture-everything flag. */
  DEV_EMAILS?: string;
  /**
   * Texting OVOA over iMessage through Sendblue (texting.ts, docs/texting.md).
   * All four are secrets, put by scripts/sendblue-setup.mjs; until every one is
   * set, texting is off: the webhook answers 503 and the app's Link button says
   * it isn't ready. The key pair is Sendblue's API key; SENDBLUE_NUMBER is the
   * line people text (E.164, "+15551234567"); SENDBLUE_WEBHOOK_SECRET is what
   * Sendblue sends back in `sb-signing-secret` with every webhook.
   */
  SENDBLUE_API_KEY_ID?: string;
  SENDBLUE_API_SECRET?: string;
  SENDBLUE_NUMBER?: string;
  SENDBLUE_WEBHOOK_SECRET?: string;
  /** Where Sendblue's API is: https://api.sendblue.co unless a local test points it at a fake one. */
  SENDBLUE_API_BASE?: string;
  /**
   * The websites OVOA builds (sites.ts, docs/sites.md) live at <name>.SITES_DOMAIN:
   * "ovoa.ai" unless set. SITES_WILDCARD says whether that domain's wildcard DNS
   * record is in place: "on" or "off" decide it; unset, it's looked up (DNS over
   * HTTPS, cached), and until it answers, links go to the preview address on
   * this Worker (PUBLIC_URL/s/<name>) instead.
   */
  SITES_DOMAIN?: string;
  SITES_WILDCARD?: string;
  /** Rate limits (wrangler.jsonc "ratelimits", limits.ts). Optional: a missing one allows everything. */
  RL_AUTH?: RateLimit;
  RL_TURN?: RateLimit;
  RL_SPEAK?: RateLimit;
  RL_LOGS?: RateLimit;
  /** A website's contact form, per sender's address (sites.ts). */
  RL_FORM?: RateLimit;
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
