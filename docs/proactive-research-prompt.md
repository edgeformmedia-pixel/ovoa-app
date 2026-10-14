# Deep research: every way OVOA can reach out first

You are a senior product researcher who knows behavioural science, notification and interruption research, just-in-time adaptive interventions (JITAI), and the best human service jobs: executive assistants, butlers, concierges, nurses, coaches, good friends. Do deep, sourced research and build **the complete catalog of ways OVOA can be proactive**: every moment where OVOA should reach out to the person first, without being asked, and what it should say.

**There is no target number. Keep going until you have run out of possibilities.** Don't stop at 50 or 100 because the list looks long. Stop only when the method in "How to know you're done" says you're done, and show the evidence that you are.

---

## What OVOA is (as of 2026-10-02)

OVOA is a personal AI assistant from a small, early-stage company, with real users in beta.

1. **Text OVOA (the front door).** An AI you text over iMessage, nothing to install. It remembers things about you, sets reminders, runs routines, reads photos and voice notes, browses the web for you, and can text you first.
2. **The OVOA app (iOS beta).** Voice talk, notes, Apple Health, a Day screen with routines and a to-do list, full-screen nag alarms, push notifications.
3. **OVOA Fit ($89.99).** A wristband with a button you press to talk to OVOA. It can buzz, and it reads heart rate.

**Plans:** Free (app only, no AI). Base $9.95/mo. Plus $13.95/mo, which adds the background agent (anything OVOA does on its own schedule). Pro $25.95/mo.

### Channels OVOA can reach someone through
- **iMessage text** (the main one). Can include links, photos and a contact card.
- **Push notification** (app users only).
- **Full-screen alarm** in the app, which nags until dismissed.
- **Wristband buzz** on OVOA Fit (a buzz pattern, no screen).
- **Through another person's OVOA:** OVOA users can connect, and one OVOA can ask another a question, run a group poll or split a bill.
- Possible but not built: email from OVOA, iOS widgets, Live Activities, Lock Screen, calendar invites, a spoken message in the app.

### Signals OVOA has to decide when to speak
- What the person told it and what it remembers about them (editable memories).
- Reminders, routines (meds, habits), streaks, a nightly to-do list.
- Promises they made in conversation ("I'll call mom Sunday").
- Questions they left hanging.
- Google Calendar and Gmail (OAuth): events, bills, renewals, trials, flights, packages, appointments.
- Weather.
- Apple Health (steps, sleep, workouts, when it works) and heart rate from OVOA Fit.
- Learned places and visits (where they usually are, when).
- Food they noted, and the money picture they entered by hand (no bank link).
- Watches they asked for ("tell me when flights to Austin drop under $300").
- Connections to other OVOA users.
- Their website (OVOA builds small sites at name.ovoa.ai) and Instagram.
- Day summaries kept long-term, everything else for 14 days.
- When they last texted, how fast they reply, what they ignore.

### Proactive things already built (don't just re-list these; extend them)
- Reminders, "urgent" reminders that nag every 2 min until "done".
- Routines with a re-buzz, then a "Did you do it? Text done or snooze" text.
- "You said you'd…" nudges on promises, and a follow-up on a question left hanging (Plus).
- An 8:30 heads-up sweep for bills, renewals, trial endings, deadlines, check-in opening, packages and appointments in the next 72 hours (Plus, needs Google).
- A morning brief and evening list (app users only today).
- Group poll results, bill split shares, watches that text once and then end.
- During the free trial: steering toward a first reminder and a website.

### Hard constraints (don't recommend around these; flag ideas that need one changed)
- **No always-listening.** No ambient mic or recording sent to servers. Capture happens only when the user acts. A wake word heard on the phone itself is OK.
- **Zero setup.** No extra hardware beyond OVOA Fit and no config. OAuth integrations are fine.
- **iMessage only** for texting. No SMS. OVOA only texts people who texted it first.
- **Rate limits:** at most 12 unprompted texts a day, quiet hours, and back-off when the person stops replying.
- **Background runs never send, delete or spend on their own.** Anything that sends a message to someone else, pays or submits waits for the person to text YES.
- **Not a medical product.** No diagnosis or treatment. Health is reminders and observations only.
- **Cost:** every model call costs money, and a heavy day already costs about $2.60 per user. Note when an idea needs a model call vs plain code.
- **Retention:** detail is deleted after 14 days; day summaries and what the person entered themselves stay.

