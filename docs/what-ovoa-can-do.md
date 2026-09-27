# What OVOA can do

A plain list for the site, the App Store text and creator briefs. Each line has something a person could
actually text or say. "Live" is on api.ovoa.ai today; "New" is on the `claude/overnight` branch and goes
live when it's merged and deployed; "Switch" says what turns it on.

## Talk to it however you like

- **Text it from Messages** (iMessage), use the app, or talk to it on the OVOA Band. One OVOA, one
  conversation, same memory everywhere. *"hey can you move my 3pm to tomorrow"* (Live)
- **Try it without an account**: 5 free texts, 5 more for an email. (Live)
- **Save its contact card** with the logo: it comes with the first reply, or text **CARD** anytime. (CARD: New)
- **It sounds like a person**: short, casual texts, reactions on your messages, never em dashes. (Live; also
  notifications and the emails it writes: New)
- **STOP, START, HELP** work on its number. STOP means it never texts you first again. (New)

## Your day

- **Calendar and email** (Google): *"what's on tomorrow"*, *"reply to Dana that Thursday works"*,
  *"find the email from my landlord"*. Sending waits for your OK. (Live)
- **Reminders, alarms, to-dos, notes, routines**: *"remind me to call mom Sunday at 5"*, *"every weekday
  at 7 wake me up"*. (Live)
- **Morning brief** and a nightly summary of your day. (Live)
- **It texts you first** when something matters: a reminder, a dropped thread, a check-in. Text
  *"stop texting me first"* to turn it off. (Live)
- **Money, food, health**: budgets and bills, *"I had a burrito"* food memory, sleep and workouts from the
  Band and Apple Health. (Live)

## Getting things done

- **Look things up live**: *"is the pharmacy open"*, *"best tacos near me"*. (Live)
- **Read any link**: *"what does this article say"* with a link, or pull a list off a page. (New, no switch)
- **Use websites for you in a real browser**: search a site, check availability, fill a form. Anything
  that orders, books, pays or posts waits for your YES, and it never types passwords or card numbers.
  (New. Switch: Browser Rendering binding + adapter, see docs/claude-overnight.md)
- **Sites you signed into yourself**: sign into OpenTable or Amazon once in the app and OVOA can use it.
  It never sees your password and never signs into banks or payment apps. (New server side; the app's
  sign-in screen needs a native library, docs/logins-without-passwords.md)
- **Your vault**: *"my Delta number is 1234567, save it"*. Addresses, loyalty numbers, sizes, seat
  preference, encrypted, used when it books or fills forms. Never cards or passwords. (New)
- **Saved lists** it builds over time: *"keep a list of the places we liked"*. (New)
- **Watch a page for you**: *"tell me when Saturday tickets go on sale"*, *"let me know if this jacket drops
  under $120"*. Checks hourly or daily and texts you once when it happens; it never buys. (New, Plus)
- **Plans and trips**: options, when to book, a reminder, a follow-up. (Live)
- **Buy within a budget**: it finds it, you say YES, you finish at the store's checkout. OVOA never pays. (Live)
- **Websites** at yourname.ovoa.ai: *"make a site for my dog walking business"*. (Live)
- **Games for two**: *"make a game for me and my girlfriend"*. (Live)

## Doing it for many at once

- **Campaigns**: one YES, many targets. *"email these 30 venues asking if they have June 14 open"*
  (from your own Gmail, 200 a day max), *"look up the hours of every place on my list"*, *"tell my friends
  the party moved to 8"*. Runs in the daytime, shows progress in the app, stop anytime.
  (New. Switch: `CAMPAIGNS=1`)
- **Standing approvals**: *"you don't have to ask before emailing my wife"*. Deleting and money always ask.
  (New)

## Friends and other OVOAs

- **Friends**: connect OVOAs by username with access levels (Basic, Best friend, Partner, Full access).
  *"ask Jake's OVOA when he's free Saturday"*, *"find a time for dinner with Maya"*. Anything outside what a
  friend allows goes to you first. (Live)
- **Group chats**: add OVOA to an iMessage group with friends and ask it by name: *"ovoa what time works
  for all of us?"*. In a group it never shares anyone's private stuff; anything that needs your accounts it
  handles with you 1:1. (New. Switch: `TEXT_GROUPS=1`)

## For creators

- **"Text JAKE to OVOA"**: make a text-in code with up to 5 questions. Everyone who texts it gets your
  questions one at a time, and you ask *"who answered?"* to see and rank them. Only people who texted the
  code are ever texted, and STOP ends it. Good for giveaways, fan Q&As, casting calls, leads.
  (New. Switch: `INBOUND_CODES=1`)

## On its own, while you're busy

- **Background agent** (Plus): scheduled jobs and goals it works on, with quiet hours; it never sends,
  deletes or spends without you. (Live)

## Not yet

- **Calling a business for you** (a real AI voice call): designed in docs/server-calls.md, needs a voice
  provider picked.
- **Adding a signed-in site from the app**: server is ready; the app screen needs a native cookie library.
