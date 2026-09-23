// The always-listening gate (ambient.ts): whether an overheard line was said to
// OVOA. What matters here is its own voice: the reply and the filler lines come
// back through the microphone, and every one that got through was answered with
// "Take your time" or "Sounds like you got cut off" (messages, 2026-09-23).

import {
  awaitingVerdict,
  FILLER_LINES,
  gatekeeperPrompt,
  isMeantForAssistant,
  judgeOverheard,
  NotForUs,
  soundsLikeItsReply,
  withoutFillerLines,
} from "../src/ambient";
import { FILLERS } from "../../app/src/lib/fillerLines";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(got)}${ok ? "" : `  (wanted ${JSON.stringify(want)})`}`);
}

// ---------- The filler lines ----------

eq("the server's copy is the phone's list", FILLER_LINES, FILLERS);
eq("a filler heard back leaves a scrap", withoutFillerLines("Sure one sec say?"), ["say"]);
eq("wherever it falls", withoutFillerLines("Give me a second. just fine"), ["just", "fine"]);
eq("the longer line goes whole", withoutFillerLines("Okay, give me a second."), []);
eq("today's lines too", withoutFillerLines("Bear with me. still on it"), []);
eq("a request after one is kept", withoutFillerLines("Let me see my calendar for tomorrow"), ["my", "calendar", "for", "tomorrow"]);
eq("words that aren't a whole line stay", withoutFillerLines("Give me the weather"), ["give", "me", "the", "weather"]);
eq("a one-word line is the user's word too", withoutFillerLines("okay stop"), ["okay", "stop"]);

// ---------- Its own reply ----------

// The logged reply's words aren't known past "...where the Department of
// Defence...", so this is one like it, and the echo below is a scrap of it.
const REPLY = "The Russell Offices are in Barton, in Canberra, where the Department of Defence has its headquarters.";
const ECHO = "that... Sure, one sec. in Barton, in Canberra, where the dep";
eq("its reply heard back, cut off mid-word", soundsLikeItsReply(withoutFillerLines(ECHO), REPLY), true);
eq("a real follow-up is not its reply", soundsLikeItsReply(withoutFillerLines("how far is it from here"), REPLY), false);
eq("its words out of its order are not its reply", soundsLikeItsReply(["headquarters", "its", "has", "defence"], REPLY), false);
eq("nothing heard is not its reply", soundsLikeItsReply([], REPLY), false);

// ---------- What the model is told ----------

const prompt = gatekeeperPrompt("OVOA");
eq("it knows every filler line, old builds' too", [...FILLER_LINES, "Give me a second."].every((l) => prompt.includes(l)), true);
eq("and to look at what it last said", prompt.includes("assistantLastSaid"), true);
eq("and that picking one of its choices is an answer", prompt.includes("picking one of the choices"), true);

// ---------- The whole check, with no model to ask ----------
//
// No engine has a key here, so a line that reaches the model falls back to "a
// recent follow-up gets through": a false below was decided without it.

const env = (reply: { content: string; ago: number } | null) =>
  ({
    DB: {
      prepare: () => ({
        bind: () => ({
          all: async () => ({
            results: reply ? [{ role: "assistant", content: reply.content, created_at: Date.now() - reply.ago }] : [],
          }),
        }),
      }),
    },
  }) as never;

async function main() {
  const quiet = console.error;
  console.error = () => {};
  const justNow = env({ content: REPLY, ago: 5_000 });
  eq("the name gets through", await isMeantForAssistant(justNow, "u", "Ovo what's the time", "OVOA"), true);
  eq("filler and a scrap: ignored", await isMeantForAssistant(justNow, "u", "Sure one sec say?", "OVOA"), false);
  eq("its reply heard back: ignored, no model call", await isMeantForAssistant(justNow, "u", ECHO, "OVOA"), false);
  // The logged line itself: "There you are" isn't in the reply above, so it's
  // left to the model, which is told about its own voice (gatekeeperPrompt).
  eq("the logged echo goes to the model", "ask" in (await judgeOverheard(justNow, "u", "that... Sure, one sec. There you are. where the dep", "OVOA")), true);
  eq("a follow-up still reaches the model", await isMeantForAssistant(justNow, "u", "How far is it from there?", "OVOA"), true);

  // Picking one of the choices it just offered is its own words, in its order,
  // and an answer: these must reach the model, never be dropped as echo.
  const choices: [string, string][] = [
    ["Do you mean the Russell Offices or the Russell Hotel?", "The Russell Offices"],
    ["Do you want it at seven in the morning or seven at night?", "Seven at night"],
    ["Want me to set it for tomorrow at three, or Friday at noon?", "Friday at noon"],
    ["Is that the Coles on Main Street or the one in Barton?", "the one in Barton"],
    ["Is that the Coles on Main Street or the one in Barton?", "The one on Main Street"],
  ];
  for (const [asked, answer] of choices) {
    const judged = await judgeOverheard(env({ content: asked, ago: 5_000 }), "u", answer, "OVOA");
    eq(`"${answer}" after "${asked}" reaches the model`, "ask" in judged && judged.followUp, true);
  }
  eq("room talk with nobody in conversation: ignored", await isMeantForAssistant(env(null), "u", "yeah I told him already", "OVOA"), false);

  // In two steps, for a turn that goes on while the model judges (index.ts runTurn's gate).
  const followUp = await judgeOverheard(justNow, "u", "How far is it from there?", "OVOA");
  eq("a follow-up needs the model, and is worth starting on meanwhile", "ask" in followUp && followUp.followUp, true);
  const tv = await judgeOverheard(env(null), "u", "What's the best way to clean a cast iron pan?", "OVOA");
  eq("a request-shaped line in a quiet room needs the model, but waits for it", "ask" in tv && !tv.followUp, true);
  eq("the name needs nothing more", await judgeOverheard(justNow, "u", "OVOA stop", "OVOA"), { now: true });

  // ---------- The turn meanwhile (index.ts runTurn) ----------

  const verdictFrom = () => {
    let settle!: (yes: boolean) => void;
    const addressed = new Promise<boolean>((r) => (settle = r));
    const out: string[] = [];
    return { turn: awaitingVerdict(addressed, (s) => out.push(s)), settle, out };
  };
  const yes = verdictFrom();
  yes.turn.pass("It's 24 degrees,");
  yes.turn.pass("and sunny.");
  eq("nothing is said while it's judged", yes.out, []);
  yes.settle(true);
  await yes.turn.decided;
  eq("a yes lets it all out, in order", yes.out, ["It's 24 degrees,", "and sunny."]);
  yes.turn.pass("Anything else?");
  eq("and what comes after goes straight on", yes.out.length, 3);

  const no = verdictFrom();
  no.turn.pass("Take your time.");
  no.settle(false);
  await no.turn.decided;
  no.turn.pass("Sounds like you got cut off.");
  eq("a no says nothing at all", no.out, []);
  eq("and calls the model off", no.turn.signal.reason instanceof NotForUs, true);
  eq("and is known as refused", no.turn.refused(), true);

  const said: string[] = [];
  const direct = awaitingVerdict(undefined, (s) => said.push(s));
  direct.pass("Done.");
  eq("with nothing pending, it's said at once", said, ["Done."]);
  console.error = quiet;

  if (fails) {
    console.log(`\n${fails} failed`);
    process.exit(1);
  }
  console.log("\nall passed");
}

void main();
