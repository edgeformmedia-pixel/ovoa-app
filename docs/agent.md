# The agent: OVOA with nobody in the room

Everything the assistant did before this ran because somebody spoke. A turn
existed because of a message, and when the reply was written the assistant
stopped existing until the next one. That is a very good search box. What
people mean by "Jarvis" is the other thing — something that notices the
meeting moved, that you said you'd call your mother on Sunday and it's now
Sunday evening, that the flight you asked about last week is delayed.

That requires running when nobody asked, which is a different problem from
answering well, and a much easier one to get wrong. The failure mode isn't a
wrong answer, it's a thing on your phone that interrupts you forty times a day
until you turn it off — and then it's worth nothing at all, including the
times it was right.

So the design is mostly about restraint.

## The shape of it

```
cron (*/2)  ──▶  tick()  ──┬─▶ runDueJobs()  ─▶ autonomousTurn()  ─▶ agent_notes
                           │                          │
                           │                          └─▶ pending_actions (proposals)
                           └─▶ drainNotes()  ─▶ Expo push  ─▶  the phone
cron (4:13) ──▶  purgeExpired() ─▶ the 14-day purge (retention.ts, docs/retention.md)
```

- `agent_jobs` — standing work with a due time.
- `agent_goals` — standing intent with no due time, read into every run.
- `agent_runs` — every run, including the quiet ones. The audit log.
- `agent_notes` — the outbox. Written first, pushed second.
- `agent_budget` — autonomous runs per user per UTC day.

Files: [`api/src/agent.ts`](../jarvis/api/src/agent.ts),
[`api/src/push.ts`](../jarvis/api/src/push.ts),
[`api/migrations/0011_agent.sql`](../jarvis/api/migrations/0011_agent.sql).

## Three rules that aren't in the prompt

**Speaking is a tool call.** The autonomous turn's final text is discarded. If
it wants to reach you it calls `agent_say`; if it has nothing, it calls
`agent_stay_quiet`. Silence is therefore the default and interrupting is the
deliberate act, rather than the other way round. A job set to `notify: always`
— a briefing you asked for every morning — is the one exception, and falls
back to the turn's text if the model wrote its answer instead of calling the
tool.

**It cannot talk to anyone but you.** `gmail_send`, `gmail_trash`,
`drive_trash` and `calendar_delete_event` are removed from the autonomous tool
list, not discouraged in the prompt. A prompt is a request; a missing tool is a
fact. If something needs sending, it proposes it and you send it.

**Every run costs budget and is written down.** `agent_daily_runs` (40 by
default) is a ceiling on autonomous runs per day, claimed before the run
starts. Turns you asked for are never refused for budget. Every run lands in
`agent_runs` whether it spoke or not, with the tools it touched — which is the
honest answer to "what has this thing been doing while I wasn't looking".

## Autonomy

Off until asked for, per user, like the timeline.

- **suggest** (default) — it reads, thinks, and tells you. Anything that would
  change something is parked in `pending_actions` as a card for you to approve.
- **act** — it may also create calendar events, tasks and drafts on its own
  when they clearly follow from what you asked it to do.

At both levels the outbound-communication and deletion tools are absent. "Act"
widens what it may set up, never what it may do behind your back.

## Quiet hours

`quiet_start`/`quiet_end`, minutes past local midnight, defaulting to 22:00 to
07:00 and wrapping midnight. Notes are still *written* during quiet hours;
they just wait to be pushed. `urgency: "high"` comes through anyway, and the
agent is told to keep that for something about to be missed tonight rather
than for anything it finds interesting. `urgency: "low"` never pushes at all
and waits in the app.

## Jobs

`once`, `daily`, `weekly`, `interval` (floored at 15 minutes, so a job cannot
become a busy loop). Scheduling is anchored to the user's own day, so "every
morning at seven" means seven in their kitchen on the day the clocks change as
much as on any other — see [`api/src/time.ts`](../jarvis/api/src/time.ts) and
its tests.

A job is claimed — rescheduled — *before* it runs, so a slow run can't be
picked up twice by overlapping ticks. Three consecutive failures pause a
recurring job rather than retrying it forever. A one-off that fails stays done:
the moment it existed for has passed, and a nudge about last Thursday turning
up next Thursday is worse than no nudge.

