# Handoff — OVOA / Jarvis (voice latency + Apple Health work)

Paste everything below into a fresh Claude Code session in
`C:\Users\thoma\OneDrive\Documents\GitHub\ovoa-app`.

---

You are picking up work on OVOA (repo `ovoa-app`, branch `main`). The previous
session ran out of usage mid-stream. Everything described here is **committed
(`a93b502`) and the Worker is deployed (version `3d048f36`)** — nothing is
half-finished on disk. Read this, then continue from "What to do next".

## What the product is

A personal voice assistant. Two halves:

- `jarvis/api` — Cloudflare Worker (Hono + Zod), D1 database `jarvis-db`,
  deployed at `https://jarvis-api.edgeformmedia.workers.dev`. Chat turns, tool
  calling across three model engines (Gemini → DeepSeek → Workers AI), the
  background agent, Google integration, Deepgram STT/TTS proxying.
- `jarvis/app` — Expo (SDK 57) iOS app. Talks to the API, drives an **ES100
  wrist clip** over BLE through a custom native module. The clip has a button
  and its own microphone but **no live audio stream**: a turn is
  press → record on the clip → press again → fetch the file over BLE → decode
  opus → upload → transcribe → model → speak.

## Ground rules that will save you time

- **Always `npm run db:migrate && npm run deploy` in `jarvis/api` after server
  changes.** The user expects this without being asked.
- **OneDrive makes recursive `find` / `grep -r` time out** (node_modules).
  Use `git ls-files` and the Grep tool instead.
- **The Bash tool collapses backslashes inside heredocs.** A python/node
  heredoc containing `\\n` arrives as a real newline and your string matches
  will fail mysteriously. Use the Edit/Write tools for anything with escapes.
- `jarvis/app/AGENTS.md` says: read `https://docs.expo.dev/versions/v57.0.0/`
  before writing Expo code. Expo has changed; don't write from memory.
- Verify with: `npx tsc --noEmit` in **both** `jarvis/api` and `jarvis/app`;
  `npm test` in `jarvis/api`; and the smoke test:
  `npx wrangler dev --local --port 8787 --var DEBUG_KEY:localtest` then
  `npm run smoke` (47 checks, needs no Cloudflare auth).
- **Read the phone's real logs instead of guessing.** The app uploads its whole
  dev log to D1 every 3 s:
  `npx wrangler d1 execute jarvis-db --remote --json --command "SELECT time, kind, text, detail FROM device_logs ORDER BY id DESC LIMIT 200"`
- HealthKit and the BLE module need a **development build** (Codemagic →
  TestFlight), not Expo Go. The user tests on a real iPhone.

## What the last session did, file by file

### Apple Health on the Activity tab

- `jarvis/app/src/lib/health.ts` — was only the LLM tool (`healthSummary`, 7-day
  history). **Added** `healthPermission()` and `todayHealth()`: today's heart
  rate stats, the last 12 h of raw heart-rate samples thinned to 48 points,
  resting rate, HRV (SDNN), active energy, exercise minutes, stand hours, sleep
  that ended today, and today's workouts. `READ` gained the SDNN, exercise-time
  and stand-time identifiers. Everything is `.catch(() => null)` per query, so
  one unauthorised type doesn't sink the card.
- `jarvis/app/src/components/HealthCards.tsx` — **new.** Renders the above:
  a big bpm number with "12 min ago", a bar graph of the last 12 h (plain
  Views, no SVG dependency), resting rate, tiles for sleep / active / exercise
  and HRV / stand, and today's workouts. Four states: unavailable (Expo Go),
  error with a retry, loading, and "Health has nothing for today yet". Reloads
  on `useFocusEffect` with an `alive()` guard.
- `jarvis/app/src/app/(tabs)/index.tsx` — the Activity tab. Renders
  `<HealthCards />` under the step cards, **and** in the
  denied/unavailable-steps branch, which used to return a bare centred notice
  and hide everything else.

### Turn timing (the debug surface)

- `jarvis/app/src/lib/turnTimer.ts` — **new, the centre of this work.** One open
  turn at a time. `startTurn("band"|"phone")`, `mark(name, detail)`,
  `markStopTalking()` (the zero point — everything before it is the user
  talking), `noteHeard`, `noteServer`, `failTurn`, `endTurn`. Closing a turn
  emits one `perf` devlog line with the whole breakdown. Keeps the last 12
  turns, exposed via `useTurns()`. `mark()` is a no-op when no turn is open,
  which is why the call sites below can be unconditional.
- `jarvis/app/src/lib/devlog.ts` — added the `"perf"` log kind.
- `jarvis/app/src/components/DevLogPanel.tsx` — colour for `perf`.
- `jarvis/app/src/lib/clip.ts` — `downloadOne()` now calls
  `markTurn("fetch from the clip", "<KB>, <B/s>, <ms> decode")` next to its
  existing `say(...)` timing line.
