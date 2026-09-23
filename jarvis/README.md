# OVOA app

An iPhone app with accounts, an AI assistant with memory, step tracking, and
fall and SOS safety alerts.

```
jarvis/
  api/        Cloudflare Worker (Hono) + D1 database "jarvis-db"
  app/        Expo (SDK 57) app with expo-router
  forwarder/  the old workers.dev address, handed on to api.ovoa.ai until 2026-10-14
```

The folder, Worker (`jarvis-api`), and database (`jarvis-db`) keep their
original names so the live deployment keeps working. Nothing the user sees says
"Jarvis".

Live API: https://api.ovoa.ai, on the ovoa.ai Cloudflare account
(`e58b0ec5305410f9d3cd70f461f39cb6`) since the v1 move. Builds from before the
move call `https://jarvis-api.edgeformmedia.workers.dev`, which is now a
forwarder ([`forwarder/`](forwarder/)) on the old edgeformmedia account. That
account keeps only the forwarder and the old D1 as a backup, until 2026-10-14.

## App tabs

- **Activity**: today's steps, a goal progress bar, distance and calorie
  estimates, a goal streak, a 7-day chart, and a daily goal picker. Steps come
  from the iPhone's motion chip (`expo-sensors` Pedometer). iOS keeps 7 days of
  history, and the app syncs those days to the `step_days` table.
  Below the steps it shows Apple Health: the latest heart rate with the last
  12 hours as a graph, resting heart rate, today's range, sleep, active
  energy, exercise minutes, HRV, stand hours, and today's workouts
  (`app/src/components/HealthCards.tsx`, reading `app/src/lib/health.ts`).
  Health needs a development build; in Expo Go the card says so, and the tab
  still works with steps alone. Each card hides itself when Health has nothing
  for it, so a phone with no watch isn't a wall of dashes.
