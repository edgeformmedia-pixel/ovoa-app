# Reply engines, measured

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

## What the numbers say

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

## After Phase 6 (prompt shape, measured locally on a fresh account, 2026-09-22)

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

## Recommendation

Keep today's order until DeepSeek has credit and Phase 6 has landed, then
measure again with the smaller prompt. If GLM's tool calling on typed turns
recovers with fewer tools, `glm,deepseek,gemini,workers` for typed turns and
Workers AI first for spoken turns is the cheapest arrangement that keeps the
first word under three seconds. If it does not, gpt-oss-120b on Workers AI
stays the spoken engine and GLM is the typed one.

Switching is a Dev tools tap or one request, no deploy:

```bash
curl -X PUT https://jarvis-api.edgeformmedia.workers.dev/debug/engines \
  -H "x-debug-key: $DEBUG_KEY" -H "content-type: application/json" \
  -d '{"engine_order":"glm,deepseek,gemini,workers","voice_engine":"workers"}'
```
