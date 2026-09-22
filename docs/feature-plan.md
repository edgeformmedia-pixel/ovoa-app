# OVOA feature plan

Spec only — nothing here is built yet. Server = `jarvis/api` (Cloudflare Worker + D1). App = `jarvis/app` (Expo).
Existing pieces reused: `clip.buzz()` (modules/ute-ble), agent cron jobs (`api/src/agent.ts`),
commitments (`api/src/context.ts`), wake-word matching (`api/src/ambient.ts`), HealthKit (`app/src/lib/health.ts`).

> ⚠️ Legal flag: features marked **[AL]** depend on always-listening, which was ruled out on 2026-09-20.
> Build them behind `settings.captureEverything` (dev / own account only) until that decision is revisited.
> The band-button "save last 60 s" (F27) is the shippable alternative.

## Standalone rule — every feature works on its own

Each feature declares what it **needs** (hard) and what **improves** it (optional). If an optional input is missing, the feature degrades instead of breaking. Code pattern: `capabilities(userId) → {band, google, health, watchHr, locationAlways, ambient}`; every feature checks it and picks a path.

| Feature | Needs | Improves it | Without the optional parts |
|---|---|---|---|
| F1 Buzz | band | — | falls back to phone notification |
| F4 Agent commands | app | — | — |
| F5 Onboarding | app | — | — |
| F6 Meds | Apple Reminders/Health **or** Google | band | phone notification instead of buzz |
| F6 Daily routines | app (OVOA timer) | band | phone notification |
| F7 Notes | app | location | time reminders only |
| F8 To-do list | app | Google, Reminders | built from notes, routines, favors |
| F9 Feed | app | everything | shows whatever ran |
| F10 Location | Always location | — | off |
| F11–F12 HR / workouts | Health HR source (watch) | location | off; manual "log workout" by voice |
| F13–F15 [AL] | ambient (test only) | — | F27 button capture instead |
| F18 Morning brief | app | Google, Health, weather | reads routines + todos |
| F22 Oddities | routines | location, HR | asks "did you do X?" at window end |

## Build order

| Phase | Features |
|---|---|
| 0 Foundation | F1 buzz · F2 action log · F3 push command channel |
| 1 Core loop | F4 agent commands · F5 onboarding · F6 routines/meds · F7 notes · F8 to-do list · F9 feed |
| 2 Sensing | F10 location · F11 heart rate · F12 workouts · F13 memory blocks [AL] |
| 3 Social memory | F14 names [AL] · F15 favors [AL] · F16 people memory · F17 object memory |
| 4 Daily rhythm | F18 morning brief · F19 leaving-home · F20 commute · F21 wind-down · F22 oddity detection |
| 5 Extras | F23 inbox triage · F24 follow-ups · F25 bills · F26 health coaching · F27 save-last-60s · F28 weekly report · F29 on-this-day · F30 shared reminders · F31 parking · F32 meeting prep · F33 fall escalation |

---

## Phase 0 — Foundation

### F1. Band buzz from anywhere
**Tables:** none.
**App**
- `buzzPattern(pattern: "ack"|"double"|"reminder"|"meds"|"urgent")` — maps to `clip.buzz(count, option)` sequences; enforces ≥30 s gap (queue, drop duplicates) so the clip doesn't freeze.
- `onPush("buzz")` → `if clip.connected: buzzPattern(p) else showLocalNotification(p)`.
**Server**
- `sendBuzz(userId, pattern, reason)` → `sendPush(userId, {type:"buzz", pattern})` + `logAction("buzz", reason)`.
- Tool `agent_buzz(pattern, reason)` — rate limit 6/hour.
**First task:** test which `option` (1/2/3) the ES100 honours.

### F2. Action log
**Table** `action_log(id, user_id, ts, kind, summary, source, ref_id, minutes_saved)`.
**Server**
- `logAction(userId, kind, summary, source, refId?)` — called from the tool dispatcher after every successful tool call, agent run, reminder fired, buzz.
- `MINUTES_SAVED: Record<kind, number>` (email_draft 3, email_send 2, event 1, reminder 0.5, note 0.5, workout_log 2, favor_caught 2…).
- `getActions(userId, from, to)`, `dailyRollup(userId, date) → {counts, minutesSaved}`.

### F3. Push command channel
**Table** `command_queue(id, user_id, text, source, status, created_at, ran_at)`.
**Server**
- `enqueueCommand(userId, text, source)` → insert + `sendPush({type:"command", id}, silent)`.
- `GET /commands/pending`, `POST /commands/:id/done`.
**App**
- `drainCommandQueue()` — on silent push, on app foreground, on BLE reconnect → for each: `runAssistant(text, {source:"agent"})` → mark done.
- Caveat: iOS may not wake a killed app for silent push; queue guarantees it runs on next open.