---

## The question

**What are all the moments where OVOA should reach out first, what should it say, through which channel, and when should it stay quiet instead?**

Good proactive outreach:
- is **triggered by something real** (a signal above, a time, an absence, a change), not a generic "checking in!"
- is **useful on its own**: the text alone helps, even if they never reply
- makes the **next step a one-word reply** (YES, done, snooze, 2)
- **gets smarter** with what OVOA knows, so a stranger couldn't send the same text
- **earns its place** against the 12-a-day cap and doesn't train people to ignore OVOA

---

## How to find everything (use every lens, not just one)

Generate ideas through each lens below, one at a time. Each lens is a separate pass. Ideas will repeat across lenses; that's fine, de-duplicate at the end.

1. **Trigger type.** Time (fixed, relative, recurring), an event about to happen, an event that just happened, an absence (something that should have happened didn't), a change in a pattern, a threshold crossed, new information arriving (email, price, weather), something another person did, a milestone or anniversary, a follow-up on OVOA's own earlier message.
2. **Data source.** Go through every signal in the list above, one by one, and ask "what could OVOA say because of this?" Then cross pairs of signals (calendar × weather, heart rate × calendar, places × reminders, promises × contacts, money × renewals, sleep × tomorrow's first meeting).
3. **Life domain.** Work, school, money, home, health, sleep, food, fitness, family, partner, friends, kids, pets, car, travel, shopping, admin and paperwork, legal and government, faith, hobbies, learning, side business, community, moving house, job hunt, dating, grief, celebrations.
4. **Time horizon.** Seconds (right now), minutes, hours, today, tomorrow, this week, this month, this season, this year, years (renewals, anniversaries, document expiry).
5. **Life stage and life event.** Student, new job, new parent, caring for a parent, moving, wedding, divorce, retirement, illness, new pet, new city.
6. **Relationship to the person.** What would a great executive assistant, butler, concierge, nurse, personal trainer, coach, therapist (within limits), accountant, travel agent, best friend, parent, or partner proactively say? Go through each role.
7. **Emotional state.** Stressed, overwhelmed, bored, lonely, procrastinating, proud, grieving, excited, anxious about something tomorrow. What helps, and what should OVOA never say in that state?
8. **Where they are in the product.** First hour, first day, first week, end of free trial, newly paying, power user, fading (replies slowing), gone quiet for 3, 7, 30 days, cancelled, came back.
9. **Failure modes.** What goes wrong in people's lives because nobody reminded them, warned them or noticed? (Missed renewals, late fees, expired passports, forgotten birthdays, missed refills, double-booking, leaving late, forgetting the umbrella, a return window closing.)
10. **Other people.** Birthdays, someone's big day, a friend who hasn't been heard from in months, a group plan going quiet, a shared bill unpaid, someone else's OVOA asking.
11. **The world.** Weather, traffic, holidays, daylight saving, school calendars, sports, local events, price drops, product recalls, outages, news they asked to follow.
12. **OVOA itself.** A new feature that solves something they asked for, a watch that fired, a background job's result, an honest "I couldn't do X, here's why", a weekly "here's what I handled for you".
13. **Competitors and analogues.** What do Siri Suggestions, Google Now (RIP) and Google Assistant, Apple Journal suggestions, ChatGPT tasks, Poke, Lindy, Martin, Fieldy, Tiimo, Duolingo, Oura, Whoop, Fitbit, banking apps, airline apps, Amazon, Uber, Calm, Headspace and the best human assistant services proactively send? Re-verify every fact. For each, what works, what annoys people, and what OVOA could do better by text?
14. **Research.** JITAI and mobile-health intervention literature, notification interruption and receptivity research (when people are open to a nudge), habit formation, implementation intentions, prospective memory, reminder fatigue, the "notification overload" literature. Mine these for triggers and for rules about timing.
15. **Voice of customer.** Reddit, App Store reviews, TikTok and YouTube comments: "I wish my phone would just tell me when ___", "I wish someone had reminded me ___". Quote short snippets with links and dates.
16. **Inversion.** List everything OVOA could do proactively that would be creepy, annoying, wrong or harmful. Each one is a rule about when to stay quiet, and sometimes a hint at a gentler version that works.
17. **Random combinations.** Pick a random signal, a random domain and a random channel and force an idea out of it. Do at least 30 of these. Keep the good ones.

### How to know you're done
After each lens, count how many **new** ideas it added that weren't already in the catalog. Report that count. Keep running lenses (repeat them with a different angle, or invent new lenses) until **two passes in a row add fewer than 3% new ideas**. Then say how many passes you ran and show the yield per pass.

---

## What to deliver

### 1. The catalog
One row per distinct idea, as a table (also give it as CSV at the end). Columns:

| Field | What goes in it |
|---|---|
| ID | P001, P002… |
| Name | A few words |
| Trigger | The exact signal and condition ("calendar event with a location, 45 min before, traffic heavy") |
| Example text | The actual iMessage OVOA would send, in plain short words, with the reply it expects |
| Channel | Text, push, alarm, buzz, another OVOA, or other |
| Timing | When it's sent, and when it must not be |
| Data needed | Which signals; mark any that OVOA doesn't have today |
| Status | Built / extends something built / new |
| Plan | Free, Base or Plus |
| Lifecycle stage | Which stage from lens 8 it matters most in |
| Value | Saves money, saves time, avoids a mistake, keeps a promise, relationship, health, delight, or product growth |
| How often | Once ever, rare, weekly, daily |
| Model call? | Plain code or needs AI, and a rough cost |
| Annoyance risk | Low / medium / high, and why |
| Privacy risk | Low / medium / high, and why (would it feel like being watched?) |
| Constraints | Any constraint it bumps into |
| Evidence | Research, competitor or voice-of-customer source, if any |

### 2. The map
Group the catalog into families (for example: "before something happens", "after something happened", "something didn't happen", "patterns", "other people", "money", "the world"). Show which families are thin and why.

### 3. When to stay quiet
A list of **never** and **must** rules for proactive outreach, each grounded in research or a real example. Cover:
- how to rank ideas against the 12-a-day cap when several fire at once
- how to bundle (one text with three things vs three texts)
- timing and receptivity (when people actually read and act)
- how to word a follow-up after they ignored the first one
- how to back off without disappearing
- what should never be sent unprompted (health worries, money judgments, anything about other people's private info)
- how to let people tune it ("fewer", "more", "never about X") by text

### 4. Score and pick
Score every idea 1–5 on: value to the person, how often it would be useful, how clearly it beats Siri, ChatGPT and Apple Reminders, build cost given what's already built, running cost, annoyance risk (reversed), privacy risk (reversed), and how much it would make someone tell a friend or upgrade to Plus.

Then give:
- **Top 10 to build next**, with the strongest case against each.
- **Top 5 for text-only users on Base**, since they get the least proactive help today.
- **Top 5 for the first 15 trial texts**, that would make someone pay.
- **5 wild ones** worth testing even though they're risky.

### 5. Gaps
What signals or channels would unlock the most new ideas if OVOA had them, within the constraints? Rank them by how many catalog rows they'd unlock.

---

## If you have the code

If you're running with access to this repo, check the "already built" list against the code before you start, so you don't recommend things that exist. Start with `docs/agent.md`, `docs/agentic.md`, `docs/texting.md`, `docs/capabilities.md` and `jarvis/api/src/reach.ts`. Don't change any code; this is research only.

## Style

Plain, short words. Example texts should sound like a sharp friend, not an app ("Your Netflix renews tomorrow, $15.49. Keep it? Text CANCEL and I'll do it."). Cite sources with links and dates. Say when something is a guess.
