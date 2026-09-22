# Five redesign prompts — full-app mocks

Five chats, five tastes. Each one produces a **working single-file HTML mock of
the whole app**: six tabs you can actually tap between, plus the sub-screens, in
one artifact — not a row of static pictures.

**How to use:** copy the `SHARED BRIEF` block below, then append **exactly one**
of the five `DIRECTION` blocks at the end. Do that five times, once per chat. The
shared brief is what keeps them comparable; the direction is what makes them
differ.

The five pull on different axes on purpose, so you're choosing between real
alternatives rather than five shades of the same idea:

| # | Direction | The axis it pulls on |
|---|---|---|
| 1 | One day, one spine | **Structure** — time organizes everything |
| 2 | Instrument panel | **Density** — hairlines, numerals, glanceability |
| 3 | Soft depth | **Material** — elevation, light, premium weight |
| 4 | Voice on the page | **Typography** — the app as a record of speech |
| 5 | One thing at a time | **Attention** — one subject per screen, nothing else |

---

## SHARED BRIEF

```
You are redesigning the look of OVOA's iOS app. I'm running this same brief in
three chats with three different visual directions so I can compare tastes, so
stay inside your direction and make it distinctive.

DELIVERABLE: one self-contained HTML artifact that behaves like the whole app —
a phone frame with a working tab bar, every tab built, and the sub-screens
reachable by tapping the rows that lead to them (with a back arrow in the
header). Plain HTML/CSS/JS, no framework. Every screen opens already populated
with believable content; nothing is an empty shell. Don't change any React Native
code in this task — this is a design study.

READ FIRST — design from the code, not from this brief alone:
  jarvis/app/src/lib/theme.ts                 current palette (colors only)
  jarvis/app/src/app/(tabs)/_layout.tsx       the six tabs
  jarvis/app/src/app/(tabs)/index.tsx         Activity
  jarvis/app/src/app/(tabs)/chat.tsx          OVOA, the voice screen
  jarvis/app/src/app/(tabs)/record.tsx        Record
  jarvis/app/src/app/(tabs)/journal.tsx       Journal
  jarvis/app/src/app/(tabs)/safety.tsx        Safety
  jarvis/app/src/app/(tabs)/settings.tsx      Settings
  jarvis/app/src/app/agent.tsx                Settings -> Background work
  jarvis/app/src/components/Feed.tsx          the 11 feed card kinds, and their copy
  jarvis/app/src/components/HealthCards.tsx   heart, resting, HRV, sleep, workouts
  jarvis/app/src/components/ApprovalCard.tsx  "Needs your approval"
  jarvis/app/src/components/NagOverlay.tsx    an alarm going off
  docs/agent.md                               the background agent and its restraint rules

WHAT THE PRODUCT IS
OVOA is a personal voice assistant: an ES100 wrist clip (a microphone, nothing
else) plus an iPhone app plus a Cloudflare Worker. Press the clip's button, talk,
press again; the phone pulls the audio over Bluetooth, the server transcribes it,
a model answers, and the answer is spoken back. Round trip is 8-12 seconds.
Separately a background agent runs on a two-minute cron: standing jobs, goals,
an outbox of notes, a daily run budget, quiet hours (22:00-07:00), and an
autonomy level of "suggest" or "act". For the agent, speaking is a deliberate
act and silence is the default. Anything that would reach another person stops as
a card the user approves.

THE SCREENS TO BUILD

Tab 1 — ACTIVITY (opens here)
  - Steps: today against a goal (5,000 / 8,000 / 10,000 / 12,000 / 15,000), a
    seven-day bar row, km and kcal, a streak count.
  - Health cards: heart rate, resting heart rate, HRV, sleep, recent workouts.
  - Two shortcuts: Live (live metrics) and Ask Claude.
  - The feed, which the server builds from the action log, routines and the day's
    list. All eleven kinds exist, show at least seven: TODAY summary with
    "~35 min saved (estimated)"; today's list with tickable items; MEDS &
    ROUTINES rows with a time, a title and a Done chip (statuses: done, missed,
    later, skipped, snoozed); a streak; a missed item; the agent's own card of
    what it did while you were out; ASKED OF YOU / DID THEY ASK? with
    Done / Not needed / Yes, keep it / No; a remembered fact; a workout; THIS
    WEEK; RECENTLY.

Tab 2 — OVOA (the voice screen)
  - The orb is the whole control: a 180pt circle with a gradient ring and a halo
    that breathes while listening. Tap to talk, tap to interrupt.
  - Phase label: "Tap to start listening" / "Listening" / "Thinking..." /
    "Speaking", with the hint line under it ("Tap to stop listening", "Tap to
    interrupt", "Always listen is on - tap the orb to turn it off").
  - The transcribed words appear under the orb while it works.
  - A red bar at top left when always-listen is on: "Always listen is on - tap to
    turn off". A "Logs" chip at top right that opens a dev log panel showing
    "listening - mic 62 dB - always listen".
  - Approval cards below the orb: "Needs your approval", the action in plain
    words, Approve / Cancel. Include the contact-disambiguation state ("Which
    contact?" with two matches) and the "Doing it for you..." row.
  - Build at least three of these as states you can switch between, so I can see
    idle, listening and needs-approval without imagining them.

Tab 3 — RECORD (the clip)
  - Connection, with its real phases: "Not connected", "Looking for clips...",
    "Press the clip's button", "Connecting...", "Connected". A Find clips button,
    a found-devices list, battery, Disconnect, and an Inputs link.
  - The record control: one big button. "Connect the clip to record" when there's
    no clip, "Tap to record on the clip" when there is, then Pause / Resume /
    Stop & save while running, and "Paused".
  - Recordings: a list with duration and time, play, rename, "Import from clip",
    and "Adding to your timeline..." on a fresh one.

Tab 4 — JOURNAL
  - Three segments: Notes, Your days, Transcripts.
  - Notes is the agent's outbox: the 7am morning brief, a 6pm commitment sweep
    held until 07:00 by quiet hours, a question it couldn't answer alone, and
    today's list. Mark which ones it spoke and which it kept to itself.
  - Your days: a Day / Week toggle, a date header ("Today", or "Sep 14 - Sep 20"
    for a week), the summary of that day, and the empty states as written in the
    code ("Nothing recorded"; "No timeline yet" with an Open Settings action).
  - A field to add a moment by hand: "What just happened?" and Add.

Tab 5 — SAFETY
  - A large SOS control: "Press and hold to alert your contacts".
  - Call 911.
  - Fall detection with its status lines ("Watching for falls while the app is
    open.", "This device has no motion sensor.", "Allow Motion & Fitness access
    in the Settings app.") and "Test the fall alert".
  - Emergency contacts: a list with Remove, and Name / Phone number fields with
    Add contact.
  - Recent alerts: SOS or Possible fall, "Contacts alerted" or "Marked OK".

Tab 6 — SETTINGS
  Sections, in this order: Account (your name) - Assistant (assistant name,
  personality) - Voice (voice picker with samples) - How to start talking
  (always listen, band double-click) - Background work - Google accounts -
  Siri - Memory (remembered facts, Forget everything, Clear chat history) -
  Password - Your day (Timeline toggle, Transcripts) - Go through setup again -
  Developer (Sensors, inputs & ES100) - Session (Sign out) - Texts.
  Dangerous switches carry their real warning text; write them as the code does,
  plainly, no euphemism.

SUB-SCREENS (reachable from those tabs, with a back arrow)
  - Background work (from Settings): autonomy Suggest / Act, quiet hours, runs
    used of the daily budget, standing jobs with "Run now" and Pause (morning
    brief 7am always speaks; commitment sweep 6pm speaks only if pressing; a
    one-off nudge three hours before a promise), "What you're trying to do" —
    goals with the reason each one exists — and "Everything it has done": every
    run including the quiet ones.
  - Live (from Activity): live heart rate and motion while the screen is open.
  - Ask Claude (from Activity): a plain question-and-answer screen.
  - Transcripts (from Settings or Journal).
  - Sensors, inputs & ES100 (from Settings): the developer panel.
  Plus two full-screen moments, shown as switchable states rather than tabs:
  - An alarm going off: the nag overlay you have to deal with.
  - First run: setup is a spoken conversation, not a form.

WHAT'S WRONG WITH THE CURRENT LOOK (solve these; don't preserve them)
1. Everything is a card. All eleven feed kinds get the same surface fill, the
   same 1px border, the same 16px radius and the same padding, so nothing reads
   as more important than anything else and the screen becomes a pile.
2. Nearly every card carries a 12px uppercase letterspaced label, including ones
   whose content is self-evident.
3. There is no type scale: body 15, dim 13, label 12, and that's it. Nothing is
   allowed to be big, so nothing is the point of the screen.
4. The cyan accent is on chips, the tab bar, the orb ring, the step bar and
   section headings at once, so it no longer means "live" or "act here".
5. theme.ts holds colors and one shadow. No spacing scale, no type scale, no
   elevation roles — so every screen reinvents them in its own StyleSheet and
   "gap: 12" becomes the answer to every layout question.
6. Surface (#11151C) sits almost on top of ground (#07090D), so 1px borders do
   all the separating. That's what gives it its wireframe feel.

KEEP ITS IDENTITY
Near-black ground #07090D. The orb's ring pair, cyan #22E2FF and violet #7E5AFF.
Semantic colors already in the app and already right: #3DDC97 success, #FFC46B
warning, #FF6B6B danger. Commit to dark — this is a single-theme product, so
skip light-mode entirely but paint every color explicitly. Set a real type scale
and a 4px spacing scale, and use tabular numerals wherever digits stack. Decide
one meaning for the accent and hold it on every screen.

RULES
- Real copy, taken from the components you read. No lorem, and don't invent
  features. What exists: voice turns; the background agent; routines and
  medications; todos; notes; remembered facts; alarms; money (user-entered, no
  bank link); Google (Gmail, Calendar, Drive, Docs, Sheets, Tasks); phone tools
  (Reminders, Apple Calendar, Contacts, Health, call, compose a text or email);
  transcripts with day and week rollups; steps; heart rate; fall detection and
  SOS; web search. Nothing is ever captured in the background — recording is
  always something the user started.
- Every tab reachable in one tap, every sub-screen in two, nothing dead. If a
  control does nothing, don't draw it.
- Enough interactivity to judge the design and no more: tab switching, the
  sub-screen back arrow, ticking a todo, confirming a routine, approving an
  action, switching the orb's state, toggling a switch. No backend.
- Holds up at 400px wide. Visible keyboard focus. Honor
  prefers-reduced-motion.
- Typefaces may come from Google Fonts (the only font host an artifact can load)
  with a real fallback stack. Pick faces your direction actually needs; iOS ships
  SF, so a system stack is a legitimate choice and a custom face has to earn the
  load. Whatever you choose, say which faces and weights the app would need to
  bundle through expo-font.
- Finish your reply with the token set you'd add to theme.ts to carry this into
  React Native: type scale, spacing scale, elevation roles, color roles — and
  name the two or three components you'd build first.
```