---

## Phase 1 — Core loop

### F4. Agent sends itself commands
- Tool `agent_run_command(text, reason)` → `enqueueCommand(user, text, "agent")`.
- Guards: same blocked-tool list as agent (no send/delete), max 10/hour, logged via F2.
- Chat renders these with a 🤖 "Agent" label.

### F5. Onboarding conversation
**Tables** `profile(user_id, name, nicknames[], wake_time, sleep_time, work_hours, emergency_contact, onboarded_at)`, uses `routines` (F6).
**Server**
- `ONBOARDING_STEPS = [name, nicknames, wake/sleep, work, meds, pets, gym, routines, emergency]`.
- `onboardingNext(userId) → question | done`, `onboardingAnswer(userId, step, text)` → LLM extracts structured fields → `saveProfile` / `createRoutine`.
- Tool `profile_update(field, value)` so "update my routine" re-runs a step.
**App:** `app/onboarding.tsx` — voice or chat; shown when `profile.onboarded_at` is null.

### F6. Routines, medications, reminders
**Two sources of truth:**
- **Medications → Apple or Google owns the schedule.** OVOA reads it, mirrors it, and buzzes — it never becomes the only copy.
  - iOS: Apple Health Medications (HealthKit medication read access, iOS 26+ — verify availability) → fallback Apple Reminders list "Medications" (EventKit, already permitted).
  - Google: Google Tasks list "Medications" or a recurring Google Calendar event.
  - `syncMedSchedule(userId)` — on app open + every 6 h: read source → upsert `routines(kind="med", external_source, external_id)`. Edits happen in Apple/Google; OVOA re-syncs.
  - Onboarding (F5) creates the meds **in** the chosen source (Reminders / Tasks), not only in OVOA.
  - Confirm "took it" → write back: complete the Reminder/Task (or log a HealthKit dose event if write access exists).
- **Daily routines (dog walk, water, stretch, custom) → OVOA timer.** Stored only in `routines`, fired by OVOA's own scheduler. No Google or Apple Watch needed.

**Standalone rule:** reminders need only the app + notifications. Band present → buzz; no band → phone notification. No Google, no Apple Watch, no location required.

**Offline firing:** schedule each upcoming occurrence as a **local notification on the phone** (`Notifications.scheduleNotificationAsync`, next 48 h, iOS cap 64 pending) so reminders fire even without network or server push. When the notification fires with the app alive and band connected → `buzzPattern`.

**Tables** `routines(id, user_id, kind[med|pet|habit|custom], title, times[], days[], buzz_pattern, meta_json, active, external_source[apple_health|apple_reminders|google_tasks|google_calendar|null], external_id)`,
`routine_events(id, routine_id, due_at, status[pending|done|missed|snoozed], confirmed_at, via)`.
**Server**
- `createRoutine / updateRoutine / listRoutines` + tools `routine_add`, `routine_list`, `routine_change`.
- Cron (every minute): `fireDueRoutines()` → for due rows: insert event, `sendBuzz(pattern)`, push notification with actions [Done, Snooze].
- `escalate()` — pending 15 min → buzz again; 60 min → speak; still pending at end of window → `missed`.
- `confirmRoutine(eventId, via)` — from notification action, voice ("took it"), or band press within 2 min of buzz.
- `streak(routineId)`.

### F7. Mental notes
**Table** `notes(id, user_id, ts, text, tags[], place_id?, remind_at?)`.
- Tools `note_add(text, tags?, remind_at?, place?)`, `note_search(q)`, `note_list(tag?)`.
- Notes with `place` become geofence triggers (F10); with `remind_at` become one-off routines.

### F8. End-of-day to-do list
**Table** `todos(id, user_id, date, text, source, source_id, priority, done)`.
**Server**
- Cron at `profile.sleep_time - 1h`: `buildTomorrowTodos(userId)`:
  ```
  items = openCommitments + openFavors + missedRoutines + tomorrowEvents
        + carriedOverTodos + importantUnreadEmails + notes(tag:"todo")
  score = dueSoon*3 + fromPerson*2 + ageDays + userPriority
  top 10 → todos; sync to Google Tasks or Reminders
  ```
- Push "Tomorrow's list is ready"; morning brief (F18) reads the top 3.
- Tools `todo_list(date)`, `todo_done(id)`.

### F9. Value feed (home screen)
**Server** `GET /feed?since=` → cards built from `action_log`, `routine_events`, favors, workouts:
- `summaryCard(today)`, `caughtCard(oddity)`, `rememberedCard(favor)`, `streakCard`, `workoutCard`, `weeklyCard`.
**App** `components/Feed.tsx` on the index tab; tap → deep link to source. Label minutes as "~estimated".

---

## Phase 2 — Sensing

