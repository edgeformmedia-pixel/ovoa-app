# Server-side calls (design)

Today OVOA "calls" someone by opening the iPhone's dialer (phone.ts `phone_call`, the app's `tel:` link):
the person talks, OVOA doesn't. Instinct-style assistants also call a business for you: "call the dentist
and move my cleaning to next week", "call these five plumbers and ask for a quote". This is how OVOA would
do that. Nothing here is built, because it needs a paid voice provider (a new provider and keys are the
owner's decision, docs/cost-cut-prompt.md).

## What it does

1. The person asks. OVOA proposes the call as an approval (pending_actions, tool `call_place`) that says
   exactly who, what number, and what OVOA will ask for or agree to. Nothing dials before YES.
2. On YES (approvers.ts `registerApprover("call_place", ...)`), the Worker asks the provider to place the
   call from OVOA's own number.
3. The call is a voice agent: it opens with "Hi, this is OVOA, an AI assistant calling for Sam Lee" (always:
   it never pretends to be a person), states the purpose, listens, answers only within the approved purpose,
   and ends politely. It never gives out anything not in the approval (no card numbers, no vault items unless
   the approval names them, e.g. "the booking name is Sam Lee").
4. Afterwards: a short summary and the outcome come back to the person by text or in the app ("Moved to
   Tuesday 3 PM, they'll send a confirmation text"), plus the transcript in the app for 14 days.
5. If the other side asks for something outside the purpose (a deposit, a different day, personal details),
   the agent says it will check and call back, and asks the person by text.

## Pieces

- Provider: Twilio Programmable Voice with Media Streams (a websocket of the call's audio), or a hosted
  voice-agent API (Vapi, Retell, ElevenLabs Agents) that takes a prompt and a phone number. The hosted route is
  far less code; Twilio is cheaper per minute and keeps the brain on OVOA's own engines.
- Brain: the same model order as spoken turns (GLM on Workers AI, then Gemini), with a call prompt and NO
  tools except `end_call` and `note` (what they said). Turn-taking can reuse turnGate.ts ideas.
- Voice: Deepgram Aura 2 (already TTS_ENGINE) for speaking; Deepgram or Workers AI for listening.
- A Durable Object per live call (like GameRoom) holds the websocket and the transcript.

## Guardrails (in code)

- Approval required for every call; the agent (background) may never place one alone (FORBIDDEN_ALONE).
- Calls only to numbers the person gave or picked, and only businesses or their own contacts; never
  do-not-contact numbers (keywords.ts).
- Daytime only in the callee's time zone when known (9 AM to 8 PM), at most 10 calls per person per day,
  at most 5 minutes each, and a per-call cost cap on the plan's spend gate (plans.ts).
- Always discloses it's an AI in the first sentence. Recording and transcripts only where one-party
  consent is fine, or it says "this call may be recorded" first (safest: always say it).
- Never agrees to pay, sign up, or share card, bank, SSN or password details on a call.

## Cost (rough, check current pricing)

Per 2-minute call: provider minutes about $0.03, speech in about $0.02, speech out about $0.02, model a
cent or two on GLM: about 7 to 10 cents a call. A campaign of 50 calls is about $4 to $5, which the plan's
daily spend limits already bound.

## Order to build, once the owner picks a provider

1. `call_place` tool + approval card + approver (no provider yet: it texts "calls aren't set up").
2. Provider client behind a flag (secrets: account id, token, from number), status webhook, summary text.
3. The live call agent (Durable Object + media stream), with the disclosure line and the tool-less prompt.
4. Campaign mode `calls` (campaigns.ts) reusing the same approval and caps.
