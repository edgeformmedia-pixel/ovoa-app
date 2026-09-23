# 03 · App server: plans, the 402 gate, daily allowances

Repo: `C:\Users\thoma\OneDrive\Documents\GitHub\ovoa-app`, folder `jarvis/api`.
Read first:
- `docs/paywall/SPEC.md`.
- `docs/cost-cut-prompt.md` §1 (how to work, test and deploy here). Follow all of it.
- The Fable cost pass's commits: `pricing.ts`, `usage.ts`, `0033_usage.sql`, and whatever it wrote about measured cost per reply.
- `index.ts`, `auth.ts`, `limits.ts`, `agent.ts`, `voice.ts`, `notes.ts`, `heart.ts`, `fitness.ts`, `sweep.ts`.

## Goal
The server knows each person's plan (`free`, `base` or `pro`). It serves health and notes to everyone, and the AI only to the plans that include it, with a daily allowance per plan. The contract is SPEC §2.

## Do
1. **Route table first.**
   - List every route in `index.ts` and every cron job.
   - Mark each one `free`, `base` or `pro` using the SPEC §1 table, and put the result at the top of a new `plans.ts`.
   - Health, notes CRUD, auth, `/me`, logs, settings and push registration are free. Anything that calls a model is base or pro: chat, speech, the memory pass, the brief, the agent, the clip reply, and the email and calendar tools. Open-mic wake streaming and the background agent are pro.
   - If a route doesn't fit, pick the safer (paid) side and list it in your summary.
2. **Plan lookup** (`plans.ts`)
   - Call `GET https://ovoa.ai/api/public/membership?email=` with `Bearer MEMBERSHIP_API_KEY`. The key is a Worker secret. The URL goes in a var so it can point at the site's test Worker.
   - Cache the answer per person in D1 for 10 minutes. The new migration adds `plan_tier`, `plan_status`, `plan_checked_at`, `plan_trial_ends_at`, `plan_renews_at` and `plan_override` to users.
   - If the site is down, keep the last good answer for 24 h, then fall back to free.
   - `plan_override` (set with DEBUG_KEY) beats the site. It's for the developer, App Review and testers.
   - Until `MEMBERSHIP_API_KEY` is set, treat everyone as **pro**, so deploying this can't lock out the current tester. Log that once per isolate.
3. **Gate.** Add one middleware or helper, not checks scattered through handlers. It returns the SPEC 402 body. The cron jobs that call models skip people whose plan doesn't cover them.
4. **Allowances.**
   - Use `usage.ts` to count replies and cost per person per day, and set the Base and Pro caps from `pricing.ts` so SPEC's $/day ceilings hold. Make the caps named constants, with the arithmetic in a comment.
   - At the cap, send a short spoken/text reply saying the allowance is used up and when it resets. This is a normal reply, not a 402.
   - Open-mic streaming minutes count toward the allowance too.
5. **`GET /me`** gains `plan` exactly as SPEC §2. Add `POST /me/plan/refresh`, rate limited.
6. **Tests.**
   - Unit tests for tier resolution, cache expiry, the site-down fallback, the override and the cap math.
   - Smoke cases in `test/smoke.sh`: a free user gets 402 on `/chat` and 200 on health and notes, and a pro override gets through.

## Verify and finish
- Run `npm run typecheck`, `npm test`, and `npm run smoke` against `wrangler dev --local`. The smoke total must go up, not down.
- Then run `npm run db:migrate` and `npm run deploy` with the ovoa.ai account's profile (`XDG_CONFIG_HOME=C:/Users/thoma/.wrangler-ovoa`).
- Check production with a throwaway account (`DELETE /me` afterwards).
- Commit and push.
- Report the route table and the caps you chose.
