// What the observability plumbing promises, checked without a Worker.
//
// Two of these are load-bearing in a way that does not announce itself. A
// fingerprint that fails to group turns "166 times" back into 166 rows, which
// is the problem it exists to solve. A scrubber that misses turns /debug/logs
// into a transcript endpoint, which is the one thing it must never be.

import { fingerprint, say, scrub, sinceFrom } from "../src/obs";
import { classifyEngineError, troubleFrom } from "../src/llm";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${got}${ok ? "" : `  (wanted ${want})`}`);
}

// ---------- Grouping ----------

const deepseek402 = (id: string) =>
  fingerprint("error", "/chat", `DeepSeek deepseek-flash 402: {"error":{"message":"Insufficient Balance"}} (request ${id})`);
eq(
  "two of the same failure are one row",
  deepseek402("3f2a9c11-0b7d-4e21-9a44-2c1d5e6f7a80") === deepseek402("a1b2c3d4-5e6f-4071-8899-aabbccddeeff"),
  true,
);
eq(
  "rate limited and out of credit stay apart",
  fingerprint("error", "/chat", "Gemini gemini-3.8-flash 429: quota") ===
    fingerprint("error", "/chat", "Gemini gemini-3.8-flash 402: no"),
  false,
);
// A status is the whole content of an engine failure; a fingerprint that
// scrubbed short numbers would merge every one of them.
eq("the status survives", fingerprint("error", "/chat", "Workers AI 4006: used up").includes("4006"), true);
eq(
  "a timestamp does not",
  fingerprint("error", "/chat", "failed at 1758412800123") === fingerprint("error", "/chat", "failed at 1758499200456"),
  true,
);
eq(
  "different routes are different rows",
  fingerprint("error", "/chat", "boom") === fingerprint("error", "/brief", "boom"),
  false,
);

// ---------- The one word ----------

eq("out of free neurons", classifyEngineError(new Error("4006: used up your daily free allocation of 10,000 neurons")), "out_of_free");
eq(
  "no credit",
  classifyEngineError(new Error('DeepSeek deepseek-flash 402: {"error":{"message":"Insufficient Balance"}}')),
  "no_credit",
);
eq("quota", classifyEngineError(new Error("Gemini gemini-3.8-flash 429: quota exceeded for this project")), "quota");
eq("rate limited", classifyEngineError(new Error("Gemini gemini-3.8-flash 429: too many requests")), "rate_limited");
eq("bad key", classifyEngineError(new Error("Gemini gemini-3.8-flash 401: bad key")), "bad_key");
eq("a stall", classifyEngineError(new Error("No output from the model for 25 s")), "timeout");
eq("nothing recognised", classifyEngineError(new Error("socket hang up")), "failed");

// ---------- The sentence the phone shows ----------

const now = 1_758_412_800_000;
eq("nothing down, nothing to say", troubleFrom([], now), null);
eq(
  "names the engine and the reason",
  troubleFrom([{ engine: "deepseek", until: now + 600_000, error: "DeepSeek deepseek-flash 402: Insufficient Balance" }], now)?.startsWith(
    "DeepSeek is out of credit.",
  ),
  true,
);
eq(
  "a long wait is said in hours",
  troubleFrom([{ engine: "workers", until: now + 5 * 3_600_000, error: "4006 daily free allocation" }], now)?.includes("5 hours"),
  true,
);
eq(
  "all three read as one sentence",
  troubleFrom(
    [
      { engine: "gemini", until: now + 60_000, error: "Gemini gemini-3.8-flash 429: rate" },
      { engine: "deepseek", until: now + 600_000, error: "DeepSeek deepseek-flash 402: Insufficient Balance" },
    ],
    now,
  )?.includes("Gemini is rate limited, and DeepSeek is out of credit"),
  true,
);

// ---------- What never comes back out ----------

eq("what was said is gone", scrub('heard: "call my mother at four"'), 'heard: "…"');
eq("a bearer token is gone", scrub("401 GET /me Bearer 9f8e7d6c5b4a39281706"), "401 GET /me Bearer …");
eq("a push token is gone", scrub("push failed for ExponentPushToken[abc123def456]"), "push failed for ExponentPushToken[…]");
eq("an email is gone", scrub("signup for someone@example.com"), "signup for <email>");
eq(
  "a session token is gone",
  scrub("session 0123456789abcdef0123456789abcdef0123")?.includes("0123456789abcdef"),
  false,
);
// And what is left is still worth reading.
eq("the shape survives", scrub("429 POST /chat after 12000 ms"), "429 POST /chat after 12000 ms");
eq("nothing is nothing", scrub(null), null);

// ---------- since= ----------

eq("minutes", Math.round((Date.now() - sinceFrom("30m")) / 60_000), 30);
eq("hours", Math.round((Date.now() - sinceFrom("6h")) / 3_600_000), 6);
eq("days", Math.round((Date.now() - sinceFrom("2d")) / 86_400_000), 2);
eq("a raw epoch is taken as given", sinceFrom("1758412800000"), 1_758_412_800_000);
eq("nonsense falls back to an hour", Math.round((Date.now() - sinceFrom("yesterday")) / 3_600_000), 1);
eq("nothing falls back to an hour", Math.round((Date.now() - sinceFrom(undefined)) / 3_600_000), 1);
// Beyond what is kept is pointless, and an unbounded since= is an unbounded scan.
eq("capped at a month", Math.round((Date.now() - sinceFrom("400d")) / 86_400_000), 30);

// ---------- One event, one line ----------

const lines: string[] = [];
const realLog = console.log;
console.log = (...args: unknown[]) => void lines.push(args.join(" "));
say("req", { rid: "8f3a", route: "/chat", status: 200, ms: 1240, user: undefined, note: "two words" });
console.log = realLog;
eq("prefixed", lines[0]?.startsWith("ovoa.req "), true);
eq("empty fields are left out", lines[0]?.includes("user="), false);
eq("one event is one line", lines[0]?.includes("\n"), false);
eq("a space inside a value does not split it", lines[0]?.includes("note=two_words"), true);

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
