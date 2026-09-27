# Instinct parity (2026-09-27)

Everything Instinct (the assistant you text) does, as recorded in this repo's notes, and where OVOA stands on
each. Sources: docs/texting.md, docs/instinct-more.md, docs/sites.md, docs/ovoa-network.md, docs/server-calls.md,
docs/what-ovoa-can-do.md, contextforclaude.txt and the gap audit at the top of docs/claude-overnight.md. There were
no separate memory notes in the plan's header. Rows marked "(typical)" are things an assistant like Instinct is
known for that no note here spells out; check them against Instinct itself before quoting this table publicly.

Status words:

- **Live on main**: on api.ovoa.ai today (main 16c2deb).
- **On this branch (task N)**: built on `claude/overnight`, live once merged and deployed (see the final report
  in docs/claude-overnight.md for switches).
- **Needs the owner (what)**: built or designed, waiting on a key, library, binding or provider decision.
- **Missing**: not built; one line of suggested design.

## The table

| Instinct does | OVOA | Notes |
| --- | --- | --- |
| **Talking to it** | | |
| An assistant you text from Messages (iMessage) | Live on main | texting.ts through Sendblue; same memory as the app and the Band |
| Try it before signing up | Live on main | Guest free trial (guest.ts); daily ceiling across all guests on this branch (task 2) |
| Understands photos and screenshots you text | Live on main | texting.ts lookAt, describeImage |
| Understands voice memos you text | Live on main | texting.ts, transcribeAudio |
| Reads files you text (PDF, Word, Excel) | On this branch (task 20) | files.ts with the existing AI binding |
| Sounds like a person, short texts, reactions | Live on main | Tone rules; no dashes in pushes and emails on this branch (task 2) |
| Contact card with its logo | Live on main | contactcard.ts; CARD keyword on this branch (task 5); Sendblue contact sharing needs `SENDBLUE_CONTACT_SHARING=1` |
| STOP / START / HELP on its number | On this branch (task 5) | keywords.ts, do_not_contact |
| Answers in group chats when named | On this branch (task 9) | Off until `TEXT_GROUPS=1`; Sendblue group sending may need a plan change |
| Replies with a voice note (typical) | On this branch (task 28) + Needs the owner (`TEXT_VOICE_REPLIES=1`) | voicereply.ts: only when they sent a voice memo, after the text |
| **Texting first** | | |
| Texts you first: brief, reminders, nudges | Live on main | reach.ts, 12 a day, quiet hours, "stop texting me first" |
| Follows up on dropped threads | Live on main | agent.ts followUpDropped |
| Follows up on plans and trips you mention | Live on main | lifeplans.ts: booking timing, a reminder, one useful question |
| Tells you when something on a page changes | On this branch (task 13) | watches.ts, hourly or daily, Plus |
| **Your accounts** | | |
| Gmail and Google Calendar | Live on main | Sending waits for YES |
| Outlook and Microsoft 365 | On this branch (task 19) + Needs the owner (Entra app, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`) | docs/outlook.md |
| Reads email attachments | On this branch (task 20) | gmail_attachment, outlook_attachment |
| Trips and orders found in your email (flight check-in, a delivery today) (typical) | On this branch (task 26) | mailtrips.ts: read-only morning scan, Plus; "stop reading my email for trips" |
| Schedules with people who aren't on it, by email (typical) | On this branch (task 25) | meetings.ts: 3 times in one email you approve, the invite after their pick with your YES |
| **Doing things** | | |
| Looks things up live | Live on main | web.ts (Z.ai search first) |
| Reads a whole page or link | On this branch (task 1) | fetchurl.ts |
| Uses websites in a real browser | On this branch (task 7) + Needs the owner (`@cloudflare/puppeteer`, BROWSER binding, Workers Paid) | Submits wait for YES |
| Uses sites you're signed into, without your password | On this branch (task 10) + Needs the owner (native cookie library and a dev build for the app screen) | sitesessions.ts |
| Remembers your details for bookings and forms | On this branch (task 4) | vault.ts, never cards or passwords |
| Books and buys within a budget, you say YES | Live on main | budget.ts; OVOA gives the link, never pays |
| Pays for you hands-off | Needs the owner (Stripe Issuing, KYC, a terms update) | docs/instinct-more.md; not planned for now |
| Calls a business for you | Needs the owner (voice provider: Twilio or a hosted voice agent) | docs/server-calls.md, design only |
| Builds and hosts websites | Live on main | sites.ts at username.ovoa.ai |
| Makes a game for two people | Live on main | together.ts |
| Keeps lists across steps | On this branch (task 3) | lists.ts |
| Shared lists with a partner or friend (typical) | On this branch (task 24) | lists.ts + list_shares: a Friend at Best friend or above (or the Share lists switch) reads, adds and ticks |
| Receipts into money: text a photo of a receipt and it's counted (typical) | On this branch (task 27) | receipts.ts: offered, logged on yes, counts against a budget |
| **Many at once** | | |
| One approval, many targets (emails, research, friends) | On this branch (task 6) | Off until `CAMPAIGNS=1` |
| Standing approvals ("don't ask before emailing my wife") | On this branch (task 8) | rules.ts; never money |
| Creator text-in codes ("text JAKE") | On this branch (task 14) | Off until `INBOUND_CODES=1` |
| **Other people** | | |
| Your AI talks to other people's AIs | Live on main | network.ts, Friends with access levels |
| Invite a friend | On this branch (task 23) | invites.ts; rewards are the owner's call |
| **Background** | | |
| Works on things while you're busy | Live on main | agent.ts, Plus; never sends, deletes or spends alone |

## The 5 most valuable Missing items

Ranked by how often a person would feel them, and all buildable without a new provider or key. They are
appended to docs/claude-overnight.md as tasks 24 to 28, and all five are now built on the branch.

1. **Shared lists with Friends** (task 24): groceries and packing lists with a partner are an everyday use, and
   lists.ts plus network.ts access levels already hold both halves.
2. **Scheduling with people not on OVOA** (task 25): most people you meet with don't have OVOA; today OVOA can
   only find a time with other OVOAs.
3. **Trips and orders from email** (task 26): flight check-in and "leave for the airport" without being asked is
   the kind of thing that makes an assistant feel like it pays attention.
4. **Receipts into money** (task 27): small, and money.ts is otherwise fed by hand.
5. **Voice-note replies** (task 28): delight more than need, and it adds voice cost, so it stays behind a var.
