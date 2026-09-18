# OVOA app

An iPhone app with accounts, an AI assistant with memory, step tracking, and
fall and SOS safety alerts.

```
jarvis/
  api/   Cloudflare Worker (Hono) + D1 database "jarvis-db"
  app/   Expo (SDK 57) app with expo-router
```

The folder, Worker (`jarvis-api`), and database (`jarvis-db`) keep their
original names so the live deployment keeps working. Nothing the user sees says
"Jarvis".

Live API: https://jarvis-api.edgeformmedia.workers.dev

## App tabs

- **Activity**: today's steps, a goal progress bar, distance and calorie
  estimates, a goal streak, a 7-day chart, and a daily goal picker. Steps come
  from the iPhone's motion chip (`expo-sensors` Pedometer). iOS keeps 7 days of
  history, and the app syncs those days to the `step_days` table.
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
- **Settings**: name, assistant name and personality, Google, Siri, memory
  controls, password, and sign out. **Danger zone** has **Approve for me** and
  delete account.

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

1. **Live transcription** (`app/src/lib/liveListen.ts`): the app gets a
   30-second Deepgram token from `POST /voice/token`, then streams 16 kHz PCM
   from `expo-audio`'s `AudioStream` straight to Deepgram's live WebSocket
   (`nova-3`, with `OVOA` as a key term). Your words appear under the orb as
   you say them. Deepgram's endpointing says when you've finished (600 ms
   pause, or 1.2 s with no new words), and the sentence is sent right away.
   The real key never leaves the Worker.
   - Fallback: if the live connection fails twice, it records with the level
     meter instead and uploads to `POST /voice/transcribe`.
2. The text goes to `/chat` with `voice: true`, which asks the model for
   short, spoken-style replies. Conversations are still saved for memory and
   context.
3. The reply is read aloud through `POST /voice/speak` (Deepgram Aura 2), a
   sentence or two at a time so it starts quickly. Then it listens again.

Tap the orb while it's talking to cut it off. Approval cards (texts, emails,
calls) still appear under the orb. Listening pauses when you leave the tab or
the app goes to the background; iOS doesn't allow recording in the background
from Expo Go. Pick the voice in **Settings → Voice** (saved on the phone).

While it's on, everything it hears goes to the assistant, including TV and
other people talking. There's no wake word.

Everything uses `expo-audio` and `expo-file-system`, so it works in Expo Go.
Listening lives in `AssistantProvider` (`app/src/lib/assistant.tsx`), above
the tabs; the Assistant tab only draws it.

### Always listen (Danger zone)

Off by default, saved on the phone, and it asks for confirmation. When on:

- The microphone stays on while the app is open, on **every** screen, not
  just the Assistant tab. It still stops in the background.
- **Talk over a reply to interrupt it.** Expo Go can't turn on the iPhone's
  echo cancellation, so the mic also hears the reply. While a reply plays, the
  app records 1.8 s pieces and transcribes them. It only counts as the user
  talking if at least 3 words (70% of what was heard) aren't in the reply, or
  if the piece is just "stop" / "okay stop" / "hold on". It then stops
  the reply and catches the rest of the sentence. A bare "stop" or "hold on"
  just silences it. Expect about 1–2 s before it reacts.
- If a reply creates an approval card while you're on another tab, the app
  switches to the Assistant tab to show it.

The Deepgram key lives only on the Worker (`DEEPGRAM_API_KEY` secret). Without
it, the voice routes return 503.

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
  `https://jarvis-api.edgeformmedia.workers.dev/google/callback`. The app
  opens `POST /google/connect`'s URL in an auth session. The Worker swaps the
  code for tokens (with PKCE) and sends the browser back to `exp://…` (Expo
  Go) or `ovoa://…` (installed app).
- **Token storage:** refresh and access tokens are AES-GCM encrypted in
  `google_accounts` (one row per connected account, unique per user + email)
  using the `TOKEN_ENC_KEY` secret. Google drops testing-mode grants after
  7 days; when that happens, the Worker deletes that row, promotes another
  account to default, and the app shows **Connect** again.
- **Scopes:** openid/email/profile, `spreadsheets`, `calendar`,
  `gmail.modify`, `drive`, `documents`, `tasks`, `contacts`. Gmail and Drive
  are restricted scopes: a public launch needs Google verification plus a
  yearly CASA security assessment.
- **Assistant tools** (`api/src/google/tools.ts`): calendar list, create,
  update and delete; Gmail search, read, draft, send, mark read and trash;
  Drive search and trash; Sheets info, read, append, update and create; Docs
  read, create and append; Tasks list, add and complete; Contacts search. The
  Workers AI fallback and Gemini both call tools through `chatWithTools` in
  `llm.ts`.
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

## How memory works

- **Short-term:** the last 30 messages are sent with every request.
- **Long-term:** after each reply, a model reads the exchange and adds or
  removes short facts in `memories`. Those facts go into the system prompt.
  Users can view and delete them in Settings, or turn memory off.

## AI models

Set in `api/wrangler.jsonc`:

- `CHAT_MODEL`: `gemini-3.1-pro-preview` for replies
- `MEMORY_MODEL`: `gemini-3.8-flash` for memory extraction
- `FALLBACK_MODEL`: `@cf/openai/gpt-oss-120b` on Cloudflare Workers AI (free
  plan). It's used when `GEMINI_API_KEY` is not set or a Gemini call fails, so
  chat works before the key is added.

**To add the Gemini key:** double-click `jarvis/set-gemini-key.cmd` and paste
the key when asked.

## API

```powershell
cd jarvis\api
npm install
npm run deploy
```

Schema changes: add a file to `api/migrations/`, then run
`npm run db:migrate`.

| Method | Path | |
|---|---|---|
| POST | /auth/signup, /auth/login | `{ email, password, name? }` → `{ token, user }` |
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
