# OVOA v1 release pass: brief for a fresh Claude session

You are working in the OVOA repo `C:\Users\thoma\OneDrive\Documents\GitHub\ovoa-app`. The site repo is
`C:\Users\thoma\OneDrive\Documents\GitHub\ovoa-team`. OVOA is a voice assistant:

- **App:** Expo SDK 57 iOS app in `jarvis/app`.
- **Server:** Cloudflare Worker (Hono, D1 `jarvis-db`) in `jarvis/api`.
- **Site:** `ovoa-team`, a TanStack Start site that sells the plans and the Band through Stripe. It runs as the
  Cloudflare Worker `ovoa-site` on the new account (`npm run deploy` there; see its AGENTS.md).
- **Shipping:** pushing `main` in `ovoa-app` starts Codemagic → TestFlight, but only when `jarvis/app` or `codemagic.yaml` changed.

The user is getting ready to release **v1 on TestFlight**; the App Store comes later. Every decision below was made by
the user in one long conversation on 2026-09-23. **This file is the source of truth.** Where an older doc
(`docs/paywall/SPEC.md`, `docs/food.md`, `docs/feature-plan.md`) disagrees with it, this file wins, and you update
the older doc to match.

The user said twice: **don't start coding until you understand.** So Phase 0 is reading, and it ends with you
writing back a short plan and waiting for "go".

---

## 1. How to work in this repo (read first)

- **Read before coding.** `jarvis/app/CLAUDE.md` → `AGENTS.md`: Expo changed, so check the versioned docs at
  https://docs.expo.dev/versions/v57.0.0/ before writing app code. Read the comment at the top of every file you
  touch; they explain why things are the way they are.
- **OneDrive:** recursive `find` / `grep -r` time out on `node_modules`. Use `git ls-files` and the Grep tool.
  Metro misses file changes in this folder, so restart it with `--clear`. The Bash tool collapses backslashes
  inside heredocs, so use the Edit/Write tools for anything with escapes.
- **Checks:**
  - `jarvis/api`: `npm run typecheck`, `npm test`, `npm run smoke` against
    `npx wrangler dev --local --port 8787 --var DEBUG_KEY:localtest`. Run **one** smoke suite at a time: stop the
    worker and the suite (PowerShell), wipe `.wrangler/state`, apply migrations locally
    (`npx wrangler d1 migrations apply jarvis-db --local`), then run it. Running suites at the same time produces
    fake tick and 429 failures.
  - `jarvis/app`: `npx tsc --noEmit`, plus `npx expo start --web` at 390 px wide for layout.
  - `ovoa-team`: `npm run build && npm run test:billing`, which runs against `scripts/fake-stripe.mjs`.
  - Model calls don't work locally. Check them against production with a throwaway account, then delete it with
    `DELETE /me`.
- **Two Cloudflare accounts during this pass.** Pass `CLOUDFLARE_ACCOUNT_ID` explicitly on every remote command.
  Wrangler caches the account it last used in `jarvis/api/node_modules/.cache/wrangler/wrangler-account.json`, and
  that cache already sent one login to the wrong account once.
  - **New account (everything goes here):** "Admin@ovoa.ai's Account", id `e58b0ec5305410f9d3cd70f461f39cb6`.
    Profile: `XDG_CONFIG_HOME=C:/Users/thoma/.wrangler-ovoa`, already logged in. The `ovoa.ai` zone is active in
    this account.
  - **Old account (read and forward only):** edgeformmedia, id `33594882ed1877edb5cee6f495ca7fae`. Profile:
    `XDG_CONFIG_HOME=C:/Users/thoma/.wrangler-edgeformmedia`.
  - The global wrangler login is neither of these. Don't use it.
  - A D1 `7403` error is usually transient: retry twice, then compare its `accountTag` with the account you meant.
- **Deploying:** always migrate **before** deploying (`npm run db:migrate`, then `npm run deploy`), then curl the
  live server. You may deploy, push `main` in both repos and start Codemagic builds without asking. Deploy the
  server before any `ovoa-app` push that depends on it. Each iOS build uses about 25 minutes of the monthly
  Codemagic allowance, so batch app pushes (see Phase 10).
