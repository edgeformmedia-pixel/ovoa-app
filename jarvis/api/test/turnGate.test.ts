// The turn gate (app/src/lib/turnGate.ts), played through with what people
// really said to it and what it really heard of itself. Every line below is
// from the messages table or device_logs on 2026-09-23: requests cut off at
// the pause before the message, "Hey OVOA." sent as a question, and the app's
// own filler and reply heard back and answered with "Take your time".
//
// Each case is a script of what the phone's ear handed on and when (in ms from
// the start of the case), and the gate's answers in order. A final comes a
// pause (earWords.ts PAUSE_MS) after its last word unless it says otherwise.

import { soundsComplete, soundsUnfinished, TurnGate, withoutFiller, type GateResult } from "../../app/src/lib/turnGate";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(got)}${ok ? "" : `\n       wanted ${JSON.stringify(want)}`}`);
}

const t0 = 1_758_412_800_000;
/** earWords.ts hands words on as a sentence end this long after they last changed. */
const PAUSE = 700;
/** How long the name or a click opens the gate for (voice.ts SUMMON_MS). */
const SUMMON = 8000;

type Step =
  /** The phone heard the name (voice.ts onWake → gate.named). */
  | { named: number }
  /** The clip's button (gate.summon). */
  | { click: number }
  /** A second click: send what's been said. */
  | { done: number }
  /** A final. `lastWord`: when its words last changed (default: a pause before `at`). */
  | { said: string; at: number; end?: boolean; lastWord?: number }
  /** Words still forming. */
  | { interim: string; at: number }
  | { tick: number }
  /** The turn was sent: the answer is being worked out. */
  | { think: number }
  /** A filler line is audible until `until`. */
  | { filler: string; until: number }
  /** The reply so far. */
  | { reply: string }
  /** The reply's audio ended. */
  | { spoke: number }
  /** Back to listening. */
  | { listen: number };

function describe(r: GateResult, at: number) {
  if (!r) return null;
  if (r.kind === "turn") return `turn at +${at} (heard +${r.turn.heardAt - t0}): ${r.turn.text}${r.turn.addressed ? " [addressed]" : ""}`;
  if (r.kind === "interrupt") return `${r.stopOnly ? "stop" : "talk-over"} at +${at}`;
  return `ignored at +${at}`;
}

function play(gate: TurnGate, steps: Step[]) {
  const out: string[] = [];
  const note = (r: GateResult, at: number) => {
    const line = describe(r, at);
    if (line) out.push(line);
  };
  for (const s of steps) {
    if ("named" in s) gate.named(t0 + s.named + SUMMON);
    else if ("click" in s) gate.summon(t0 + s.click + SUMMON);
    else if ("done" in s) gate.done();
    else if ("said" in s) note(gate.onFinal(s.said, s.end ?? true, t0 + s.at, t0 + (s.lastWord ?? s.at - PAUSE)), s.at);
    else if ("interim" in s) gate.onInterim(s.interim, t0 + s.at);
    else if ("tick" in s) note(gate.tick(t0 + s.tick), s.tick);
    else if ("think" in s) gate.think(t0 + s.think);
    else if ("filler" in s) gate.hearFiller(s.filler, t0 + s.until);
    else if ("reply" in s) gate.speak(s.reply);
    else if ("spoke" in s) gate.spoke(t0 + s.spoke);
    else gate.listen(t0 + s.listen);
  }
  return out;
}

const RUSSELL = "The Russell Offices are in Barton, in Canberra, where the Department of Defence has its headquarters.";

const cases: { name: string; room?: boolean; talkOver?: boolean; answers?: boolean; steps: Step[]; want: string[] }[] = [
  {
    // Sent at 169 and 333 ms after the pause before the message (rows 37977, 37803): the old
    // quiet event ended it a second after the last word without asking if it sounded finished.
    name: "cut off: a message waits for what it should say",
    steps: [
      { named: 0 },
      { said: "Hey, Ovo, son my girlfriend Donya a text message", at: 1000 },
      { tick: 1300 },
      { tick: 2500 },
      { tick: 4000 },
      { said: "saying I'm on the 7th floor.", at: 4200 },
      { tick: 4600 },
      { tick: 4800 },
    ],
    want: ["turn at +4800 (heard +3500): Hey, Ovo, son my girlfriend Donya a text message saying I'm on the 7th floor. [addressed]"],
  },
  {
    name: "cut off: \"Text Danya\" on its own gets four seconds, not one",
    steps: [{ named: 0 }, { said: "Hey OVOA, text Danya", at: 900 }, { tick: 2000 }, { tick: 4100 }, { tick: 4300 }],
    want: ["turn at +4300 (heard +200): Hey OVOA, text Danya [addressed]"],
  },
  {
    // The name used to count as a click: every named request waited out 1.8 s of quiet.
    name: "a complete named request goes at its pause",
    steps: [
      { named: 0 },
      { said: "Hey OVOA, what's the weather in Canberra tomorrow?", at: 1400 },
      { said: "Hey OVOA, set an alarm for seven.", at: 5000 },
    ],
    want: [
      "turn at +1400 (heard +700): Hey OVOA, what's the weather in Canberra tomorrow? [addressed]",
      "turn at +5000 (heard +4300): Hey OVOA, set an alarm for seven. [addressed]",
    ],
  },
  {
    name: "a request that isn't plainly complete gets a little longer",
    steps: [{ named: 0 }, { said: "OVOA, I'm on the seventh floor.", at: 1000 }, { tick: 1400 }, { tick: 1600 }],
    want: ["turn at +1600 (heard +300): OVOA, I'm on the seventh floor. [addressed]"],
  },
  // A pause to think after how a request opens is not its end: sent there, the rest came while it
  // was answering and was dropped, and "Sure, what would you like?" cost a whole model round.
  ...[
    ["Hey OVOA, can you remind me", "to call mum at six."],
    ["Hey OVOA, can you please", "set an alarm for seven."],
    ["Hey OVOA, could you please", "set an alarm for seven."],
    ["Hey OVOA, can you set", "an alarm for seven."],
    ["Hey OVOA, can you tell me what", "the weather is tomorrow?"],
  ].map(([opening, rest]) => ({
    name: `a pause after "${opening}" is not the end of it`,
    steps: [
      { named: 0 },
      { said: opening, at: 1700, lastWord: 1000 },
      { tick: 2300 },
      { tick: 3000 },
      { said: rest, at: 3200, lastWord: 2500 },
    ],
    want: [`turn at +3200 (heard +2500): ${opening} ${rest} [addressed]`],
  })),
  {
    // Other talk in the room never leaves a pause: the question comes as words settled while
    // talk goes on (earWords.ts SETTLE_MS), and the TV's words after it. Waiting for quiet sent
    // it at NAMED_MAX_MS with the TV's words joined on.
    name: "a named question in a noisy room goes at its question mark",
    steps: [
      { named: 0 },
      { said: "Hey OVOA, what's the weather tomorrow?", at: 2500, end: false, lastWord: 1000 },
      { interim: "and the markets", at: 2800 },
      { tick: 2900 },
      { interim: "and the markets closed lower", at: 3400 },
      { said: "and the markets closed lower", at: 4000, end: false, lastWord: 2500 },
    ],
    want: ["turn at +2500 (heard +1000): Hey OVOA, what's the weather tomorrow? [addressed]", "ignored at +4000"],
  },
  {
    // Build 67's filler lines, heard back while it worked the answer out, kept, and sent as
    // the next request: each answered "Take your time" (messages, 2026-09-23).
    name: "the filler's echo while it works is not the next question",
    steps: [
      { named: 0 },
      { said: "Hey OVOA, what's the time?", at: 1000 },
      { think: 1000 },
      { filler: "Give me a second.", until: 2300 },
      { said: "Give me a second. just fine", at: 2600 },
      { said: "Sure one sec say?", at: 3000 },
      { said: "Let me look into that. I'm here", at: 3400 },
      { said: "Let me see How far does it work from there?", at: 3800 },
      { reply: "It's ten past three." },
      { spoke: 6000 },
      { listen: 6000 },
      { tick: 7500 },
    ],
    want: ["turn at +1000 (heard +300): Hey OVOA, what's the time? [addressed]", "ignored at +2600", "ignored at +3000", "ignored at +3400", "ignored at +3800"],
  },
  {
    // Kept, but not vouched for: in a room it could as well be someone else ("Did you feed the
    // dog?"), so the server checks it was meant for the assistant.
    name: "a clicked turn keeps what's added while it works, not the filler's echo",
    steps: [
      { click: 0 },
      { said: "Set a timer for ten minutes.", at: 900 },
      { tick: 1900 },
      { tick: 2100 },
      { think: 2100 },
      { filler: "Sure, one sec.", until: 3000 },
      { said: "Sure one sec say?", at: 3200 },
      { said: "and call it pasta", at: 4000 },
      { reply: "Timer set for ten minutes." },
      { spoke: 6500 },
      { listen: 6500 },
      { tick: 7100 },
      { tick: 7300 },
    ],
    want: [
      "turn at +2100 (heard +200): Set a timer for ten minutes. [addressed]",
      "ignored at +3200",
      "ignored at +4000",
      "turn at +7300 (heard +6500): and call it pasta",
    ],
  },
  {
    name: "a click while it works says the rest is for the assistant",
    steps: [
      { click: 0 },
      { said: "Set a timer for ten minutes.", at: 900 },
      { tick: 2100 },
      { think: 2100 },
      { filler: "Okay.", until: 2600 },
      { click: 3500 },
      { said: "and call it pasta", at: 4000 },
      { reply: "Timer set for ten minutes." },
      { spoke: 6500 },
      { listen: 6500 },
      { tick: 8200 },
      { tick: 8400 },
    ],
    want: [
      "turn at +2100 (heard +200): Set a timer for ten minutes. [addressed]",
      "ignored at +4000",
      "turn at +8400 (heard +6500): and call it pasta [addressed]",
    ],
  },
  {
    // "...where the dep" arrived after a reply about the Russell Offices and was sent as a
    // request. Now the reply's echo is dropped, and a follow-up needs words of its own.
    name: "the reply's echo after it ends is not a request; a real follow-up is",
    steps: [
      { named: 0 },
      { said: "Hey OVOA, where are the Russell Offices?", at: 1200 },
      { think: 1200 },
      { filler: "One moment.", until: 2000 },
      { reply: RUSSELL },
      { spoke: 9000 },
      { listen: 9000 },
      { said: "where the dep", at: 10000 },
      { said: "that... Sure, one sec. There you are. where the dep", at: 10600 },
      { said: "just fine", at: 12500 },
      { said: "And how far is it from Parliament House?", at: 14000 },
    ],
    want: [
      "turn at +1200 (heard +500): Hey OVOA, where are the Russell Offices? [addressed]",
      "ignored at +10000",
      "ignored at +10600",
      "ignored at +12500",
      "turn at +14000 (heard +13300): And how far is it from Parliament House?",
    ],
  },
  {
    name: "\"stop\" while it works the answer out stops it",
    steps: [{ named: 0 }, { said: "Hey OVOA, tell me about the Russell Offices.", at: 1200 }, { think: 1200 }, { said: "stop", at: 2000 }],
    want: ["turn at +1200 (heard +500): Hey OVOA, tell me about the Russell Offices. [addressed]", "stop at +2000"],
  },
  {
    name: "talking over the reply: \"stop\" stops it, its own \"wait\" doesn't, the name cuts in",
    steps: [
      { named: 0 },
      { said: "Hey OVOA, how do I get into the Russell Offices?", at: 1200 },
      { think: 1200 },
      { reply: "You'll have to wait at the gate until security lets you in." },
      { said: "wait at the gate", at: 4000 },
      { said: "Wait.", at: 4500 },
      { said: "Stop.", at: 5000 },
      { said: "OVOA, what about tomorrow?", at: 6000 },
    ],
    want: [
      "turn at +1200 (heard +500): Hey OVOA, how do I get into the Russell Offices? [addressed]",
      "ignored at +4000",
      "ignored at +4500",
      "stop at +5000",
      "talk-over at +6000",
    ],
  },
  {
    // "Hey OVOA." was sent on its own and cost a whole model round (row 37894).
    name: "only the name is not a question; the request can follow",
    steps: [
      { named: 0 },
      { said: "Hey OVOA.", at: 800 },
      { tick: 3000 },
      { tick: 3200 },
      { said: "What time is it?", at: 5000 },
      { said: "what time is it in London", at: 12000 },
    ],
    want: ["ignored at +3200", "turn at +5000 (heard +4300): What time is it? [addressed]", "ignored at +12000"],
  },
  {
    name: "the name after the question, in one breath",
    steps: [{ named: 0 }, { said: "What's the weather? OVOA.", at: 1500 }],
    want: ["turn at +1500 (heard +800): What's the weather? OVOA. [addressed]"],
  },
  {
    name: "a click lets them finish; a second click sends now",
    room: false,
    talkOver: false,
    steps: [
      { click: 0 },
      { said: "Set a timer for ten minutes.", at: 900 },
      { tick: 1900 },
      { tick: 2100 },
      { click: 3000 },
      { said: "Text Danya", at: 3800 },
      { tick: 5000 },
      { tick: 7000 },
      { tick: 7200 },
      { click: 8000 },
      { said: "Remind me to", at: 8800 },
      { done: 8900 },
      { tick: 9000 },
    ],
    want: [
      "turn at +2100 (heard +200): Set a timer for ten minutes.",
      "turn at +7200 (heard +3100): Text Danya",
      "turn at +9000 (heard +8100): Remind me to",
    ],
  },
  {
    name: "just after a reply its echo is ignored; a moment later an answer is theirs",
    room: false,
    talkOver: false,
    steps: [
      { said: "Can you text Mum that I'm running late?", at: 1500 },
      { think: 1500 },
      { filler: "One sec.", until: 2300 },
      { reply: "Want me to send it now?" },
      { spoke: 6500 },
      { listen: 6500 },
      { said: "send it now", at: 7500 },
      { said: "Yes.", at: 7900 },
      { said: "Yes please.", at: 9800 },
      { tick: 10200 },
      { tick: 10400 },
    ],
    want: [
      "turn at +1500 (heard +800): Can you text Mum that I'm running late?",
      "ignored at +7500",
      "ignored at +7900",
      "turn at +10400 (heard +9100): Yes please.",
    ],
  },
  {
    // The same lines as in a room, heard by the orb 2.5-4.5 s after the reply by lastWordAt: past
    // the echo tail, where one word the app didn't say used to make them a request.
    name: "in the orb, the reply's late echo is not a request either; a real follow-up is",
    room: false,
    steps: [
      { said: "Where are the Russell Offices?", at: 1200 },
      { think: 1200 },
      { filler: "One sec.", until: 2000 },
      { reply: RUSSELL },
      { spoke: 6000 },
      { listen: 6000 },
      { said: "that... Sure, one sec. There you are. where the dep", at: 9200, lastWord: 8500 },
      { said: "just fine", at: 10200, lastWord: 9500 },
      { said: "I'm here", at: 11200, lastWord: 10500 },
      { tick: 11500 },
      { said: "And how far is it from Parliament House?", at: 11800 },
    ],
    want: [
      "turn at +1200 (heard +500): Where are the Russell Offices?",
      "ignored at +9200",
      "ignored at +10200",
      "ignored at +11200",
      "turn at +11800 (heard +11100): And how far is it from Parliament House?",
    ],
  },
  {
    name: "a misheard echo over the reply is not talking over it; the user is",
    room: false,
    steps: [
      { said: "Where are the Russell Offices?", at: 1200 },
      { think: 1200 },
      { reply: RUSSELL },
      { said: "the apartment of defence", at: 5000 },
      { said: "Hang on, what about Sydney?", at: 6000 },
    ],
    want: ["turn at +1200 (heard +500): Where are the Russell Offices?", "ignored at +5000", "talk-over at +6000"],
  },
  {
    name: "setup: an answer goes at its pause, and the question's echo doesn't answer it",
    room: false,
    answers: true,
    steps: [
      { said: "Seven.", at: 900 },
      { think: 900 },
      { reply: "What time do you usually get up?" },
      { spoke: 4000 },
      { listen: 4000 },
      { said: "get up", at: 4600 },
      { said: "Seven thirty.", at: 6000 },
    ],
    want: ["turn at +900 (heard +200): Seven.", "ignored at +4600", "turn at +6000 (heard +5300): Seven thirty."],
  },
  {
    name: "the user's own words that sound like a filler are theirs when the app is quiet",
    steps: [{ named: 0 }, { said: "OVOA, let me see my calendar for tomorrow.", at: 1500 }, { tick: 2100 }],
    want: ["turn at +2100 (heard +800): OVOA, let me see my calendar for tomorrow. [addressed]"],
  },
];

for (const c of cases) {
  const gate = new TurnGate("OVOA", c.room ?? true, c.talkOver ?? true, c.answers ?? false);
  eq(c.name, play(gate, c.steps), c.want);
}

// ---------- The filler lines, and only them ----------
const fillerCases: [string, string[], string, string[]?][] = [
  ["Give me a second. just fine", ["Give me a second."], "just fine"],
  ["Sure one sec say?", ["Sure, one sec."], ""],
  ["Let me see How far does it work from there?", ["Let me see."], "How far does it work from there?"],
  ["One moment.", [], ""],
  ["Okay. Stop.", [], "Stop."],
  // Two lines run together without the full stop.
  ["Sure, one sec.", [], ""],
  ["Sure, send it.", [], "Sure, send it."],
  // After "Want me to send it?" only the lines it played are its own.
  ["Sure.", ["One sec."], "Sure.", []],
  ["Look into that for me", ["Let me look into that."], "Look into that for me"],
  ["Let me see my calendar", ["Let me see."], "Let me see my calendar"],
  ["Let me see I want the other one", ["Let me see."], "Let me see I want the other one"],
];
for (const [heard, played, want, known] of fillerCases) eq(`withoutFiller "${heard}"`, withoutFiller(heard, played, known), want);

// ---------- How finished a request sounds ----------
const unfinished: [string, boolean][] = [
  ["Hey, Ovo, son my girlfriend Donya a text message", true],
  ["Text Danya", true],
  ["Send a text to Ty saying", true],
  ["Send a text to Ty saying please", true],
  ["Hey, Ooa, Sth Thai Ecker boss text message saying that I'm on the 7th floor", false],
  ["What time is it", true],
  ["What time is it?", false],
  ["Set an alarm for seven please.", false],
  ["Yes please.", false],
  ["Hey OVOA, yes please.", false],
  ["Can you please", true],
  ["Hey OVOA, could you please", true],
  ["Hey OVOA, please", true],
  ["Hey OVOA, can you remind me", true],
  ["Can you remind me?", true],
  ["Hey OVOA, can you tell me what", true],
  ["Hey OVOA, can you set", true],
  ["Hey OVOA, do you know", true],
  ["Do you know?", false],
  ["What can you do", false],
];
for (const [text, want] of unfinished) eq(`soundsUnfinished "${text}"`, soundsUnfinished(text, "OVOA"), want);

const complete: [string, boolean][] = [
  ["What's the weather in Canberra tomorrow?", true],
  ["Set an alarm for seven.", true],
  ["Please call mum now", true],
  ["Can you set an alarm for", false],
  ["I'm on the seventh floor.", false],
  ["What time?", false],
  ["Hey OVOA, can you please", false],
  ["Can you hear me", false],
  ["Can you please set an alarm for seven", true],
];
for (const [text, want] of complete) eq(`soundsComplete "${text}"`, soundsComplete(text, "OVOA"), want);

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