### F10. Location timeline
**Config:** add `NSLocationAlwaysAndWhenInUseUsageDescription`, `UIBackgroundModes: location`; needs a dev/production build (not Expo Go).
**Tables** `visits(id, user_id, lat, lng, arrived, left, place_id)`, `places(id, user_id, name, lat, lng, radius, kind)`.
**App**
- `startLocationTracking()` — `Location.startLocationUpdatesAsync` with significant-change accuracy + deferred updates; high accuracy only during workouts/on request.
- Background task `LOCATION_TASK` → batch upload to `POST /locations`.
- `registerGeofences(places)` → `Location.startGeofencingAsync` (iOS limit 20 regions — pick nearest/most used).
**Server**
- `clusterVisits(userId)` nightly — DBSCAN-ish (≤100 m, ≥3 visits) → new `places`; guess kind by time (night = home, weekday 9–5 = work).
- `askPlaceName(placeId)` → agent asks "What's this place on Elm St?"
- Tools `location_timeline(date)`, `place_list`, `place_rename`.

### F11. Heart rate ingest
Requires a device writing HR to Apple Health (Apple Watch etc.) — unless the ES100 has an optical sensor: its firmware claims the factory heart-rate and SpO2 tests (isSupportHeartRateTest), so Dev tools → Clip — heart rate probes it (2026-09-21).
**Table** `hr_samples(user_id, ts, bpm)`.
**App** `enableHrBackgroundDelivery()` (HealthKit observer query, set plugin `background: true`) → `uploadHr(samplesSince(lastTs))`.
**Server** `restingBaseline(userId) = median(bpm, last 7 days, while at home & still)`.

### F12. Workout detection + summaries
**Table** `workouts(id, user_id, start, end, kind, avg_hr, peak_hr, zones_json, place_id, confirmed_kind, summary)`.
**Server** — `detectWorkouts(userId)` runs on each HR upload:
```
w = last 15 min
if !open && median(w) > baseline+25 for ≥10 min → openSession()
kind: intervals of rise→fall every 1–3 min → "strength"
      sustained plateau + moving location     → "run/walk"
      sustained plateau, stationary          → "cardio"
      at place.kind == gym                    → boosts strength
if open && median(last 10 min) < baseline+10 → closeSession()
```
- `closeSession()` → compute zones/duration → `summarizeWorkout()` (LLM) → push + optional speech → `logAction("workout_log")`.
- Ask "Was that legs day?" → `confirmWorkout(id, kind)`; store answers to tune thresholds per user.
- Tools `workout_list(range)`, `workout_summary(id)`.

### F13. Memory blocks — store everything [AL]
**Tables** `raw_captures(id, user_id, ts, text, source, place_id)`, `blocks(id, user_id, level[5m|1h|day|week|month], start, summary, topics[], people[], places[], capture_count)`.
**Server**
- Every capture (ambient, clip, chat) → `storeCapture()` when `captureEverything` is on.
- Cron 5 min: `buildBlock("5m")` from raw → LLM summary + tags.
- Cron hourly/daily/weekly/monthly: `buildBlock(level)` from children blocks (never from raw).
- `searchMemory(q)` — search 5m blocks first, widen to parents; return block + raw lines.
- `purgeOld(days = settings.retentionDays)` nightly.
- Upgrade `context_day/week/search` to read `blocks`.

---

## Phase 3 — Social memory

### F14. Name & nickname detection [AL]
- `profile.nicknames` from F5; `learnNickname()` — when an unknown address term precedes a user reply ≥2 times → ask "Should I answer to 'T'?".
- `mentionsUser(text) → {hit, span}` via fuzzy match (reuse `editDistance` from ambient.ts).
- Hit + request pattern → hand to F15.

### F15. Favors people ask you [AL]
**Uses** commitments table; add `who, due_at, confidence, status`.
- `extractFavor(transcriptWindow) → {who, what, due, confidence}` (LLM, 60 s window around the mention).
- `confidence ≥0.8` → save + feed card; `0.5–0.8` → ask to confirm; else drop.
- `scheduleFavorReminder(favor)` — day before due, or next morning if no due date.
- `closeFavor(id)` on "sent it"/"done" → feed card.

### F16. People memory
**Table** `people(id, user_id, name, aliases[], facts_json, last_seen, birthday)`.
- `upsertPersonFacts(name, facts)` from captures/emails/contacts.
- Tool `person_lookup(name)` → "what do I know about Jake?".

### F17. Where I put things
**Table** `objects(user_id, name, location_text, place_id, ts)`.
- Tool `object_save(name, where)` ("keys in the drawer"), `object_find(name)`.

---

## Phase 4 — Daily rhythm

