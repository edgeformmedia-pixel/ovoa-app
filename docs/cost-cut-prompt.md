# OVOA cost-reduction pass (brief for Fable 5.1)

You are working in the OVOA repo (`C:\Users\thoma\OneDrive\Documents\GitHub\ovoa-app`). OVOA is a voice assistant:

- **App:** Expo SDK 57 iOS app in `jarvis/app`.
- **Server:** Cloudflare Worker (Hono, D1 `jarvis-db`) in `jarvis/api`.
- **Shipping:** push to `main` → Codemagic → TestFlight.

Your job is to cut what it costs to run OVOA per person per day, and to prove the cut with measured numbers. The target for a typical user is **$0.53/day down to $0.17/day or less**, keeping today's voice quality. The pricing model is a $9.99/month membership, which is about $0.31/day after Stripe fees, so this pass decides whether OVOA makes or loses money.

The user also wants a **switch between DeepSeek, Gemini and GLM 5.3 Flash** (the cheap version) for replies. They will supply the GLM API key later, so GLM must sit there, inert and harmless, until the key is set.

Work through the phases in order. Commit after each phase. Deploy after each phase that touches the server. Write down what you measured.

---

## 1. How to work in this repo (read first)

- **Read before coding.** Read `jarvis/app/CLAUDE.md` → `AGENTS.md`: Expo changed. Use the versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing app code. Also read the comments at the top of each file you touch: this codebase explains *why* in long comments, and your code must read the same way (plain-English comments with the reason, plain-English UI text, no jargon for the user).
- **Server checks, no Cloudflare login needed.** From `jarvis/api`:
  - `npm run typecheck`, `npm test` (unit tests, `scripts/test.mjs`, no framework) and `npm run smoke` (`test/smoke.sh`, currently 185/185).
  - Run the smoke tests against `npx wrangler dev --local --port 8787 --var DEBUG_KEY:localtest`.
  - Apply migrations locally with `npx wrangler d1 migrations apply jarvis-db --local`.
  - Model calls do not work locally ("Binding AI needs to be run remotely"). Check model paths against production with a throwaway account, then delete it with `DELETE /me`.
- **Remote Cloudflare access** uses a separate wrangler profile that is logged in to the right account:
  ```
  XDG_CONFIG_HOME=C:/Users/thoma/.wrangler-edgeformmedia npx wrangler <command>
  ```
  - The account is `33594882ed1877edb5cee6f495ca7fae` (edgeformmedia).
  - The global wrangler login is the WRONG account; don't use it.
  - A `7403` error from D1 is usually transient. Retry twice, then compare the error's `accountTag` with the account above.
- **Deploying:** always migrate **before** deploying, `npm run db:migrate` then `npm run deploy`, both with the profile above. You may deploy the Worker, push `main` and start Codemagic builds without asking. Pushing `main` starts the `ios-testflight` build (mac_mini_m2), so deploy the server first.
- **Phone logs** go to the D1 table `device_logs`. Read them before guessing about on-phone behaviour. The user's phone is device `ios-6mjol3py8umu7sb93z`.
- **You are on Windows and cannot run the iOS app.**
  - `npx expo start --web` checks layout.
  - Native code is verified by the user on a TestFlight build; you then read `device_logs`. Say plainly what was and wasn't verified on a device.
  - Code that needs a native module must still compile and degrade gracefully when the module is missing (web, Expo Go). Follow how `modules/ute-ble` is guarded.
- **Hard product constraints:**
  - **No always-listening.** Ambient capture was ruled out on legal grounds (2026-09-20). Room audio must never be sent to or stored on any server. This pass makes that *stricter*, not looser.
  - **Zero-setup consumer app.** No integrations that need a Pi, Home Assistant, ADB and so on.
  - **iOS will not OPEN a microphone while the app is off screen.** Background audio only keeps an already-running one alive (OSStatus 560557684 `'!int'`).
- **Commits and notes.**
  - Commit messages are plain sentences, like the history: "Answer sooner, and hold up with many people on the server".
  - Never commit or print secrets.
  - After finishing, rewrite `contextforclaude.txt` to about 5 lines describing the current state.

---

