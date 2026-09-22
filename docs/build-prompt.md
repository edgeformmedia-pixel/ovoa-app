# Build prompt — OVOA feature plan

Paste everything below the line into a new Claude Code session (Opus 5) opened in the `ovoa-app` repo.

---

You're building the next set of features for **OVOA** (codebase name "Jarvis"): a voice assistant that runs on an ES100 recorder band + iPhone. The full spec is in `docs/feature-plan.md` — read it in full before anything else. It has 34 features (F1–F34), a "Standalone rule" table, and a phased build order.

## Step 1 — Before writing any code, interview me

Read these first so your questions are informed, not generic:
- `docs/feature-plan.md` (the spec)
- `jarvis/api/src/` — especially `agent.ts`, `context.ts`, `ambient.ts`, `phone.ts`, `google/assistant.ts`, `google/tools.ts`, `push.ts`
- `jarvis/app/app.json`, `jarvis/app/src/lib/assistant.tsx`, `src/lib/clip.ts`, `src/lib/health.ts`, `modules/ute-ble/index.ts`
- `jarvis/api/migrations/` (latest migration number)
- `codemagic.yaml`, `contextforclaude.txt`, `docs/handoff.md`

Then ask me, **in one batch, grouped by topic** (use the AskUserQuestion tool where the answer is a choice), everything you need that you can't work out from the code. At minimum cover:

1. **Scope** — which phase(s) to build in this session, and whether to go phase-by-phase with a check-in after each.
2. **Always-listening** — features F13–F15 are marked [AL]. Always-listening was ruled out on 2026-09-20 on legal grounds. Confirm: build them behind a dev-only `captureEverything` flag limited to my account, or skip them? And should the existing always-listen setting stay, be hidden, or be removed?
3. **Medications source** — Apple Health Medications vs Apple Reminders list vs Google Tasks; what's the default when a user has none.
4. **Hardware I have** — Apple Watch (needed to test F11/F12)? Which ES100 buzz `option` works (or should you build a test screen to find out)?
5. **Location** — OK to request "Always" location and add background location mode? This needs a real device build, not Expo Go.
6. **Accounts & keys** — anything needing a new API key (weather for F18, Maps/travel time for F20), which provider, and whether I'll add the secrets myself (you must never type keys; tell me the exact `wrangler secret put` command).
7. **Google** — should work/personal routing (F34) be allowed to *send* email on its own when confident, or always ask?
8. **Data retention** — how many days to keep raw captures (F13) and location visits (F10).
9. **Timing defaults** — end-of-day to-do time, morning brief trigger, reminder escalation (15 min / 60 min).
10. **Testing** — do you have my permission to run migrations and deploy the worker after each server change, and to trigger Codemagic TestFlight builds?
11. Anything in the spec that's ambiguous, conflicts with existing code, or that you think is a bad idea — say so and suggest an alternative.

**Wait for my answers before coding.** After I answer, write a short build plan (which features, which files, which migrations, in what order) and wait for my OK.

## Step 2 — How to build

- **Standalone rule is mandatory:** every feature must work without the optional inputs in its row of the table (no band → phone notification; no Google → local sources; no watch → manual). Implement one `capabilities(userId)` helper and branch on it.
- **Follow existing patterns:** tools are defined like the ones in `phone.ts` / `agent.ts`; match the code style, comment density and naming around you. Don't add libraries without asking.
- **Server work:** new D1 migrations numbered after the latest; run tests with `wrangler dev --local` + `npm test` / smoke tests before deploying. Always migrate before deploy.
- **Device debugging:** phone logs are in the D1 `device_logs` table — read them before guessing at on-device bugs.
- **Band (ES100):** real-device only; don't flood it with commands (it freezes). Keep ≥30 s between buzzes. SDK connect status 0 means "connected" by default — use the bridge's linked flag.
- **Agent safety:** the background agent must not get send or delete tools; all its runs are logged. New agent tools (`agent_buzz`, `agent_run_command`) must be rate-limited and logged.
- **iOS limits to respect:** max 64 pending local notifications, 20 geofences, silent pushes may not wake a killed app (so queue + drain on open).
- **Push** needs the EAS project id (already set) and a real build, not Expo Go.
- **Commits:** one commit per feature, plain-English messages in the style of `git log`. Don't push unless I say so.
- **After each task,** rewrite `contextforclaude.txt` to ~5 lines describing the current state.

## Step 3 — Report back after each phase

- What was built, per feature, with file links.
- What was verified and how (tests, local worker, device logs) — and what could **not** be verified without a device build.
- Anything skipped or changed from the spec, and why.
- What you need from me next.
