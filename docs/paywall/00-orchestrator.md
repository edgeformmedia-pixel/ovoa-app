# 00 · Orchestrator: wait for the cost pass, then run 01–06

> These prompts (00–06) are the historical record of how the plans were built. The site has changed since (it is the
> `ovoa-site` Cloudflare Worker now); `setup.md` in ovoa-team is the current guide.

You are working in `C:\Users\thoma\OneDrive\Documents\GitHub\ovoa-app`. The site repo is `C:\Users\thoma\OneDrive\Documents\GitHub\ovoa-team`.

Another session (Fable 5.1) is running the cost-reduction pass from `docs/cost-cut-prompt.md`. Your job is to wait until it has finished, then run the plans-and-paywall work in `docs/paywall/` using subagents. **Do not edit any code yourself while waiting.**

## 1. Read, don't act
Read `docs/paywall/SPEC.md` and prompts `01`–`06` in the same folder, and `docs/cost-cut-prompt.md` §1 (repo rules). Don't start any of them yet.

## 2. Wait for the cost pass
Use the Monitor tool with an until-loop that checks every 5 minutes. Don't poll with repeated tool calls or sleeps. The cost pass is done when **either** of these is true:

- **A (preferred):** the file `docs/paywall/.cost-pass-done` exists.
- **B (fallback):** all of these hold, and have held for 20 minutes with no new commits:
  - `git log` shows commits containing `jarvis/api/src/pricing.ts`, `jarvis/api/src/usage.ts` and `jarvis/api/migrations/0033_usage.sql`;
  - `git status --porcelain -- jarvis/api` is empty;
  - `contextforclaude.txt` was committed after the latest of those commits (the cost pass rewrites it last).

If neither is true after 12 hours, stop and tell the user. Don't guess.

When it fires, read the cost pass's commits (`git log -p` since `f91cbdb`) and anything it wrote about cost per reply. Prompt 03 sets its caps from those numbers.

## 3. Run the agents in waves
Give each subagent the full text of its prompt file, plus: "Read docs/paywall/SPEC.md first. It is the source of truth."

- **Wave 1, in parallel:** 01 (site billing), 03 (server plan gate), 05 (transcription on the phone).
- **Wave 2:** start 02 as soon as 01 is done, and start 04 as soon as 03 is deployed.
- **Wave 3:** 06 once everything else is done.

Rules:
- Two agents never work in the same repo folder at the same time. 01/02 share `ovoa-team`; 03 and 04 share `ovoa-app`. 05 touches `jarvis/app` and might touch `jarvis/api`, so if it needs `jarvis/api`, have it wait for 03 to commit.
- An agent's work only counts as done if its own checks passed (typecheck, tests, smoke, build) **and** it committed. If one fails, stop that branch and ask the user; don't let a later wave build on it.
- Agents may deploy the Worker, push `main` in both repos and start Codemagic builds without asking. Deploy the server (03) before any push to `ovoa-app` `main`, because that push starts a TestFlight build.
- Never print or commit secrets. Never put Stripe into live mode.

## 4. Report
At the end, give the user a short summary:
- what shipped (with commit hashes);
- what they must click themselves (Lovable publish, applying the migration in the Lovable chat, Stripe setup script, `MEMBERSHIP_API_KEY` on both sides);
- what still needs checking on a phone;
- the open decisions in SPEC §1: free week vs month with a Band, and what's in Pro.