- `jarvis/app/src/lib/voice.ts` — `transcribe()` marks `"transcribe"` and notes
  what was heard; `playFile()` gained an `onStart` callback so `createSpeaker`
  can mark `"first word out loud"` exactly once per reply; `answerAloud` was
  split into a wrapper that opens/closes a `"phone"` turn around
  `answerOneTurn` (unchanged body).
- `jarvis/app/src/app/dev-tools.tsx` — new **Turn timings** card: median answer
  time, then each recent turn with its breakdown, what was heard and the
  server's meta. Reachable from Settings.

### Conversationality and perceived speed

- `jarvis/app/src/lib/assistant.tsx` — the band turn lives here.
  - `ask()` marks `"model answers"` on the first streamed sentence and
    `"phone lookup"` around the on-device lookups, and records `res.meta`.
  - `bandClick()` — `startTurn` on the first press, `markStopTalking()` + **one
    buzz** on the second, `endTurn` when a click cuts a reply short.
  - `bandAnswer()` — after `FILLER_AFTER_MS` (2200) with nothing streamed it
    says a short line ("One sec.") through the same speaker queue, so the
    answer plays right after it; on failure it buzzes twice and **speaks**
    `excuse(message)` instead of going silent.
- `jarvis/app/src/lib/api.ts` — `ChatResponse["meta"]` widened to carry
  `contextMs`, `firstTokenMs`, `firstSentenceMs`, `promptChars`, `toolCount`
  and per-tool timings.
- `jarvis/api/src/index.ts` — three changes in `runTurn`:
  1. the `voice` system prompt rewritten (answer first, contractions, no
     "Certainly", short confirmations) plus a line asking the model to write
     four words *in the same turn as a tool call* — that text is streamed and
     spoken while the lookup runs;
  2. `callTool` wrapped to time every tool, surfaced in `meta.tools` and the
     turn log;
  3. the system prompt is built from a labelled `sections: [string, string][]`
     array (same text, same order) so the log can print `prompt: base 412,
     voice 1180, phone 3900, google 9100, agent 7300, tools 11000, history 2400`.

### Documentation

- `docs/voice-latency.md` — **new and the thing to read next.** The measured
  breakdown of a band turn, what is now instrumented, what was fixed, and the
  ranked list of what to try next.
- `jarvis/README.md` — Activity tab now documents the health cards; the Voice
  section links to `docs/voice-latency.md`.
- `contextforclaude.txt` — the running 5-line summary the user keeps. **Rewrite
  it (~5 lines) when you finish a task.**

## The measurements you are working against

From `device_logs`, 2026-09-20, build `1.0.0 ios release`, band turns, timed
from the second button press:

| Leg | Measured |
| --- | --- |
| press → download starts | 150–250 ms |
| BLE fetch | 1.7–2.4 s (470–590 ms to first byte, 11–20 KB/s) |
| opus → WAV decode | 350–560 ms |
| upload + Deepgram | 730–990 ms (300–580 KB WAV) |
| model, first call | 0.8–12.4 s, median ~3.5 s, 32.5k prompt chars, 50 tools |
| phone lookup + second call | +1.1–4.4 s |
| first voice clip | ~540 ms |

Typical **8–12 s**. Two of six turns that session answered nothing at all
(`/chat` died after 57 s "network connection was lost"; `Gemini 503 high
demand") — both silent from the wrist, which is what the buzz/filler/spoken-
failure work above addresses.

## What to do next

1. **Get a build on the phone and read the new `perf` lines.** Nothing above
   has run on real hardware yet — HealthKit and the clip both need a
   development build (Codemagic → TestFlight; `ios-testflight` workflow works,
   read the signing log first). Then:
   `SELECT time, text, detail FROM device_logs WHERE kind = 'perf' ORDER BY id DESC LIMIT 20`
2. **Check the buzz did not slow the transfer.** The new "heard you" buzz rides
   the same BLE link the recording is about to come over. Every fetch mark
   carries B/s — if it dropped below the 11–20 KB/s baseline, move the buzz to
   after the download (the code comment in `assistant.tsx` says so too).
3. **Trim the voice prompt using the new per-section numbers**, not guesses.
   The likely win: gate the shortcut-writing and agent job-management tools out
   of voice turns (~12 of the 50), since a spoken question never needs them.
4. **Send ogg-opus instead of a 580 KB WAV** (`jarvis/app/modules/ute-ble/ios/src/OpusWav.swift`).
   Deepgram takes opus directly: ~16× smaller upload and the 350–560 ms decode
   disappears.
5. Confirm the 2.2 s filler never overlaps a real reply on device, and that a
   short first sentence isn't held back behind it.

## Known blockers and constraints

- **`eas init` in `jarvis/app` has never been run** → no EAS project id → push
  notifications have nowhere to go. Needs the user.
- The ES100's only motion stream is a ~1 Hz gyro; twist-to-listen was dropped
  because of it. Motion command floods freeze the clip. Don't reopen this.
- The context/timeline feature is **explicit-capture only**; ambient always-on
  listening was ruled out on legal grounds. Don't propose it.
- Consumer bar: anything that needs a Raspberry Pi, Home Assistant or ADB is
  out. Prefer OAuth cloud integrations.
