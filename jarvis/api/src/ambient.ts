import { z } from "zod";
import { generateText, isModelRefused } from "./llm";
import type { Env } from "./types";

// Always-listening sends everything the phone overhears. Before treating it as
// a message, decide whether it was actually said to the assistant, the way a
// person in the room would: their name, a request plainly aimed at them, or a
// reply to what they just said. Anything else (talk with other people, TV,
// phone calls, thinking out loud) gets silence.

/** Right after the assistant speaks, an unnamed reply is probably for it. */
const FOLLOW_UP_MS = 45_000;
const CONTEXT_MESSAGES = 6;

/**
 * The phone's filler lines, played while a reply is worked out. A copy of
 * app/src/lib/fillerLines.ts FILLERS: change both together (test/ambient.test.ts
 * fails when they differ). The microphone hears them, and they came back as
 * the user's next message: "Give me a second. just fine", "Sure one sec say?",
 * "that... Sure, one sec. There you are. where the dep", each answered "Take
 * your time" (messages, 2026-09-23).
 */
export const FILLER_LINES = ["One moment.", "Let me see.", "One sec.", "Sure.", "Okay.", "Still on it.", "Bear with me."];

/** The lines builds up to 67 play instead, heard back from phones that haven't updated yet. */
const OLD_FILLER_LINES = [
  "One second while I get that.",
  "Give me a second.",
  "Let me check on that.",
  "Hang on, getting that for you.",
  "Sure, one sec.",
  "Let me look into that.",
  "Okay, give me a second.",
  "Right, one moment.",
];

const HEARD_BACK = [...FILLER_LINES, ...OLD_FILLER_LINES];

const wordsOf = (text: string) => text.toLowerCase().replace(/[‘’]/g, "'").match(/[\p{L}\p{N}']+/gu) ?? [];

/**
 * Longest first, so "okay give me a second" goes whole rather than leaving its
 * "okay". Two words at least: "Sure." and "Okay." are the user's words as often
 * as the phone's, and alone they're too short to answer anyway.
 */
const FILLER_WORDS = HEARD_BACK.map(wordsOf)
  .filter((w) => w.length >= 2)
  .sort((a, b) => b.length - a.length);

/**
 * The words of `text` once every filler line in it, word for word, is taken
 * out: "Sure one sec say?" is ["say"]. Whole lines only, wherever they fall.
 */
export function withoutFillerLines(text: string) {
  const words = wordsOf(text);
  const out: string[] = [];
  for (let i = 0; i < words.length; ) {
    const line = FILLER_WORDS.find((f) => f.every((w, j) => words[i + j] === w));
    if (line) i += line.length;
    else out.push(words[i++]);
  }
  return out;
}

/**
 * Whether what was heard is mostly the assistant's own last reply coming back
 * through the microphone: at least four words in five are the reply's, in the
 * reply's order, the last one allowed to be cut short ("where the dep" of
 * "where the Department of Defence"). In order, because the speaker plays the
 * reply start to end; a line of the user's own that only shares its words
 * doesn't. `words` has had the filler lines taken out already.
 */
export function soundsLikeItsReply(words: string[], reply: string) {
  if (!words.length) return false;
  const said = wordsOf(reply);
  const last = words.length - 1;
  const same = (i: number, s: string) => words[i] === s || (i === last && words[i].length >= 2 && s.startsWith(words[i]));
  // The most heard words the reply has in the same order, gaps allowed.
  let row = new Array<number>(said.length + 1).fill(0);
  for (let i = 0; i < words.length; i++) {
    const next = [0];
    for (let j = 0; j < said.length; j++) next.push(same(i, said[j]) ? row[j] + 1 : Math.max(row[j + 1], next[j]));
    row = next;
  }
  return row[said.length] / words.length >= 0.8;
}

const verdictSchema = {
  type: "object",
  properties: { addressed: { type: "boolean" } },
  required: ["addressed"],
};

function editDistance(a: string, b: string) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = row[j];
      row[j] = next;
    }
  }
  return row[b.length];
}

/**
 * Whether the assistant's name is said, allowing for how transcription spells
 * it: "OVOA" comes back as "Ovoa", "Ovo", "Ova", "O.V.O.A." and so on. Any word,
 * or two words run together, within one edit of the name counts.
 */