- **Phone logs** are in the D1 table `device_logs`. The user's phone is `ios-6mjol3py8umu7sb93z`. Read them before
  guessing about on-phone behaviour. You're on Windows and can't run the iOS app, so say plainly what was verified
  on a device and what wasn't.
- **Native code** must still compile and degrade gracefully when its module is missing (web, Expo Go). Follow how
  `modules/ute-ble` and `modules/name-ear` are guarded.
- **Secrets:** never print, log or commit them. Read only the variable names from `.env` files
  (`sed 's/=.*//'`), and pipe values into `wrangler secret put` through stdin.
- **Commits:** plain sentences like the history ("Give made apps their own screen and editor…"). Commit after
  every phase. When you finish, rewrite `contextforclaude.txt` to about 5 lines describing the current state.

### Hard product rules (don't break these)

- **No room audio to any server, ever.** Speech is recognised on the iPhone. The name ear listens on the phone.
  Nothing leaves the phone until OVOA's name is heard, and even then it's text, not audio.
- **Zero-setup consumer app.** No integrations that need a Pi, Home Assistant, ADB and so on.
- **iOS won't OPEN a microphone while the app is off screen.** Background audio only keeps one that's already
  running alive (OSStatus 560557684 `'!int'`).
- **Don't set `MEMBERSHIP_API_KEY`** on either side. Plans stay off (everyone is Pro) until the user does it, after
  free Pro accounts exist for App Review.
- **Stripe is live-only.** No test keys. Don't run the Stripe setup script; the user does that.
- **Food:** never mention eating disorders. No streaks, no praise for eating less, no red numbers, no moralising.
- **Don't build shortcut signing.** Assistant-written shortcuts are a future update.

---

## 2. What the user decided (2026-09-23)

| Topic | Decision |
|---|---|
| Release | v1 = **TestFlight only**. The App Store comes after the rough edges are sharpened. |
| What v1 is | Talk, the in-app Apps store, Create (made apps), the Base and Pro AI plans, and the Calorie add-on. |
| Plans | Free: health, notes, and every app that doesn't use AI. **Base** $9.95/mo or $95.99/yr: every AI feature, 20 replies a day. **Pro** $25.95/mo or $195.99/yr: **3× Base's usage and nothing else**, 60 replies a day. **Band** $89.99 one-time; it works without a plan. |
| The gate | Charge only for things that use AI. **Before anything is sent to a model, OVOA checks the plan.** Screens that never call a model are free. |
| Locked things | Talk stays in the menu for free users with a **lock icon** and "That's for Base users". **See options** opens pricing on ovoa.ai. The link is **temporary** for TestFlight; in-app purchase comes later (`Plan.tsx` `StoreActions` is the seam). |
| Band's 7 days | Every Band comes with 7 free days of Base. Band-only buyers can **redeem them for free if they want**, or give them to someone else. |
| Signup | Verify email with a **6-digit code** sent through Resend. |
| Consent | Before anything goes to an AI company, the user **agrees** on a screen that says where their data goes. |
| First open (free) | Only a **simple tutorial with no AI**. |
| Setup conversation | Runs the **first time someone activates Base**. It starts with the consent screen and the voice picker, asks about fitness or health goals and habits, and **builds an app** for them. |
| AI | **Z.ai GLM 5.3 Flash** first (temporary; the provider will change later) and **Gemini 3.5 Flash Lite** as the fallback (temporary; paid key). DeepSeek, Workers AI chat models and Ask Claude are gone. |
| Speech | **iOS speech recognition** for everything: Talk and Band recordings. **Deepgram is only OVOA's voice** (reply text → speech). |
| Retention | After **14 days everything is deleted except** the **day summary** and **what people manually entered or set up**. A Band recording someone made **on purpose** counts as manually entered and stays. |
| Food | The AI notes food as part of the day. A **"Calorie"** by-OVOA add-on in the in-app Apps store shows it plus other stats. OVOA asks as much as the user's tracking level allows ("what kind of burrito?"). It says "about" at quick and normal and the plain number at strict. Details are in `docs/food.md` (its Decisions section wins). |
| Band's name | Users see **"OVOA Band"**. "ES100" is only the supplier's name. |
| Ask Claude | **Cut.** |
| Shortcuts | Only the auto send-message shortcut ships. |
| Google | The user moves the Google OAuth client over. **Everyone reconnecting Google once is fine.** Narrow Drive access to **files OVOA creates** (`drive.file`). |
| Cloudflare | **Everything** moves to the new account, with **all data copied**. The server lives at **`api.ovoa.ai`**. |
| Privacy policy | Update it to match all of the above. |

