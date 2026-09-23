# The cost pass (2026-09-22)

What was done to bring a person's day from about $0.53 to $0.17 or under
without making the voice worse, and what the numbers said. The brief is in
`docs/cost-cut-prompt.md`; the device checklist for the parts that can only be
seen on a phone is `docs/cost-pass-testflight.md`; engine latency and the
prompt shape are in `docs/voice-latency.md`.

Every price here is list price on the day (`jarvis/api/src/pricing.ts`, with
the date each was checked). "Measured" means read back from `usage_daily`,
Cloudflare's analytics, or a benchmark run against production; "estimate"
means worked out from a measured rate and an assumed day.

## Where the money went before

Cloudflare's own analytics and the Worker's logs for the heaviest account,
2026-09-21 (`scripts/usage-report.mjs`):

| line | a heavy day | share | how it was counted |
|---|---|---|---|
| microphone streamed to Deepgram (Nova-3 live, $0.0048/min) | ≈ $1.80 | ≈ 70% | hours the phone kept the socket open, all day, whatever was said |
| replies spoken (Aura-2, $0.030/1K chars) | ≈ $0.35 | ≈ 14% | characters voiced, fillers and nags included |
| reply models (gpt-oss-120b on Workers AI; Gemini free tier) | ≈ $0.30 | ≈ 12% | ≈ 7K input tokens per spoken reply, 12K typed, 1.7-2.1 model calls each |
| server (Workers requests, D1 reads and writes, log rows) | ≈ $0.13 | ≈ 5% | 3.8M D1 reads in a day before Phase 0; 90,103 device_logs rows in 24 h |
| **total** | **≈ $2.58** | | one person, a long day with the mic on |

$0.53 was the average across everyone, most of whom had shorter days. The
microphone line was the one to move: everything else together was under a
third.

## What changed, phase by phase

**0. Ship what was waiting.** The many-users pass (migration 0032, one D1
read per request instead of dozens) went out first.

**1. Count it.** `usage_daily` holds, per person per day, model tokens
(input, cached, output) by model, voiced characters by engine, clip seconds,
microphone seconds the phone reports, searches, and turns, each priced at the
list price of the day. `GET /debug/usage?days=7` reads everyone; Dev tools →
Usage today reads your own.

**2. Switch engines without a deploy.** GLM (Z.ai, `GLM_API_KEY`) joined
Gemini, DeepSeek and Workers AI; `server_settings` holds the order for typed
and spoken turns, the Workers model, the voice engine and the clip
transcriber, cached a minute, overridable per person; Dev tools has the
picker. `docs/voice-latency.md` has the benchmark.

**3. Nothing streams until the name.** A native module hears the assistant's
name on the phone (Apple's on-device recognition, never Apple's servers,
never ours), keeps four seconds of audio ready, and opens Deepgram only for
the name, the band's button, a follow-up window after a reply, and while a
reply is thought out or read. The old always-open way stays as the fallback
on phones that can't run it, with a ten-minute auto-off and an hour a day.
The phone reports every streamed second to `usage_daily`.

**4. Choose the voice.** Deepgram Aura-2 stays the default. Workers AI's
Aura-2, Aura-1 and MeloTTS and the phone's own voice are a setting away. A
sentence voiced once is served from the Workers cache the next time anyone
needs the same one; fillers and nags come from the chosen engine.

**5. Choose the clip transcriber.** Whisper on Workers AI
(`STT_CLIP_ENGINE=workers-whisper`, $0.0005/min) with Deepgram as the fallback.
Deepgram stays the default; see the clip benchmark below.

**6. Fewer input tokens.** Typed turns carry a core of 31 tools instead of
all ~55 (the rest arrive through `more_tools`, or from the start when the
request names one); instructions for tool families that aren't carried leave
the prompt with them; the money instructions have a short spoken form;
history is 16 messages cut at 800 characters (was 30 whole ones); memories
are capped at 60 and compacted by the memory update when they pass it; tool
results are cut at 6,000 characters (was 12,000), and mail and calendar
lists are trimmed before that.

**7. Fewer log rows.** A release build uploads warnings, errors and one
timing line per turn and per listening session; everything else stays on the
phone and goes up with a crash, a bug report, or Dev tools → Send logs. No
log line carries what was said any more, only how long it was. One unread
index on `device_logs` is dropped (migration 0035).

