# 01 · Site billing: new prices, Band checkout, tiers in the membership API

Repo: `C:\Users\thoma\OneDrive\Documents\GitHub\ovoa-team` (TanStack Start on Lovable, Lovable Cloud Supabase, and a Cloudflare test Worker with D1).
Read first: `C:\Users\thoma\OneDrive\Documents\GitHub\ovoa-app\docs\paywall\SPEC.md` (the source of truth), then `setup.md`, then everything in `src/lib/membership/` and `src/routes/api/public/`.

## Goal
Make billing match SPEC §1–2. That means two AI tiers (Base, Pro), each monthly or yearly; a $89.99 Band that comes with 7 days of Base; no trial without a Band; no lifetime. The membership API must answer with a resolved `tier`.

## Do
1. `src/lib/membership/plans.ts`
   - Replace the plan model with tiers and billing periods: `PlanId = "base_monthly" | "base_annual" | "pro_monthly" | "pro_annual"`, plus `BAND_LOOKUP_KEY`.
   - Set `NO_BAND_TRIAL_DAYS = 0` and `BAND_TRIAL_DAYS = 7`.
   - Update the fallback prices to the SPEC amounts.
   - Keep `formatMoney`. Rework `annualSavings` so it works per tier.
   - Add `tierOf(lookupKey)`. It maps the old `ovoa_member_*` keys to `base`.
2. `scripts/stripe-setup.mjs`: create the five prices by lookup key. It must be safe to run twice: when an amount changes, create a new price and move the lookup key to it (`transfer_lookup_key`). Leave the old prices alone.
3. Checkout (`/api/public/billing/checkout`)
   - Accept `?plan=<PlanId>` and `?band=1`.
   - A Band checkout is `subscription` mode: the Band one-time item plus `ovoa_base_monthly` with a 7-day trial, collecting a US shipping address and a phone number.
   - `?band=1&ai=0` is `payment` mode, Band only.
   - Plan checkout without a Band has no trial.
   - Keep the referral (`?ref`) and affiliate handling that's there today.
4. Webhook
   - Store `tier` alongside status on the member row.
   - Record Band orders (a new `band_orders` table with email, Stripe session, shipping, and status `paid|shipped|refunded`) so the admin page can see what to ship.
   - Handle `checkout.session.completed` for payment mode too.
5. Storage: write a migration for **both** backends. That's a Supabase migration in `supabase/migrations/` (the user applies it through the Lovable chat) **and** a D1 migration in `migrations/`, because `store.server.ts` switches between them. Add `tier` to members and create `band_orders`.
6. `/api/public/membership` returns exactly the SPEC §2 shape. `comp` members carry a tier; add it to the "give free access" server function (agent 02 builds the picker UI).
7. Commission (20% for 12 months) still applies to subscriptions, but **not** to the Band. Say that in `plans.ts`.

## Verify
- `npm run build` (plus any typecheck script).
- Run the whole flow on `wrangler dev --local` with the fake Stripe through the `STRIPE_API_BASE` var. `setup.md` and `wrangler.site.jsonc` show how. The flows: Band + AI, Band only, Base monthly, Pro annual, cancel, refund, and a membership API call for each.
- Don't touch the live Lovable Stripe keys. Test mode only.

## Finish
- Commit with plain-sentence messages (look at `git log` for the style) and push `main`.
- Lovable syncs from `main`; publishing is the user's click, so say so.
- Deploy the test Worker (`ovoa-site`, on the ovoa.ai account since 2026-09-23) with that account's profile: `XDG_CONFIG_HOME=C:/Users/thoma/.wrangler-ovoa npm run cf:migrate`, then the same with `npm run cf:deploy`.
- Leave a short list of the Stripe and Lovable steps the user must do; agent 06 folds it into `setup.md`.
