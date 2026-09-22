# Cost pass: what to check on the phone

Everything below runs on a TestFlight build made from commit `main` after the
cost pass (2026-09-22). Nothing here can be checked from Windows; the numbers
land in `device_logs` and in Dev tools, and Claude reads them from there.

Open **Settings → Developer → Sensors, inputs & ES100** (Dev tools) first: the
new blocks are **Usage today** (what today has cost, as the server counted it)
and, for a development account, **Which engine answers**.

## 1. Nothing streams until the name (the big one)

1. Turn the orb on in wake mode (the default listening mode) and leave the
   phone on the table for ten minutes with a radio, a podcast or people talking.
2. Then say "OVOA, what time is it?" and let it answer.
3. Say the name mid-sentence: "So anyway, OVOA, set an alarm for seven." The
   whole request should be heard, not just "set an alarm for seven".
4. Straight after a reply, answer it without the name ("yes please" / "and
   cancel it") within about eight seconds.
5. Press the band's button and ask something, without the name.
6. Turn the orb off.

What it shows: Dev tools → Usage today → **mic streamed** should be well under
a minute for the whole exercise, not ten minutes. The log lines to look for
(no words in any of them): `the phone's ear is listening for "OVOA"`,
`woke (name); opening live transcription`, `live transcription connected · N ms`,
`back to listening on the phone · N s of audio sent this time`, and at the end
`live transcription closed · N s of audio sent over N wakings`. A line saying
`can't hear the name on the phone; listening the old way` means the phone
fell back to the old way (see 3).

Say how many times it woke when it shouldn't have (false wakes) and how many
times you said the name and nothing happened (missed wakes). Both are the
thing to tune; the old fuzzy match and the phone's recogniser both get a vote.

## 2. The first word

Ask a few things and read **Turn timings** in Dev tools. "answer" is from the
end of your sentence to the first word out loud. It should not be slower than
before: the connection now opens on the name, with a token fetched ahead, so
the log's `live transcription connected · N ms` line is the extra wait.

## 3. The old way still works, with limits

Only if the phone fell back (an older iPhone, or on-device recognition not
allowed): the orb still listens as before, but after ten minutes with nothing
said to OVOA it stops and says so on screen, and after an hour of streaming in
a day it stops for the day.

## 4. Voices

Settings → Voice: tap each voice; every one should speak. In Dev tools, a
development account can switch the voice engine (Phase 4); the default stays
Deepgram Aura-2 until you choose.

## 5. Engines

Dev tools → Which engine answers: pick GLM for "just me", ask something typed
and something spoken, then put it back on the usual order. The reply's engine
shows in Turn timings.

## 6. Logs

After all of the above, Dev tools → Log uploads → **waiting** should be small
and the day's rows in `device_logs` for your device should be under two
thousand (Phase 7). Nothing in them should be a sentence you or anyone in the
room said.
