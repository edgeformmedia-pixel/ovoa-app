// Web search (web.ts) when Gemini's grounding is failing. It answered 403
// PERMISSION_DENIED all of 2026-09-23, and every search paid 270-350 ms to find
// that out before DuckDuckGo was asked anyway: grounding now rests after a
// failure like that, and searches go straight to DuckDuckGo meanwhile.

import { forgetGroundingRest, searchWeb } from "../src/web";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(got)}${ok ? "" : `  (wanted ${JSON.stringify(want)})`}`);
}

const DDG = '<div class="result__body"><a class="result__a" href="#">Austin weather</a><a class="result__snippet" href="#">Sunny, 31 degrees.</a></div>';
const env = { GEMINI_API_KEY: "key", CHAT_MODEL: "gemini-test" } as never;

let asked: string[] = [];
let geminiStatus = 403;
globalThis.fetch = (async (url: string) => {
  const host = new URL(String(url)).hostname;
  asked.push(host.includes("googleapis") ? "gemini" : "duckduckgo");
  if (host.includes("googleapis")) return new Response('{"error":{"status":"PERMISSION_DENIED"}}', { status: geminiStatus });
  return new Response(DDG);
}) as typeof fetch;

async function main() {
  const quiet = console.error;
  console.error = () => {};

  forgetGroundingRest();
  const first = await searchWeb(env, "u", "weather in Austin", "Wednesday");
  eq("a refused key: Gemini tried, then DuckDuckGo", asked, ["gemini", "duckduckgo"]);
  eq("and the answer is DuckDuckGo's", first.via, "duckduckgo");
  asked = [];
  await searchWeb(env, "u", "is the pharmacy open", "Wednesday");
  eq("the next search doesn't ask Gemini while it rests", asked, ["duckduckgo"]);

  forgetGroundingRest();
  geminiStatus = 200;
  asked = [];
  await searchWeb(env, "u", "weather in Austin", "Wednesday").catch(() => null);
  eq("after the rest, grounding is tried again", asked[0], "gemini");

  console.error = quiet;
  if (fails) {
    console.log(`\n${fails} failed`);
    process.exit(1);
  }
  console.log("\nall passed");
}

void main();