## 2. What was measured (baseline, 2026-09-22)

One tester (the developer). Sept 21 UTC, the heaviest real day, pulled from Cloudflare analytics and D1:

| Thing | Sept 21 | Cost at list price |
|---|---|---|
| Mic streamed live to Deepgram (wake mode) | ~380 min, but OVOA was being addressed in only 62 of them. 2,962 transcripts of room talk were thrown away. | **$1.82 (≈70%)** |
| Replies: Workers AI `@cf/openai/gpt-oss-120b` | 331 calls for ~92 replies. 1,051,513 input + 32,396 output tokens (35,666 neurons). ≈11.4K input tokens and ≈3.6 model calls per reply. | $0.39 |
| Spoken replies: Deepgram Aura-2, direct | ≤11,871 chars | $0.36 |
| Clip transcription (band button) | 14 clips | <$0.01 |
| Worker | 12,483 requests, 37 s CPU (mostly phone log uploads) | covered by the $5/mo plan |
| D1 | 4.42M rows read, 85,955 written | covered by the plan; near the free-plan caps |
| `device_logs` | 20,615 rows | Each row = 5 writes (table + 4 indexes). ~50% came from a mic-restart loop, already fixed in commit 1a1f1d7. |

- **Typical user (estimate):** 30 replies/day and the orb on for 1 h → $0.53/day. Of that, mic $0.29, voice $0.12, AI $0.13 on gpt-oss.
- **With GLM at the user's price:** the AI line is $0.02.

**Unit prices, 2026-09-22.** Put these in one file, `jarvis/api/src/pricing.ts`, dated and with source URLs:

| Item | Price |
|---|---|
| Deepgram Nova-3 live, direct (`wss://api.deepgram.com/v1/listen`) | $0.0048/min (promo; regular $0.0077) |
| Deepgram Nova-3 pre-recorded, direct | $0.0043/min |
| Deepgram Aura-2 TTS, direct | $0.030 per 1K chars |
| Workers AI `@cf/deepgram/aura-1` | $0.015 per 1K chars |
| Workers AI `@cf/deepgram/aura-2-en` | $0.030 per 1K chars |
| Workers AI `@cf/myshell-ai/melotts` | $0.0002 per audio minute |
| Workers AI `@cf/openai/whisper-large-v3-turbo` | $0.0005 per audio minute |
| Workers AI `@cf/openai/gpt-oss-120b` | $0.35 / $0.75 per M in/out. Workers AI gives 10K neurons/day free, then $0.011 per 1K neurons. |
| Workers AI `@cf/zai-org/glm-5.3-flash` | $0.15 / $0.50 per M in/out, $0.03 cached. Needs the paid plan. Supports tool calls. Context 1.31M. |
| **GLM 5.3 Flash, cheap provider (user-supplied)** | **$0.06 / $0.20 per M in/out**. Provider TBD, so the price must be editable. |
| DeepSeek `deepseek-flash` | $0.30 in (cache miss), $0.006 in (cache hit), $1.20 out per M. Half price off-peak (outside 01–04 and 06–10 UTC on weekdays). Thinking is on by default. |
| Gemini `gemini-3.8-flash`, paid | $0.75 / $3.75 per M in/out; doubles on 2027-01-01. The current key is free tier: ~20 requests, and no Google Search grounding. Grounding costs $14 per 1K searches after 5K/month. |

Sources: https://developers.cloudflare.com/workers-ai/platform/pricing/, https://deepgram.com/pricing, https://api-docs.deepseek.com/quick_start/pricing, https://ai.google.dev/gemini-api/docs/pricing, https://docs.z.ai/guides/overview/pricing

**Re-measuring.** Cloudflare's GraphQL API at `https://api.cloudflare.com/client/v4/graphql` gives daily Workers AI tokens/neurons per model, Worker requests/CPU and D1 rows read/written.
- **Auth:** Bearer = `oauth_token` in `C:/Users/thoma/.wrangler-edgeformmedia/.wrangler/config/default.toml`. Never print it.
- **Datasets:** `aiInferenceAdaptiveGroups` (sum `totalNeurons totalInputTokens totalOutputTokens`, dims `date modelId`), `workersInvocationsAdaptive` (filter `scriptName:"jarvis-api"`), `d1AnalyticsAdaptiveGroups` (databaseId `96162569-6625-4cad-af9c-62a3f6820033`).
- **Use:** re-run the same queries after each phase for before/after numbers.

