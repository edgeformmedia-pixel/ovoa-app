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
  CHAT_MODEL: string;
  /** Secret for the /debug routes; unset turns them off. */
  DEBUG_KEY?: string;
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
};

export type Vars = { userId: string; token: string };
