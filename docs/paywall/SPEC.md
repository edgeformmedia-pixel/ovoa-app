# OVOA plans, paywall and beta site: spec

Written 2026-09-22. **Start only after the Fable 5.1 cost pass (`docs/cost-cut-prompt.md`) is committed and deployed.** That pass adds `jarvis/api/src/pricing.ts`, `usage.ts` and migration `0033_usage.sql`. The limits in this spec are built on its per-person usage numbers.

Prompts for the agents that build this are in this folder (`01-…` to `06-…`). Each one reads this spec first.

---

## 1. What the user decided

| Thing | Decision |
|---|---|
| Release state | Nothing is fully released. The app, the AI and the Band are all **beta**. The app ships through **TestFlight** only. The site must say "beta" wherever it sells something. |
| Band | **$89.99** one-time. Beta hardware. |
| Band perk | Each Band comes with **7 days of Base AI free**. Confirmed by the user on 2026-09-22 (a week, not a month). |
| Free app | **Health tracking** and **notetaking**, no AI. Free notes are transcribed **on the iPhone** (Apple's speech recognition), so free users cost ~$0 on the server. |
| Base AI | **$9.95/month** or **$95.99/year**. All the AI assistant features. |
| Pro AI | **$25.95/month** or **$195.99/year**. |
| Trial without a Band | **None.** You pay from day one. |
| Dropped | The $249 lifetime plan, the $9.99/$99.99 prices, the $19.99 "Pro" on `/checkout`, and the $99 Band price on the home page. |

### Proposed, needs the user's OK (agents: build it this way, but make it one-line to change)

**What Pro gets over Base.** The cost pass found open-mic wake mode is ~70% of what OVOA costs to run. So:

| | Free | Base | Pro |
|---|---|---|---|
| Health (HealthKit, Band heart rate, activity cards) | ✓ | ✓ | ✓ |
| Notes: typed, and Band recordings transcribed on the phone | ✓ | ✓ | ✓ |
| Chat and voice with OVOA: tools, reminders, email, calendar, money, memory, morning brief | – | ✓ | ✓ |
| Band button → AI reply | – | ✓ | ✓ |
| Hands-free wake word (open mic) | – | – | ✓ |
| Background agent (standing jobs that run on their own) | – | – | ✓ |
| Daily AI allowance | – | Base cap | ~3× Base |

Set the caps from Fable's measured cost per reply. Base must stay under **$0.25/day** per person at its cap. $9.95 is about $0.31/day after Stripe, and the cap leaves margin. Pro's cap must stay under **$0.65/day**. When a cap is hit, OVOA says so plainly and says when it resets. It never just fails silently.

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

- **Band checkout** is one Stripe Checkout in `subscription` mode. It has the Band as a one-time line item and `ovoa_base_monthly` with `trial_period_days: 7`. Shipping address is collected. There is a visible "Band only, no AI" option: that one is `payment` mode with no subscription.
- **Plan checkout without a Band** has no trial.
- Old lookup keys (`ovoa_member_*`) stay readable, so anyone already on them maps to **base**. Lifetime maps to base with no end date. Stripe is still in test mode, so there should be no real members, but don't crash on old rows.

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
- Any AI route called without the right tier answers **HTTP 402** with `{ "error": "needs_plan", "needs": "base" | "pro", "message": "<plain English>" }`. The app keys off `error`, never off the status code alone.
- A tier is cached per person for 10 minutes (D1 or the session cache). There's a `POST /me/plan/refresh` for the app to call after checkout. If the site is unreachable, keep the last known tier for 24 h; after that, fall back to free. Never lock a paying person out because ovoa.ai had a blip.
- App Review needs a login with comp **Pro** access, set up before the first external TestFlight submission.

---

## 3. Work split and order

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
- **Apple guideline 3.1.1.** When the app reaches the App Store, AI unlock has to be an in-app purchase too; web purchases are honoured under 3.1.3(b). During TestFlight, the app must **not** show a buy button or prices, and must not link out to checkout. Show "Your plan: Free" and "Already a member? Pull to refresh" only, with a plain line pointing to ovoa.ai. Build it so an IAP button can be added later without a rewrite.
- **Apple speech recognition** is free and can run on the phone, but Band recordings are 16 kHz mono **opus**. iOS speech recognition may not read opus files directly, so they may need converting to a format it accepts first. It has to be proven on a TestFlight build, and on-device recognition needs iOS 17+ for good accuracy on longer clips.
- **No always-listening** and **zero-setup** constraints from `docs/cost-cut-prompt.md` §1 still hold.
