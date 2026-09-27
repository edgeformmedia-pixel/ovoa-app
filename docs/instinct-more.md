# Games for two, plans followed up, budgets (2026-09-26)

Three more things OVOA does from the text conversation, on top of texting first (docs/texting.md), websites
(docs/sites.md) and OVOA to OVOA (docs/ovoa-network.md). Every model call goes through `llm.ts` like the rest,
so the engine order in `server_settings` decides who answers (GLM 5.3 Flash on Z.ai first in production).

Code: `jarvis/api/src/together.ts`, `src/lifeplans.ts`, `src/budget.ts`, the game parts of `src/sites.ts`
(`gamePrompt`, `cleanGameHtml`, `GAME_POLICY`, `gameReady`, `presentGame`), `network.ts shareWithConnection`,
migration `0055_games_plans_budgets.sql`, the wiring in `index.ts` (turn tools, the slow lane's `plans` and
`together` parts). Tests: `test/instinct.test.ts`; production: `scripts/instinct-probe.mjs`.

## The rule that doesn't change

Background runs never send, delete or spend on their own. `game_make`, `budget_set`, `purchase_propose` and
`purchase_confirm` are in `commands.ts FORBIDDEN_FOR_COMMANDS` and none of the new tools are in `agent.ts
READ_ALONE` / `WRITE_ON_ACT`, so an autonomous run can't reach them. What goes to another person (a game's link
to their OVOA) happens because the owner asked for it in their own turn; any spend needs their YES in a later
reply of theirs (`purchase_confirm` refuses a purchase prepared in the same turn). The only things the cron
sends on its own are texts to the owner themselves, paced by `reach.ts`.

## 1. "Made something for you two"

Text: "make a game for me and my girlfriend, a quiz about each other".

- `game_make` (`with`, `idea`, `name?`) works out who "my girlfriend" is (`together.ts resolvePartner`): an
  @username; else the people OVOA knows (`people.relation`, facts) and what it remembers ("Thomas's girlfriend
  is Maria", "my girlfriend Ana"); matched to their accepted OVOA connections by first name or username. Two
  matches, or a relation nobody has named: it asks ("is it Maria (@maria)?") rather than guesses.
- The game is a site of `kind = 'game'` at `<username>.ovoa.ai/game-<name>` (so it needs a username, asked for
  the same way as a website), built by the sites lane with the game maker's instructions (`gamePrompt`): two
  players on one phone (pass-and-play), personal, inline JS only, no network, no storage.
- **Script, sandboxed.** A game is the only page that runs script. It's cleaned as it's kept (`cleanGameHtml`:
  external scripts, frames, plugins, forms, redirects, non-Google-Fonts style sheets, script links, secret
  inputs go) and again as it's served (`presentGame`, HTMLRewriter), under `GAME_POLICY`: CSP `sandbox
  allow-scripts` without `allow-same-origin` (an opaque origin: no `.ovoa.ai` cookies or storage), `script-src
  'unsafe-inline'` only, `connect-src 'none'`, `form-action 'none'`, `frame-ancestors 'none'`, noindex, no
  cache. Websites keep their no-script policy. Games aren't listed on the username's page.
- When it's built (`sites.ts gameReady`): the owner is texted the link. If the partner's OVOA is connected, the
  link goes to it with `network.ts shareWithConnection` (the same `ask` path as `ovoa_ask` share, so the
  connection's limits apply: 20 messages a day, 3 open threads), once (`sites.shared_at`), and the partner's OVOA
  texts it to them ("Thomas had their OVOA make a game for the two of you…"). Not on OVOA, or the share was
  refused: the owner is told to forward the link.
- Changing it: "make the quiz harder" is `site_change` like any site.
- **Offered now and then** (`togetherTick`, slow lane): someone who texts OVOA with texting first on and is
  connected to a partner's OVOA (a couple relation resolves to a connection) gets one text around 6 pm their
  time, at most every 30 days (`ovoa_suggestions`), as a `reach` news text (so the 3 news a day, the 12 a day
  and the quiet-person pacing apply; a held one isn't counted and is tried on a later tick). Their "make us a
  game" is an ordinary turn.

## 2. Plans, with useful follow-ups and reminders

Text: "I'm traveling to SF next month".

- `plan_add` (in the typed core, since a plan names no tool) keeps it in `life_plans` (title, kind, place, dates,
  detail) and returns rule-of-thumb timing (`bookingAdvice`): domestic flights are usually cheapest ~3 weeks to
  3 months out (international 2-6 months), climbing inside 3 weeks; a `remindToBookOn` day (35 days before, or
  90 before for trips over 100 days away, or none when it's under 3 weeks: book now).
- The turn is told to answer usefully: 2-3 concrete options from `web_search` (fares, areas, things to do), the
  timing in a sentence, and an offer to remind them to book. On yes, `reminder_set` for that day (an OVOA
  reminder, texted first when due: `reach.ts` "reminder", never held).
- One follow-up question, written with them there, e.g. "Want me to find a dinner spot near Union Square for
  your first night?". Generic check-ins ("any updates?") are refused (`usefulQuestion`). `plansTick` texts it on
  its day (5 days before, or 2 for a close trip), 9 am to 8 pm their time, as an ask (`reach.ts`: one a day at
  most, backing off when unanswered). No model call in the background.
- `plan_list`, `plan_update` (dates, place, follow-up, done/cancelled).

## 3. "Pay for me, with a budget"

Text: "set a travel budget of $500 a month, max $300 per purchase", then "find me a hotel in SF for Oct 17-19
under budget".

- `budget_set` (category, amount, period week/month/once, perPurchaseMax, remove) → `spend_budgets`.
- OVOA searches (`web_search`), picks one that fits and calls `purchase_propose` (what, total price, merchant,
  https link, category): checked against the per-purchase cap and what's left this period (`fits`; month from
  the 1st, week from Monday, their time), kept as `proposed` in `purchases`, and the reply ends "Book this for
  $X? Reply YES". At most 5 waiting; each waits 24 hours.
- The next turn's prompt lists what waits (`budgetContext`) and carries `purchase_confirm`, so a bare "yes"
  works. `purchase_confirm` yes: re-checked against the budget, recorded `approved`, and the reply gives the
  link for them to finish it themselves, with what's left or a warning past 80% (`WARN_AT`). No: `declined`.
- `budget_status`: each budget, spent this period, left.

**OVOA never pays.** It holds no card, never asks for card details, and there is no payment integration for
people's own purchases (OVOA's Stripe is only for OVOA's own plans), so "booked" always means "recorded
against your budget; finish it at this link". Hands-off paying would need virtual cards from a provider like
**Stripe Issuing** (one card per budget with spending controls matching the budget, the card's details used at
checkout by a browsing agent or merchant API, authorizations webhooked back to count against the budget), plus
KYC and a terms update. That's later work, not built.

## Kept

`life_plans` mixed (an active plan stays; one over goes 14 days later), `spend_budgets` kept, `purchases` 35
days (a month's total reads from the 1st), `ovoa_suggestions` kept (one row per kind). Game sites follow the
`sites` rules (docs/retention.md).

## What to text

- "Make a game for me and my girlfriend" (or "…for me and @maria", "…for me and Sofia" for someone not on OVOA).
- "I'm traveling to SF next month" → options, timing, "want a reminder to book?" → "yes".
- "Set a travel budget of $500 a month, $300 max per purchase" → "Find me a hotel in SF Oct 17-19 within my
  budget" → "YES" → the link to finish it. "How's my travel budget?"
