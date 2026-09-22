# Prompt — rebuild the OVOA app UI on the white/drawer design

Paste everything below the line into a fresh Opus 5 session with full access to
this machine and the `ovoa-app` repo.

---

You are rebuilding the interface of OVOA, an iOS personal voice assistant, in the
repo at `C:\Users\thoma\OneDrive\Documents\GitHub\ovoa-app`. A design study has
already been approved. Your job is to move the real Expo app onto it without
losing a single developer or debugging surface, and without touching the server's
behaviour.

## Read these before you write anything

1. `jarvis/app/AGENTS.md` — **Expo has changed.** Read the exact versioned docs at
   https://docs.expo.dev/versions/v57.0.0/ before writing any Expo code. The
   project is on `expo ~57.0.23` / `expo-router ~57.0.21`. Do not write from
   memory of older SDKs.
2. `jarvis/app/src/lib/theme.ts` — the current palette. Colours only: no spacing
   scale, no type scale, no elevation roles. That is the problem you are fixing.
3. Every screen you are going to change:
   `app/(tabs)/_layout.tsx`, `app/(tabs)/index.tsx`, `app/(tabs)/chat.tsx`,
   `app/(tabs)/journal.tsx`, `app/(tabs)/record.tsx`, `app/(tabs)/safety.tsx`,
   `app/(tabs)/settings.tsx`, `app/agent.tsx`,
   `components/Feed.tsx`, `components/HealthCards.tsx`, `components/ApprovalCard.tsx`.
4. `docs/agent.md` — what the background agent is and why silence is its default.
   The UI must not make it look chattier than it is.
5. `jarvis/api/src/rhythm.ts` (`buildMorningBrief`, `morningTick`) — the morning
   brief already exists server-side. You are giving it a screen, not building it.

## The design

The approved mock is a working HTML demo:
**https://claude.ai/artifact/P9v7jS7yBNUjSRW4e3UsFq**

Open it and drive it before you start — it is interactive, and the gestures,
transitions and empty states are all specified by behaviour rather than prose.
Seven screens: Talk, Brief, Activity, Day, Record, Safety, Background work.

### What the design actually changes

- **White base.** The app is currently near-black. It becomes white. Single
  theme — do not build a light/dark switch.
- **The bottom tab bar is gone.** Navigation is a hamburger at the top-left
  opening a left drawer (ChatGPT-style): icon rows with a value on the right, a
  "Today" list of recent items, and a teal **Talk** pill pinned to the bottom.
- **Journal becomes "Day"** and carries the timeline spine — a 42px mono time
  column, an 18px rail, and one line per moment. Four states must stay
  distinguishable at a glance: done, due now, upcoming, missed.
- **Settings → Background work becomes a 2-up grid of tiles** — icon, label,
  value, nothing else. Autonomy, Quiet, Runs today, Jobs, Goals, Run log. Then
  three job rows: icon, name, run button, switch.
- **Activity is health only** — steps, the 7-day chart with a goal line, and
  workouts that each show where you were and a heart-rate trace.
- **Safety and Record are full screens** reached from the drawer.

### Tokens — put these in `lib/theme.ts` and use nothing else

```ts
export const colors = {
  paper:"#FFFFFF", wash:"#F4F5F7", wash2:"#EAECF0", line:"#E4E7EC",
  ink:"#0C0E12", inkDim:"#5A6270", inkMute:"#8B93A1",
  rail:"#D6DAE1", railNext:"#EDEFF3",
  now:"#0E8CA8", nowWash:"#E1F3F8",      // now / your turn — the only accent
  agent:"#5B4FC7", agentWash:"#ECEAFB",  // the background agent's own hand
  done:"#1C8C5E", doneWash:"#E2F3EB",
  late:"#B0761A", lateWash:"#FBF0DC",
  stop:"#D24540", stopWash:"#FCE9E8",
  blue:"#2E6FE8", blueWash:"#E6EEFD",
  pink:"#C7488F", pinkWash:"#FBE8F3",
} as const;

export const space = { s1:4, s2:8, s3:12, s4:16, s5:20, s6:24, s8:32, s10:40 } as const;

export const type = {
  display:{ fontSize:44, lineHeight:46, fontWeight:"600", letterSpacing:-1.5 },
  title:  { fontSize:22, lineHeight:28, fontWeight:"600" },
  lead:   { fontSize:19, lineHeight:26, fontWeight:"600" },  // a moment that is due now
  head:   { fontSize:17, lineHeight:23, fontWeight:"600" },
  body:   { fontSize:17, lineHeight:23, fontWeight:"500" },
  sub:    { fontSize:15, lineHeight:21, fontWeight:"400" },
  meta:   { fontSize:13, lineHeight:20, fontWeight:"400" },
  micro:  { fontSize:11, lineHeight:14, fontWeight:"500", letterSpacing:0.9 },
} as const;

export const radius = { chip:12, pill:22, tile:20, sheet:26 } as const;
export const numeric = { fontVariant: ["tabular-nums"] as const };
```

**Rules that come with the tokens, and matter more than the hex values:**

- Nothing renders below 11px. Nothing uses a font weight above 600.
- `now` (teal) means *now, or your turn* — and nothing else. It is allowed on:
  the NOW marker, the due-now node, the single most urgent button on a screen,
  today's bar in the week chart, and "Run now". It is **not** allowed on
  selection states, tab underlines, switches, or progress fills.
