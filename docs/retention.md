# Retention: what OVOA keeps, and for how long

The v1 release (2026-09-23, `docs/release-v1-prompt.md` Phase 6, decision 2 in the release pass). This is the
table in words. The code that enforces it is `jarvis/api/src/retention.ts` (`RULES` and `TABLES`), and
`jarvis/api/test/retention.test.ts` fails when a table in `migrations/` isn't classified here.

## The rule

After **14 days** everything is deleted except:

1. **The day summary.** One per day, for every Base user who did something with OVOA that day (talked to it,
   recorded something, or had food noted): a short title and two or three sentences, with the day's food on
   the end when any was noted.
2. **What the person entered or set up themselves.** When a table holds both kinds, the rows are told apart by
   a source column or by how the row gets made (a user action vs the AI or something automatic).

Three exceptions to the 14 days:

- **Counts, 35 days:** `usage_daily` (a month's cap reads from the 1st) and `daily_marks` (the month-cap
  warning and pay-cycle warnings must outlive their period, or they fire twice).
- **The phone's log, 7 days:** `device_logs`, as before.
- **Finished one-off agent jobs, 7 days** after they ran, as before.

## When it runs

Once a night, in the `13 4 * * *` cron (`index.ts runTick`), as three parts, each caught on its own:

1. `nightly` — learn places, expectations and what each Google account is for. No deletes any more.
2. `summaries` — `daysummary.ts writeDaySummaries`: for every local day from 14 days ago to yesterday that
   had activity and has no summary yet, oldest first, within a 6-minute budget. One short model call per
   person-day, through the plan and consent (`blockedFor`, then the model-call gate): free users and anyone
   who hasn't agreed to AI get none, silently. A day with only food needs no model ("Food noted" plus the food
   line). A day that couldn't be written (engines down, allowance used) is tried again the next night.
3. `retention` — `retention.ts purgeExpired`: every rule, in order, in chunks of 500 rows
   (`DELETE ... WHERE rowid IN (SELECT rowid ... LIMIT 500)`) until a chunk comes back short, within a
   6-minute budget. A failing rule is written to `error_events` and the rest still run.

By hand, with the debug key: `POST /debug/agent/tick?what=summaries`, `?what=retention` (`maintenance` still
works as an alias), `?what=nightly` for the learning part.

