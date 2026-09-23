// The phone's words, in the turn gate's shape (app/src/lib/earWords.ts),
// checked without a microphone. Since 2026-09-23 the iPhone recognises speech
// itself, and everything the gate decides (when a request is over, whether
// "stop" was said over a reply, whether it was the app's own echo) now rests on
// this turning the recogniser's growing, self-correcting text into
// Deepgram-style finals at the right moments, each with when its words were said.

import { BEFORE_NAME_WORDS, EarWords, PAUSE_MS, SETTLE_MS } from "../../app/src/lib/earWords";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(got)}${ok ? "" : `  (wanted ${JSON.stringify(want)})`}`);
}

/** An EarWords with a sink that writes down everything handed on. */
function ear() {
  const w = new EarWords();
  const out = { finals: [] as string[], ends: [] as boolean[], lastWordAt: [] as number[], interim: "" };
  w.attach({
    onInterim: (t) => (out.interim = t),
    onFinal: (t, end, at) => {
      out.finals.push(t);
      out.ends.push(end);
      out.lastWordAt.push(at);
    },
  });
  return { w, out };
}

const t0 = 1_758_412_800_000;

// ---------- iOS 26: stretch by stretch, each settled by a final ----------
{
  const { w, out } = ear();
  w.open(t0);
  w.word("what's", false, t0 + 100);
  w.word("what's the", false, t0 + 300);
  eq("words forming show as interim", out.interim, "what's the");
  w.word("What's the time?", true, t0 + 600);
  eq("a final hands the stretch on", out.finals, ["What's the time?"]);
  eq("as a sentence end", out.ends, [true]);
  eq("said when its words last changed", out.lastWordAt, [t0 + 600]);
  eq("and clears the interim", out.interim, "");
  w.tick(t0 + 600 + PAUSE_MS + 50);
  eq("nothing is handed on twice", out.finals.length, 1);
  w.word("and tomorrow", false, t0 + 5_000);
  eq("the next stretch starts fresh", out.interim, "and tomorrow");
}

// ---------- A pause is the end of a sentence ----------
{
  const { w, out } = ear();
  w.open(t0);
  w.word("set an alarm", false, t0);
  w.tick(t0 + PAUSE_MS - 1);
  eq("not before the pause", out.finals, []);
  w.tick(t0 + PAUSE_MS);
  eq("at the pause", out.finals, ["set an alarm"]);
  eq("flagged as a sentence end", out.ends, [true]);
  eq("heard a pause before it was handed on", out.lastWordAt, [t0]);
  // SFSpeechRecognizer keeps the whole task's text: it grows from where it was.
  w.word("set an alarm for seven", false, t0 + 2_000);
  eq("only the new words are still forming", out.interim, "for seven");
  w.tick(t0 + 2_000 + PAUSE_MS);
  eq("and only they are handed on", out.finals, ["set an alarm", "for seven"]);
  w.word("Set an alarm for seven.", true, t0 + 3_000);
  eq("a final that only tidies the words adds nothing", out.finals.length, 2);
}

// ---------- A new stretch without a final for the old one ----------
{
  const { w, out } = ear();
  w.open(t0);
  w.word("I think the meeting moved to Thursday afternoon", false, t0);
  w.word("hello", false, t0 + 300);
  eq("the old stretch goes first", out.finals, ["I think the meeting moved to Thursday afternoon"]);
  eq("and the new one is forming", out.interim, "hello");
  w.tick(t0 + 300 + PAUSE_MS);
  eq("then the new one", out.finals, ["I think the meeting moved to Thursday afternoon", "hello"]);
}

// ---------- A correction of words already handed on isn't handed on again ----------
{
  const { w, out } = ear();
  w.open(t0);
  w.word("set an alarm for two o'clock", false, t0);
  w.tick(t0 + PAUSE_MS);
  w.word("Set an alarm for 2:00", false, t0 + 900);
  w.tick(t0 + 900 + PAUSE_MS);
  eq("one final, not two", out.finals, ["set an alarm for two o'clock"]);
  w.word("Set an alarm for 2:00 please", false, t0 + 2_000);
  eq("but what's added after it is new", out.interim, "please");
}

// ---------- Talking on, or over a reply: settled words go without a pause ----------
{
  const { w, out } = ear();
  w.open(t0);
  const said = "hold on stop that's not what I asked for at all".split(" ");
  let t = t0;
  for (let i = 1; i <= said.length; i++) {
    w.word(said.slice(0, i).join(" "), false, t);
    w.tick(t);
    t += 300;
  }
  eq("words settle and are handed on while talk goes on", out.finals.length > 0, true);
  eq("with no sentence end, since nobody paused", out.ends.every((e) => !e), true);
  eq("the first of them is the start", out.finals[0]?.split(" ")[0], "hold");
  eq("the last two words wait", out.interim.split(" ").length >= 2, true);
  eq("nothing settles before its time", out.finals.join(" ").split(" ").length <= Math.ceil((t - t0 - SETTLE_MS) / 300) + 1, true);
  w.tick(t + PAUSE_MS);
  eq("and all of it has gone at the pause, once", out.finals.join(" "), said.join(" "));
}

// ---------- Closed: heard, but nothing handed on, until the name ----------
{
  const { w, out } = ear();
  const room = "so anyway we went to the shop and then there was this guy who kept talking about his car";
  w.word(room, false, t0);
  w.tick(t0 + PAUSE_MS);
  eq("room talk goes nowhere", `${out.finals.length} ${out.interim}`, "0 ");
  w.word(`${room} OVOA set a timer`, false, t0 + 2_000);
  eq("still nowhere before the ear is opened", out.finals.length, 0);
  w.openAtName("OVOA", t0 + 2_000);
  const shown = out.interim.split(" ");
  eq("opened at the name, with a few words before it", shown.length, BEFORE_NAME_WORDS + 4);
  eq("ending with the request", shown.slice(-4).join(" "), "OVOA set a timer");
  w.word(`${room} OVOA set a timer for five minutes`, false, t0 + 2_500);
  w.tick(t0 + 2_500 + PAUSE_MS);
  eq("handed on from there", out.finals[0].endsWith("OVOA set a timer for five minutes"), true);
  eq("not the whole minute of room talk before it", out.finals[0].split(" ").length, BEFORE_NAME_WORDS + 7);
  w.close();
  w.word(`${room} OVOA set a timer for five minutes thanks`, false, t0 + 4_000);
  w.tick(t0 + 4_000 + PAUSE_MS);
  eq("closed again: nothing more", out.finals.length, 1);
}

// ---------- A click: only what came around it ----------
{
  const { w, out } = ear();
  w.word("the game last night was", false, t0);
  w.word("the game last night was great what's the score", false, t0 + 3_000);
  w.open(t0 + 3_200, t0 + 2_500);
  eq("the words from just before the click come, not the room's", out.interim, "great what's the score");
}

// ---------- A final that ends early ----------
{
  const { w, out } = ear();
  w.open(t0);
  w.word("set an alarm for seven thirty", false, t0);
  w.tick(t0 + PAUSE_MS);
  w.word("Set an alarm for seven", true, t0 + 800);
  w.word("thirty please", false, t0 + 1_000);
  eq("the rest of it isn't handed on twice", out.interim, "please");
  w.tick(t0 + 1_000 + PAUSE_MS);
  eq("so it reads once", out.finals.join(" "), "set an alarm for seven thirty please");
}
{
  const { w, out } = ear();
  w.open(t0);
  w.word("set an alarm for two o'clock", false, t0);
  w.tick(t0 + PAUSE_MS);
  w.word("Set an alarm for 2:00.", true, t0 + 800);
  w.word("and remind me", false, t0 + 1_000);
  eq("a final that only reformatted doesn't eat the next words", out.interim, "and remind me");
}

// ---------- An empty final still settles what's left ----------
{
  const { w, out } = ear();
  w.open(t0);
  w.word("call mum", false, t0);
  w.word("", true, t0 + 200);
  eq("what was forming is handed on", out.finals, ["call mum"]);
}

// ---------- When the words were said, not when they were handed on ----------
{
  const { w, out } = ear();
  w.open(t0);
  w.word("call", false, t0);
  w.word("call mum", false, t0 + 300);
  w.word("Call mum.", true, t0 + 900);
  eq("a final that only tidies the words keeps when they were said", out.lastWordAt, [t0 + 300]);
}
{
  const { w, out } = ear();
  w.open(t0);
  const said = "no not that one the other one please".split(" ");
  for (let i = 1; i <= said.length; i++) {
    w.word(said.slice(0, i).join(" "), false, t0 + i * 300);
    w.tick(t0 + i * 300);
  }
  eq("settled words go while talk goes on", out.finals.length > 0 && !out.ends[0], true);
  const settled = out.finals[0].split(" ").length;
  eq("each with when its own last word appeared", out.lastWordAt[0], t0 + settled * 300);
  w.tick(t0 + said.length * 300 + PAUSE_MS);
  eq("and the rest with the stretch's last change", out.lastWordAt.at(-1), t0 + said.length * 300);
}

// ---------- Detached: nothing goes anywhere ----------
{
  const w = new EarWords();
  const got: string[] = [];
  const detach = w.attach({ onInterim: () => {}, onFinal: (t) => got.push(t) });
  w.open(t0);
  detach();
  w.word("hello there", false, t0);
  w.tick(t0 + PAUSE_MS);
  eq("after detaching, nothing is handed on", got, []);
  eq("and it is closed", w.isOpen, false);
}

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
