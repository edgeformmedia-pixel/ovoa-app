# 04 · App: free mode and upgrade screens

Run **after 03 is deployed**. Repo: `…\ovoa-app`, folder `jarvis/app`.
Read first:
- `docs/paywall/SPEC.md` (especially §4 on Apple's rules).
- `docs/cost-cut-prompt.md` §1.
- `jarvis/app/CLAUDE.md` → `AGENTS.md`. Use the Expo SDK 57 versioned docs.
- 03's commits and the `/me` `plan` shape.
- `src/app/(tabs)/_layout.tsx`, `chat.tsx`, `record.tsx`, `day.tsx`, `index.tsx`, `agent.tsx`, `brief.tsx`, `settings.tsx`, `components/HealthCards.tsx`, `components/Drawer.tsx`, `lib/assistant.tsx`, `lib/agent.tsx`, `lib/auth.tsx`, and the voice/orb code.

## Goal
A free user gets a complete, calm app: health, notes, and Band recordings turned into notes. Every AI surface shows what it would do and that it needs a plan. It never shows an error. Base and Pro users see no change except a "Your plan" row.

## Do
1. **One plan hook.** Add `usePlan()` backed by `/me.plan`.
   - It refreshes on app focus and on pull-to-refresh, and it resets through the existing `lib/signOut.ts` registry.
   - Every gate reads it.
   - A 402 `needs_plan` from any call also counts as a signal: refresh the plan and show the locked state.
2. **Free home.** When the plan is `free`, the first screen is the day spine with health cards and notes. Replace the orb, the chat input, the wake word, the agent tab and the morning brief with one quiet "OVOA's assistant is part of a plan" card, not repeated nags.
3. **Band button on free.**
   - A press records a note: it's saved as a note and transcribed on the phone.
   - Agent 05 builds the transcriber: call its `transcribeOnDevice()`. If 05 isn't merged yet, save the audio and show "Transcribing…".
   - It never calls the AI clip reply.
4. **Pro-only features on Base.** The wake word and the background agent show "Part of Pro".
5. **Allowance used up.** Show the server's message and the reset time as a normal reply bubble.
6. **Settings → Your plan.**
   - Show the plan name, the trial end or renewal date, and "Refresh".
   - **No prices, no buy buttons and no links to checkout** during TestFlight (SPEC §4). Plain text only: "Plans are managed at ovoa.ai."
   - Put an `// IAP goes here` seam in one component so the App Store version can add StoreKit later.
7. The UI text is plain English and matches the white "one day, one spine" design. No "tier", "entitlement" or "paywall" in the UI.

## Verify
- `npx tsc --noEmit`.
- `npx expo start --web`: check free, base and pro at phone width (use 03's DEBUG_KEY override on a throwaway account), and take screenshots.
- Say plainly that nothing was checked on a device. List the on-device checks for the user's next TestFlight build.

## Finish
Commit and push `main`. That starts the Codemagic TestFlight build; the server must already be deployed.