---

## Phase 0: Ship what is already written

Commits `747338c` (server) and `6a7e0b3` (app) are committed but **not deployed or pushed**. They contain:
- The memory pass only runs on messages about the person (`src/remember.ts`), which roughly halves model calls per reply.
- A stable prompt prefix, and Workers AI session affinity.
- The log throttle stops counting on every upload.
- The missing indexes.
- Rate-limit bindings.
- Cron lanes.

Steps:
1. From `jarvis/api`, with the profile: `npm run db:migrate`. Migration 0032 is required, because `drainNotes` reads `agent_notes.hold_until`.
2. Then `npm run deploy`, then curl a route.
3. If deploy rejects the `ratelimits` block in `wrangler.jsonc` because of the plan, delete that block. `limits.ts` allows everything when a binding is missing.
4. Push `main`.

## Phase 1: Measure cost per person per day (build this before optimising)

Everything later is judged by this, so it comes first.

1. **Migration `0033_usage.sql`.** Add a rollup table, upserted like `src/obs.ts` does it: bounded, one row per (user, day, kind, engine/model), never failing the request it records. Suggested columns:
   - `user_id, day (UTC 'YYYY-MM-DD'), kind, engine, model`
   - `n` (calls/turns/clips), `input_tokens, cached_tokens, output_tokens, chars, seconds`
   - `est_micro_usd` (cost in millionths of a dollar, so it stays an integer)
   - `last_at`

   `kind` is one of: `turn` (one user message answered), `llm_call`, `tts`, `stt_stream`, `stt_clip`, `search`. Prune rows older than 90 days in the nightly job (`13 4 * * *`).
2. **LLM tokens.** Read the real usage from every engine response, streamed ones included. Verify each field name against the current API docs rather than trusting this list:
   - OpenAI-style `usage.prompt_tokens / completion_tokens`. For streams, ask for usage in the final chunk (`stream_options.include_usage`) where the provider supports it.
   - DeepSeek's `prompt_cache_hit_tokens / prompt_cache_miss_tokens`.
   - Gemini's `usageMetadata` (`promptTokenCount, candidatesTokenCount, thoughtsTokenCount, cachedContentTokenCount`).
   - Workers AI's usage object.

   `llm.ts` must stay free of the database. Report usage through a callback, the same way `onAttempt` reports engine attempts, and let the caller write it.
3. **TTS characters.** Record them where the server calls TTS: `/voice/speak` and `speechStream` inside `/chat` in `src/voice.ts`.
4. **Clip seconds.** Record them on `/voice/transcribe`. Take the duration from the transcriber's response metadata, not the byte count.
5. **Live-stream seconds.** The phone streams straight to Deepgram, so only the phone knows how long. In `jarvis/app/src/lib/liveListen.ts`, count the audio actually sent per connection (PCM bytes ÷ 32,000 per second at 16 kHz / 16-bit / mono). Report it in batches to a new small route, e.g. `POST /usage/stream`: authenticated, rate-limited with the existing `RL_LOGS`, and it clamps absurd values.
6. **Reading it back.**
   - `GET /debug/usage?days=7` behind the `x-debug-key` header: per person per day tokens, chars, seconds, searches, turns and estimated $, plus a total.
   - A small "Usage today" block in the app's Dev tools, showing the signed-in person's own numbers and estimated $ for today and the month so far.
7. Unit-test the cost maths in `pricing.ts`.

## Phase 2: Switchable reply engines (DeepSeek / Gemini / GLM 5.3 Flash / Workers AI)