---

## DIRECTION 1 — One day, one spine

```
YOUR DIRECTION: "ONE DAY, ONE SPINE"

Time is the organizing structure, not card kinds. A vertical spine runs down the
screen and everything — a medication due, an agent run, a note it wrote, a
commitment it found, a workout, the morning brief — is a moment placed on that
spine at its own time, with a clear NOW marker dividing what happened from what's
coming. Cards mostly dissolve: the spine and the time column do the grouping that
borders used to do. Activity and Journal are two views of the same day; Record's
recordings and Safety's alerts are moments on it too.

Make these calls deliberately:
- What a moment looks like in four states: done, due now, upcoming, missed.
- How a moment that needs an answer — approve this text, did they ask you this? —
  earns more weight than one that's only a record, without becoming a card again.
- How the agent's own moments are marked as its work rather than yours.
- What the spine does at the top and bottom of a day, and on an empty day.
- Where the spine goes on screens that aren't a day at all: Settings, Record's
  connection panel, the orb.
```

---

## DIRECTION 2 — Instrument panel

```
YOUR DIRECTION: "INSTRUMENT PANEL"

This is a health-and-time instrument worn on the wrist, and the phone is its
readout. Quiet near-black ground, hairline rules instead of cards, large tabular
numerals, generous space between groups. Every screen should read at a glance
from arm's length: a value, its unit, and how it compares — the comparison doing
the work a sentence used to do.

Make these calls deliberately:
- The numeral treatment: one display face used only for figures and times, and
  how it sits against the body text. Units and deltas stay subordinate, always.
- How a row that can be acted on — a medication due, a commitment to settle —
  announces itself without a button on every line.
- How state is encoded in form as well as color so it survives a glance:
  overdue, live, stale, off.
- What replaces the border: rule weight, indentation, spacing, or a single
  left-edge stripe reserved for exactly one meaning.
- Cyan marks what is live right now and nothing else; everything not live is
  neutral. Say what that costs you and where you had to bend it.
- Sparklines, the seven-day step bars and the heart trace get the same care as
  the type: a faint grid, an emphasized endpoint, and labels naming values the
  chart actually reaches.
- The orb is the one round, soft object in a rectilinear instrument. Decide
  whether that's the point or a problem, and commit.
```

