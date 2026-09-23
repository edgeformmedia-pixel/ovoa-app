// The cost arithmetic, checked on fixed numbers. Every figure the final report
// quotes comes through these functions, so a slip here (dollars where micro
// were meant, cached tokens counted twice) would be a wrong report with a
// confident face on it.

import {
  glmPriceFrom,
  llmCostMicro,
  priceFor,
  sttCostMicro,
  ttsCostMicro,
  usd,
} from "../src/pricing";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${got}${ok ? "" : `  (wanted ${want})`}`);
}

const today = new Date("2026-09-22T12:00:00Z");

// ---------- Tokens to money ----------

// A million input tokens on Gemini 3.5 Flash-Lite is $0.30 exactly.
eq("a million tokens is the list price", llmCostMicro("gemini-3.5-flash-lite", { input: 1_000_000, output: 0 }, today), 300_000);
eq("output is priced separately", llmCostMicro("gemini-3.5-flash-lite", { input: 0, output: 1_000_000 }, today), 2_500_000);
// A typical reply: 11.4K in, 350 out ≈ $0.0043 on Flash-Lite.
eq("one typical reply on Flash-Lite", llmCostMicro("gemini-3.5-flash-lite", { input: 11_400, output: 350 }, today), 4_295);
eq("an unknown model costs nothing rather than throwing", llmCostMicro("nope", { input: 100, output: 100 }, today), 0);

// Cached tokens are part of `input`, charged at the cached rate, never twice.
eq(
  "cache hits are cheaper on Gemini",
  llmCostMicro("gemini-3.5-flash-lite", { input: 10_000, cached: 8_000, output: 0 }, today),
  // 2,000 fresh at $0.30/M + 8,000 cached at $0.03/M = 600 + 240 micro
  840,
);
eq(
  "cached cannot exceed input",
  llmCostMicro("gemini-3.5-flash-lite", { input: 1_000, cached: 5_000, output: 0 }, today),
  // all 1,000 at the cached rate
  30,
);
eq("no cached rate means the input rate", llmCostMicro("x", { input: 1_000, cached: 1_000, output: 0 }, today, { in: 0.35, out: 0.75 }), 350);

// ---------- Dates ----------

eq("Gemini 3.8 Flash doubles on New Year's Day", priceFor("gemini-3.8-flash", new Date("2027-01-01T00:00:00Z"))?.in, 1.5);
eq("and not the day before", priceFor("gemini-3.8-flash", new Date("2026-12-31T23:59:00Z"))?.in, 0.75);
eq("Flash-Lite does not double: Google names no 2027 price for it", priceFor("gemini-3.5-flash-lite", new Date("2027-01-01T00:00:00Z"))?.in, 0.3);
eq("nor does its output", priceFor("gemini-3.5-flash-lite", new Date("2027-06-01T00:00:00Z"))?.out, 2.5);

// ---------- Overrides ----------

const glm = glmPriceFrom({ GLM_PRICE_IN_PER_M: "0.10", GLM_PRICE_OUT_PER_M: "0.40" });
eq("GLM in from the var", glm.in, 0.1);
eq("GLM out from the var", glm.out, 0.4);
eq("GLM cached keeps its default", glm.cachedIn, 0.06);
eq("a garbage var keeps the default", glmPriceFrom({ GLM_PRICE_IN_PER_M: "cheap" }).in, 0.06);
eq("an override replaces the table", llmCostMicro("glm-5.3-flash", { input: 1_000_000, output: 0 }, today, glm), 100_000);
eq("the GLM default is Z.ai's price", glmPriceFrom({}).out, 0.2);

// ---------- Speech ----------

eq("Aura-2 direct: $0.030 per 1K chars", ttsCostMicro("deepgram-aura-2", 1000), 30_000);
eq("the phone's voices are free", ttsCostMicro("device", 5000), 0);
// The Sept 21 baseline: 11,871 chars on Aura-2 ≈ $0.36.
eq("a heavy day of Aura-2", usd(ttsCostMicro("deepgram-aura-2", 11_871)), "$0.36");
eq("a minute of live Nova-3", sttCostMicro("deepgram-nova-3-live", 60), 4_800);
// The Sept 21 baseline: 380 minutes streamed ≈ $1.82.
eq("a day of the mic streaming", usd(sttCostMicro("deepgram-nova-3-live", 380 * 60)), "$1.82");
eq("a minute of a recorded clip", sttCostMicro("deepgram-nova-3-clip", 60), 4_300);
eq("an unknown engine costs nothing", sttCostMicro("nope", 60), 0);

// ---------- Printing ----------

eq("dollars", usd(530_000), "$0.53");
eq("tiny amounts keep their digits", usd(4_800), "$0.0048");
eq("nothing", usd(0), "$0");

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