**8. A ceiling.** `TURN_CAP_MONTHLY` (1000; 0 turns it off) replies per
person per calendar month, counted from `usage_daily`. At 80% the person is
told once, on the end of a reply; past it they hear one sentence saying when
it resets. `DEV_EMAILS` accounts are never capped. Nothing checks membership.

**9. Cache what the world says.** Web search answers are kept for half an
hour and a reply may search twice; `SEARCH_ENGINE` picks Gemini's grounding
or DuckDuckGo. The commute's drive times are kept for half an hour per
rounded origin and destination, addresses for a day, and the public router
and geocoder are never asked twice in a second.

## After

### Tokens per reply (Phase 6), production, gpt-oss-120b on Workers AI

`scripts/engine-bench.mjs`, the same ten spoken and ten typed requests on a
fresh throwaway account before (2026-09-22, morning) and after the pass
(2026-09-22, evening), Workers AI both times:

| | spoken before | spoken after | typed before | typed after |
|---|---|---|---|---|
| input tokens per reply | 7,581 | **6,022 (−21%)** | 12,061 | **8,793 (−27%)** |
| input tokens per model call | 3,591 | 2,853 (−21%) | 6,892 | **4,690 (−32%)** |
| model calls per reply | 2.11 | 2.11 | 1.75 | 1.88 |
| output tokens per reply | 112 | 100 | 170 | 153 |
| first sentence | 1.9 s | 2.0 s | 2.9 s | 2.7 s |
| list price per reply | $0.0027 | $0.0022 | $0.0043 | $0.0032 |

Across the twenty requests that is 25% fewer input tokens per reply on an
account with no history and no memories, which is where the benchmark has
to run. The brief asked for 30%. Where the rest is:

- History. The one account with a real conversation (505 messages, 106
  characters each on average) used to send its last 30 messages on every
  typed turn and now sends 16: about 1,500 characters (≈ 400 tokens) less
  per typed reply there, which the benchmark can't see. Only three messages
  in the whole table are over the 800-character cut.
- Memories. Nobody has more than 26 yet, so the cap at 60 and the
  compaction have not had anything to do.
- Rounds. "Cancel my seven o'clock alarm" went from four model calls
  (16,163 tokens) to three (8,839): the alarm tools were loaded from the
  words instead of through two more_tools calls. Typed calls per reply rose
  a little (1.75 to 1.88) because one request looked in two places.
- Cache. Workers AI reports no cached tokens for gpt-oss (0% both runs).
  The GLM benchmarks in `docs/voice-latency.md` showed 71–76% of input
  tokens served from cache, which is what the byte-identical prefix is for.

Two of the twenty turns went wrong after the pass, both on the model's
side rather than the prompt's: one spoken request timed out at the
benchmark's limit (a Workers AI stall; the same request answered in 3.5 s
before), and gpt-oss answered "Show me Mom's contact details" with a leaked
chain of thought instead of calling the contact search it had. The same
model got that one right in the morning; it is a known gpt-oss habit, not a
missing tool.

### Clip transcription (Phase 5), production, 2026-09-22

`scripts/clip-bench.mjs` sent the same four clips (two from the band as WAV,
two from the phone as M4A) through both transcribers:

| clip | Deepgram Nova-3 | Whisper turbo (Workers AI) |
|---|---|---|
| ovoa1.wav (a spoken reply, 4.5 s) | 515 ms: "I can handle that. I found an opening at 04:30. Want me to move it?" | 2,751 ms: same words, "430" for the time |
| ovoa1.m4a | 303 ms: "Can handle that. I found an opening at 04:30…" (dropped the "I") | 748 ms: "I can handle that…" |
| rachel2.wav ("Yes.") | 129 ms | 584 ms |
| rachel2.m4a | 117 ms | 954 ms |
| price | $0.0043/min | $0.0005/min |

Whisper heard every clip right (once better than Deepgram) but takes two to
five times longer: half a second to nearly three. Four clips is not proof, so
**Deepgram stays the default** as the brief asked; Whisper is a Dev tools tap
away (`stt_clip_engine`), and the fallback to Deepgram is in place if it ever
fails. On a band turn that already takes nine to thirteen seconds, the extra
second is the whole difference in cost: eight and a half times cheaper.

### Server (Cloudflare analytics, `scripts/usage-report.mjs`)

| day | Worker requests | D1 rows read | D1 rows written | gpt-oss input tokens |
|---|---|---|---|---|
| 2026-09-21 (before) | 12,483 | 4,422,950 | 85,955 | 1,051,513 over 331 calls (3,177 per call) |
| 2026-09-22 (Phase 0 landed mid-day) | 4,370 | 3,849,088 | 138,651 | 443,744 over 151 calls (2,939 per call) |
| 2026-09-23 (first hours after the pass) | 182 | 30,751 | 1,972 | — |