- **Assistant**: a voice-only assistant with memory (see [Voice](#voice)). The assistant also sees the last 7 days of
  steps and the daily goal, and can use the iPhone's Contacts, Calendar,
  Reminders, Messages, Mail, and Phone (see [iPhone apps](#iphone-apps)).
- **Safety**:
  - **SOS:** press and hold for 1.5 s. The phone opens a text to your
    emergency contacts with your location. iOS always requires tapping Send.
  - **Fall detection:** watches the accelerometer for free fall, then an
    impact, then lying still. It shows a 30-second "Did you fall?" countdown,
    then opens the same text. There's a button to test the alert.
  - **Call 911**, up to 5 emergency contacts, and a list of recent alerts.
- **Journal**: two views of the same question, from two directions.
  **From OVOA** is what the agent went and found out while you weren't
  looking; **Your days** is what your days were made of, by day or by week.
  See [Background work](#background-work) and [Timeline](#timeline).
- **Settings**: name, assistant name and personality, Google, Siri, memory
  controls, background work, timeline, password, and sign out. **Danger zone**
  has **Approve for me** and delete account.

### Approve for me

Off by default. When on (`settings.auto_approve`), the assistant skips
approval cards:

- Google actions that normally wait (send email, trash, delete, invite guests)
  run right away on the server.
- Phone actions are still saved to `pending_actions`, marked `auto: true`. The
  app runs them one at a time as soon as it gets them, including ones Siri
  created, and shows a card only when it needs a choice: several contacts
  match, or a name has no number or email.
- iOS still requires tapping Send for texts and emails, and Call for calls.
- Turning it on asks for confirmation first.

### Limits of Expo Go

- **Apple Health** (heart rate, sleep, workouts) needs a development build.
  See [Development build](#development-build). In Expo Go the assistant says
  so instead of answering.
- **Fall detection only runs while the app is open on screen.** iOS doesn't
  let third-party apps keep reading motion sensors in the background, even in a
  development build. Workarounds like keeping location running drain the
  battery and get rejected in App Store review. For fall detection while the
  phone is locked, use an Apple Watch: its built-in Fall Detection calls
  emergency services on its own.
- **Texts always need a tap on Send.** iOS never lets an app send a text
  silently. Sending automatically would mean texting from the server (e.g.
  Twilio), which this app doesn't do.

Fall detection is not a medical device.

## Voice

The Assistant tab is voice only: no message list, no text box. Tap the orb
to turn listening on. It stays on, and comes back on when you return to the
tab or reopen the app, until you tap the orb again.

1. **Hearing you, on the phone** (`app/src/lib/liveListen.ts`): the iPhone
   recognises speech itself. The phone's ear (`app/modules/name-ear`, Apple's
   on-device recognition) hears you; `earWords.ts` turns its growing text into
   sentences, and the turn gate (`turnGate.ts`) decides when you've finished
   (a pause of about 0.7 s, or a question mark). Only the words leave the
   phone, never the sound. On an iPhone that can't recognise on its own, a
   turn you start uses Apple's recogniser instead (it may use Apple's servers);
   listening for the name and Always listen then don't run at all. Recordings
   (the band's button, the Record tab) are turned into words on the phone too
   (`onDeviceTranscribe.ts`). Nothing is transcribed on the server:
   `POST /voice/transcribe` and `POST /voice/token` answer 410 for old builds.
2. The text goes to `/chat` with `voice: true`, which asks the model for
   short, spoken-style replies. Conversations are still saved for memory and
   context.
3. The reply is read aloud through `POST /voice/speak` (Deepgram Aura 2), or
   voiced in the `/chat` stream itself, a sentence or two at a time so it
   starts quickly. Then it listens again. Deepgram is only OVOA's voice.

How long a turn takes, and which leg of it is slow, is measured per turn in
`app/src/lib/turnTimer.ts` and shown in **Dev tools → Turn timings**; the
numbers and what to do about them are in
[docs/voice-latency.md](../docs/voice-latency.md).

Tap the orb while it's talking to cut it off. Approval cards (texts, emails,
calls) still appear under the orb. Listening pauses when you leave the tab or
the app goes to the background. Pick the voice in **Settings → Voice** (saved
on the phone).

Without the wake word, everything it hears while the orb is on goes to the
assistant, including TV and other people talking. With it, only what follows
"OVOA" (or a click on the band) does; the rest never leaves the phone.

Expo Go and the web have neither recogniser, so there talking is typing.
Listening lives in `AssistantProvider` (`app/src/lib/assistant.tsx`), above
the tabs; the Assistant tab only draws it.

### Always listen (Danger zone)

Off by default, saved on the phone, and it asks for confirmation. When on:

- The microphone stays on, on **every** screen and with the app in the
  background, on the phone's own ear: nothing leaves the phone until it hears
  its name. It only runs on an iPhone that recognises speech on its own.
- **Talk over a reply to interrupt it.** The phone's ear also hears the
  reply. What it hears while a reply plays only counts as the user talking if
  at least 3 words (70% of what was heard) aren't in the reply, or if it's
  just "stop" / "okay stop" / "hold on". It then stops the reply and catches
  the rest of the sentence. A bare "stop" or "hold on" just silences it.
  Expect about 1–2 s before it reacts.
- If a reply creates an approval card while you're on another tab, the app
  switches to the Assistant tab to show it.

The Deepgram key lives only on the Worker (`DEEPGRAM_API_KEY` secret). It is
used for OVOA's voice only (text to speech). Without it, `/voice/speak` returns
503.

## Google connection

Right after sign-up, users see **Connect your Google account**, with a
**Skip for now** option. They can also connect later in **Settings → Google
accounts**.

- **More than one account:** a user can connect several (work, personal, …).
  Each has an optional **tag** they type in Settings — or that the assistant
  sets from a chat ("my other one is for school") with `google_tag_account`.
  One account is the **default**, used when a request doesn't say which.
  Every Google tool then takes an optional `account` (tag or email), so
  "what's on my work calendar" hits the right one; for questions that name no
  account, the assistant checks each and says where each result came from.
- **How it connects:** OAuth web client `736336639952-…` in Google Cloud
  project `ovoaappios`, with redirect URI
  `https://api.ovoa.ai/google/callback` (`PUBLIC_URL`). The app
  opens `POST /google/connect`'s URL in an auth session. The Worker swaps the
  code for tokens (with PKCE) and sends the browser back to `exp://…` (Expo
  Go) or `ovoa://…` (installed app).
- **Token storage:** refresh and access tokens are AES-GCM encrypted in
  `google_accounts` (one row per connected account, unique per user + email)
  using the `TOKEN_ENC_KEY` secret. Google drops testing-mode grants after
  7 days; when that happens, the Worker deletes that row, promotes another
  account to default, and the app shows **Connect** again.
- **Scopes:** openid/email/profile, `spreadsheets`, `calendar`,
  `gmail.modify`, `drive.file`, `documents`, `tasks`, `contacts`. Drive is
  `drive.file`: only files OVOA created, never the rest of someone's Drive.
  Gmail is a restricted scope: a public launch needs Google verification plus
  a yearly CASA security assessment.
- **Assistant tools** (`api/src/google/tools.ts`): calendar list, create,
  update and delete; Gmail search, read, draft, send, mark read and trash;
  Drive search and trash (OVOA's own files only); Sheets info, read, append,
  update and create; Docs read, create and append; Tasks list, add and
  complete; Contacts search. GLM and Gemini both call tools through
  `chatWithTools` in `llm.ts`.
- **Approvals:** tools with a `confirm` step (send email, trash, delete,
  invite guests) aren't run right away. They're saved to `pending_actions`
  and appear in chat as an **Approve / Cancel** card. `POST
  /actions/:id/approve` runs them. Unapproved actions expire after 24 hours.

To set the client secret, double-click `jarvis/set-google-secret.cmd`.

## iPhone apps

The assistant can use the iPhone's own apps. All of this works in Expo Go
except Apple Health.

| App | Look up | Change (after Approve) |
|---|---|---|
| Contacts | search by name: numbers, emails, company, birthday | add a contact; edit name, company, job title, phones, emails |
| Calendar | events in a date range, across all calendars | add, change, or delete an event |
| Reminders | open reminders (and recently completed ones) | add a reminder, mark one done |
| Messages | | open a text with recipients and message filled in |
| Mail | | open an email with recipients, subject, and body filled in |
| Phone | | start a call |
| Shortcuts | | run a shortcut by name; add one the assistant wrote (see [Shortcuts the assistant writes](#shortcuts-the-assistant-writes)) |
| Apple Health | steps, heart rate, resting heart rate, sleep, active energy, workouts (development build only) | |

Examples: "What's Sarah's number?", "Add sarah@acme.com as Sarah's email",
"What's on my calendar Friday?", "Move my dentist appointment to 4",
"Remind me to call Mom at 5", "Text Sarah I'm running late", "How did I
sleep this week?".

**How it works** (`api/src/phone.ts`, `app/src/lib/phoneActions.ts`)

- **Lookups.** The Worker can't reach the phone. When the model asks for a
  lookup, `/chat` pauses the turn: the model's state goes into
  `paused_turns`, and the response is `{ paused: { turnId, calls } }`. The
  app runs the lookups and posts the results to `/chat/resume`, which picks the
  model up where it stopped. A turn can pause more than once. Paused turns
  expire after 10 minutes.
- **Changes** always go to `pending_actions` and appear as an approval card.
  For contact edits, the card finds the contact on the phone and asks which
  one if several match. For texts, emails, and calls, it shows the number or
  email each name resolves to. **Approve** makes the change on the phone, then
  sends the result to `POST /actions/:id/approve` as `phoneResult`.
- **Capabilities.** The app sends `phone: { lookups, capabilities }` with each
  message, so the server only offers tools this app can run. Older app
  versions and Siri get changes only, not lookups; `capabilities` includes
  `health` in a development build.
- Looked-up data is sent to the AI model to answer the question. The server
  keeps it only while the turn is paused, and deletes turns that are never
  resumed on the user's next message.

## Siri

**Settings → Siri → Set up Siri** creates a key and shows how to build an
"Ask OVOA" shortcut in the Shortcuts app: Dictate Text → Get Contents of URL
(`POST /siri` with the key) → Speak Text. Then "Hey Siri, Ask OVOA" talks to
the assistant hands-free.

- `/siri` takes `{ message }` and returns the reply as plain text.
- Through Siri, the assistant can answer, use Google, and prepare phone changes
  (add a contact, event, or reminder; start a text, email, or call). You
  approve those in the app. Siri can't look things up on the phone.
- The key is a session with `kind = 'siri'`. It lasts 5 years, only works for
  `/siri`, and is replaced when you set up again. **Turn off Siri** deletes it.
  Changing your password also deletes it.
- Siri uses the last time zone the app reported (`settings.time_zone`).
- This is a Shortcut, not a built-in Siri command, so it needs no development
  build. Native App Intents ("Hey Siri, add a reminder in OVOA" with no
  shortcut) would need Swift code in a development build.

## Shortcuts the assistant writes

The assistant can write its own iPhone shortcuts and run shortcuts by name.
Examples: "Make me a shortcut that starts a 4-minute tea timer", "Build a
morning briefing I can run with Siri", "Run my Leaving Work shortcut".

**How it works** (`api/src/shortcuts/`)

1. `shortcut_actions_search` looks up actions in `catalog.json`: 302 of
   Apple's built-in actions with their exact parameters. It's generated from
   the ShortcutsBench dataset in `IOS SHORTCUTS DB/` by
   `python api/scripts/build-shortcut-catalog.py`. Mac-only, scripting,
   payment, and retired third-party actions are left out.
2. `shortcut_create` takes a JSON program (actions, if/otherwise, repeat,
   menus, variables, and `{{references}}` to earlier results).
   `compile.ts` checks every action, parameter, enum value, and reference,
   then writes the shortcut file (an XML plist). Mistakes go back to the model
   as errors to fix.
3. `sign.ts` sends the file to a signing service. iOS only imports shortcuts
   Apple has signed.
4. The signed file is saved in `shortcuts` (the last 50 per user) with a
   download link that works for 24 hours. The app shows an approval card
   listing the steps and what the shortcut can do (send messages, use the
   internet, delete files…). **Approve** opens
   `shortcuts://import-shortcut`, and the user taps **Add Shortcut**.
5. `phone_shortcut_run` opens `shortcuts://run-shortcut?name=…` (after
   Approve, like other phone actions).

The assistant can also list, reopen, and revise shortcuts it wrote
(`shortcut_list`, `shortcut_get`, `shortcut_install`).

**Signing (required).** Until `SHORTCUT_SIGNING_URL` is set, shortcut writing
is off and the assistant says so; running shortcuts still works. Signing needs
Apple's `shortcuts sign` command on a Mac signed into iCloud. A GitHub Actions
Mac doesn't work because it isn't signed in. Options:

- Run [shortcut-signing-server](https://github.com/scaxyz/shortcut-signing-server)
  on a Mac you control, and set `SHORTCUT_SIGNING_URL` to its sign endpoint.
- RoutineHub's HubSign (`https://hubsign.routinehub.services/sign`), which
  needs a RoutineHub developer membership. Every shortcut is sent to
  RoutineHub, so shortcuts never contain secrets.

Both accept `POST { shortcutName, shortcut: <XML plist> }` and return the
signed file (it starts with `AEA1`). If the service needs a key, set it as the
`SHORTCUT_SIGNING_TOKEN` secret; it's sent as `Authorization: Bearer …`.

```powershell
cd jarvis\api
npx wrangler secret put SHORTCUT_SIGNING_URL
npx wrangler secret put SHORTCUT_SIGNING_TOKEN   # only if the service needs one
```

**Limits**

- Built-in Apple actions only. Actions from other apps and newer App Intents
  (like Set Alarm) aren't in the catalog.
- Message and email recipients must be written out; the compiler can't fill
  them from a variable.
- Shortcuts can't schedule themselves. Time- or place-based runs are set up
  by the user in Shortcuts → Automation.
- iOS asks before a new shortcut first sends messages, reads data, or
  contacts a website.
- Some catalog descriptions come from a research dataset with known errors.
  `OVERRIDES` in the build script fixes the ones found so far.
- Not yet tested on an iPhone with a real signed file.

## Development build

Apple Health needs a development build: your own installable OVOA app
instead of Expo Go. On Windows it's built in the cloud with EAS, which needs a
paid Apple Developer account ($99/year).

The code is already in place: `@kingstinct/react-native-healthkit` with its
config plugin in `app.json` (read-only, no background delivery), and
`app/src/lib/health.ts` loads it only outside Expo Go. `eas.json` has a
`development` profile.

Once you have the account:

```powershell
cd jarvis\app
npx expo install expo-dev-client
npm install -g eas-cli
eas login
eas device:create
eas build --profile development --platform ios
```

`eas device:create` registers your iPhone. When the build finishes, open its
link on the iPhone to install it, then run `npx expo start` and open the
project from the installed app.

`expo-dev-client` isn't installed yet on purpose: while it is, `npx expo
start` targets the development build instead of Expo Go.

## Background work

Off by default. When on, OVOA runs on a schedule with nobody in the room:
standing jobs with a due time, an outbox it writes notes into, and a log of
every run including the quiet ones. Two jobs are seeded when you turn it on —
a 7am brief, and a 6pm sweep of what you said you'd do.

It can't send a message or email on its own, and can't delete anything, at any
autonomy level: those tools are removed from the autonomous tool list rather
than discouraged in the prompt. **Suggest** (the default) means it looks and
tells you, and anything that would change something waits for a tap. **Act**
lets it create calendar events, tasks and drafts on its own as well.

Speaking is a deliberate act: the turn's text is discarded and reaching you
needs a tool call, so an agent with nothing to say says nothing. Quiet hours
(22:00–07:00 by default) hold notes back until morning unless something is
about to be missed.

The whole design, and why each piece is the way it is, is in
[docs/agent.md](../docs/agent.md).

**Setup:** migrations 0011 and 0012, `npm run deploy` (the cron triggers ride
along), and `eas init` in `jarvis/app` for the Expo project id push tokens
need. Without that last one, notes are written and shown in the app but never
pushed, and Settings says so. Expo Go can't receive remote push at all; it
needs the built app.

## Timeline

Off by default. What you record is summarised into a day OVOA can look things
up in: "what did I do Tuesday", "did I ever call Sarah back", "how was last
week". The assistant reaches it through `context_day`, `context_week`,
`context_search` and `context_commitments` rather than being handed a pile of
transcripts, which is what stops it falling over after a week of real use.

Capture is explicit only, and there is no branch in the code that makes it
otherwise. A saved recording is turned into words on the phone, the words go
to the server to be summarised and are dropped there, and what is kept is a
title and two sentences. The audio stays on the phone. Ambient capture was ruled out on
legal grounds (all-party consent, BIPA), not deferred.

Promises are pulled out while the words are still around, with the words
attached, and their due date is resolved at the same time — so a dated promise
can schedule its own reminder. See [docs/agent.md](../docs/agent.md).

`contextRetainDays` (2 weeks by default) is enforced nightly.

## How memory works

- **Short-term:** the last 30 messages are sent with every request.
- **Long-term:** after a reply to anything the user says about themselves
  (first person, "remember…", "forget…"; see `api/src/remember.ts`), a model
  reads the exchange and adds or
  removes short facts in `memories`. Those facts go into the system prompt.
  Users can view and delete them in Settings, or turn memory off.

## AI models

Every model call (typed and spoken turns, memory and summaries, setup, app
design, agent jobs) tries **GLM first and Gemini second** (`api/src/llm.ts`,
since v1). An engine without its key doesn't exist. When both fail, a person's
turn is answered plainly: "Sorry, I can't reach the AI right now." Set in
`api/wrangler.jsonc`:

- `GLM_BASE_URL`, `GLM_MODEL`: GLM 5.3 Flash on Z.ai (`glm-5.3-flash`); the
  key is the secret `GLM_API_KEY`. Any OpenAI-compatible host works.
- `CHAT_MODEL`, `MEMORY_MODEL`: `gemini-3.5-flash-lite`, the fallback, for
  replies and for the quick calls (memory, setup, app design, briefs).
  `CHAT_MODEL` also does web search grounding. The key is `GEMINI_API_KEY`.
- Adding another OpenAI-compatible provider is an entry in `OPENAI_PROVIDERS`
  plus its vars and price; the top of `api/src/llm.ts` says how.

Dev tools (development accounts) can change which engine goes first without a
deploy. Prices are in `api/src/pricing.ts`.

**To add the Gemini key:** double-click `jarvis/set-gemini-key.cmd` and paste
the key when asked.

## API

```powershell
cd jarvis\api
npm install
$env:XDG_CONFIG_HOME = "C:/Users/thoma/.wrangler-ovoa"
npm run db:migrate
npm run deploy
```

`api/wrangler.jsonc` pins the ovoa.ai account (`account_id`), so every remote
wrangler command run from `jarvis/api` (deploys, `secret put`, `d1 ... --remote`)
lands there or fails. Run them with that account's login: the profile in
`XDG_CONFIG_HOME` above. The forwarder at the old address deploys from
`jarvis/api` too, with the old account's profile:
`XDG_CONFIG_HOME=C:/Users/thoma/.wrangler-edgeformmedia npx wrangler deploy -c ../forwarder/wrangler.jsonc`.

Schema changes: add a file to `api/migrations/`, then run
`npm run db:migrate`.

`npm test` runs the unit tests (local-time and scheduling arithmetic, which is
where the silent bugs live). `npm run smoke` runs the API end to end against a
local worker:

```powershell
npx wrangler dev --local --port 8787 --var DEBUG_KEY:localtest
npm run smoke
```

The Worker has cron triggers (`api/wrangler.jsonc`): every two minutes for the
agent's due work and its outbox, and 04:13 UTC for retention and log trimming.
`npm run deploy` registers them.

| Method | Path | |
|---|---|---|
| POST | /auth/signup, /auth/login | `{ email, password, name? }` → `{ token, user }` |
| POST | /auth/email/code | `{ email }` → emails a 6-digit code from no-reply@ovoa.ai (ovoa.ai's sign-in; `src/emailauth.ts`) |
| POST | /auth/email/verify | `{ email, code }` → `{ token, user }` for an existing account, else `{ ticket, email, name }` |
| POST | /auth/email/signup | `{ ticket, name, password }` → `{ token, user }` |
| POST | /auth/google | `{ idToken }` (checked with Google) → same as /auth/email/verify |
| POST | /auth/logout | |
| GET / PATCH / DELETE | /me | profile + settings (incl. `stepGoal`, `fallDetection`) |
| POST | /me/password | `{ currentPassword, newPassword }` |
| GET / DELETE | /chat/messages | history / clear |
| POST | /chat | `{ message, timeZone?, phone? }` → `{ messages }` or `{ paused }` (see iPhone apps) |
| POST | /chat/resume | `{ turnId, results }` → same as /chat |
| POST | /siri | `{ message }` → reply as plain text (Siri key) |
| POST / DELETE | /siri/key | create or revoke the Siri key |
| GET / DELETE | /memories, /memories/:id | |
| GET / PUT | /steps | PUT `{ days: [{ day: "YYYY-MM-DD", steps }] }` |
| GET / POST / DELETE | /contacts, /contacts/:id | POST `{ name, phone }` (max 5) |
| GET / POST | /safety-events | POST `{ kind: "fall"\|"sos", status: "ok"\|"alerted", latitude?, longitude? }` |

| POST | /google/connect | `{ returnUrl, accountId? }` → `{ url }` to open; `accountId` reconnects that account |
| GET | /google/callback | Google redirect target (public) |
| GET | /google/status | default account's details plus `accounts` |
| PATCH / DELETE | /google/accounts/:id | `{ label?, isDefault? }` / disconnect and revoke one account |
| DELETE | /google | disconnect and revoke every account |
| GET | /actions | actions waiting for approval |
| POST / DELETE | /actions/:id/approve, /actions/:id | approve / cancel |
| GET | /shortcuts/file/:token/:name | signed shortcut download for the Shortcuts app (public, 24-hour link) |
| GET / POST / PATCH / DELETE | /agent/jobs, /agent/jobs/:id | standing work; POST `{ title, instruction, kind, ... }` |
| POST | /agent/jobs/:id/run | run one now instead of waiting for its time |
| GET / POST / PATCH | /agent/goals, /agent/goals/:id | standing intent with no due time |
| GET | /agent/notes | the outbox, plus an unread count |
| POST / DELETE | /agent/notes/read, /agent/notes/:id | mark read / dismiss |
| GET | /agent/runs | the audit log, plus today's run count |
| POST / DELETE | /push/token | register or forget this phone's Expo push token |
| POST | /context/blocks | `{ startedAt, endedAt, source, transcript? , note? }` — the transcript is read and dropped |
| GET | /context/days/:date, /context/weeks/:date | a day, or the week it falls in |
| GET | /context/commitments | what you said you'd do and haven't |
| PATCH | /context/commitments/:id | `{ status }` — settling one cancels its reminder |
| DELETE | /context/blocks/:id, /context/blocks?since= | "forget that" / "forget the last hour" |

All routes except signup, login, the Google callback, and shortcut downloads need
`Authorization: Bearer <token>`.

## Running the app

```powershell
cd jarvis\app
npm install
npx expo start
```

Scan the QR code with the iPhone camera, which opens it in Expo Go.
`npx expo start --web` gives a browser preview; step counting and fall
detection don't work there.
