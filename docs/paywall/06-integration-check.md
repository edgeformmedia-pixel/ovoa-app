# 06 · Tie it together: end-to-end check, setup.md, notes

Run **after 01–05 are all committed**. Repos: `ovoa-team` and `ovoa-app`.
Read first: `docs/paywall/SPEC.md`, and every commit 01–05 made (`git log -p` in both repos, starting after the cost pass).

## Do
1. **Contract check.**
   - Compare the site's membership API response with what `jarvis/api/src/plans.ts` parses.
   - Compare `/me.plan` with what `usePlan()` reads.
   - Fix any drift in field names, tier values or dates. Fix whichever side breaks SPEC §2.
2. **End to end, on test infrastructure.**
   - Point a local `jarvis/api` (`wrangler dev --local`) at the membership URL on the site's test Worker, with the same test `MEMBERSHIP_API_KEY` on both.
   - Walk through, using fake or test Stripe:
     1. Buy a Band with AI.
     2. The membership API says base/trialing.
     3. The server's `/me.plan` says base, `/chat` is allowed, and wake gets 402.
     4. Cancel. The plan becomes free: `/chat` gets 402, and notes and health still work.
   - Do the same for Pro annual.
   - Write down each step's actual response.
3. **Price sweep.** Grep both repos for anything that disagrees with SPEC §1: $99, $9.99, $19.99, $249, "lifetime", "1 month free".
4. **Update `ovoa-team/setup.md`** with the new steps from 01's notes:
   - Re-running `stripe-setup.mjs`.
   - The Supabase and D1 migrations.
   - Setting `MEMBERSHIP_API_KEY` on **both** Lovable and the Worker (`wrangler secret put MEMBERSHIP_API_KEY` in `jarvis/api`).
   - App Review's comp Pro login.
   - The privacy URL for TestFlight.
   - Also remove the lifetime plan from the Roll comparison table.
5. Rewrite `ovoa-app/contextforclaude.txt` to about 5 lines. Update the memory note `paid-early-access-site`: setup.md Part C (gating the app) is done now.
6. Give the user a short list of three things: what's live, what needs a click from them (Lovable publish, Stripe live mode, the migration in the Lovable chat), and what still needs a device check.