### F18. Morning brief
- Trigger: first HealthKit wake / first motion after `wake_time - 30m` / first app open.
- `buildMorningBrief()` = weather + first 3 events + meds due + top 3 todos + open favors → speak ≤30 s + buzz ack.

### F19. Leaving-home checklist
- Geofence exit `home` → `sendBuzz("double")` + speak "Keys, wallet, meds?" (list configurable in profile).

### F20. Commute alert
- Next event with location → travel time (Maps API) → at `start - travel - 10m` push "Leave in 10 min".

### F21. Wind-down
- At `sleep_time - 30m`: day recap from `dailyRollup` + tomorrow preview (F8).

### F22. Oddity detection
**Table** `expectations(id, user_id, what, window_start, window_end, days[], evidence_rule, learned)`.
- Seeded from routines; `learnExpectations()` nightly — any event (visit, workout, routine done) occurring ≥80% of days over 14 days in a similar window → new learned expectation.
- `checkExpectations()` every 15 min: window passed & no evidence → `oddity` → ask ("Did you walk the dog yet?") → feed card if confirmed missed.
- Evidence rules: `visit(place)`, `left(home)`, `walk(hr/motion)`, `routine_done(id)`, `transcript_mentions(...)` [AL, supporting only].

---

## Phase 5 — Extras

| # | Feature | Key functions |
|---|---|---|
| F23 | Inbox triage | `triageInbox()` morning → LLM ranks unread → top 3 in brief |
| F24 | Follow-up nudges | `findUnanswered(sentDays=3)` → ask "Nudge Sarah?" → draft |
| F25 | Bills & subscriptions | `scanBills()` Gmail search receipts/invoices → `routine` 2 days before due |
| F26 | Health coaching | `dailyReadiness(sleep, restingHr, workouts)` → one line in brief |
| F27 | Save last 60 s | clip long-press → `captureClip(60s)` → `storeCapture(source:"manual")` — shippable memory without [AL] |
| F28 | Weekly report card | Sunday cron `weeklyReport()` → feed card + push |
| F29 | On this day | `blocksOnThisDay(date - 1y/1m)` → feed card |
| F30 | Shared reminders | tool `remind_other(contact, text, when)` → text via `phone_message_compose` |
| F31 | Parking | driving→stopped transition (location speed) → `object_save("car", coords)` |
| F32 | Meeting prep | 10 min before event with attendees → `person_lookup` each → buzz + 20 s brief |
| F33 | Fall escalation | fall → buzz → 30 s speak "Are you OK?" → no answer → text emergency contact + location |

### F34. Smart account routing (work vs personal)
**Today:** accounts can be tagged (`google_tag_account`), there's a default, and the model is told to use the default "unless the conversation makes another account the obvious one" (`api/src/google/assistant.ts:258`). So it only switches on explicit wording.

**Goal:** the AI picks the right account by itself, like a human assistant would.

**Table** `account_profiles(account_id, label, email_domain, work_hours, known_contacts_domains[], topics[], calendar_names[], learned_at)`.

**Learning (`learnAccountProfile(accountId)` — on connect + weekly):**
- Email domain (`@company.com` → work; `@gmail.com` → personal).
- Top correspondent domains + names from the last 200 sent emails.
- Recurring calendar event titles → topics (standup, client, sprint → work; gym, dinner, dentist → personal).
- Busy hours from calendar → the account's "work hours".
- Onboarding (F5) asks once: "Which account is work?" → tags it.

**Routing (`pickAccount(request) → {account, confidence, why}`):**
```
score each account:
  +5 named explicitly ("work email", "my school calendar")
  +4 recipient/attendee email domain matches account's contacts or domain
  +3 person is in that account's contacts / past threads
  +2 topic matches account topics (meeting with client → work)
  +1 time falls inside the account's work hours
  +1 place is the "work" place (F10)
  -2 personal words (mom, doctor, gym, birthday) for a work account
pick highest; confidence = gap to second place
confidence high  → just do it, say which: "Added to your work calendar."
confidence low   → default account, but mention it: "Put it on personal — want work instead?"
  and for sending email / inviting people → ask first
```
**Feedback:** "no, put it on work" → `recordCorrection(request features, correct account)` → added to that account's profile so it doesn't happen twice.

**Also applies to non-Google:** meds/routines (F6) and todos (F8) get a `context: work|personal` so work to-dos go to the work Google Tasks and personal ones to Reminders.

**Tools:** reuse existing `account` argument; the dispatcher calls `pickAccount` when the model omits it instead of falling back blindly to the default.

## New agent tools (summary)
`agent_buzz`, `agent_run_command`, `routine_add/list/change`, `note_add/search/list`, `todo_list/done`,
`location_timeline`, `place_list/rename`, `workout_list/summary`, `person_lookup`, `object_save/find`,
`remind_other`, `profile_update`, `search_memory`.