- `agent` (violet) marks work the background agent did on its own. Never
  decoration.
- Switches use `done` (green) when on, the way iOS does.
- The icon tiles in the drawer and on Background work are the one deliberate
  exception to accent discipline — they are identity colours, not state.
- `fontVariant: ["tabular-nums"]` wherever digits stack: the time column, steps,
  bpm, run counts.
- A moment that needs an answer gets a 2px left rail in `now` and an indent —
  **never** a filled card, a border, or a radius. If it starts looking like a
  card again, you have got it wrong.

## The navigation decision — make it deliberately, and tell me which you took

The app has **no** `react-native-gesture-handler`, **no** `react-native-reanimated`
and **no** `@react-navigation/drawer`. Check `jarvis/app/package.json` yourself
before deciding.

- **Option A — expo-router `Drawer`.** Needs three new native dependencies. That
  means a new Codemagic dev build before it can be tested on device, and it may
  break the `--go` workflow that is currently how this app is run day to day.
- **Option B — a hand-rolled drawer** in `app/_layout.tsx` using core
  `Animated` + `PanResponder`: an absolutely-positioned panel, a scrim, an
  edge-drag to open and a swipe to close. Zero new dependencies, works in Expo
  Go today.

I lean to **B** for the first pass, because being able to keep testing in Expo Go
is worth more right now than the polish of the stock drawer, and the drawer is
~120 lines. But verify the dependency situation yourself and say so if I am
wrong. If you take A, do not leave the repo in a state where Expo Go is broken
without telling me.

Either way: the routes under `app/(tabs)/` should keep their paths where
possible so every `router.push("/…")` in the codebase keeps working. Renaming
`journal` to `day` means finding every reference — grep for it.

## Do not break any of this

This app is debugged on a real device through these surfaces. Every one of them
must still be reachable and still work when you are done. Restyle them to the new
tokens; do not simplify them away.

| Surface | Where | How it is reached |
|---|---|---|
| Dev tools: sensors, inputs, ES100, twist calibration, turn timings | `app/dev-tools.tsx` | Settings → "Sensors, inputs & ES100" |
| Live log panel over the voice screen | `components/DevLogPanel.tsx` + the `Logs` toggle in `app/(tabs)/chat.tsx` | tap **Logs**, top-right of the voice screen |
| Device log upload + levels | `lib/devlog.ts`, `lib/remoteLog.ts` (`logStatus`, `setUploadLevel`) | dev-tools |
| Motion lab | `app/motion-lab.tsx` | dev-tools |
| ES100 BLE screen | `app/es100.tsx` | dev-tools |
| Live listen | `app/live.tsx` | Activity shortcut |
| Ask Claude | `app/claude.tsx` | Activity shortcut |
| Report a problem | `app/report-bug.tsx` | Settings |
| Turn timer | `lib/turnTimer.ts` (`useTurns`, `breakdown`, `summary`) | dev-tools |

The Activity screen in the new design has no shortcut row. **Do not delete the
`/live` and `/claude` entry points** — move them into the drawer, below the main
nav, or into a "Developer" group in it. Same for dev-tools. Losing these is the
one outcome that makes this rework a net negative.

Phone logs live in D1 `device_logs`. If something misbehaves on device, read
them before guessing.

## Order of work

Do it in commits I can revert one at a time. After each step the app must still
build and run.

1. **`lib/theme.ts`** — add the full token set, keep the old `colors` keys as
   aliases so nothing breaks. Commit. Nothing should look different yet.
2. **The drawer + root layout.** Hamburger, panel, scrim, edge-drag. Keep the
   tab routes; just stop rendering the tab bar. Commit and verify navigation to
   every route including the dev ones.
3. **One screen at a time**, in this order: Day (the spine is the hardest and
   everything else is easier once it exists) → Activity → Talk → Background work
   → Record → Safety → Brief.
4. **The Brief screen** last. It reads `buildMorningBrief`'s output; there is no
   "what it learned" data yet, so render that section from an empty state and
   leave a `TODO(brief-learning)` — do not fake the learned list with hardcoded
   strings.

## Verification — do this, do not ask me to

- `npx tsc --noEmit` in `jarvis/app` after every screen.
- Run the app and look at it. Screenshot each screen and check it against the
  mock before you call a screen done.
- Check every screen at the smallest supported width. Nothing may clip, and no
  screen may scroll horizontally.
- Confirm by clicking: drawer opens and closes, every drawer item routes, the
  Logs panel still opens, dev-tools still reads sensors.
- If you change anything under `jarvis/api`, migrate and deploy it —
  `npx wrangler d1 migrations apply jarvis-db --remote` then `npx wrangler deploy`
  — without asking. You should not need to for this task.
- You may push to `main` and start Codemagic builds without asking.

## Out of scope

- No server behaviour changes. No new API endpoints. No schema changes.
- No new features. The Brief screen displays what already exists.
- Do not build the brief-learning loop. That is a separate piece of work with its
  own design.
- Do not add a dark theme.

## When you are done

Rewrite `contextforclaude.txt` to about five lines describing the current state.
Then tell me, in plain terms: which navigation option you took and why, which
screens are done, anything in the mock you deliberately did not copy and the
reason, and anything you broke and could not fix.

If something in the design does not survive contact with the real data — a
string that is longer than the mock's, a state the mock does not show, a screen
where the real content does not fit — **do not silently redesign it.** Build the
rest, and tell me which one it was and what you would do about it.
