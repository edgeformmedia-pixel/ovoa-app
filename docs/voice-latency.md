# Reply engines, measured

## 2026-09-23: spoken turns go to GLM on Workers AI

v1 shipped with GLM 5.3 Flash on Z.ai first for everything and Gemini second.
Spoken turns then took 8-23 s, and the model's own wait was most of it: Z.ai
cannot switch GLM 5.3's thinking off (its floor is `reasoning_effort: "low"`),
so every round reasons before it writes a word, and first content per round in
production was 4.5-6.6 s. Gemini, the fallback, answers 403 PERMISSION_DENIED,
so one Z.ai timeout left nothing to answer at all.

The same model on Cloudflare Workers AI (`@cf/zai-org/glm-5.3-flash`), probed
from this machine with an OpenAI-style body: a 6.7K-token prompt carrying 15
tools, streamed.

| host | thinking field sent | reasoning | first word |
|---|---|---|---|
| Z.ai | `reasoning_effort: "low"` (the floor; "disabled" is refused for 5.3) | yes | 4.5-6.6 s (production, per round) |
| Workers AI | `reasoning_effort: "low"` | **none** | **0.66-1.5 s** |
| Workers AI | none (the model's default) | yes | 1.8-5 s |
| Workers AI | `thinking: {type: "disabled"}` (Z.ai's spelling) | yes | 1.8-5 s |
| Workers AI | `chat_template_kwargs: {enable_thinking: false}` | written **into the reply** ("The user is asking two things...") | never use |

On Workers AI with `"low"`, tool calls (alarm_set, web_search) were complete in
1.0-1.8 s, and three calls at once were no slower than one. The last row is how
the pre-v1 Workers AI engine, which sent `chat_template_kwargs` for spoken
turns, came to give 761-token rambling replies (the table below).

A second probe the same evening went through `/ai/run/<model>`, which is what
the binding calls, with the exact inputs `llm.ts` now sends (`reasoning_effort:
"low"`, `stream_options.include_usage`, tools, `x-session-affinity`): no
reasoning at all, first output 0.77-1.2 s from here, OpenAI-style deltas for
text and tool calls, and the counts on a last `{"response": "", "usage": …}`
chunk. The second call with the same affinity read 1,536 of its 1,546 prompt
tokens from the cache.

### The arrangement (`jarvis/api/src/llm.ts`)

- **Spoken turns:** Workers AI first (`VOICE_ENGINE`, default `workers`;
  `server_settings.voice_engine` overrides it, `keyed` means the typed order),
  then the typed order. If Workers AI has written neither a word nor a tool
  call 6 s in (`VOICE_FIRST_CONTENT_MS`), the turn moves on to the next engine,
  GLM on Z.ai, as long as one after it isn't cooling down or last refused for
  good. That deadline is Workers AI's alone: Z.ai's ordinary first word
  (4.5-6.6 s) sits right at it, so GLM first on a spoken turn (Workers AI
  cooling, or `voice_engine` set to `glm` or `keyed`) is waited for up to the
  20 s connect deadline, not cut off on to Gemini's 403.
- **Typed turns and everything in the background:** GLM on Z.ai, then Gemini,
  then Workers AI as the last resort, which keeps things answering while Gemini
  is refused.
- A paused turn (a phone lookup) resumes on the engine and model it paused on.
- The last engine able to answer is never cooled down for more than 3 s after
  a failure that can pass (a timeout, a 5xx, a 429 short of the quota), and
  when every engine is cooling the one back soonest is tried anyway. A key,
  credit, model or quota refusal keeps its full rest (10 or 30 min) even then;
  capped, Gemini's 403 was back before the engines that had only stumbled, and
  every call went to it.
- Each streamed round records when its headers, first event, first reasoning,
  first word, first tool call and end arrived (`LlmUsage.timing`), so the next
  slow turn says where its time went.

### Cost

Workers AI lists the model at $0.15 per million tokens in, $0.03 cached and
$0.50 out, against Z.ai's $0.06 in (cached or not) and $0.20 out. Each person's
calls share an `x-session-affinity`, so the stable front of the prompt
(instructions, tools, history) is read at the cached price: a 6.7K-token spoken
turn with 5K cached and 12 tokens out is $0.00041 on Workers AI and $0.00040 on
Z.ai (`test/pricing.test.ts`). Uncached it would be $0.0010.

## 2026-09-22: five engines compared

(The record below is from before v1. Its recommendation was overtaken by the
section above.)

Twenty production turns per engine on 2026-09-22 (ten spoken, ten typed), from
a throwaway account created and deleted by `jarvis/api/scripts/engine-bench.mjs`,
each account given its own engine through `server_settings`. Times are measured
from the phone's side of the request, in a Windows terminal, so they include
the network. "Tools right" counts turns that were expected to call a tool and
called the right one (phone lookups pause the turn and were answered with a
made-up result, as the app would). "$/reply" is at list price from the tokens
the engine reported (`meta.usage` on the reply), not an invoice.

| run | first token (median) | first sentence | total | tools right | answered | calls/reply | tokens in / out | $/reply |
|---|---|---|---|---|---|---|---|---|
| Workers AI gpt-oss-120b · spoken | 2.2 s | 2.3 s | 2.6 s | 7/8 | 9/10 | 1.9 | 6,823 / 101 | $0.0025 |
| Workers AI gpt-oss-120b · typed | 3.3 s | 3.6 s | 4.4 s | 6/8 | 8/10 | 1.7 | 11,692 / 161 | $0.0042 |
| Workers AI glm-5.3-flash · spoken | 0.6 s | 0.9 s | 6.0 s | 6/8 | 8/10 | 1.9 | 8,848 / 273 | $0.0007 |
| Workers AI glm-5.3-flash · typed | 1.9 s | 2.1 s | 3.3 s | 3/8 | 5/10 | 1.3 | 13,432 / 72 | $0.0010 |
| GLM 5.3 Flash via Z.ai · spoken | 5.7 s | 8.8 s | 9.4 s | 7/8 | 9/10 | 2.0 | 8,538 / 49 | $0.0005 |
| GLM 5.3 Flash via Z.ai · typed | 5.2 s | 5.3 s | 5.4 s | 3/8 | 5/10 | 1.3 | 11,819 / 30 | $0.0007 |
| DeepSeek deepseek-flash | not measured: the account is out of credit (402 Insufficient Balance), so every turn fell through to Workers AI gpt-oss-120b | | | | | | | |
| Gemini gemini-3.8-flash | not measured: the key is on the free tier (about 20 requests a day), which the app itself needs | | | | | | | |

The Z.ai price is the provider's own list price ($0.15 / $0.50 per million,
$0.03 cached); at the user's target provider price ($0.06 / $0.20) the same
turns come to about $0.0002 spoken and $0.0003 typed.

### What the numbers said

- **gpt-oss-120b on Workers AI** is the balanced choice today: first word in
  about two seconds, the right tool most of the time, $0.0025 a spoken reply.
  One spoken turn in twenty hit the 20-second connect deadline.
- **glm-5.3-flash on Workers AI** reaches the first word fastest (0.6 s
  spoken) and costs a quarter of gpt-oss, but it lets thinking run on spoken
  turns despite being asked not to (761 output tokens on one reply, 16 s), and
  on typed turns it usually answered without calling the tool it was asked for
  (3 of 8). Typed turns carry about seventy tool definitions; spoken ones
  carry nine. That gap is the likely cause and Phase 6 reduces it.
- **GLM 5.3 Flash via Z.ai** is the cheapest per reply and called tools on
  spoken turns as well as gpt-oss did, but Z.ai will not switch thinking off
  for the 5.3 models (their floor is "low"), so the first word takes five to
  ten seconds. Fine for typed turns if the tool-calling gap closes; too slow
  for the wrist as it stands.
- Every engine sends the same prompt, so input tokens are the same story
  everywhere: about 7K on a spoken turn and 12K on a typed one before Phase 6.

### After Phase 6 (prompt shape, measured locally on a fresh account, 2026-09-22)

Characters the model reads before its first word, from the `ovoa.prompt` log
line, same fresh account and phone capabilities as the benchmark above:

| turn | before | after | change |
|---|---|---|---|
| typed: instructions | 6,560 | 5,520 | families whose tools aren't carried leave the prompt |
| typed: tool JSON | 24,600 (all ~55 tools) | 14,600 (31 core + more_tools) | typed toolbelt |
| typed: total | 31,300 | 20,300 | **−35%** |
| spoken: instructions | 7,370 | 5,140 | shorter money prompt, uncarried families out |
| spoken: tool JSON | 7,530 (16) | 6,700 (14) | alarm_cancel, calendar_create, morning_brief ride along only when named |
| spoken: total | 15,000 | 11,850 | **−21%** |

Rounds also fell where the request names its tool: "cancel my seven o'clock
alarm" took four model calls before (two of them more_tools) and takes two
now, because the alarm tools are loaded from the words before the first call.
Tokens per reply in production are in docs/cost-pass.md.

### The recommendation then

Keep today's order until DeepSeek has credit and Phase 6 has landed, then
measure again with the smaller prompt. If GLM's tool calling on typed turns
recovers with fewer tools, `glm,deepseek,gemini,workers` for typed turns and
Workers AI first for spoken turns is the cheapest arrangement that keeps the
first word under three seconds. If it does not, gpt-oss-120b on Workers AI
stays the spoken engine and GLM is the typed one.

## Switching engines

A Dev tools tap or one request, no deploy. An order naming DeepSeek is ignored
since v1, so orders name only `glm`, `gemini` and `workers`; the engines an
order leaves out follow it. This one puts Workers AI ahead of Gemini for typed
turns, for as long as Gemini is refused:

```bash
curl -X PUT https://api.ovoa.ai/debug/engines \
  -H "x-debug-key: $DEBUG_KEY" -H "content-type: application/json" \
  -d '{"engine_order":"glm,workers","voice_engine":"workers"}'
```

`voice_engine` `keyed` sends spoken turns down the typed order; an empty value
clears a setting back to the vars (`ENGINE_ORDER`, `VOICE_ENGINE`).
