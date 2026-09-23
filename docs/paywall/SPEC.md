# OVOA plans, paywall and beta site: spec

Written 2026-09-22 and brought up to date for the v1 release (2026-09-23). The v1 brief,
`docs/release-v1-prompt.md`, and the decisions made with it win where this file disagrees. Everything here is built:
the server side in `jarvis/api/src/plans.ts` (on the cost pass's `pricing.ts`, `usage.ts` and migration
`0033_usage.sql`), the site side in the `ovoa-team` repo.

The prompts the agents built this from are in this folder (`01-…` to `06-…`), kept as history.

---

## 1. What the user decided

| Thing | Decision |
|---|---|
| Release state | Nothing is fully released. The app, the AI and the Band are all **beta**. v1 ships through **TestFlight** only; the App Store comes later. The site must say "beta" wherever it sells something. |
| Band | **$89.99** one-time. Beta hardware. It works without a plan. |
| Band perk | Each Band comes with **7 days of Base AI free**, started when the buyer chooses (§2). Band-only buyers get them too, with no card, and can use them or give them to someone else. |
| Free app | **Health tracking**, **notetaking** and every app that doesn't use AI. Speech is recognised **on the iPhone** (Apple's speech recognition) for everyone since v1, recordings and spoken turns alike, so free users cost ~$0 on the server. |
| Plans switched on | **Not yet.** Until `MEMBERSHIP_API_KEY` is set on the Worker and the site, the server treats everyone as **Pro**, so no tester is locked out. The user sets it after comp Pro accounts exist for App Review and the testers. Until then a test account's tier can only be changed with `PUT /debug/plan` (DEBUG_KEY, `users.plan_override`), which is how the free and Base states are tried. |
| Consent | Before anything goes to an AI company, the person agrees on a screen that says where their data goes (`app/consent.tsx`, `api/src/consent.ts`). Base without consent shows AI locked with "Agree to use AI". |
| Base AI | **$9.95/month** or **$95.99/year**. **Every** AI feature, the wake word, Always listen and the background agent included. 20 replies a day. |
| Pro AI | **$25.95/month** or **$195.99/year**. **3× Base's usage and nothing else**: 60 replies a day. |
| Trial without a Band | **None.** You pay from day one. |
| Dropped | The $249 lifetime plan, the $9.99/$99.99 prices, the $19.99 "Pro" on `/checkout`, and the $99 Band price on the home page. |

### What each plan gets (decided 2026-09-23, the v1 release brief; this replaces the 2026-09-22 proposal)

**Pro = 3× usage, nothing else.** Every feature is Base's. The wake word listens on the phone now (no open mic
to a server), so it no longer has to be priced apart.

| | Free | Base | Pro |
|---|---|---|---|
| Health (HealthKit, Band heart rate, activity cards) | ✓ | ✓ | ✓ |
| Notes: typed, and Band recordings transcribed on the phone | ✓ | ✓ | ✓ |
| Every screen and app that never calls a model: routines, to-dos, alarms, money, people, places, saving and editing a made app by hand, the Calorie screen's reads and fixes | ✓ | ✓ | ✓ |
| Chat and voice with OVOA: tools, reminders, email, calendar, money, memory, morning brief, food noted from what they say | – | ✓ | ✓ |
| Band button → AI reply | – | ✓ | ✓ |
| Hands-free wake word and Always listen (on phones that recognise speech on their own) | – | ✓ | ✓ |
| Background agent (standing jobs that run on their own) | – | ✓ | ✓ |
| Create (making an app by describing it) and the AI add-ons | – | ✓ | ✓ |
| A day summary kept past the 14 days (`docs/retention.md`; it's written by a model) | – | ✓ | ✓ |
| Replies a day | – | 20 | 60 |
| Spend ceiling a day | – | $0.25 | $0.75 |
| Replies a calendar month (the daily cap × 31) | – | 620 | 1,860 |

The rule is **charge only for things that use AI**: before anything is sent to a model, the server checks the plan,
the day's allowance and consent (`jarvis/api/src/plans.ts` `modelGate`, asked by every model call in `llm.ts`, web
search grounding included). Crons that call a model skip free users, and anyone who hasn't agreed, silently. Every
route that never calls a model is free, including saving a designed app (`POST /apps`), editing a made app or its
screen by hand, transcript reads, `/context/commitments`, Google status and connect, `/actions` and approving one,
`/siri/key` and the Calorie screen (`/food`). Creating or changing an app with AI (`/apps/design`, `/apps/revise`),
a turn (`/chat`, `/siri`) and OVOA's voice (`/voice/speak`, Deepgram) are Base. `ROUTE_TIERS` in `plans.ts` is the
list, and a route it doesn't name needs Base. Base stays under **$0.25/day** per person at its cap ($9.95 is about
$0.31/day after Stripe), Pro under **$0.75/day**. When a cap is hit, OVOA says so plainly and says when it resets.
It never just fails silently.

---

## 2. Contracts (every agent builds to these exact names)

### Stripe (site repo `ovoa-team`)

One product per thing. Prices are found by lookup key, as today:

| Lookup key | Price | Kind |
|---|---|---|
| `ovoa_base_monthly` | $9.95 | subscription, month |
| `ovoa_base_annual` | $95.99 | subscription, year |
| `ovoa_pro_monthly` | $25.95 | subscription, month |
| `ovoa_pro_annual` | $195.99 | subscription, year |
| `ovoa_band` | $89.99 | one-time |