Small calls the user left to you (defaults):
- Codes come from `OVOA <no-reply@ovoa.ai>`. `ovoa.ai` is already verified in Resend (us-east-1).
- Existing accounts enter a code once at their next sign-in.
- The old server forwards to the new one for about 3 weeks.
- Monthly caps are the daily cap × 31: Base 620, Pro 1,860.

---

## Phase 0 — Read, then check back (no code)

1. Read §1–§2, then `contextforclaude.txt`, `docs/paywall/SPEC.md`, `docs/food.md`, `jarvis/api/src/plans.ts`,
   `jarvis/api/src/llm.ts` (top and engine list), `jarvis/api/wrangler.jsonc`, `jarvis/app/src/lib/voice.ts`,
   `liveListen.ts`, `onDeviceTranscribe.ts`, `jarvis/app/src/app/_layout.tsx`, `onboarding.tsx`,
   `components/Drawer.tsx` and `Tour.tsx`.
2. Check what's ready, reading names only, never values:
   - Key files in `ovoa-team`: `resend/.env` (var `ResendApiKey`, present), `gemini/.env`, `deepgram/.env`,
     `zai/.env`, `google/.env`.
   - Has the user said whether the new account has **Workers Paid** ($5/mo)? The free plan's per-request CPU
     limit is too small for a chat turn.
   - Has `https://api.ovoa.ai/google/callback` been added in Google Cloud Console?
   - `git status` in both repos is clean, and no other session is mid-change.
3. Write back to the user: a plan of about 10 lines, what's missing from step 2, and anything in this file that
   contradicts the code. **Wait for "go".**

If a Phase 1 key is still missing after "go", you may build and test Phases 2–9 locally. Deploy only to the new
account, and only after Phase 1 is done.

---

## Phase 1 — Move to the new Cloudflare account

1. **Pin the account.** Add `"account_id": "e58b0ec5305410f9d3cd70f461f39cb6"` to `jarvis/api/wrangler.jsonc`.
   Delete the wrangler account cache file afterwards.
2. **Database.** Create `jarvis-db` in the new account, put its id in `wrangler.jsonc`, and apply all migrations to
   it remotely. That creates the schema, including the FTS table.
3. **Copy the data.** `context_search` is an FTS5 virtual table, and `wrangler d1 export` fails on virtual tables.
   - Export from the old account table by table with `--no-schema`. Skip `context_search`, its shadow tables
     (`context_search_*`) and `d1_migrations`.
   - Import each file into the new database.
   - Rebuild the index: `INSERT INTO context_search(context_search) VALUES('rebuild')`. It's external-content on
     `context_blocks`.
   - Compare row counts per table between old and new, and write them in the commit message.
4. **Drop the Google tokens.** The new `TOKEN_ENC_KEY` can't read the old ones. Delete the rows in
   `google_accounts` / `google_accounts_new` and `oauth_states` in the new database. Then check the app shows
   "Connect Google" (not an error) for a user with no Google account.