---

## DIRECTION 3 — Soft depth

```
YOUR DIRECTION: "SOFT DEPTH"

Keep surfaces, but make depth mean something. Three elevation levels, not one:
the ground, the things resting on it, and the one thing that wants the user right
now — lifted clear with shadow and a light edge borrowed from the orb's cyan-to-
violet ring. Wider radii, more inner padding, fewer objects per screen. This is
the most consumer-premium of the three directions and the biggest departure from
what exists: spend the boldness on depth and keep the type quiet.

Make these calls deliberately:
- The three elevation levels as tokens: fill, border treatment, shadow, radius.
  A flat list of eight identical cards is the failure mode — decide what earns
  lift, and enforce that only one thing per screen gets the top level. Say what
  that one thing is on each of the six tabs.
- Edge lighting: where the ring's gradient appears and the rule that stops it
  appearing everywhere. One accent moment per screen.
- How grouped rows live inside a surface without each becoming a surface — the
  routines list and the Settings sections are the test.
- The resting state of the orb screen, so the orb is plainly the brand object and
  everything around it is subordinate to it.
- Motion: one page-load or state-change moment, respecting
  prefers-reduced-motion. Not scattered effects.
```

---

## DIRECTION 4 — Voice on the page

```
YOUR DIRECTION: "VOICE ON THE PAGE"

Everything in this app began as somebody speaking. So typeset it as a record of
speech rather than a dashboard of objects. Said things are set as said things —
quoted, attributed, timestamped in a narrow left column — and the app's own
replies are typeset in a second voice that is unmistakably not yours. The page
carries a printed rhythm: a measure you can read, real rules between entries,
hanging indents, no boxes. Think a well-set radio log or interview transcript on
a black ground, not a chat bubble UI.

Pair two faces and make the pairing the design: one for spoken words and one for
the interface's own labels, figures and controls. Bubbles are banned — the
distinction between the two voices is carried by type, indent and color, not by
containers.

Make these calls deliberately:
- How your words and the assistant's words differ typographically, and how a
  third kind of line — the app narrating what it did on its own, unspoken — sits
  apart from both.
- What a screen that has no speech on it looks like in this system: steps, the
  step chart, Safety's contacts, the Settings list. This is where the direction
  is won or lost; if those screens become cards again, the idea has failed.
- The time column: its width, its face, and what happens when an entry runs long.
- Where the accent is allowed on a page that is almost entirely type.
- The orb against a page of type — decide whether it stays a round object, or
  becomes something typographic while speaking.
```

