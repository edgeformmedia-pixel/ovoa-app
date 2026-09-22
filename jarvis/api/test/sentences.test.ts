// How a streamed reply is cut up for the phone to speak.
//
// A spoken reply goes out a piece at a time, and the first piece is the wait the
// user hears. These check that a long opening sentence is sent at its first
// pause, that a short one is not chopped for nothing, and that numbers and
// abbreviations are never mistaken for the end of anything.

import { clauseEnd, dropRepeats, sentenceStream } from "../src/sentences";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(got)}${ok ? "" : `  (wanted ${JSON.stringify(want)})`}`);
}

/** Feeds `text` in small pieces, the way a model streams it, and returns what was emitted after each. */
function run(text: string, firstClause: boolean, step = 3) {
  const out: string[] = [];
  const s = sentenceStream((x) => out.push(x), undefined, { firstClause });
  let firstAt = -1;
  for (let i = 0; i < text.length; i += step) {
    s.push(text.slice(i, i + step));
    if (firstAt < 0 && out.length) firstAt = i + step;
  }
  s.end();
  return { out, firstAt, text: s.text() };
}

const long = "Your dentist appointment is tomorrow afternoon, at three, with Dr. Patel on Main Street. Want a reminder?";

const plain = run(long, false);
eq("without the option, the first sentence goes out whole", plain.out[0], "Your dentist appointment is tomorrow afternoon, at three, with Dr. Patel on Main Street.");

const early = run(long, true);
eq("with it, the first clause goes out on its own", early.out[0], "Your dentist appointment is tomorrow afternoon,");
eq("and the rest of that sentence follows", early.out[1], "at three, with Dr. Patel on Main Street.");
eq("then the next sentence as usual", early.out[2], "Want a reminder?");
eq("the first piece is out well before the sentence ends", early.firstAt < plain.firstAt, true);
eq("what was said reads back exactly as written", early.text, long);

eq("a short opening is left whole", run("Sure, it's at three. Anything else?", true).out, ["Sure, it's at three.", "Anything else?"]);
eq("a thousands separator is not a pause", clauseEnd("You've spent 3,000 dollars on food this month so far"), -1);
eq("nor is a dash with no space after it", clauseEnd("Your flight to Denver leaves tomorrow—at six"), -1);
eq("a dash with spaces is", clauseEnd("Your flight to Denver leaves tomorrow — at six") > 0, true);
eq("a pause too early is skipped for a later one", clauseEnd("Okay, your flight to Denver leaves at six, from gate B"), "Okay, your flight to Denver leaves at six,".length);
eq("a pause past 120 characters doesn't count", clauseEnd(`${"word ".repeat(26)}, then`), -1);
eq("only the first clause: later sentences keep their commas", run(long, true).out.length, 3);
eq("an abbreviation still isn't a sentence end", run("Dr. Patel moved your appointment to Friday.", true).out, ["Dr. Patel moved your appointment to Friday."]);
eq("a looping reply still loses its repeats", dropRepeats("I set it for three o'clock. I set it for three o'clock."), "I set it for three o'clock.");

if (fails) {
  console.log(`\n${fails} failed`);
  process.exit(1);
}
console.log("\nall passed");
