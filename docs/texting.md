# Texting OVOA (iMessage, through Sendblue)

Built 2026-09-24, on the idea of Instinct (an assistant you text): text OVOA's number from Messages and it
answers by text. It is the same OVOA as the app, not a second one. A text is a turn on your account, so it
reads and adds to the same conversation, the same memories, the same reminders, notes, lists, routines, money
and food, your Google account, and the apps you made in OVOA.

Code: `jarvis/api/src/texting.ts` (the whole channel), `index.ts textTurn` (the turn), migration
`0049_texting.sql`, app `components/TextingSetup.tsx` (Settings, Assistant). Tests: `test/texting.test.ts`.

## Turning it on (once)

1. Make a Sendblue account (sendblue.com) with a dedicated iMessage line. Free plans only answer contacts
   verified in their dashboard; OVOA's flow (the person texts first) needs a paid line to work for anyone.
2. Put the keys in `ovoa-team/sendblue/.env` (gitignored):

   ```
   SENDBLUE_API_KEY_ID=...
   SENDBLUE_API_SECRET=...
   SENDBLUE_NUMBER=+15551234567
   ```

3. From `jarvis/api`, with the ovoa.ai wrangler profile:

   ```
   XDG_CONFIG_HOME=C:/Users/thoma/.wrangler-ovoa node scripts/sendblue-setup.mjs
   ```

   It checks the keys against Sendblue, puts the three values and a new webhook secret on the Worker, points
   Sendblue's receive webhook at `https://api.ovoa.ai/texting/webhook` with that secret, and checks the Worker
   takes it. Run it again to rotate the secret. `--dry-run` changes nothing.

Until all four secrets are on the Worker, texting is off: the webhook answers 503, the cron skips it, and the
app's Settings doesn't show the section.

## How someone uses it

- **Link.** Settings, Assistant, "Link my number". The server makes a code (`POST /texting/link`: ten
  characters, one use, 15 minutes) and the app opens a text to OVOA's number with the code in it. They tap
  Send; the text arrives from their number with the code, so the number is theirs (`text_links`). The app
  sees the link appear (`GET /texting`) and says so. One number per account and one account per number: a
  number linked to another account moves when its owner links it again.
- **Text.** Anything they'd say in the app. OVOA answers in one to three texts, shows "Read" and the typing
  bubble while it works.
- **Their apps.** `my_apps` lists them, `app_open` opens one in the text conversation (their texts go to it
  and OVOA follows its instructions, with `app_update` for its screen), `app_close` closes it. An app left an
  hour without a text closes itself.
- **Approvals.** What waits for approval in the app (sending an email, deleting, inviting) is approved by
  replying YES (or a thumbs up on that text), cancelled with NO. Anything else lets it go: the next request
  counts. With "Approve for me" on, those run at once, as in the app.
- **What waits for the phone.** Texting or calling someone, the iPhone's contacts, calendar and Reminders app,
  shortcuts: these run on the iPhone, so they wait in the app. The reply ends with "Waiting for you in the OVOA
  app: …", and a notification ("Waiting in OVOA") opens Talk, where the card is. Nothing on the phone can be
  looked up from a text (as for Siri).
- **Unlink.** In Settings, or by texting just `unlink`.

## Rules

- **Only iMessage.** An SMS sender can be spoofed, and replies go to the real number, so a spoofed text could
  make OVOA act without the owner seeing why; an iMessage sender is Apple's. SMS gets one reply a day saying
  to use iMessage. OVOA is an iPhone app, so everyone has iMessage.
- **Never in a group chat**, and never to anyone not linked: a number nobody linked is told once a day how to
  link, and nothing it says is kept or reaches a model.
- **The same gates as the app**, each answered in one sentence: the account's email proven, a plan with AI
  (Base), agreed to AI, the per-person turn limit, today's replies and the month's. Texting is Base, like
  talking; linking is free.
- **Privacy.** A text's words are kept only until it's answered (`text_inbox`, two days, to tell a second
  delivery of the same text); the conversation itself is in `messages` like the app's, 14 days. Texts go
  through Sendblue. The privacy policy (ovoa-team) should name Sendblue.

## How a text is answered

Sendblue posts each text to the webhook, may post the same one twice, and waits 45 seconds for an answer.

1. The secret in `sb-signing-secret` must match `SENDBLUE_WEBHOOK_SECRET` (401 otherwise).
2. Each text is written down once, by `message_handle` (`text_inbox`), before anything is done with it.
3. A linked person's text waits 1.2 s for the rest of its burst (a photo and its words come as two); the last
   text of a burst answers all of it, as one message to OVOA.
4. One reply at a time per person (`text_links.busy_until`): texts that come in while a reply is being written
   are answered together, after it, by the same run.
5. The webhook answers Sendblue once the reply has gone or after 40 s; the work carries on for the 30 s a
   Worker gets after that. A text still waiting after a minute is answered by the cron (`textsTick`, every two
   minutes), and one whose run died half way through gets "Sorry, I lost track of your last text".

## Testing

- `npm test` (texting.test.ts): parsing, codes, the whole path from the webhook body to the texts sent, on
  the real schema, with a scripted turn: linking, strangers, SMS, groups, duplicates, bursts, order, YES/NO,
  reactions, the cron, apps.
- `POST /texting/try` (signed in, Base, a linked number): a text answered in the response instead of by text.
  `scripts/texting-probe.mjs` runs real turns through it against production with a throwaway account.