export function saysName(text: string, name: string) {
  const clean = (s: string) => s.toLowerCase().normalize("NFD").replace(/[^a-z0-9 ]/g, "").trim();
  const target = clean(name).replace(/ /g, "");
  if (target.length < 3) return false;
  // "O.V.O.A." and "o v o a" become "ovoa".
  const joined = text.toLowerCase().replace(/\b([a-z])[. ]+(?=[a-z]\b)/g, "$1");
  const words = clean(joined.replace(/[^a-z0-9]+/gi, " ")).split(/\s+/).filter(Boolean);
  const candidates = [...words, ...words.slice(1).map((w, i) => words[i] + w)];
  const allowed = target.length >= 4 ? 1 : 0;
  return candidates.some((w) => Math.abs(w.length - target.length) <= allowed && editDistance(w, target) <= allowed);
}

/**
 * Words a sentence aimed at an assistant tends to open with: a question, or an
 * instruction. Deliberately generous — a real request wrongly dropped here is
 * silence the user notices, while a stray line of television getting as far as
 * the model only costs what it always cost.
 */
const REQUEST_START =
  /^(what|whats|when|where|who|whose|why|how|which|is|are|was|were|can|could|would|will|do|does|did|should|shall|am|any|tell|remind|text|message|call|email|mail|send|set|add|put|schedule|book|play|pause|stop|start|cancel|delete|remove|open|show|find|look|check|search|read|write|draft|make|create|turn|give|help|log|note|remember|forget|snooze|wake|save)\b/i;

/** The discourse markers people start a sentence with before getting to the point. */
const PREAMBLE = /^(hey|hi|ok|okay|so|um|uh|well|yeah|alright|right|and|but|oh|now|please)[,\s]+/i;

/** What the gatekeeper model is told. Exported for its test. */
export function gatekeeperPrompt(assistantName: string) {
  return [
    `You are the gatekeeper for ${assistantName}, a voice assistant whose microphone is always on.`,
    "You get one sentence the microphone just overheard. Decide whether the user said it TO the assistant.",
    "addressed = true when:",
    `- it names the assistant (${assistantName}), even misspelled by transcription;`,
    "- it's a clear command or question for an assistant (\"what's the weather\", \"remind me to call mom\", \"text Sam I'm late\") and nothing suggests another person is being spoken to;",
    "- the assistant spoke in the last ~45 seconds and this answers or follows up on what it said.",
    "addressed = false when it's conversation with someone else, one side of a phone call, TV/music/video audio,",
    "thinking out loud, a fragment, filler (\"yeah\", \"okay\", \"hmm\"), or anything about the assistant in the third person.",
    // Its own voice, heard back through the microphone (messages, 2026-09-23).
    `The microphone also hears the assistant itself: its last reply (assistantLastSaid), and these lines it plays while it works: ${HEARD_BACK.map((l) => `"${l}"`).join(" ")}`,
    "addressed = false when the sentence is mostly those words heard back, or a trailing scrap of them (\"There you are. where the dep\" after a reply about where the Department of Defence is).",
    // Its own words said back are sometimes the answer it asked for.
    "But picking one of the choices it just offered is an answer, and true: \"The Russell Offices\" after \"the Russell Offices or the Russell Hotel?\".",
    "When unsure, answer false: speaking up uninvited is worse than staying quiet.",
  ].join("\n");
}

function looksLikeARequest(text: string) {
  const trimmed = text.trim();
  if (trimmed.includes("?")) return true;
  if (REQUEST_START.test(trimmed)) return true;
  const stripped = trimmed.replace(PREAMBLE, "");
  return stripped !== trimmed && REQUEST_START.test(stripped);
}

/**
 * The check in two steps, so a turn can go on while the slow one runs:
 * `now` when it's settled without a model (the name, a fragment, room talk,
 * its own voice), or `ask` for the model's verdict. `followUp`: the assistant
 * spoke in the last FOLLOW_UP_MS, so the line is most likely an answer to it,
 * and worth starting on while it's judged (index.ts runTurn's gate).
 */
export type Judgement = { now: boolean } | { ask: () => Promise<boolean>; followUp: boolean };

export async function isMeantForAssistant(env: Env, userId: string | null, text: string, assistantName: string) {
  const judged = await judgeOverheard(env, userId, text, assistantName);
  return "now" in judged ? judged.now : judged.ask();
}

