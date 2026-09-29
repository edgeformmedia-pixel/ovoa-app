# More agentic (2026-09-29)

The ask: make OVOA as autonomous as it can be. Most of the list was already
there. This fills the gaps it could fill without new accounts, and keeps the
rules that make it safe to leave alone (docs/agent.md): background runs never
send, delete or spend on their own; OVOA only texts people who texted it first
(Sendblue); anything that pays, sends or submits waits for a YES.

Code: `network.ts` (ovoa_group, groupProgress, tally, shares, payLink),
`memorytools.ts`, `agent.ts` (agent_finish_job, seedHeadsUp,
backfillSystemJobs), `texting.ts` (the "take things off their plate" line),
`toolbelt.ts` (synonyms), migration `0062_groups_watches.sql`. Tests:
`test/agentic.test.ts`.

## What's new

- **Group polls** (`ovoa_group` poll): "ask Maria and Jake where they want
  dinner Friday, sushi or tacos". One question thread per connection, all under
  one `ovoa_groups` row. The answers are counted instead of told one by one, and
  the owner gets one text with the tally ("Sushi 2, Tacos 0. Sushi wins. Want
  me to book it?") once everyone has answered, or after 24 hours with whatever
  came in. Each connection's limits and approvals apply as for any question.
- **Bill splits** (`ovoa_group` split): "split $120 for dinner at Nopa with
  Maria, Jake and Sam, my Venmo is @thomas-l". Shares in cents, with the
  leftover cents spread out. Each connection's OVOA gets their share with a
  Venmo or Cash App link as an ordinary share. Anyone not on OVOA (Sam) gets a
  line for the owner to forward.
- **Watches that end themselves**: a recurring job's run now has
  `agent_finish_job`. "Text me when flights to Austin drop under $300" becomes
  an interval job that stays quiet until the price drops, texts once, then ends
  itself instead of repeating the news every few hours. `agent_schedule`'s
  description says how to set a watch up.
- **Heads-up sweep**: a system job at 8:30 every day for anyone with Google
  connected. It covers bills and renewals about to charge, free trials ending,
  deadlines, flight check-in opening, and packages or appointments that need
  them, in the next 72 hours. It speaks only when something is due. It's
  seeded when the agent is turned on, and backfilled for people who already had
  it on (10 per cron tick). Runs are Plus, like all background work.
- **"What do you know about me"**: `memory_list` (numbered),
  `memory_forget`, `memory_edit`. These work by text as well as in the app. An
  edited or added memory is kept as `asked`, so the 14-day purge of learned
  memories leaves it alone.
- **Texting prompt**: a photo of a flyer or ticket goes on the calendar in the
  same reply. "I'll call mom Sunday" gets a reminder without asking. "Let me
  know when" is a watch. Cancelling a subscription, a refund, a return or a
  form goes to `browser_task`. A group plan or a shared bill goes to
  `ovoa_group`.

## Still not built, and why

- **Bank read access** needs a Plaid (or similar) account and its review.
- **Notion, Apple contacts**: Notion needs an OAuth integration made in
  Notion's dashboard. Apple contacts are on the phone, and the phone tools
  already reach them.
- **Paying on its own**: this would need Stripe Issuing and a card per user.
  It's deliberately not built; purchases stay "YES, then you finish it at the
  link", or the browser agent stops at the pay step for a YES.
- **Messaging a non-user**: not on the $100/mo Sendblue plan (inbound-first).
  Forwardable lines instead.