- **Band checkout** charges the Band and collects the shipping address. Bought with Base, it saves the card for
  Base; "Band only, no AI" is a one-time payment with nothing saved. The 7 free days wait for the Band to arrive:
  the welcome page's **Start my 7 free days** (a form POST, never a plain link, since mail scanners open links)
  creates the `ovoa_base_monthly` subscription then, with `trial_period_days: 7`, once per Band order. For Band
  only it has no payment method and `trial_settings.end_behavior.missing_payment_method: "cancel"`, so it ends on
  its own and nothing is charged. To give the days away, the buyer starts them and then uses **Use a different
  email in the app**. Band orders from before 2026-09-23 had the trial start at checkout and carry on that way.
- **Plan checkout without a Band** has no trial.
- Old lookup keys (`ovoa_member_*`) stay readable, so anyone already on them maps to **base**. Lifetime maps to base
  with no end date. Stripe is **live only** (no test keys; the site's `npm run test:billing` runs against
  `scripts/fake-stripe.mjs`), and nobody but the user runs its setup script. Don't crash on old rows.

### Membership API (site → app server)

`GET https://ovoa.ai/api/public/membership?email=…` with `Authorization: Bearer MEMBERSHIP_API_KEY`. It returns:

```json
{ "tier": "free" | "base" | "pro",
  "status": "trialing" | "active" | "past_due" | "canceled" | "comp" | "none",
  "trialEndsAt": "ISO date or null",
  "renewsAt": "ISO date or null",
  "source": "stripe" | "band_trial" | "comp" | "none" }
```

`tier` is already resolved. The app server never works out tiers from Stripe itself. `comp` (free access given from the admin page) carries a tier, so the admin page needs a Base/Pro picker.

### App server (`jarvis/api`)

- `GET /me` gains `plan: { tier, status, trialEndsAt, renewsAt, limits: { repliesLeftToday, resetsAt }, features: { chat, voice, wake, agent } }`.
  The four feature flags are all true from Base up (Pro adds none); they stay four because every build reads them.
  Since v1 it also says `emailVerified` (the emailed code), `aiConsent` (`{ given, version, at, current }`) and
  `devTools` (a development account).
- Any AI route called without the right tier answers **HTTP 402** with `{ "error": "needs_plan", "needs": "base" | "pro", "message": "<plain English>" }`. The app keys off `error`, never off the status code alone.
  The other refusals, each with a `message` to show: **429** `allowance` (with `resetsAt`) when the day's replies
  or spend are used up, **403** `needs_consent` before the person has agreed to AI, and **403**
  `needs_verification` for a new account that hasn't typed its emailed code (it can reach only `GET /me`, sign out,
  `DELETE /me` and the code routes; `api/src/verify.ts`).
- A tier is cached per person for 10 minutes (D1 or the session cache). There's a `POST /me/plan/refresh` for the app to call after checkout. If the site is unreachable, keep the last known tier for 24 h; after that, fall back to free. Never lock a paying person out because ovoa.ai had a blip.
- App Review needs a login with comp **Pro** access, set up before the first external TestFlight submission. It
  can't receive a code, so its address must be marked proven first (`POST /debug/verify`), and while plans are off
  it's Pro anyway (or pinned with `PUT /debug/plan`).

---

## 3. Work split and order (done; kept as history)

| # | Prompt | Repo | Runs |
|---|---|---|---|
| 01 | Site billing: Stripe prices, checkout, webhook, membership API with tiers | `ovoa-team` | Wave 1 |
| 03 | Server entitlements: tiers, 402 gate, caps, `/me.plan` | `ovoa-app/jarvis/api` | Wave 1 |
| 05 | On-phone transcription for free notes | `ovoa-app/jarvis/app` | Wave 1 |
| 02 | Site pages and copy: beta framing, new prices, Band $89.99, plan picker | `ovoa-team` | Wave 2 (after 01) |
| 04 | App free mode and upgrade screens | `ovoa-app/jarvis/app` | Wave 2 (after 03) |
| 06 | End-to-end check, docs, setup.md, context note | both | Wave 3 |

Wave 1 agents touch separate folders, so they can run at the same time. 01 and 02 share `ovoa-team`, and 03 and 04 share `ovoa-app`, so each pair runs one after the other.

---

## 4. Risks the agents must not paper over

- **Apple guideline 2.2** (no payment for TestFlight access) still applies. The site sells a *membership to the service* and a *physical Band*, never "TestFlight access". `setup.md` already explains this, so keep that wording.
- **Apple guideline 3.1.1.** When the app reaches the App Store, AI unlock has to be an in-app purchase too; web purchases are honoured under 3.1.3(b). The app never shows a buy button or prices, and never links to checkout.
  - **TestFlight (the user's call, 2026-09-23, temporary):** the locked state says "That's for Base users" with a **See options** button that opens the plans on the site, `https://ovoa.ai/early-access#plans`. It opens the plans page, never checkout. It lives in `jarvis/app/src/components/Plan.tsx` `StoreActions`, the one seam where in-app purchase replaces it for the App Store. Beta App Review may object to the link; if it does, `StoreActions` goes back to the plain line.
- **Apple speech recognition** is free and can run on the phone. Band recordings are bare 16 kHz mono **opus**
  packets, which iOS can't read, but the Band module already decodes every download to a 16 kHz PCM WAV, and that
  is what `jarvis/app/src/lib/onDeviceTranscribe.ts` hands the recogniser. It still has to be proven on a TestFlight
  build, and on-device recognition needs iOS 17+ for good accuracy on longer clips. Apple's speech servers are
  used only for things the person starts (an orb tap, a Band click, a recording made on purpose, a file) on an
  iPhone that can't recognise on its own, never for listening for the name or Always listen.
- The hard rules in the v1 brief §1 hold: **no room audio to any server** (the wake word and Always listen run on
  the phone's own ear, and nothing leaves the phone until the name is heard, and then only the words), and
  **zero-setup**.
