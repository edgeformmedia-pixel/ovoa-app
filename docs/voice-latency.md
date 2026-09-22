# Where a spoken turn's seconds go

Measured from `device_logs` on 2026-09-20 (build `1.0.0 ios release`), band
turns — the clip's own microphone, which is the slow path, because nothing can
start until the recording has crossed Bluetooth.

## The legs of one turn

Times below are from the second button press (the user has stopped talking) to
the first word out of the phone's speaker.

| Leg | Measured | Notes |
| --- | --- | --- |
| Press → download starts | 150–250 ms | the clip has to stop and close the file first |
| Fetch over Bluetooth | 1.7–2.4 s | 470–590 ms to the first byte, then 11–20 KB/s |
| Opus → WAV decode | 350–560 ms | on the phone, in `OpusWav.swift` |
| Upload + Deepgram | 730–990 ms | 300–580 KB of 16 kHz WAV for 10–19 s of speech |
| Model, first call | 0.8–12.4 s | median ~3.5 s; 32.5k prompt chars, 50 tools |
| Phone lookup + second call | +1.1–4.4 s | only when it needs contacts, calendar or Health |
| First voice clip | ~540 ms | Deepgram Aura 2 |

**Typical: 8–12 s.** Two of the six band turns in that session never answered
at all — one `POST /chat` died after 57 s with "the network connection was
lost", one came back `Gemini 503: high demand`. Both were silent from the
wrist: the LED went out and nothing else happened.

## What the turn now records

`app/src/lib/turnTimer.ts` holds one open turn at a time. Each leg marks
itself where it happens — `clip.ts` after the transfer, `voice.ts` after
transcribing and when audio first plays, `assistant.tsx` around the model and
the phone lookups — and the turn ends with a single `perf` line:

```
perf  band turn 8.4 s after you stopped speaking
      you talk into the clip 18.5 s · stopped talking 0 ms · fetch from the clip 2.7 s (36 KB, 19946 B/s, 354 ms decode) ·
      transcribe 854 ms (579 KB uploaded) · model answers 3.9 s · first word out loud 541 ms
      server {"engine":"gemini","ms":3932,"firstTokenMs":3792,"promptChars":32501,"toolCount":50,"tools":[...]}
```

It lands in `device_logs` like everything else, and **Dev tools → Turn
timings** shows the last dozen turns on the phone, with the median answer time
at the top. The server logs the matching half: every tool it ran and what each
cost, plus which section of the prompt is big (`prompt: base 412, voice 1180,
phone 3900, google 9100, agent 7300, tools 11000, history 2400`).

## Already done

- **The wrist answers immediately.** One buzz when the recording stops, two on
  a failure. Before this the only feedback was the LED going out.
- **A word while it thinks.** If nothing has been streamed 2.2 s after the
  question goes out, the speaker says a short line ("One sec.") and the answer
  plays straight after it, through the same queue.
- **Failures are spoken.** A lost connection or a busy model now says so from
  the wrist instead of going quiet (`excuse()` in `assistant.tsx`).
- **A line before the lookup.** Voice turns ask the model to write four words
  ("Checking your calendar.") in the same turn as a tool call. Text written
  alongside a tool call is streamed, so it's spoken while the lookup runs —
  which is the difference between 4 s of silence and 4 s of being answered.
- **A spoken reply that sounds spoken.** The voice prompt now asks for the
  answer in the first sentence, contractions, no "Certainly", and a short
  confirmation rather than a recital of every field.

## Done on 2026-09-22 (not yet measured on a phone)

- **A prompt the engines can reuse.** The clock and today's step counts sat
  ~200 characters into the system prompt and changed every minute, so no
  engine's prompt cache (DeepSeek's context cache, Gemini's implicit cache,
  Workers AI's prefix cache) could reuse the ~5.8k of instructions and ~7.5k of
  tool JSON behind them. They now ride on the latest message instead, and the
  system prompt is ordered from what never changes to what changes most.
- **Same model server for the same person.** Workers AI calls carry
  `x-session-affinity: ovoa-<user>`, which routes a person's turns to the
  server still holding their prompt.
- **The server voices the reply.** With `speak: { voice }` on a streamed
  `/chat`, each piece is sent to Deepgram the moment the model writes it and
  the mp3 comes down the same stream (`{"type":"audio"}` lines after a
  `{"type":"voice","on":true}` acknowledgement). That removes a phone→server
  round trip and a sign-in check from the first word, and one request per
  sentence. Builds that don't ask are untouched; a piece the server can't voice
  arrives as words and the phone voices it itself.
- **The first clause goes early.** A long opening sentence is sent at its
  first pause ("Your dentist is tomorrow afternoon,") instead of after its full
  stop.
- **Less before the model starts.** Sessions are cached in memory for a
  minute (no database read per `/voice/speak` or `/logs`), and the Google
  account list is read alongside the settings instead of after them.
- **Half the model calls.** The memory pass after each reply only runs when
  the message is about the person (first person, "remember", "forget"), so it
  no longer spends the Workers AI allowance voice turns answer on first.

To check these on the phone: `first voiced piece after N ms` in device_logs
is the new number to watch, next to `first sentence after`.

## Worth trying next, in the order the numbers justify

1. **The model is the biggest and the most variable leg** (0.8–12.4 s). The
   prompt is 32.5k chars and 50 tools; per-section sizes now go into the log,
   so the next pass can trim the section that is actually paying for it rather
   than guessing. Gating the shortcut-writing and agent job-management tools
   out of voice turns would cut the tool list by ~12 without touching anything
   a spoken question normally asks for.
2. **Send opus, not WAV.** The phone decodes the clip's opus to a 580 KB WAV
   and uploads that; Deepgram takes opus directly. Wrapping the frames in an
   ogg container instead would drop the upload ~16× and skip the 350–560 ms
   decode. Costs a change in `OpusWav.swift`.
3. **The two-call shape.** A turn that needs the phone pays the prompt twice.
   Sending the day's calendar and recent contacts with the question, for the
   questions that almost always need them, would collapse it to one call.
4. **Watch the buzz.** The "heard you" buzz goes out on the same Bluetooth
   link the recording is about to come over. The fetch mark carries B/s, so if
   the transfer rate drops after this change, move the buzz to after the
   download.