Two jobs are seeded when you turn the agent on, as ordinary visible jobs rather
than behaviour baked into the scheduler: a **morning brief** (7am, always
speaks) and a **commitment sweep** (6pm, speaks only if something's pressing).

## Promises that chase themselves

This is the part that feels like the thing people actually want.

The timeline already pulls out what you said you'd do, in your own words, while
the words are still around. Now the due date is resolved to a moment at the
same time — while the surrounding conversation is still there to say *which*
Thursday — and a dated promise schedules a one-off job that wakes up three
hours before it.

The job doesn't decide to interrupt. It's an ordinary autonomous turn, told to
check whether the thing already happened and say nothing if it did.

Undated promises get no job. "When I get a chance" has no moment to attach a
reminder to, and inventing one turns an intention into a false alarm. Those
stay with the daily sweep.

Settling a commitment cancels its nudge.

## Prompt injection

Everything the agent reads — email, web pages, calendar invites, documents —
is data. The autonomous prompt says so explicitly, and says that text telling
it to do something is a thing to be suspicious of and, if it matters, to
mention. The structural protection is the same one as above: the tools that
could act on such an instruction in a way that reaches another person are not
in the list.

## What it can't do

- **React to events.** It reacts to the clock. An interval job is the closest
  thing to a watch, and it polls. There's no webhook from Gmail or Calendar.
- **Ask you something and wait.** There's nobody there. It can send a note of
  kind `question` and stop.
- **Use the phone.** Phone lookups pause a turn until the app answers, and the
  app isn't there, so no phone tools are offered to an autonomous run.

## Setup

Three things beyond the code:

1. `npx wrangler d1 migrations apply jarvis-db --remote` — 0011 and 0012.
2. `npx wrangler deploy` — the cron triggers in `wrangler.jsonc` come with it.
3. `eas init` in `jarvis/app`, for the Expo project id push tokens need. Until
   that exists, notes are written and shown in the app but never pushed, and
   Settings says so.

Remote push doesn't work in Expo Go on recent SDKs. It needs the built app.

## Testing it without waiting for the clock

`wrangler dev --local` runs the whole API offline against real D1.

```bash
npx wrangler dev --local --port 8787 --var DEBUG_KEY:localtest
npm run smoke        # in jarvis/api
```

`test/smoke.sh` covers what only a running worker shows: migrations applying,
defaults being off, seeding landing in the right timezone, and one account not
being able to see another's. With `DEBUG_KEY` set,
`POST /debug/agent/due?id=<job>` brings a job forward,
`POST /debug/agent/tick` runs one piece of a cron tick by hand, and
`POST /debug/agent/tick?what=cron` runs the whole beat exactly as the cron does,
leaving its row in `cron_ticks`.

A local worker has no model key, so an autonomous run there always fails —
which the smoke test uses on purpose, to check what the scheduler does when a
run can't complete.

## Reading what happened, without D1 credentials

```bash
curl -H "x-debug-key: $DEBUG_KEY" \
  "https://api.ovoa.ai/debug/logs?since=2h&kind=err"
```

One answer covering both halves: what the phone uploaded (`device_logs`) and
what the server wrote down (`error_events`, `engine_stats`, `cron_ticks`, see
`migrations/0030_observability.sql`). `since` takes `30m` / `6h` / `2d` or an
epoch; `kind`, `text` and `limit` narrow it; `detail=1` asks for stack traces
and detail lines.

`health.lastTickMs` is the one number worth checking first — the two-minute
cron should never be more than a couple of minutes stale, and nothing else in
the system says whether it is still beating.

Anything the app quoted (`heard: "…"`), anything token-shaped and whole email
addresses are masked, and `detail` comes back only for the kinds on the
allowlist in `src/obs.ts` — every kind that has ever carried a sentence is
withheld. `text`, though, is whatever the app interpolated into it: the obvious
offenders were moved off it, but the real boundary is the key, not the
scrubber. Treat the key as giving away the log. Without `DEBUG_KEY` set the
route 404s, which is how production stays shut.
