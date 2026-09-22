// The server voicing a reply as it's written (voice.ts speechStream).
//
// What matters: pieces come out in the order they were said even when Deepgram
// answers them out of order, no more than three are asked for at once, a piece
// that couldn't be voiced still reaches the phone as words, and nothing more is
// voiced once the phone has hung up.

import { speechStream, type AudioLine } from "../src/voice";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(got)}${ok ? "" : `  (wanted ${JSON.stringify(want)})`}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fake Deepgram: answers each text after `delay(text)` ms, with its own text as the "audio". */
function fakeDeepgram(delay: (text: string) => number, fail?: (text: string) => boolean) {
  let inFlight = 0;
  let most = 0;
  const asked: string[] = [];
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const { text } = JSON.parse(init.body) as { text: string };
    asked.push(text);
    inFlight++;
    most = Math.max(most, inFlight);
    await sleep(delay(text));
    inFlight--;
    if (fail?.(text)) return new Response("busy", { status: 503 });
    return new Response(new TextEncoder().encode(text));
  }) as typeof fetch;
  return { asked, most: () => most };
}

const decode = (line: AudioLine) => (line.mp3 ? new TextDecoder().decode(Uint8Array.from(atob(line.mp3), (c) => c.charCodeAt(0))) : null);

async function main() {
  // Later pieces answer first: the long first piece is the slowest.
  let dg = fakeDeepgram((t) => (t.startsWith("Your dentist") ? 60 : 5));
  let lines: AudioLine[] = [];
  let s = speechStream("key", "aura-2-thalia-en", async (l) => void lines.push(l));
  s.say("Your dentist appointment is tomorrow afternoon, at three, with Dr. Patel on Main Street.");
  s.say("Want a reminder?");
  s.say("I can set one for the morning so you don't forget it.");
  await s.end();
  eq("a long first sentence is split at its pause, as the phone would", lines[0]?.text, "Your dentist appointment is tomorrow afternoon,");
  eq("written out in the order they were said", lines.map((l) => l.seq), [0, 1, 2]);
  eq("a short sentence rides along with the next", lines[2]?.text, "Want a reminder? I can set one for the morning so you don't forget it.");
  eq("the audio is what Deepgram sent", decode(lines[1]!), "at three, with Dr. Patel on Main Street.");

  // Many pieces at once: never more than three in flight.
  dg = fakeDeepgram(() => 20);
  lines = [];
  s = speechStream("key", "aura-2-thalia-en", async (l) => void lines.push(l));
  for (let i = 0; i < 8; i++) s.say(`This is sentence number ${i + 1}, long enough to go out on its own.`);
  await s.end();
  eq("all eight arrive", lines.length, 8);
  eq("no more than three asked for at once", dg.most() <= 3, true);

  // Deepgram refuses one: the words still go, for the phone to voice.
  fakeDeepgram(() => 5, (t) => t.includes("second"));
  lines = [];
  s = speechStream("key", "aura-2-thalia-en", async (l) => void lines.push(l));
  s.say("The first sentence is perfectly ordinary and fine.");
  s.say("The second sentence is the one that fails to voice.");
  s.say("The third sentence carries on as if nothing happened.");
  await s.end();
  eq("a failed piece is still sent, without audio", [lines[1]?.text, !!lines[1]?.mp3, !!lines[1]?.error], [
    "The second sentence is the one that fails to voice.",
    false,
    true,
  ]);
  eq("and the one after it is fine", !!lines[2]?.mp3, true);

  // The phone hangs up: nothing more is voiced or written.
  dg = fakeDeepgram(() => 30);
  lines = [];
  s = speechStream("key", "aura-2-thalia-en", async (l) => void lines.push(l));
  s.say("The first sentence is perfectly ordinary and fine.");
  s.stop();
  s.say("Nobody is listening to this one any more.");
  await s.end();
  await sleep(50);
  eq("nothing is written after stop", lines.length, 0);
  eq("and nothing new is asked for", dg.asked.includes("Nobody is listening to this one any more."), false);

  // Markdown never reaches the voice.
  fakeDeepgram(() => 1);
  lines = [];
  s = speechStream("key", "aura-2-thalia-en", async (l) => void lines.push(l));
  s.say("**Done** — see https://example.com for the rest of it, OVOA.");
  await s.end();
  eq("symbols and links are stripped before voicing", lines[0]?.text, "Done — see for the rest of it, Ovoa.");

  if (fails) {
    console.log(`\n${fails} failed`);
    process.exit(1);
  }
  console.log("\nall passed");
}

void main();
