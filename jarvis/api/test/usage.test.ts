// The usage rollup, checked without a database: how each provider's token
// counts are read, and how rows fold into a day's totals. The report at the
// end of the cost pass is only as honest as these two things.

import { readGeminiUsage, readOpenAiUsage, type LlmUsage } from "../src/llm";
import { dayOf, foldRow, llmRow, sttStreamRow, ttsRow, turnRow, type DayTotals } from "../src/usage";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${got}${ok ? "" : `  (wanted ${want})`}`);
}

// ---------- Reading what each provider sends ----------

// DeepSeek: hits and misses, thinking counted in the output.
const deepseek = readOpenAiUsage({
  prompt_tokens: 11_400,
  completion_tokens: 900,
  prompt_cache_hit_tokens: 10_000,
  prompt_cache_miss_tokens: 1_400,
  completion_tokens_details: { reasoning_tokens: 550 },
});
eq("DeepSeek input is the whole prompt", deepseek?.input, 11_400);
eq("DeepSeek cached is the hits", deepseek?.cached, 10_000);
eq("DeepSeek output includes thinking", deepseek?.output, 900);
eq("DeepSeek says how much was thinking", deepseek?.reasoning, 550);

// OpenAI-style (Z.ai, OpenRouter): the hits are under prompt_tokens_details.
const openai = readOpenAiUsage({ prompt_tokens: 5_000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 4_000 } });
eq("OpenAI-style cached tokens", openai?.cached, 4_000);
eq("OpenAI-style output", openai?.output, 200);

// Workers AI: the plain three.
const workers = readOpenAiUsage({ prompt_tokens: 3_000, completion_tokens: 100, total_tokens: 3_100 });
eq("Workers AI has no cached count", workers?.cached, 0);
eq("Workers AI input", workers?.input, 3_000);

// DeepSeek with only hits and misses, no prompt_tokens: added up.
eq("hits plus misses when there is no total", readOpenAiUsage({ prompt_cache_hit_tokens: 30, prompt_cache_miss_tokens: 70, completion_tokens: 1 })?.input, 100);
eq("cached can't exceed input", readOpenAiUsage({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 50 } })?.cached, 10);
eq("nothing sent is null, not zeros", readOpenAiUsage(undefined), null);
eq("garbage is null", readOpenAiUsage("usage"), null);

// Gemini: thoughts are billed as output and are part of it.
const gemini = readGeminiUsage({ promptTokenCount: 8_000, candidatesTokenCount: 150, thoughtsTokenCount: 400, cachedContentTokenCount: 6_000, totalTokenCount: 8_550 });
eq("Gemini input", gemini?.input, 8_000);
eq("Gemini output is the answer plus the thinking", gemini?.output, 550);
eq("Gemini cached", gemini?.cached, 6_000);
eq("Gemini reasoning", gemini?.reasoning, 400);
eq("Gemini with no thoughts field", readGeminiUsage({ promptTokenCount: 10, candidatesTokenCount: 5 })?.output, 5);

// ---------- Rows ----------

const call: LlmUsage = {
  engine: "workers",
  model: "@cf/openai/gpt-oss-120b",
  inputTokens: 11_400,
  cachedTokens: 0,
  outputTokens: 350,
  reasoningTokens: 0,
  ms: 1200,
  userId: "u1",
  purpose: "voice",
};
const row = llmRow("u1", call);
eq("a call row is an llm_call", row.kind, "llm_call");
eq("filed under its model", row.model, "@cf/openai/gpt-oss-120b");
eq("and priced", row.microUsd, 4_253);
eq("a GLM row uses the provider's price", llmRow("u1", { ...call, engine: "glm" as never, model: "glm-5.3-flash" }, { in: 0.06, out: 0.2, cachedIn: 0.06 }).microUsd, 754);
eq("a turn row carries no cost", turnRow("u1", "workers", true).microUsd, undefined);
eq("a spoken turn is filed as voice", turnRow("u1", "workers", true).model, "voice");
eq("ten minutes of mic", sttStreamRow("u1", "deepgram-nova-3-live", 600, 2).microUsd, 48_000);
eq("a voiced sentence", ttsRow("u1", "deepgram-aura-2", "aura-2-thalia-en", 100).microUsd, 3_000);

// ---------- Folding a day ----------

const day: DayTotals = { day: "2026-09-21", turns: 0, llmCalls: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, ttsChars: 0, streamSeconds: 0, clipSeconds: 0, searches: 0, microUsd: 0, by: {} };
const base = { user_id: "u1", day: "2026-09-21", engine: "", model: "", n: 0, input_tokens: 0, cached_tokens: 0, output_tokens: 0, chars: 0, seconds: 0, est_micro_usd: 0 };
foldRow(day, { ...base, kind: "turn", engine: "workers", model: "voice", n: 92 });
foldRow(day, { ...base, kind: "llm_call", engine: "workers", model: "@cf/openai/gpt-oss-120b", n: 331, input_tokens: 1_051_513, output_tokens: 32_396, est_micro_usd: 392_326 });
foldRow(day, { ...base, kind: "tts", engine: "deepgram-aura-2", n: 200, chars: 11_871, est_micro_usd: 356_130 });
foldRow(day, { ...base, kind: "stt_stream", engine: "deepgram-nova-3-live", n: 40, seconds: 380 * 60, est_micro_usd: 1_824_000 });
foldRow(day, { ...base, kind: "stt_clip", engine: "deepgram-nova-3-clip", n: 14, seconds: 70, est_micro_usd: 5_017 });
foldRow(day, { ...base, kind: "search", engine: "gemini", n: 3 });
eq("turns are counted", day.turns, 92);
eq("calls are counted", day.llmCalls, 331);
eq("input tokens add up", day.inputTokens, 1_051_513);
eq("chars add up", day.ttsChars, 11_871);
eq("stream seconds add up", day.streamSeconds, 22_800);
eq("clips add up", day.clipSeconds, 70);
eq("searches are counted", day.searches, 3);
// The Sept 21 baseline day, priced: $0.39 + $0.36 + $1.82 + a cent of clips.
eq("the day's total is the baseline", Math.round(day.microUsd / 10_000) / 100, 2.58);
eq("the mic is most of it", day.by["mic"], 1_824_000);
eq("the AI line is named by engine", day.by["ai (workers)"], 392_326);

// ---------- Days ----------

eq("a day is UTC", dayOf(Date.UTC(2026, 8, 21, 23, 59)), "2026-09-21");
eq("and rolls at midnight UTC", dayOf(Date.UTC(2026, 8, 22, 0, 0)), "2026-09-22");

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