**The day summary's one store** is the `transcript_titles` row with `grain = 'day'` for that date, marked with
`summarised_at` (migration 0042). It was already the transcript's day title and already outlived the words
("On this day" reads it). The transcript titler never overwrites a summarised day. `context_rollups`' day row
(the timeline's cached title) is deleted when the summary is written, and the cache goes at 14 days anyway.
`context_day`, `context_week`, `transcript_day` and "On this day" read the summary once a day's details are
gone; `context_day` uses it as the day's title (no model call) whenever it exists.

**The food line** is `food.ts foodDayLine`, added to the summary by code, not by the model: "Ate 1,850 kcal
and 90 g protein: burrito, coffee." for someone who set up tracking (a level in `profile.food_detail`), and
"Ate: burrito, coffee." with no number for someone who didn't, the same rule as in conversation.

**The full-text index** (`context_search`) follows `context_blocks` on its own: the `context_blocks_ad`
trigger in `migrations/0010_context.sql` gives FTS5 its `'delete'` command with the old values for every row
the purge removes. The test checks `integrity-check` after a purge.

**Order matters** in four places: promises before the blocks they hang off (a block with a promise still
being kept stays, and a block's delete would cascade its promises); orphaned nudge jobs after the promises;
routine streaks folded into the routine row before its events go; visits before the unnamed places nobody
visits any more.

## The table

Times are epoch ms unless noted. "14 d" means deleted 14 days after the column named.

| Table | Treatment | How it's split, and the clock | Exceptions |
|---|---|---|---|
| users | keep | the account | |
| sessions | expires | deleted once past `expires_at` | |
| settings | keep | `context_retain_days` is ignored now (see below) | |
| profile | keep | set up by the user; includes the food target and tracking level | the AI-led setup's own columns (migration 0047), below |
| profile.setup_state | delete | the setup conversation's state (`setup/state.ts`): what each objective holds, the last lines said. The lines are cleared when setup finishes; the whole value goes 14 d after its own `updatedAt` (`sweepStaleSetup`, a step of its own), since someone who starts and never comes back would otherwise keep an emergency number and medication names there | what setup stored (profile fields, routines, contacts, memories, apps) is in their own rows and stays |
| profile.setup_rev | keep | a counter the setup's saves compare and swap on; the sweep moves it on, so a turn still in flight can't write the old state back | |
| profile.setup_apps | delete | the apps being made for their goals (status and app id, no conversation); cleared with `setup_state` by the sweep, and on restart | the apps themselves are `user_apps` rows and stay |
| emergency_contacts | keep | entered by the user | |
| push_tokens | keep | the phone's registration | dropped by push.ts when Expo says the app is gone |
| device_state | keep | one row per user, overwritten | |
| google_accounts | keep | the connection | |
| oauth_states | expires | deleted once past `expires_at` | |
| verify_links | expires | the confirmation email's one-tap links: deleted once past `expires_at` (a day), used or not | |
| account_profiles | delete | what each Google account is for, learned from mail: 14 d after `learned_at` (relearned nightly for Base users while connected), or at once when its account is disconnected | |
| messages | delete | 14 d after `created_at` | |
| memories | mixed | `source`: `asked` (they told OVOA to remember it) kept; `learned` (the background memory pass) 14 d after `created_at` | existing rows are `learned` |
| context_blocks | mixed | kept: blocks the user made through `POST /context/blocks` (a recording, a note on the Day screen). Deleted 14 d after `started_at`: blocks the transcript titler filed (`category = 'transcript'`) and signal blocks (`source` calendar / location / health, none written today) | pinned blocks, and a block a kept promise hangs off, stay |
| context_commitments | mixed | the AI's catch. Deleted 14 d after `settled_at` (done / dropped), 14 d after `due_at` (open, dated), or 14 d after `created_at` (open, undated) | an open promise still to come is never deleted |
| context_rollups | delete | cached hour / day / week titles, 14 d after `updated_at` | the day summary lives in transcript_titles |
| context_search | index | FTS over context_blocks, kept in step by triggers | |
| raw_captures | mixed | `source`: `recording` (a recording made on purpose) kept; `mic`, `assistant`, `background` 14 d after `ts` | |
| transcript_titles | mixed | `grain = 'day'` kept (the day's title, and the day summary once `summarised_at` is set); `5m` and `hour` 14 d after `start` | |
| people | mixed | `facts` JSON by `from`: `said` (person_remember) kept, `heard` (from a transcript) 14 d after its `at`. A person with nothing said, no relation, birthday or aliases, not mentioned for 14 days (`last_seen`), goes | |
| objects | mixed | `lat IS NULL` (object_save: what they said) kept; automatic parking (`lat` set) 14 d after `ts` | |
| name_candidates | delete | 14 d after `last_heard_at` (new, set on each hearing) | rows without it start their clock the first night |
| agent_jobs | mixed | kept: `user` and `system` jobs, and `agent` jobs still to run. Deleted: `about` nudges whose promise is gone; any job 7 days after it finished (`status = 'done'`, `next_run_at`) | |
| agent_goals | keep | set up by the user | |
| agent_runs | delete | 14 d after `started_at` | |
| agent_notes | delete | 14 d after `created_at` | |
| agent_budget | delete | `day` (UTC date) older than 14 days | |
| pending_actions | delete | 14 d after `created_at` | they expire after 24 h when read anyway |
| paused_turns | delete | 14 d after `created_at` | 10 min in practice |
| command_queue | delete | 14 d after `created_at` | |
| action_log | delete | 14 d after `ts` (was a year) | |
| routines | keep | set up by the user (meds `kind = 'med'`). Carries the running streak (`streak`, `streak_day`) | |
| routine_events | delete | 14 d after `due_at`, after `routines.ts settleStreak` has folded them into the routine's streak | |
| alarms | keep | set up by the user | |
| notes | mixed | the user's notes (typed, on_device) kept. Bill reminders found in mail (extras.ts, `source = 'mail'`; older ones by extras' exact wording "Pay … — due YYYY-MM-DD") 14 d after `ts`, once their reminder has had its day | |
| todos | mixed | `source = 'user'` kept; built rows (`commitment`, `note`, `routine`, `carried`) 14 d after `created_at` | |
| daily_marks | delete | **35 d** after `at` | |
| location_points | delete | 14 d after `ts` | |
| visits | delete | 14 d after `left_at` | |
| place_events | delete | 14 d after `ts` | |
| places | mixed | kept: every place with a name (theirs, or Home / Work named when learned). Deleted: unnamed `kind = 'other'` places created 14+ days ago with no visit in 14 days, and no open note waiting at them. Cascades: place_events and expectations go with it; visits and workouts keep their row (`place_id` NULL) | |
| expectations | delete | 14 d after `updated_at` (relearned nightly for active users) | |
| commute_checks | delete | 14 d after `checked_at` | |
| hr_samples | delete | 14 d after `ts` (was 30) | |
| step_days | delete | `day` (local date) older than 14 days | |
| health_days | delete | `day` (local date) older than 14 days: Apple Health's sleep, resting heart rate, HRV, active energy, exercise, stand, blood oxygen, breathing and weight, kept only for accounts that agreed to AI | |
| workouts | mixed | `source = 'manual'` (logged by voice) kept; `detected` (found in heart rate) and `health` (recorded by a watch, from Apple Health) 14 d after `start_at` | |
| safety_events | delete | 14 d after `created_at` | |
| shortcuts | delete | written by the AI (signing is off): 14 d after `created_at` | |
| money_settings, money_accounts, money_income, money_paychecks, money_spend, money_plans | keep | the money picture the user gave | |
| money_bills | mixed | `source = 'user'` kept; `mail` (found in Gmail) 14 d past the last due date its mail gave (`found_due`, migration 0043; `next_due` for older rows) | |
| user_apps | keep | made apps and their screens (`blocks`, `state`) | |
| food_log | delete | 14 d after `ts` | the day's food lives on in the day summary |
| food_catalog | delete | 14 d after `used_at` | |
| usage_daily | delete | **35 d** (`day`, UTC date). Counts, no content. `/debug/usage` now reads at most 35 days | |
| device_logs | delete | **7 d** after `received_at`, as before | |
| error_events | delete | 14 d after `last_seen` (was 30) | |
| engine_stats | delete | 14 d after `last_at` | |
| cron_ticks | delete | 14 d after `last_at` | |
| cron_lock | keep | leases | |
| server_settings | keep | the switchboard | |
| email_codes, signup_tickets | expires | `emailauth.ts pruneEmailAuth`, once past their own expiry | |
| signin_states, signin_codes | expires | `signin.ts pruneSignin`, once past their own expiry | |
| text_links | keep | the number someone texts OVOA from (`texting.ts`), linked by them; gone when they unlink it or delete the account | |
| text_link_codes | expires | the code that links a number, once past `expires_at` (15 min); a used one is deleted when it's used | |
| text_inbox | delete | **2 d** after `received_at`: every text that came in, kept only to tell a second delivery of the same one. The words are cleared once it's answered (they're in `messages`), and a text from a number nobody linked never keeps any | |
| text_outbox | delete | 14 d after `sent_at`: which texts OVOA sent first (`reach.ts`), their kind and whether Sendblue took them, for the day's cap. No words: those are in `messages` | |
| sites | mixed | the websites someone had OVOA build (`sites.ts`): kept. One they deleted goes **30 d** after `deleted_at` (it can be put back until then); one whose first build never worked (`status = 'failed'`, no page) 14 d after `updated_at`. Its builds and messages go with it | |
| site_builds | delete | 14 d after `created_at`: each build or change asked for, and how it went | |
| site_leads | delete | 14 d after `created_at`: what visitors sent through a website's contact form. Each was texted (or pushed) and emailed to the site's owner as it arrived | the owner's email copy is theirs |
| usernames_history | expires | 90 d after `released_at`: a username someone moved away from, held for them and redirecting until then (`usernames.ts`) | |
| connections | keep | who agreed to let their OVOAs talk (`network.ts`), until they disconnect or delete the account | |
| connection_perms | keep | what each owner lets their OVOA do for one connection | |
| ovoa_threads | delete | 14 d after `updated_at`: one exchange between two OVOAs; its messages and approvals go with it | |
| ovoa_messages | delete | 14 d after `created_at`: what one OVOA said to another, which is also the log (`ovoa_log`) | |
| ovoa_approvals | delete | 14 d after `created_at`: what waited for an owner's yes | |

## What changed from before

- One purge replaces the old trims: `agent.ts maintenance()` (context blocks by the user's setting, agent
  runs 90 d, notes 30 / 120 d, budget, done jobs), `index.ts nightly()`'s batch (device logs, heart rate 30 d,
  raw captures, transcript titles, action log a year, command queue 30 d, daily marks 30 d, usage 90 d, error
  events 30 d, engine stats, cron ticks, email codes), and `locationNightly`'s deletes.