5. **Secrets on the new Worker:**
   - From the key files: `GEMINI_API_KEY`, `DEEPGRAM_API_KEY`, `GLM_API_KEY` (zai), `GOOGLE_CLIENT_SECRET` and
     `RESEND_API_KEY` (from `ResendApiKey`).
   - Generate new ones: `TOKEN_ENC_KEY` (base64 of 32 random bytes; `src/crypto.ts` imports it as a raw AES-GCM
     key) and `DEBUG_KEY`.
   - Don't set `DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY` or `MEMBERSHIP_API_KEY`.
6. **Address.** Set `PUBLIC_URL` to `https://api.ovoa.ai` and add `api.ovoa.ai` as a custom domain in
   `wrangler.jsonc`. Keep `workers_dev` on. Deploy, then curl a public route and one route with a throwaway
   account.
7. **The app.** Change the fallback `API_URL` in `jarvis/app/src/lib/api.ts` to `https://api.ovoa.ai`. Don't push
   yet (Phase 10).
8. **Forward the old address.** Replace the old account's `jarvis-api` Worker with a small forwarder: its own
   folder, its own `wrangler.jsonc`, **no crons**. It passes every request (method, headers, body, query) through
   to `https://api.ovoa.ai`. Do this straight after the new Worker is up, so the two sets of crons never both run
   (reminders would fire twice) and the gap where writes land on the old database stays small.
   - Keep the old D1 untouched as a backup.
   - Note in `contextforclaude.txt`: "delete the forwarder and old D1 after <date + 3 weeks>".
9. **The site is already moved.** Since 2026-09-23 ovoa.ai is the Worker `ovoa-site` on the new account
   (`ovoa-team/wrangler.site.jsonc`, D1 `ovoa-site-db`, custom domains `ovoa.ai` and `www.ovoa.ai`). Nothing to
   copy. After `api.ovoa.ai` is up, set the site's `OVOA_API_URL` var to it.
10. **Docs and notes.** Update every deploy instruction that names the edgeformmedia profile or account, starting
    with `contextforclaude.txt` and `docs/`, to the new profile and id.

**Done when:** the live server answers at `api.ovoa.ai` from the new account, row counts match, and an old-address
request is forwarded and answered.

---

## Phase 2 — AI: GLM first, Gemini as the fallback

1. **Engine order** is `glm`, then `gemini`, for everything: typed turns, spoken turns (`VOICE_PRIMARY` is
   `workers` today, so change it), memory and summaries (`MEMORY_MODEL`), the setup conversation, app design,
   agent jobs and food.
   - Take `deepseek` and `workers` out of `ENGINES` and the order, and remove their config (`PRIMARY_ENGINE`,
     `FALLBACK_MODEL`, `DEEPSEEK_*`).
   - Keep the OpenAI-compatible path generic, because the user will change providers later. A new provider should
     be config plus a few lines.
   - Delete dead engine code where that's clean. Don't do a risky refactor for it.
2. **Gemini model.** Using the new key, list Google's models (`GET v1beta/models`) and confirm the exact
   **Gemini 3.5 Flash Lite** id. Set it for `CHAT_MODEL` and the fallback. If it isn't in the list, **stop and ask**.
   Don't guess a name.
3. **Web search** stays on Gemini grounding (paid key), with DuckDuckGo as the fallback (`web.ts`).
4. **Workers AI binding:** remove it if nothing uses it after Phases 2–3. TTS goes to Deepgram directly.
5. **Measure.** In production, with a throwaway account, time 5 typed and 5 short spoken-style turns on GLM
   (Turn timings / `meta.firstSentenceMs`). Last time Z.ai took 10–37 s per reply. If the median first sentence is
   over 4 s, **tell the user**. Don't switch providers; that's their call.
6. **Prices.** `pricing.ts` keeps the Z.ai GLM default ($0.06 in / $0.20 out per M) unless the user gives numbers.
   Add the Gemini 3.5 Flash Lite price, from Google's pricing page, to the table.

---

## Phase 3 — Speech on the iPhone; Deepgram only speaks