The 9-22 rows are mostly the morning before Phase 0 went out plus the
benchmark runs; 9-23 is the first clean stretch and is what a quiet night
costs now. D1 rows read per request went from about 350 to about 170 and
should settle lower as the day's cached settings and usage rows do their job.

### The day, before and after

The same heavy day as the first table (40 spoken replies, 20 typed, the
microphone on all day), priced at list with what was measured above. The
microphone line after the pass is an estimate until a phone has run the
native ear: 40 replies at the target of 30 streamed seconds each plus a
ten-second follow-up window is 27 minutes.

| line | before | after | what changed | measured or estimate |
|---|---|---|---|---|
| microphone | 8 h × $0.0048 = **$2.30** | 27 min × $0.0048 = **$0.13** | streams only after the name (Phase 3) | estimate: rate measured, minutes not yet seen on a device |
| replies spoken | 13,200 chars × $0.030/1K = **$0.40** | **$0.40** (Aura-2 kept); $0.20 on Aura-1; ≈ $0 on the phone's voice | voice is a setting; identical sentences cached | measured rate; cache hits not yet counted on a real day |
| reply models | 40 × $0.0027 + 20 × $0.0043 = **$0.19** | 40 × $0.0022 + 20 × $0.0032 = **$0.15** | 25% fewer input tokens per reply (Phase 6) | measured, production benchmark |
| server | **$0.13** | **≈ $0.05** | 90,000 log rows a day to under 2,000 (Phase 7); D1 reads per request halved (Phase 0) | estimate from the analytics above |
| **the heavy day** | **$3.02** | **≈ $0.73** | | |

For the average person, who was $0.53 a day with the microphone as 70% of
it: the same arithmetic gives about **$0.18** with today's defaults (mic
≈ $0.02, voice ≈ $0.07, models ≈ $0.06, server ≈ $0.02), and under $0.17
with any one of Aura-1, the phone's voice, or GLM for typed turns. The
target is met on paper and hangs on Phase 3 doing on a phone what it does
in the wake-window tests.

## What was and wasn't checked on a phone

The server side of every phase ran through the unit tests (`npm test`) and
the smoke suite (`npm run smoke`, a local Worker and a fresh database) and
was deployed. The app typechecks and its pure logic (the wake window, the
daily meter, the name counter) is unit-tested from the server's test runner.

Not yet seen on a device: the native ear itself (Phase 3), the phone's own
voice (Phase 4), the release log policy's row count (Phase 7). Those need the
TestFlight build the push starts; `docs/cost-pass-testflight.md` says what to
look for, and `device_logs` is where the answer will be.

## Decisions for you

1. **Voice engine.** Deepgram Aura-2 is still the default. Workers AI's
   Aura-2 is the same voice at the same list price; Aura-1 is half; MeloTTS
   is a hundredth and sounds like it; the phone's voice is free. Try them
   from Dev tools before choosing.
2. **Reply engine.** `GLM_API_KEY` is set. GLM on Z.ai is the cheapest, but
   its first spoken word is five to ten seconds away; gpt-oss-120b on Workers
   AI stays the spoken engine until that changes. Typed turns could go to GLM
   today (Dev tools, or `PUT /debug/engines`).
3. **The cap.** 1000 replies a month is the default; it is one number in
   `wrangler.jsonc`.
4. **Search.** Gemini's grounding is free up to 5K a month on a paid key and
   $14/1K after; the key in use is free tier, so DuckDuckGo is what usually
   answers. A paid search provider was not added (no new keys).
5. **Routing.** OSRM's demo router and Nominatim are public courtesies with a
   one-request-a-second rule, now cached and spaced. A paid routing provider
   was not added.

## Switching

GLM's key is already in production (`wrangler secret put GLM_API_KEY`, done
2026-09-22). To put GLM first for typed turns without a deploy:

```bash
curl -X PUT https://api.ovoa.ai/debug/engines -H "x-debug-key: $DEBUG_KEY" -H "content-type: application/json" -d '{"engine_order":"glm,gemini,deepseek,workers"}'
```

Or Dev tools → Which engine answers, for just you or for everyone. The
model and host are `GLM_MODEL` and `GLM_BASE_URL` in `wrangler.jsonc`.