- **The "Forget summaries after" picker is gone** from Settings. The server ignores `contextRetainDays`
  (still accepted from older builds, and `/me` reports 14) and `settings.context_retain_days`.
- Migration **0042_retention.sql**: `memories.source`, `name_candidates.last_heard_at`, `routines.streak` and
  `streak_day`, `context_commitments.settled_at`, `transcript_titles.summarised_at`, and time-first indexes on
  messages, context_blocks, action_log, hr_samples, location_points and visits. No UPDATE backfills, so the
  copied data (scripts/move-db.mjs) needs nothing run after it.
- Migration **0043_mail_bills.sql**: `money_bills.found_due`, the due date the mail last gave, so a bill found in
  mail is kept while it's current. No backfill either.
- "Forget that" on a timeline moment now also deletes that recording's words, and "Forget the last hour"
  deletes the words said since then, since a recording's words are now kept until deleted. Both also delete what
  was written from those words: the 5-minute and hour titles, the timeline's cached titles, and the day's title
  and summary, which the nightly writer writes again from what's left (or, for a day past 14 days, written again
  at once from its kept blocks, and left cleared if that can't be done). Deleting a recording in the Record tab
  does "Forget that" on it first. A long recording's words are kept whole, as several lines.
- **A memory is `asked`** only when the model marks it so and the message really was an instruction to
  remember (`remember.ts askedToRemember`: "remember that…", "don't forget…", "keep in mind…", "can you
  remember that…"; not "do you remember…?" or "I can't remember…"), or when it replaces or merges an asked
  memory.

## Genuinely unclear rows (defaulted to delete)

- Workouts detected from heart rate, and those a watch recorded (manual ones are kept).
- Fall and SOS events (`safety_events`).
- Bills and bill reminders found in mail (`money_bills` source `mail`, and their notes). A mail bill stays
  while its mail is current (14 days past the last due date the mail gave); found again next month, it is
  kept going.
- Shortcuts the assistant wrote.
- What each Google account is for (`account_profiles`); relearned nightly for Base users while connected.
- Follow-up jobs the agent scheduled for itself (`agent_jobs` source `agent` without `about`): kept until they
  run, then gone a week later like every finished one-off.

## The first run after the move

The copied data starts on 2026-09-17, so the first purges on the new account remove almost nothing before
about **2026-10-01** (14 days on). Counts (`usage_daily`, `daily_marks`) start going about 2026-10-22. Every
copied day from the last 14 gets its summary written on the first nights (oldest first) before its details
go, for Base users who have agreed to AI.