1. **Band recordings and notes:** use `onDeviceTranscribe.ts` for everyone, not only free users. The clip is
   16 kHz mono opus, and `clip.ts` `downloadOne()` already decodes it. Hand iOS a format it accepts. Check the
   `expo-speech-recognition` v57 docs for file transcription and length limits, and split long clips if needed.
   Keep `ALLOW_APPLE_SERVERS` for phones that can't recognise on their own.
2. **Talk:** once the name ear (`modules/name-ear`) hears the name, recognise the rest of the turn on the phone
   (`expo-speech-recognition`, on-device first, with the same Apple-servers fallback) and send the text to `/chat`.
   - Remove the Deepgram streaming path: `liveListen.ts` socket, `POST /voice/token`, and the `mode=wake` route in
     `plans.ts`.
   - Keep the turn gate, fillers and interrupt behaviour working (`turnGate.ts`, `assistant.tsx`).
3. **Always listen 24/7:** only offered on phones with on-device recognition. Remove the fallback that streams the
   room to Deepgram. Where it can't run, hide the switch with a one-line reason.
4. **Server:** `POST /voice/transcribe` and `POST /voice/token` answer **410** with a plain message
   ("Update OVOA from TestFlight"), because old builds reach them through the forwarder. `POST /voice/speak`
   (Deepgram Aura-2) is the only Deepgram call left.
5. **Clean-up:** remove the STT engine switches from Dev tools and `STT_CLIP_ENGINE` from config.
6. **Tests:** add a unit test that no server code calls Deepgram's `listen` endpoint.
   Add a `perf` mark for "recognised on phone" so Turn timings shows it.

---

## Phase 4 — Plans, the model-call gate, the lock

1. **Pro = 3× usage only** (`jarvis/api/src/plans.ts`):
   - Base 20 replies/day, ceiling $0.25/day. Pro 60 replies/day, ceiling $0.75/day.
   - The background agent (creating and running jobs) and Always listen 24/7 move to **Base**. The open-mic wake
     route is already gone after Phase 3.
   - `TURN_CAP_MONTHLY` becomes per tier: Base 620, Pro 1,860.
   - When a cap is hit, OVOA says so plainly and says when it resets.
2. **Gate at the model call.** Add one guard in the function every model request passes through (`llm.ts`),
   covering web search through Gemini too. Before any `fetch` to GLM or Gemini it checks:
   - The plan: free → `needs_plan`.
   - The allowance.
   - **Consent** (Phase 5): not given → `needs_consent`.

   Crons that call a model (agent jobs, briefs, rollups, day summaries) go through the same guard and silently
   skip free users.
3. **Test the gate.** Add a unit test (`scripts/test.mjs`) that fails if any file outside the engine module calls a
   model URL or the engine's low-level generate function.
4. **Free routes.** Keep `ROUTE_TIERS` as the early reject, but make every route that never calls a model free:
   money, routines, to-dos, alarms, nags, people, favors, places, locations, notes, and editing a made app or its
   screen by hand.
   - Creating or changing an app with AI (`/apps/design`, `/apps/revise`) stays **Base**.
   - Fix the `/apps/:id(/state)` rule, which currently says Base.
5. **App side.** Before sending any AI request, `usePlan` stops it on the phone and shows the locked state.
   - Replace the free-mode swap (`Drawer.tsx` `FREE_TOP`, `(tabs)/index.tsx` `FreeToday`): **Talk stays in the
     menu with a lock icon**.
   - Opening Talk shows "That's for Base users" and a **See options** button that opens the plans page on ovoa.ai.
     Confirm the URL on the site; today plans are on `/early-access`.
   - Same treatment for Create and AI add-ons.
   - `MANAGED_AT` / Plan screen copy says plans are on ovoa.ai.