---

## DIRECTION 5 — One thing at a time

```
YOUR DIRECTION: "ONE THING AT A TIME"

This is a wrist device's companion, and a wrist glance holds one thing. So each
screen shows one subject at full size and nothing else: the medication due now,
the reply just spoken, today's step count, the one note the agent wants you to
read. The rest is a swipe or a tap away, never stacked underneath. Big type, a
lot of empty ground, and a single clear action per screen — closer to a boarding
pass or a thermostat than to a feed.

The hard part is that the app really does hold a lot: eleven feed kinds, fourteen
settings sections, a run log. Deciding what is promoted to a screen of its own and
what is demoted to a countable "3 more" is the whole design, and I want to see the
decision, not an escape hatch back into a list.

Make these calls deliberately:
- What Activity shows when four things are due at once. What it shows when
  nothing is.
- The gesture or control that moves between subjects, drawn so a first-time user
  finds it without being told.
- How something urgent overrides the current subject — the alarm overlay, a
  possible fall, a text waiting for approval — and how it hands control back.
- Which screens are allowed to be lists after all (Settings, contacts, the run
  log), and what marks them as a different mode rather than an inconsistency.
- A progress or position indicator, so one-at-a-time never feels like being lost.
- Motion carries this direction more than the others: one transition between
  subjects, deliberate, honoring prefers-reduced-motion.
```

---

## After you've picked one

The winner ports to React Native in this order, smallest risk first:

1. Extend `jarvis/app/src/lib/theme.ts` with the chosen tokens — type scale, 4px
   spacing scale, elevation roles, color roles. It's colors and one shadow today.
2. Add primitives (`Screen`, `Section`, `Row`, `Stat`, `Chip`, `Stripe`) so
   screens compose instead of each carrying its own StyleSheet.
3. Rebuild `Feed.tsx` against the primitives — most kinds, most to gain.
4. Then Journal, then Activity's health and step cards, then the orb screen.
5. Skeletons where components currently `return null` while loading, so screens
   stop popping in.

Notes for whoever does the port: Expo SDK 57 — read
https://docs.expo.dev/versions/v57.0.0/ first, don't write Expo from memory. No
CSS: `StyleSheet`, flex only, no grid. `npx tsc --noEmit` in `jarvis/app` before
you're done. Custom fonts load through `expo-font` and fail silently, so check
them on device rather than in the simulator.