**Today (`jarvis/api/src/llm.ts`):**
- `Engine = "gemini" | "deepseek" | "workers"`. `engines()` builds the order from which keys exist, and `PRIMARY_ENGINE` (wrangler var) can put DeepSeek first.
- `VOICE_PRIMARY: "workers"` puts Workers AI first for spoken turns, because it measured fastest to first word (1.0–2.9 s).
- `FALLBACK_MODEL` is the Workers AI model and the last resort.
- Engines in trouble cool down (`coolDown`, `classifyEngineError`), and each attempt is recorded (`engine_stats`, `noteEngines` in `obs.ts`).
- `openAiBody` sends `reasoning_effort`, which is a gpt-oss parameter. DeepSeek gets only standard fields.

**Build:**
1. **A new keyed engine, `"glm"`,** using the OpenAI-compatible path (`OpenAiEngine`):
   - `GLM_API_KEY` (secret; absent → the engine doesn't exist, no errors, no log noise).
   - `GLM_BASE_URL` (var; default Z.ai's OpenAI-compatible endpoint; check the current URL in Z.ai's docs). It must also work with OpenRouter-style providers, because the user's cheap provider is not decided yet.
   - `GLM_MODEL` (var; default `glm-5.3-flash`; the provider's id may differ, e.g. `z-ai/glm-5.3-flash`).
   - Add it everywhere an engine is named: `ENGINE_NAMES`, `modelFor`, `LoopState` (a paused tool loop must resume on GLM), `troubleFrom` wording, `engine_stats`, the attempt reporting.
2. **Thinking control.** GLM 5.3 Flash is a reasoning model, and thinking tokens are billed as output.
   - Add a `GLM_THINKING` var (`off` / `low` / `on`) and map it to whatever the provider accepts. This differs by provider: Z.ai uses a `thinking` object, OpenRouter uses `reasoning`. Check the docs.
   - Default: off for spoken turns, low for typed turns.
   - Never speak or show reasoning text. Send `reasoning_content` back on follow-up rounds only if the provider requires it.
   - Only send `reasoning_effort` to models that accept it (gpt-oss), keyed off the model id, not the engine name. `FALLBACK_MODEL` may now be `@cf/zai-org/glm-5.3-flash`, and that must work too.
3. **The switch.**
   - Order: `PRIMARY_ENGINE` accepts `gemini | deepseek | glm`. Add an optional `ENGINE_ORDER` (e.g. `glm,deepseek,gemini,workers`) that overrides it; Workers AI always stays last as the safety net unless it is listed explicitly.
   - Voice: `VOICE_PRIMARY` accepts `workers | keyed | <engine name>`.
   - **Runtime override without a deploy.**
     - A tiny D1 table `server_settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)` with keys `engine_order`, `voice_engine` (and `tts_engine` for Phase 4). Read it with an in-isolate cache of about 60 s.
     - `GET/PUT /debug/engines` behind `x-debug-key`. GET shows each engine's key status (set / missing), model, current cooldown and last error.
     - A picker in the app's Dev tools that only `DEV_EMAILS` accounts can use; enforce that on the server.
     - Optionally, a per-person override for dev accounts, so the developer can A/B engines without changing everyone.
   - Make the ordering logic a pure function and unit-test it. Cover: missing keys, cooldowns, voice vs typed, overrides, an unknown engine name (ignored, not fatal).
4. **Engine prices come from `pricing.ts`,** with GLM's price overridable by vars (`GLM_PRICE_IN_PER_M`, `GLM_PRICE_OUT_PER_M`, `GLM_PRICE_CACHED_PER_M`; defaults 0.06 / 0.20 / 0.06), so the usage table reports real dollars for whichever provider is chosen.
5. **Prove it.**
   - Before the key exists: GLM is skipped silently, everything else works.
   - With Workers AI's `@cf/zai-org/glm-5.3-flash` as `FALLBACK_MODEL`, which needs no key: run 10 spoken and 10 typed turns in production with a throwaway account. Include tool-using ones (alarm, reminder, calendar read) and one that pauses for the app (deferred tool). Record for each engine: first-token time, total time, tool-call success, tokens per reply and $ per reply.
   - Put the table in `docs/voice-latency.md`.
   - Recommend a default order in the final report, but keep today's order until the user decides.
6. **Tell the user in the final report exactly how to add the key:**
   ```
   cd jarvis/api
   XDG_CONFIG_HOME=C:/Users/thoma/.wrangler-edgeformmedia npx wrangler secret put GLM_API_KEY
   ```
   Also say which vars to set for their provider (`GLM_BASE_URL`, `GLM_MODEL`) and how to flip to GLM with the Dev tools picker or `PUT /debug/engines`.

## Phase 3: Stop paying to transcribe the room (the big one, ≈70% of cost)

**Today:**
- In wake mode, `jarvis/app/src/lib/liveListen.ts` streams **all** mic PCM (16 kHz) over a WebSocket to Deepgram for as long as the orb is on.
- `turnGate.ts` decides on the phone which words were meant for OVOA (name heard → addressed; `summonedUntil` for twists/button; room talk ignored).
- `voice.ts` → `useConversation` runs the modes: `ListenMode` `wake | twist | both`, `standby` (twist mode: the mic runs, nothing is sent until a twist), and the dev-only background Always listen.
- `soundsLike.ts` does fuzzy name matching.
- The server grants 30 s Deepgram tokens at `/voice/token`, with the assistant's name as a keyterm.

**Build on-phone name detection, so no audio leaves the phone until OVOA is called:**
1. **A local Expo module** (follow `jarvis/app/modules/ute-ble` and the SDK 57 module docs) that runs Apple's **on-device** speech recognition over the mic audio:
   - On iOS 26+: `SpeechAnalyzer` / `SpeechTranscriber`.
   - Otherwise `SFSpeechRecognizer` with `requiresOnDeviceRecognition = true`, and the assistant's name plus "OVOA" as contextual strings.
   - It must never use Apple's server recognition. If on-device isn't available, report that; don't fall back to the network silently.
   - It emits "name heard" events (and partial words, for the existing fuzzy match) to JS.
2. **Audio ownership.**
   - One component owns the mic and the audio session. Prefer the native side owning the engine and emitting PCM to JS only while a request is being sent, rather than pushing audio across the bridge all day.
   - Keep a **pre-roll ring buffer** of ~4 s, so "OVOA, set an alarm for seven" arrives whole even though the name was heard mid-sentence. `liveListen.ts` already buffers up to ~10 s while connecting (`MAX_PENDING_BUFFERS`); reuse that idea.
   - Respect the iOS background rules above. Keep the existing twist `standby` behaviour working.
3. **When to use Deepgram.** Open the Deepgram live connection only when:
   - the name is heard, or
   - a twist or the band button starts a turn, or
   - the conversation is in its follow-up window after a reply (existing `summonedUntil` behaviour).

   Send the pre-roll first, then live audio, and close the connection when the turn ends and the follow-up window lapses. Prefetch and refresh the `/voice/token` token so opening costs no extra round trip. Log the connect time: it is a latency line, keep it.
4. **Fallback when on-device recognition is unavailable** (old iOS, locale, module missing): keep today's behaviour, but add
   - an auto-off after 10 minutes without hearing the name (say so in the UI), and
   - a daily cap of 60 streamed minutes.

   Log both events (no transcript text).
5. **Privacy.** Room talk now never leaves the phone. Stop uploading `ignored: room talk` lines with what people said. Keep a count only, if anything.
6. **Measure (Phase 1 table).**
   - Target: average streamed seconds per voice turn ≤ 30, and no streaming while nobody is addressing OVOA.
   - Ask the user to check the false-wake and missed-wake rate on TestFlight. Log detections (not words) so it can be read from `device_logs`.

## Phase 4: Cheaper voice out (TTS), switchable, with fixed phrases cached

**Today:** `jarvis/api/src/voice.ts` calls Deepgram Aura-2 directly for `/voice/speak` and for `speechStream`, which voices a reply inside the `/chat` stream. The app's voice picker (`VOICES` in `app/src/lib/voice.ts`) lists 8 Aura-2 voices.

1. **Make the TTS engine switchable** (var `TTS_ENGINE` plus the `server_settings.tts_engine` runtime override, with a Dev tools picker for dev accounts):

   | Value | What it is | Price |
   |---|---|---|
   | `deepgram-aura-2` | today, direct | $0.030 / 1K chars |
   | `workers-aura-2` | `@cf/deepgram/aura-2-en` | same price; no Deepgram key needed |
   | `workers-aura-1` | `@cf/deepgram/aura-1` | $0.015 / 1K chars |
   | `workers-melotts` | `@cf/myshell-ai/melotts` | ~free; lower quality |
   | `device` | the app speaks with iOS's own voices (e.g. expo-speech / AVSpeechSynthesizer) | free, offline, lowest latency |

   - Map voice ids per engine. The app's picker shows only the voices the active engine offers, and a chosen voice survives an engine switch as the nearest match.
   - Check the audio format and streaming support of each Workers AI TTS model, and keep the streamed-sentence behaviour (first audio as early as possible).
2. **Keep `deepgram-aura-2` as the default.** The voice is the product, so the user chooses. Make A/B listening easy in Dev tools, and include the $/day difference in the final report.
3. **Cache fixed phrases.** The fillers ("one second while I get that", `app/src/lib/fillers.ts`) and other canned lines (alarms, routines, confirmations) should be rendered once per voice, stored on the phone (expo-file-system) and replayed, with no TTS call. On the server, cache identical sentences for the same engine and voice with the Workers Cache API, keyed by a hash.
4. Count chars per turn before and after (Phase 1).

## Phase 5: Clip transcription on Whisper (small saving; do it if it's clean)

1. `/voice/transcribe` (the band-button clip and the recorded fallback; 16 kHz mono opus from the ES100, uploaded by the app with a content type) → `@cf/openai/whisper-large-v3-turbo` at $0.0005/min, behind `STT_CLIP_ENGINE` (`deepgram` | `workers-whisper`).
2. Verify the formats it accepts; convert only if cheap. Use its prompt parameter (or equivalent) with the assistant's name, because Deepgram needed a keyterm to hear "OVOA".
3. Compare accuracy on a few real clips and the added latency. Keep Deepgram as the fallback when Whisper fails.
4. If the format or accuracy isn't clean, leave Deepgram as the default and say so.

## Phase 6: Fewer tokens per reply

Baseline: ≈11.4K input tokens and ≈3.6 model calls per reply (Sept 21, before Phase 0). Re-measure after Phase 0 first, because the memory-pass change alone should cut calls.

Then:
- **Make the stable prefix byte-identical turn to turn.** Phase 0 moved the clock and steps to the last message; verify it, because cache hits are 50× cheaper on DeepSeek and 5× cheaper on GLM. Report the cache-hit rate from the usage fields.
- **Send only the tools a turn plausibly needs.** Spoken turns already drop the reviewing/editing tools.
- **Cap history** (recent turns plus a short summary) and compact the memory/context block.
- **Truncate tool results sooner.** `MAX_TOOL_RESULT_CHARS` is 12,000 in `llm.ts`; big Gmail and Calendar results are the risk.
- Look at why a reply takes several calls (`MAX_TOOL_ROUNDS` 8) and remove avoidable rounds.

Target: ≥30% fewer input tokens per reply, with `npm test` and `npm run smoke` still passing and no behaviour regressions.

## Phase 7: Phone logs (server load and privacy)

Today every info line uploads to D1 (`app/src/lib/remoteLog.ts` → `POST /logs` → `device_logs`, 5 writes per row).

1. In release builds, upload only `warn` / `err` plus named **milestones**: timing lines such as "first voiced piece after N ms" and "live transcription connected · N ms", which the user relies on.
2. Keep info/debug in the on-phone ring buffer. Upload it on demand (a "Send logs" button in Dev tools) or alongside a crash. Dev builds can keep today's behaviour.
3. Never upload transcript text of room talk (see Phase 3).
4. On the server, check whether all four `device_logs` indexes are still used by the queries in `logs.ts`. Drop a redundant one only with a migration, and only if nothing reads by it.
5. Target: under 2,000 `device_logs` rows per person on a normal day.

## Phase 8: Fair-use limit

1. A monthly turn cap per person, `TURN_CAP_MONTHLY`. Default 1,000; `0` = off. Count it from the Phase 1 table.
2. At 80%, say once, in plain words, how many are left. Over the cap, answer with a friendly message instead of calling a model. Spoken turns say it in one sentence.
3. `DEV_EMAILS` are exempt.
4. Do **not** gate on membership. That is the separate ovoa-team `setup.md` Part C work.
5. The background agent already has a daily budget (`agent_budget`). Leave it.

## Phase 9: Web search and commute (make them cost-safe; don't pick paid providers)

1. **Web search** (`src/web.ts`: Gemini grounding, then scraping DuckDuckGo's HTML):
   - Cache results by normalised query for 30 minutes (Workers Cache API).
   - Allow at most 2 searches per turn.
   - Count searches in the usage table.
   - Add a `SEARCH_ENGINE` switch, but do not add a paid provider. Say in the report that DuckDuckGo scraping won't survive real traffic, and that Gemini grounding needs a paid key ($14 per 1K after 5K/month).
2. **Commute** (`src/rhythm.ts` uses `router.project-osrm.org`, OSRM's public demo server, which is not allowed for production traffic):
   - Cache routes per rounded origin/destination for 30 minutes and keep requests under 1/s.
   - Flag it in the report as a decision needed before launch.

---

## Verification and shipping

For every phase:
- `npm run typecheck`, `npm test`, `npm run smoke` (against `wrangler dev --local`) in `jarvis/api`, and the app's TypeScript check in `jarvis/app`.
- `npx expo start --web` for any UI you touched.
- Add unit tests for the new pure logic: engine ordering, pricing maths, usage rollups, the turn cap, and name detection → turn start (a state machine you can test without a microphone).

Deploy order: migrate → deploy → curl → push `main`. Server changes must tolerate an old app and the reverse, because the phone updates later.

After deploying:
- Re-run the Cloudflare GraphQL queries and `/debug/usage`, and compare with the baseline table above.
- For on-device behaviour, write the user a short TestFlight checklist, e.g.:
  1. Orb on for 10 minutes of room talk → streamed seconds stay ~0.
  2. Say the name mid-sentence → the whole request is heard.
  3. Follow-up without the name works.
  4. Twist and band button still work.
  5. Try each voice engine.

  After they test, read `device_logs` and report what it shows.

## Definition of done

1. Phase 0 is live (0032 applied, Worker deployed, `main` pushed).
2. `/debug/usage` and Dev tools show real per-person daily tokens, chars, stream/clip seconds, searches, turns and estimated $.
3. Replies can be switched at runtime, without a deploy, between DeepSeek, Gemini, GLM and Workers AI, separately for voice and typed turns.
   - GLM is inert without `GLM_API_KEY`.
   - With a key it streams, calls tools and resumes paused loops.
   - Its cost uses the $0.06 / $0.20 prices, editable by vars.
4. In wake mode, no audio leaves the phone until the name, a twist or the button. Measured streaming is ≤ ~30 s per voice turn.
5. The TTS engine is switchable, and fixed phrases are cached on the phone. The default voice is unchanged until the user picks.
6. Input tokens per reply are down ≥30% from 11.4K (measured).
7. Release builds upload <2,000 log rows per person per day and no room-talk text.
8. The turn cap works, with the dev exemption.
9. All tests pass, and the smoke suite still passes.
10. A final report (below).

## Final report to the user (plain English, short)

- **Before/after table:** $ per typical user per day, and each cost line (mic, voice, AI, server), measured where possible and marked "estimate" where not.
- **Engine comparison table:** first-token time, tool success, $ per reply.
- **What was verified on a device and what wasn't.**
- **Decisions only the user can make:**
  - which voice engine;
  - the default reply engine once the GLM key is in;
  - the turn-cap number;
  - a paid web-search provider;
  - a production routing provider for the commute check.
- **The exact commands to add `GLM_API_KEY`** and switch to GLM.

## Don't

- Don't send, store or log room audio or room-talk transcripts on any server, and don't loosen any always-listening restriction.
- Don't remove Workers AI as the last-resort engine, or any existing fallback.
- Don't change the default voice, subscription prices or membership gating.
- Don't add paid third-party providers (search, routing, TTS, STT) that need new keys or accounts without asking.
- Don't hard-code, commit or print secrets or the Cloudflare token.
- Don't claim something works on the phone unless `device_logs` from a real build show it.
