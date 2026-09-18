# What users will actually ask

A pendant that hears everything invites unbounded questions. This maps what
people will ask onto what the system can answer, and is explicit about the gap.

The organizing constraint: **the ES100 is a microphone.** No GPS, no camera, no
network of its own. Everything it knows, it knows because somebody said it out
loud near the wearer.

---

## Tier 1 — Answerable from the wearable's own audio

This is the product. Everything here works with the hardware you ordered.

| Users ask | Needs |
|---|---|
| "What did Sarah say about the deadline?" | transcript search |
| "Did I agree to send that contract?" | commitment extraction |
| "What did I miss while I was out?" | capture summaries |
| "When did I last talk to Dana, and about what?" | search + recency |
| "What's Marcus been pushing for lately?" | search across captures by person |
| "Summarize my day" | enrichment over a date range |
| "What did I say I'd do this week?" | action items across captures |

The unifying need is **retrieval**, not context-stuffing. Today `streamChat`
dumps the last 20 transcripts into the system prompt. At eight hours a day that
is roughly 40k tokens per day of wear — it stops fitting inside a week, and it
cannot answer "what did she say in March" at any size. Retrieval has to become a
tool the model calls.

## Tier 2 — Answerable from the phone

No new hardware, but the app has to report state to the backend.

| Users ask | Needs |
|---|---|
| "What time is it?" / "What's today?" | clock |
| "Where am I?" | phone GPS |
| "How much battery does the pendant have?" | BLE battery characteristic |
| "Remind me to call the supplier Friday" | reminder write |
| "What's on my calendar tomorrow?" | calendar read |

## Tier 3 — Answerable from the world

Free — Anthropic hosts these, no implementation.

| Users ask | Needs |
|---|---|
| "What's the weather tomorrow?" | `web_search` server tool |
| "Is that restaurant still open?" | `web_search` |

## Tier 4 — Answerable only with another person's consent

**This is where "where's my kid" lands, and it is not one question.**

### 4a. Recall — works today, Tier 1

> "Where's my kid?" → *"At 7:40 this morning she said she was going to Maya's
> after school and would be back by six."*

The pendant overheard the plan. This is transcript search, it needs no new
infrastructure, and it is genuinely the most useful answer for most everyday
asks. **Build this first.** It is often what the person actually wants.

### 4b. Live location — a separate product surface

> "Where's my kid?" → *"At Lincoln Middle School, as of 4 minutes ago."*

This requires the kid to carry a device that shares its location. The pendant
contributes nothing. What it needs:

- Per-user accounts (the backend currently has one shared device token)
- An explicit, revocable sharing grant from the person being located
- The located person seeing both *who* can locate them and *when* they did

That last point is the difference between Find My and stalkerware. Location
sharing that the subject cannot see is the defining property of the abusive
version, and family-tracking products are a well-documented vector for
intimate-partner surveillance. A teenager who cannot tell they are being
tracked, or cannot revoke it, is the failure case to design against — so the
audit log and the revoke control are load-bearing features, not compliance
decoration.

For a young child who cannot meaningfully consent, the custodial parent grants
it. The visibility requirements do not relax; they just get exercised later,
and the product should be honest with the child as soon as they are old enough
to ask.

**Not building:** any hidden or disguised tracking mode, tracking someone who
has not granted it, or a grant that cannot be revoked from the tracked device.
Those are the same feature as the legitimate one minus the consent, which is
exactly what makes them stalkerware.

### 4c. Cross-user transcript access

> "What did my wife say about the trip?" — from *her* pendant.

Do not build this. Even with both parties consenting, it turns one person's
ambient recording into another person's search index, and neither of them can
consent on behalf of the third parties the microphone picked up.

---

## The consent problem underneath all of it

An always-on pendant records people who never agreed to be recorded. That is
true of every Tier 1 answer, not just the exotic ones.

Two-party consent applies in roughly 11 US states. Beyond the legal exposure,
the design questions are real: the recording indicator has to be visible to the
room rather than just the wearer, and there needs to be a fast way to purge a
conversation somebody objects to after the fact.

Worth deciding before launch, not after.

---

## What this implies for the code

1. **Transcript retrieval becomes a tool.** Context-stuffing does not survive a
   week of real use.
2. **The phone reports state** — location, battery, time — through a small
   endpoint the model can query.
3. **`web_search` gets switched on.** It is one line and covers all of Tier 3.
4. **Family location waits for real auth**, and ships with the audit log and the
   revoke path in the first version rather than a later one.
