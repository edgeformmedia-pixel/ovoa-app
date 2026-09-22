-- Settings for the server itself, changeable without a deploy.
--
-- Which engine answers first, which one voices replies, which one speaks:
-- until now each was a var in wrangler.jsonc, and changing one meant a deploy
-- and a wait. A deploy is the wrong tool for "DeepSeek is out of credit, use
-- GLM for the afternoon". The Worker reads this table about once a minute per
-- isolate (src/settings.ts) and falls back to the vars when a key is absent.
--
-- Keys in use (src/settings.ts SETTING_KEYS):
--   engine_order   "glm,deepseek,gemini,workers": the order typed turns try
--   voice_engine   "workers" | "keyed" | an engine name: who answers spoken turns
--   workers_model  the Workers AI model, e.g. "@cf/zai-org/glm-5.3-flash"
--   tts_engine     which voice engine speaks (Phase 4)
--   <key>:<user_id>  the same, for one person only (a developer testing an engine)
CREATE TABLE server_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