export async function judgeOverheard(env: Env, userId: string | null, text: string, assistantName: string): Promise<Judgement> {
  if (saysName(text, assistantName)) {
    console.log("ambient: says name", text);
    return { now: true };
  }

  // Filler and fragments never need the model, and neither does the phone's own
  // filler heard back: what's left once it's gone is what gets judged.
  const words = withoutFillerLines(text);
  if (words.length < 2) {
    console.log("ambient: too short", text);
    return { now: false };
  }

  const recent = userId
    ? await env.DB
        .prepare("SELECT role, content, created_at FROM messages WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
        .bind(userId, CONTEXT_MESSAGES)
        .all<Recent>()
    : { results: [] as Recent[] };
  const now = Date.now();
  const lastReply = recent.results.find((m) => m.role === "assistant");
  const secondsSinceReply = lastReply ? Math.round((now - lastReply.created_at) / 1000) : null;

  // A room the assistant isn't part of: unless it has just spoken, the only thing
  // that earns a model call is something shaped like a request. A television
  // produced dozens of these a minute on 2026-09-21, and each one spent the same
  // quota the user's real questions needed -- which is how a spoken turn ended up
  // waiting on the slowest engine available.
  const inConversation = secondsSinceReply !== null && secondsSinceReply * 1000 < FOLLOW_UP_MS;
  if (!inConversation && !looksLikeARequest(text)) {
    console.log("ambient: room talk (no model call)", text);
    return { now: false };
  }
  // Its last reply heard back is no question, however much it sounds like the tail
  // of one. Not after a reply that asked something, though: "The Russell Offices"
  // answering "the Russell Offices or the Russell Hotel?" is all its words, in its
  // order, and only the model, told what it said, can tell an answer from an echo.
  // Four words at least for the same reason: "seven at night" may be the answer.
  if (
    inConversation &&
    lastReply &&
    !lastReply.content.includes("?") &&
    words.length >= 4 &&
    !looksLikeARequest(words.join(" ")) &&
    soundsLikeItsReply(words, lastReply.content)
  ) {
    console.log("ambient: its own reply heard back (no model call)", text);
    return { now: false };
  }
  return { ask: () => askGatekeeper(env, userId, text, assistantName, recent.results, secondsSinceReply), followUp: inConversation };
}

type Recent = { role: "user" | "assistant"; content: string; created_at: number };

/** Thrown out of a turn when an overheard line turns out not to be for OVOA. */
export class NotForUs extends Error {
  constructor() {
    super("Not said to OVOA");
    this.name = "NotForUs";
  }
}

/**
 * The turn's side of a verdict still being reached (index.ts runTurn): its
 * sentences wait, and come out in order on a yes; a no aborts `signal`, which
 * calls the model off with NotForUs, and drops them. With nothing pending,
 * everything passes straight through.
 */
export function awaitingVerdict(addressed: Promise<boolean> | undefined, onSentence?: (sentence: string) => void) {
  let verdict: boolean | null = addressed ? null : true;
  const callOff = new AbortController();
  const held: string[] = [];
  const decided = addressed?.then((yes) => {
    verdict = yes;
    if (!yes) callOff.abort(new NotForUs());
    else for (const s of held.splice(0)) onSentence?.(s);
    return yes;
  });
  return {
    /** The verdict, once reached; undefined when nothing was pending. */
    decided,
    signal: callOff.signal,
    /** True once the line is known not to be for OVOA. */
    refused: () => verdict === false,
    /** Hands a sentence on now, holds it until the verdict, or drops it after a no. */
    pass(sentence: string) {
      if (verdict === true) onSentence?.(sentence);
      else if (verdict === null) held.push(sentence);
    },
  };
}

/** The model's verdict. Never throws: when it can't tell, only a very recent follow-up gets through. */
async function askGatekeeper(env: Env, userId: string | null, text: string, assistantName: string, recent: Recent[], secondsSinceReply: number | null) {
  const lastReply = recent.find((m) => m.role === "assistant");
  try {
    // voice: the fast engine spoken turns answer on (llm.ts). A reply says
    // nothing until this verdict, and on the default engine it took 2-3 s (2026-09-23).
    const raw = await generateText(env, {
      model: env.CHAT_MODEL,
      json: { schema: verdictSchema },
      fast: true,
      voice: true,
      usage: { userId, purpose: "ambient" },
      system: gatekeeperPrompt(assistantName),
      turns: [
        {
          role: "user",
          text: JSON.stringify({
            overheard: text,
            secondsSinceAssistantLastSpoke: secondsSinceReply,
            assistantLastSaid: lastReply ? lastReply.content.slice(0, 600) : null,
            recentConversation: [...recent]
              .reverse()
              .map((m) => ({ from: m.role === "assistant" ? assistantName : "user", said: m.content.slice(0, 400) })),
          }),
        },
      ],
    });
    const addressed = z.object({ addressed: z.boolean() }).parse(JSON.parse(raw)).addressed;
    console.log(`ambient: ${addressed ? "addressed" : "ignored"}`, text);
    return addressed;
  } catch (err) {
    // Refused by the gate is no fault; the turn that follows is refused too and says why.
    if (!isModelRefused(err)) console.error("ambient check failed", err);
    // Can't tell: only a very recent follow-up gets through.
    return secondsSinceReply !== null && secondsSinceReply * 1000 < FOLLOW_UP_MS;
  }
}