6. **Docs.** Update `SPEC.md` §1 (Pro = 3×; wake word, agent and Always listen are Base) and §4 (TestFlight
   **does** link to ovoa.ai pricing: the user's call, temporary).
7. **Site copy (`ovoa-team`):**
   - `src/lib/membership/copy.ts` `"Almost 3× Base"` → `"3× Base"`.
   - `src/routes/early-access/index.tsx:238` and `welcome.tsx:655`: Pro = "three times as many AI replies a day".
     Remove the wake word and agent claims from Pro and list them under Base.
   - Update the FAQ lines to match.
8. **Band-only redeem (`ovoa-team`).** Band + Base checkout already has a 7-day trial, and
   `api/public/billing/start-trial.ts` already starts the free days for that case. Add the same for
   **Band-only** (`?band=1&ai=0`) buyers:
   - A "Start my 7 free days" form POST (never a plain link: mail scanners open links) on the welcome page.
   - It creates a `ovoa_base_monthly` subscription with `trial_period_days: 7` and
     `trial_settings.end_behavior.missing_payment_method: "cancel"`, with **no card**, so it ends on its own.
   - One per Band order.
   - Gifting is covered by the existing "Use a different email in the app".
   - `npm run test:billing` gets a case for it.

---

## Phase 5 — Email code, consent, first open, setup

1. **Email code** (`jarvis/api/src/auth.ts`, new migration with the next free number):
   - A 6-digit code, stored hashed, valid for 10 minutes, at most 5 tries, 60 s before a resend, rate-limited with
     `RL_AUTH`.
   - Sent through Resend (`RESEND_API_KEY`) from `OVOA <no-reply@ovoa.ai>`, as a plain short email.
   - An account can't do anything until it's verified.
   - Existing accounts get `email_verified_at = NULL` and verify once at their next sign-in.
   - Without the key (local), the code goes to the dev log, only when `DEBUG_KEY` is set. Tests use a fake Resend
     and never send real email.
   - App: `sign-in.tsx` gets a code step with `textContentType="oneTimeCode"`, so iOS offers the code from Mail.
2. **Consent** (new, before any AI):
   - A screen that says plainly:
     - What you say, and the data needed to answer (health numbers, calendar, emails you ask about), goes to
       **Z.ai (GLM)** to write replies, and to **Google Gemini** when GLM is down or for web searches.
     - Replies are turned into speech by **Deepgram**, which gets text only.
     - **Your voice is recognised on your iPhone and never sent.**
   - Buttons: Agree / Not now.
   - Store `ai_consent_at` and a consent version, and enforce it server-side in the Phase 4 guard.
   - Existing Base users see it once on their next open, before any AI call.
3. **First open, free:** sign up → code → permissions (Health, microphone, notifications; Bluetooth only when
   pairing the Band) → **a simple tutorial with no AI** (`Tour.tsx`: no model calls; the phone's own voice or
   silent).
4. **Setup conversation** (`onboarding.tsx`, `jarvis/api/src/onboarding.ts`) runs the **first time the user has
   Base**, whether paid or Band days, not at signup. Order:
   1. Consent.
   2. Voice picker (`VoicePicker.tsx`, Deepgram voices, default preselected).
   3. The existing questions, plus **"any fitness or health goals, or habits you want help with?"** For each goal,
      the model designs a made app (reuse `/apps/design` + `POST /apps` in `myapps.ts`) and installs it. An eating
      goal installs the **Calorie** add-on and sets the tracking level.
   4. The tour, if it hasn't been seen.

   Fix `_layout.tsx` so setup isn't forced at signup for free users.

---

## Phase 6 — 14-day retention

**Rule:** after 14 days, delete everything except:
1. **The day summary.** One per day: a short title plus a 2–3 sentence highlight, including the day's calorie total
   when food was noted.
2. **What the person manually entered or set up.**

1. **Classify every table** (the list is in `jarvis/api/migrations`) and every row source, then write the table to
   `docs/retention.md`. Where a table mixes both kinds, decide by its source column or by how the row gets made
   (a user action vs the AI or automatic). The expected outcome:
   - **Keep:** account, sessions, settings, profile, emergency contacts, push tokens, Google connection, routines
     and meds they set up, alarms, to-dos they entered, typed notes, **Band recordings made on purpose** and their
     transcripts, made apps and their screens, agent jobs and goals they set up, money picture entries, places they
     named or confirmed (home, work), people or memories they **asked OVOA to remember**, the food target and
     tracking level, day summaries.
   - **Delete at 14 days:** messages, context blocks and rollups (apart from the day summary), commitments the AI
     inferred, raw captures, transcript lines, location points, visits, place events, unconfirmed learned places,
     heart-rate samples, step days, daily marks, routine event history, AI-made to-dos, auto-learned memories and
     people, agent runs and notes, pending actions, paused turns, device logs, action log, error events, engine
     stats, cron ticks, command queue, expectations, commute checks, name candidates, objects, food logs, and food
     catalog rows unused for 14 days.
   - **Exception:** `usage_daily` holds counts, not content, and monthly caps need it, so keep 35 days.
2. **Purge.** One nightly purge in the existing cron (`rhythm.ts` / `obs.ts` pattern), batched so D1 doesn't time
   out. The context FTS index is updated along with it.
3. **Text.** Update user-facing text and tool descriptions that promise longer (location "kept forever",
   transcripts), and the privacy policy.
4. **Ambiguity.** List any row type that's genuinely unclear at the end of your report. Don't block on it; default
   to deleting.
5. **Expected side effect:** the first nightly run after the move deletes everything older than 14 days in the
   copied data. Say so in the report.

---

## Phase 7 — Clean-up

1. **"OVOA Band"** replaces "ES100" in every user-facing string: `app.json` `NSBluetoothAlwaysUsageDescription`,
   the Record screen, Settings, the tour and help copy, and server prompts that name the clip. Keep code
   identifiers, `modules/ute-ble`, log kinds and dev-only screens.
2. **Remove Ask Claude:**
   - Server: `jarvis/api/src/claude.ts`, its import/route/tool in `index.ts`, `limits.ts`, `ANTHROPIC_API_KEY` in
     `types.ts`, and the `@anthropic-ai/sdk` dependency.
   - App: `app/claude.tsx`, the `claude` entry in `lib/addons.ts`, the calls in `lib/api.ts`, `devMode.ts`, and the
     `_layout.tsx` screen.
   - A phone that still has `claude` installed must ignore the unknown id, not crash.
3. **Google scopes:** change `drive` to `drive.file` (`jarvis/api/src/google`). Change the Drive tools in
   `google/tools.ts` to work only with files OVOA created, and tell the model it can't search the rest of their
   Drive. Leave the other scopes.
4. **Shortcuts:** only the auto send-message shortcut (`SEND_TEXT_SHORTCUT`, Settings) ships.
   `SHORTCUT_SIGNING_URL` stays unset.
5. **Leftovers:** remove DeepSeek and Workers AI from Dev tools switches, docs and `server_settings` readers.

---

## Phase 8 — Food memory and the Calorie add-on

`docs/food.md` is the spec. **Its "Decisions (user, 2026-09-23)" section overrides the older parts** (the 90-day,
forever-totals and forever-catalog retention; migration number `0028`).

1. **Server:** food tables (next free migration number), `jarvis/api/src/food.ts`, the tools, the catalog and the
   sanity clamp, and day totals that feed the day summary.
2. **Food memory for everyone on Base.** OVOA notes food whenever it's mentioned, with no install needed, at the
   **quick** level (never asks).
3. **Tracking level** `quick` / `normal` / `strict` applies once the Calorie add-on is installed or the user has a
   food goal:
   - The default is `normal`.
   - On first open the add-on asks: "Do you want a rough idea, or should I ask what's in things?"
   - It can be changed by voice. "Just log it" ends the questions.
4. **Numbers:** "about" at quick and normal speech; the plain number at strict (after asking); plain on screen.
5. **Guardrails:** as in §1. The under-eating check says "that's lower than usual, did I miss anything?" at most
   once a week.
6. **Calorie add-on:** a "by OVOA" add-on in `lib/addons.ts` (usage level "some", needs Base). It shows:
   - today: a ring for eaten vs target, a protein bar, and entries with an amend sheet;
   - the last 14 days;
   - most-eaten foods and the protein average.

   Build it with the existing motion kit and `AppBlocks`.
7. **Not in v1:** Apple Health write-back (`NSHealthUpdateUsageDescription` says OVOA doesn't write) and photo
   logging.

---

## Phase 9 — Privacy policy and terms (`ovoa-team`)

Rewrite `src/routes/privacy.tsx` (and `terms.tsx` where it overlaps) to match. Use plain English and "beta"
wording. It must cover:

- **What's collected.**
- **Who gets what:**
  - **Cloudflare:** hosting and the database.
  - **Z.ai (GLM, by Zhipu):** writes the AI replies. It's the current provider and may change.
  - **Google Gemini:** fallback replies and web search, on a paid API that isn't used for training.
  - **Deepgram:** reply text only, to speak it.
  - **Resend:** sign-in codes.
  - **Stripe:** payments; OVOA never sees card numbers.
  - **Apple:** speech recognition, on the phone, or Apple's servers on phones that can't do it on the phone.
  - **Google, only if connected:** Gmail, Calendar, files OVOA made in Drive, Docs, Sheets, Tasks, Contacts.
- **Health data:** stays on the phone except the numbers needed to answer a question.
- **Consent** before any AI use.
- **The 14-day rule** and what's kept.
- **Deleting your account in the app.**
- **No ads, no selling data, no training on it.**
- **Contact email.**
- **Minimum age:** ask the user. Draft 13+ and flag it in the report.

Apple needs this page live at ovoa.ai before the TestFlight build goes to beta review. Commit, push `main` in
`ovoa-team`, and deploy the site (`npm run deploy` with the new account's profile).
The site work (Phases 4.7, 4.8, 9) is in a different repo, so a subagent can run it in parallel with the app
phases.

---

## Phase 10 — Ship

1. All checks pass in all three places (§1). Update `SPEC.md`, `docs/food.md` and `docs/feature-plan.md` where
   they disagree with this file, and rewrite `contextforclaude.txt`.
2. **Push `ovoa-app` `main` once** at the end, so a single TestFlight build carries the new address, iOS speech
   and everything else. If Phases 1 and 3 finish well before the rest, one early push so the user can test them
   is fine.
3. After the build lands, ask the user to run the phone checks below, then read `device_logs` for their device.

**Phone checks for the user:**
1. Sign up with the code.
2. Free: Talk shows the lock, and See options opens ovoa.ai.
3. The no-AI tutorial.
4. Start Base (comp or Band days) → consent → voice picker → a goal question that builds an app.
5. Say "OVOA" and ask something: it's recognised on the phone, and the reply is spoken by the Deepgram voice.
6. A Band recording turns into a note.
7. "I had a burrito" with Calorie installed asks what kind; without it, it doesn't.
8. The Calorie screen.
9. Connect Google again.
10. Always listen 24/7 on and off.
11. The Band says "OVOA Band" everywhere.

---

## Waiting on the user (don't do these, remind them)

- Key files in `ovoa-team`: `gemini/.env`, `deepgram/.env`, `zai/.env`, `google/.env`.
- Google (done 2026-09-23): the new client is in `ovoa-team/google/.env` (project `ovoa-509511`, admin@ovoa.ai),
  with `https://api.ovoa.ai/google/callback` as a redirect, and the Google app is **In production** but not verified:
  Gmail/Calendar show the "unverified app" warning, with a 100-user limit, until the user submits for verification.
- Workers Paid on the new account.
- Stripe: live keys in `ovoa-team/stripe/.env`, then the setup script.
- Free Pro accounts for App Review and testers on the admin page, **then** `MEMBERSHIP_API_KEY` on both sides.
- App Store Connect external testing details: privacy policy URL, beta description, demo login, feedback email.
- The minimum age for the privacy policy.

## Report at the end

- What shipped, with commit hashes, per phase.
- Row counts from the move.
- GLM timing numbers.
- The retention table's unclear rows.
- What the user must click themselves.
- What still needs checking on a phone.
