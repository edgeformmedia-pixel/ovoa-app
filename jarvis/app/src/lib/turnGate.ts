// Decides, on the phone and as the words come in, what the user said to the
// assistant. The phone's ear hears everything (see liveListen.ts), so this may
// see a lot: in a full room that's mostly other people talking, and whenever
// the app talks, its own voice. Its words come in Deepgram's old shape
// (interim, then final with the time the words last changed), which
// earWords.ts makes of the phone's own recogniser.
//
// Room mode (Always listen): only what follows the assistant's name counts, or
// a reply shortly after the assistant spoke. Everything else is dropped here,
// without a trip to the server.
//
// Open mode (the Assistant tab's orb): everything heard is for the assistant,
// one request at a time.
//
// When a request is over is one rule, owned by tick() (and check() at a
// sentence end), tiered by how finished it sounds:
//   complete ("What's the weather tomorrow?", "Set an alarm for seven."):
//     sent at the pause that ends it, or at its own question mark;
//   neutral: sent after QUIET_MS of quiet;
//   unfinished ("Text Danya", "Can you please", "Can you remind me"):
//     UNFINISHED_QUIET_MS;
//   a click: never sooner than CLICKED_QUIET_MS, since the click says they
//     mean to talk until they're done.
// The name is not a click: "Hey OVOA, what's the time?" goes at its pause.
//
// And the app's own voice is not the user. Its filler lines ("One moment.")
// and its replies come back through the microphone, late and misheard, and
// were answered as questions: "Give me a second. just fine" and "Sure one sec
// say?" got "Take your time", and after a reply about the Russell Offices,
// "...where the dep" was sent as the next request (messages, 2026-09-23).
// Everything the app said this turn is kept here (hearFiller, speak) and what
// is heard while it talks, or just after, is checked against all of it.

import { FILLERS } from "./fillerLines";

/** After only the name ("Hey OVOA."), this much quiet and it was only the name: nothing is sent. */
const NAME_WAIT_MS = 3000;
/**
 * A complete request goes at the pause that ends it: earWords.ts hands the
 * words on as a sentence end after this much quiet (its PAUSE_MS), and
 * tick() uses the same figure when the pause came without a sentence end.
 */
const COMPLETE_QUIET_MS = 700;
/** A request that isn't plainly complete or plainly unfinished: this much quiet ends it. */
const QUIET_MS = 1200;
/** ...but a request that is plainly mid-sentence gets this long instead (see UNFINISHED). */
const UNFINISHED_QUIET_MS = 4000;
/**
 * After a click on the clip, the user is talking to the assistant on purpose: wait for them to be
 * done (this much quiet) instead of ending at the first sentence break or short pause.
 */
const CLICKED_QUIET_MS = 1800;
/** A clicked turn still ends after this long, in case the room never goes quiet. */
const CLICKED_MAX_MS = 60_000;
/** Longest request in a full room: other people's talk keeps it from ever going quiet. */
const ROOM_MAX_MS = 9000;
/**
 * ...but one that started with the name gets longer: "Hey OVOA, send my girlfriend Danya a
 * text message ... saying I love you" was cut at nine seconds and at the pause (2026-09-23).
 */
const NAMED_MAX_MS = 15_000;
const OPEN_MAX_MS = 30_000;
/**
 * After a reply, words that match it are its echo. Transcription finishes the
 * echo's last words a few seconds late (seen: "If you need anything later"
 * arriving 4 s after the reply ended and being sent as a question), so for
 * this long after a reply what is heard without the name has to have
 * FOLLOW_UP_WORDS of its own, in the orb as in a room.
 */
const ECHO_MS = 6000;
/**
 * The stricter part of that: words that last changed while the app's audio
 * played, or this soon after it stopped, must also be plainly someone talking
 * over it (saidOverReply), and a one-word answer to a question the reply
 * asked isn't trusted yet. This is not the whole of the echo's lateness:
 * lastWordAt is when the words reached the app, the recogniser's lag
 * included, and leaves out only earWords.ts PAUSE_MS, so the 4 s above is
 * about 3.3 s by it. ECHO_MS's rule is what catches that; this stays short
 * because in it a quick "Yes." to "Want me to send it?" is not yet trusted.
 */
const ECHO_TAIL_MS = 2000;
/** Right after a reply, an answer without the name still counts (the server double-checks). */
const FOLLOW_UP_MS = 8000;
/**
 * ...if at least this many of its words are theirs, not the reply's or the filler's. Fewer is
 * most often the echo's tail ("just fine", "I'm here"), which used to be answered with "Take
 * your time" (messages, 2026-09-23). A reply that asked a question wants an answer, so after
 * one a single word of their own will do ("Yes.").
 */
const FOLLOW_UP_WORDS = 3;
/** "What's the weather? ... OVOA." still counts if the name comes this soon after the question. */
const NAME_AFTER_MS = 2000;
/** Words held while the assistant was answering are still theirs for this long. */
const HELD_MS = 30_000;

/**
 * Words a request is plainly not finished on. "Send a text to Ty saying please
 * pick me up at six" was being sent as "Send a text to Ty." — transcription
 * punctuates the pause before the message itself, and a full stop used to end the
 * turn on the spot. Ending on one of these is treated as a pause, not an ending,
 * and the rest of the sentence is waited for.
 */
const UNFINISHED = new Set([
  "saying", "that", "to", "about", "at", "for", "and", "with", "from", "of", "on", "in", "it",
  "tell", "telling", "ask", "asking", "remind", "reminding", "the", "a", "my", "his", "her",
  "their", "our", "your", "i", "is", "im", "its", "please", "like", "if", "when", "because",
  "but", "or", "so", "say", "says", "text", "call", "email", "message",
  // "Can you tell me what": the question itself is still to come.
  "what", "where", "who", "whose", "how", "which", "whether", "why",
]);

/** Words that start a message to someone; what follows them is who, then what to say. */
const MESSAGING = new Set(["text", "texts", "message", "msg", "tell", "email", "dm"]);
const NOT_THE_MESSAGE = new Set(["a", "an", "to", "my", "her", "him", "them", "girlfriend", "boyfriend", "wife", "husband", "mom", "dad"]);

/** "Remind me", "Show us": verbs that go on to say what, so ending on one and its "me" is a pause. */
const GOES_ON = new Set(["remind", "show", "give", "ask", "send", "let", "teach", "bring", "get", "find", "buy", "read", "make", "play", "wake"]);
const OBJECTS = new Set(["me", "us", "him", "them"]);
/** "Can you", "Do you know": a question that hasn't got to what it asks yet. */
const MODALS = new Set(["can", "could", "would", "will", "do", "does", "did", "should", "shall", "may", "might"]);
const SUBJECTS = new Set(["you", "i", "we"]);
/** What a closing "please" can follow and still be the end: "Yes please." */
const SHORT_ANSWERS = new Set(["yes", "yeah", "yep", "yup", "no", "nope", "sure", "okay", "ok", "thanks"]);

/**
 * Whether what has been heard so far is obviously mid-sentence. That includes a
 * message with nobody's words in it yet: "Send my girlfriend Danya a text message"
 * or "Text Danya" — the pause after it is the user getting to what it should say.
 * `name` is the assistant's, so "Hey OVOA, can you" reads as "can you".
 */
export function soundsUnfinished(text: string, name = ""): boolean {
  const words = wordsOf(text);
  const last = words[words.length - 1];
  if (!last) return false;
  if (last === "please" && words.length > 1) {
    // "Yes please." or "Set an alarm for seven, please.": politeness closing what was already
    // said. But "Can you please" or "Hey OVOA, please" is someone getting to what they want,
    // and was sent at the first pause when every closing "please" counted as an end.
    const before = text.replace(/[\s,]*please[^\p{L}\p{N}]*$/iu, "");
    const answer = wordsOf(before).filter((w) => !isName(w, name));
    const shortAnswer = answer.some((w) => SHORT_ANSWERS.has(w)) && answer.every((w) => SHORT_ANSWERS.has(w) || GREETING.has(w));
    return !shortAnswer && !soundsComplete(before, name);
  }
  // "What time is it?" ends on "it", but the question mark is the recogniser hearing a question end.
  const asked = /\?["')\s]*$/.test(text);
  if (UNFINISHED.has(last) && !asked) return true;
  if (OBJECTS.has(last) && GOES_ON.has(words[words.length - 2] ?? "")) return true;
  const own = words.filter((w) => !GREETING.has(w) && !LEAD_INS.has(w) && !isName(w, name));
  if (!asked && own.length <= 3 && MODALS.has(own[0] ?? "") && SUBJECTS.has(own[1] ?? "")) return true;
  let at = -1;
  words.forEach((w, i) => { if (MESSAGING.has(w)) at = i; });
  if (at < 0) return false;
  const after = words.slice(at + 1).filter((w) => !NOT_THE_MESSAGE.has(w));
  return after.length <= 1;
}

/** How a request opens when it's a question or an instruction ("What's...", "Set...", "Can you..."). */
const OPENERS = new Set([
  "what", "what's", "whats", "when", "when's", "where", "where's", "who", "who's", "why", "how", "how's",
  "which", "whose", "is", "are", "am", "was", "were", "do", "does", "did", "can", "could", "would", "will",
  "should", "shall", "have", "has", "set", "turn", "play", "call", "ring", "text", "send", "tell", "remind",
  "add", "put", "open", "start", "stop", "cancel", "delete", "remove", "clear", "show", "find", "check",
  "read", "give", "make", "create", "schedule", "book", "wake", "change", "switch", "pause", "resume", "skip",
  "note", "log", "email", "message", "search", "look", "get", "take", "save", "remember", "write", "move",
  "snooze", "mark", "list", "track", "record", "explain", "translate", "define", "buy", "order", "navigate",
]);
/** Said before a request without being it: "please set...", "just tell me...". */
const LEAD_INS = new Set(["please", "just", "quickly", "now", "also", "then"]);

/** Words that don't make a request any longer: "can you please" is one word of it, not three. */
const NOT_CARRYING = new Set(["you", "me", "please"]);

/**
 * A request that says all it needs to: a question or an instruction (by its
 * opening word or its closing ? or !), a few words long, not trailing off.
 * These go at their pause; waiting longer is only the user waiting.
 */
export function soundsComplete(text: string, name: string): boolean {
  if (soundsUnfinished(text, name)) return false;
  const words = contentWords(text, name).filter((w) => !NOT_CARRYING.has(w));
  if (words.length < 3) return false;
  if (/[?!]["')\s]*$/.test(text)) return true;
  return OPENERS.has(words.find((w) => !LEAD_INS.has(w)) ?? "");
}

const STOP_WORDS = new Set(["stop", "wait", "cancel", "quiet", "enough", "pause", "hold", "shut"]);
const FILLER = new Set(["ovoa", "ok", "okay", "please", "it", "that", "up", "on", "now", "hey", "no", "just", "right"]);
const GREETING = new Set(["hey", "hi", "hello", "yo", "ok", "okay", "so", "um", "uh", "oh", "and"]);

const sentencesOf = (text: string) => text.match(/[^.!?]+[.!?]*/g)?.map((s) => s.trim()).filter(Boolean) ?? [];

export const wordsOf = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];

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

/** Two words as transcription might render the same one: "sec" and "second", "defense" and "defence". */
function sameWord(a: string, b: string) {
  if (a === b) return true;
  if (Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a))) return true;
  return a.length >= 4 && b.length >= 4 && Math.abs(a.length - b.length) <= 1 && editDistance(a, b) <= 1;
}

/**
 * Whether a heard word is one the app said: the same word, a near spelling, or
 * its start ("dep" for "Department": the echo is handed on mid-word). A word the
 * app said only the start of doesn't count: "cancel" is not "can".
 */
function echoes(word: string, said: Set<string>) {
  if (said.has(word)) return true;
  for (const s of said) {
    if (word.length >= 3 && s.startsWith(word)) return true;
    if (word.length >= 4 && s.length >= 4 && Math.abs(word.length - s.length) <= 1 && editDistance(word, s) <= 1) return true;
  }
  return false;
}

/** The heard words that aren't the app's own. */
function freshWords(heard: string, said: string) {
  const saidWords = new Set(wordsOf(said));
  return wordsOf(heard).filter((w) => !echoes(w, saidWords));
}

/** Word-level edit distance between two lines, counting near spellings as the same word. */
function lineDistance(a: string[], b: string[]) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(row[j] + 1, row[j - 1] + 1, prev + (sameWord(a[i - 1], b[j - 1]) ? 0 : 1));
      prev = row[j];
      row[j] = next;
    }
  }
  return row[b.length];
}

/** Words that start a sentence capitalised anyway, so they don't mark a new one. */
const ALWAYS_CAPITAL = new Set(["i", "i'm", "i'll", "i've", "i'd", "ovoa"]);

/**
 * Whether a heard sentence is filler lines and nothing else: one, or a few run
 * together without the full stop ("Sure, one sec." for "Sure." and "One sec.").
 * A line of three words or more may be misheard by one; shorter ones must be exact.
 */
function onlyLines(words: string[], lines: string[][]) {
  const reached = [true, ...words.map(() => false)];
  for (let i = 0; i < words.length; i++) {
    if (!reached[i]) continue;
    for (const line of lines) {
      const slack = line.length >= 3 ? 1 : 0;
      for (let n = Math.max(1, line.length - slack); n <= line.length + slack && i + n <= words.length; n++) {
        if (lineDistance(words.slice(i, i + n), line) <= slack) reached[i + n] = true;
      }
    }
  }
  return reached[words.length];
}

/**
 * Leaves out the app's own filler lines, heard back through the microphone.
 * Whole lines only, near enough ("Give me a second" for "Give me a second.",
 * "Sure one sec say?" for "Sure, one sec."): the old test dropped any run of
 * filler words, which also ate the user's own "Look into that for me" or "Let
 * me see my calendar". Every line in `known` (all the app can say) is matched;
 * the lines `played` this turn (hearFiller) are also stripped from the start of
 * a longer sentence, when the recogniser plainly started a new one without a
 * full stop ("Let me see How far..."). Only used while the app is talking or
 * just has (TurnGate): otherwise a user's "Sure." or "Okay." is an answer.
 */
export function withoutFiller(heard: string, played: string[] = [], known: readonly string[] = FILLERS) {
  const lines = [...new Set([...known, ...played])].map(wordsOf);
  const openings = played.map(wordsOf).filter((line) => line.length >= 2);
  return sentencesOf(heard)
    .map((sentence) => {
      const words = wordsOf(sentence);
      if (!words.length) return sentence;
      if (onlyLines(words, lines)) return "";
      const tokens = sentence.split(/\s+/);
      const each = tokens.map((token) => wordsOf(token));
      for (const line of openings) {
        // The line's words are the sentence's first tokens, one word each...
        const opens = line.every((w, i) => {
          const [only, more] = each[i] ?? [];
          return only !== undefined && more === undefined && sameWord(w, only);
        });
        // ...and the recogniser started a new sentence after it, only without the full stop.
        const next = tokens[line.length] ?? "";
        if (opens && /^\p{Lu}/u.test(next) && !ALWAYS_CAPITAL.has(each[line.length]?.[0] ?? "")) return tokens.slice(line.length).join(" ");
      }
      return sentence;
    })
    .filter(Boolean)
    .join(" ");
}

const clean = (s: string) => s.toLowerCase().normalize("NFD").replace(/[^a-z0-9 ]/g, "").trim();

/** Whether one word is the name as transcription might spell it ("Ovo", "Ova" for "OVOA"). */
function isName(word: string, name: string) {
  const target = clean(name).replace(/ /g, "");
  const w = clean(word);
  if (target.length < 3 || !w) return false;
  const allowed = target.length >= 4 ? 1 : 0;
  return Math.abs(w.length - target.length) <= allowed && editDistance(w, target) <= allowed;
}

/**
 * Whether the assistant's name is said, allowing for how transcription spells
 * it. Same rule as the server's check (api/src/ambient.ts).
 */
export function saysName(text: string, name: string) {
  return nameCount(text, name) > 0;
}

/**
 * How many times the name is said in `text`. The phone's ear hands over a
 * transcript that grows as the person keeps talking, so "is the name in it"
 * would stay true for a minute after one mention; "is it in it one more time
 * than before" is what waking on it needs.
 */
export function nameCount(text: string, name: string) {
  // "O.V.O.A." and "o v o a" become "ovoa".
  const joined = text.toLowerCase().replace(/\b([a-z])[. ]+(?=[a-z]\b)/g, "$1");
  const words = clean(joined.replace(/[^a-z0-9]+/gi, " ")).split(/\s+/).filter(Boolean);
  let count = 0;
  for (let i = 0; i < words.length; i++) {
    if (isName(words[i], name)) count++;
    else if (i + 1 < words.length && isName(words[i] + words[i + 1], name)) {
      count++;
      i++;
    }
  }
  return count;
}

/** The words that carry a request: not the name, greetings or stray letters. */
function contentWords(text: string, name: string) {
  const words = wordsOf(text);
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    // The name heard as two words, as nameCount counts it: "Hey O Va" was sent
    // as a question, "va" being a word of its own (2026-09-24).
    if (!isName(w, name) && i + 1 < words.length && isName(w + words[i + 1], name)) {
      i++;
      continue;
    }
    if (w.length > 1 && !GREETING.has(w) && !isName(w, name)) out.push(w);
  }
  return out;
}

/** From the sentence with the name onwards ("...so anyway. Hey OVOA, what's the time"), or null. */
function fromName(text: string, name: string) {
  if (!saysName(text, name)) return null;
  const sentences = text.match(/[^.!?]+[.!?]*/g) ?? [text];
  const i = sentences.findIndex((s) => saysName(s, name));
  // Spelled out ("O. V. O. A.") the name spans sentences: keep all of it.
  return i < 0 ? text : sentences.slice(i).join(" ").trim();
}

/** The question just before the sentence with the name, when the name closes it ("What's the weather? OVOA."). */
function questionBefore(text: string, name: string) {
  const sentences = sentencesOf(text);
  const i = sentences.findIndex((s) => saysName(s, name));
  return i > 0 && /\?$/.test(sentences[i - 1]) ? sentences[i - 1] : null;
}

/** "stop", "okay stop", "hold on": the user only wanted it to be quiet. */
export function onlyStop(text: string) {
  const said = wordsOf(text);
  return said.some((w) => STOP_WORDS.has(w)) && said.every((w) => STOP_WORDS.has(w) || FILLER.has(w));
}

// How sure we need to be that it's the user and not the app's echo (misheard
// echo often has a word or two that isn't in what it said, so a share too).
const MIN_NEW_WORDS = 2;
const MIN_NEW_SHARE = 0.7;

/**
 * What the user said over the app's voice, or "" if it was only its echo.
 * `reply` is everything the app said: the filler lines and the reply so far.
 */
export function saidOverReply(heard: string, reply: string) {
  const said = wordsOf(heard);
  if (!said.length) return "";
  const replyWords = new Set(wordsOf(reply));
  // "stop" / "okay stop" on its own, not a stop word inside a longer (probably echoed) phrase.
  if (onlyStop(heard) && !said.some((w) => STOP_WORDS.has(w) && replyWords.has(w))) return heard;
  const fresh = said.filter((w) => !echoes(w, replyWords));
  return fresh.length >= MIN_NEW_WORDS && fresh.length / said.length >= MIN_NEW_SHARE ? heard : "";
}

/** A heard sentence this long, made almost only of the reply's words, is the reply's echo. */
const ECHO_SENTENCE_WORDS = 3;
const ECHO_SHARE = 0.8;

/**
 * Leaves out the sentences that are the reply's echo. Transcription can join the user's words and
 * the echo into one request: "Like I'm thirty. Besides money too. What can I help you with? OVOA."
 * (device_logs 2465, after the reply "I'm listening! What can I help you with?").
 */
export function withoutEcho(heard: string, reply: string) {
  if (!reply) return heard;
  const replyWords = new Set(wordsOf(reply));
  const kept = sentencesOf(heard).filter((sentence) => {
    const words = wordsOf(sentence);
    if (words.length < ECHO_SENTENCE_WORDS) return true;
    return words.filter((w) => echoes(w, replyWords)).length / words.length < ECHO_SHARE;
  });
  return kept.join(" ");
}

export type Turn = {
  text: string;
  /** The name was said (or a click), so there's no need to ask the server whether it was meant for the assistant. */
  addressed: boolean;
  /** When its last words were heard: the gate's wait from there is part of what the user waits (turnTimer.ts). */
  heardAt: number;
};

export type GateResult =
  | { kind: "turn"; turn: Turn }
  /** Cut the reply (or the answer being worked out) short. `stopOnly`: they just wanted quiet, nothing to answer. */
  | { kind: "interrupt"; stopOnly: boolean }
  | { kind: "ignored"; text: string; why: string }
  | null;

type Pending = { text: string; addressed: boolean; at: number; lastAt: number };

export class TurnGate {
  private phase: "listening" | "thinking" | "speaking" = "listening";
  private pending: Pending | null = null;
  private interim = "";
  private interimAt = 0;
  /** The reply so far, this turn. */
  private reply = "";
  /** The filler lines played this turn (hearFiller). */
  private fillers: string[] = [];
  /** What the app said last turn, while its echo can still arrive (ECHO_MS). */
  private before = "";
  /** When the app's own audio stopped, or will: its echo tail runs ECHO_TAIL_MS past this. */
  private audibleUntil = 0;
  private echoUntil = 0;
  private followUpUntil = 0;
  /** A click or the name: until then, what's said is for the assistant without the name in it. */
  private summonedUntil = 0;
  /** A click opened this turn: it ends on CLICKED_QUIET_MS of quiet, or on a second click. */
  private clicked = false;
  /** The turn being answered was opened by a click, so what they say meanwhile is kept for after it (whileThinking). */
  private answeringClicked = false;
  private sendNow = false;
  private lastIgnored: { text: string; at: number } | null = null;
  /** Said to the assistant while it was busy answering. Kept for after (see whileThinking). */
  private held: { text: string; at: number; addressed: boolean } | null = null;

  constructor(
    public name: string,
    /** Room mode: only the name (or a quick follow-up) gets the assistant's attention. */
    private room: boolean,
    /** Whether talking over a reply cuts it off. */
    private talkOver: boolean,
    /**
     * Answers to questions (setup): short replies like "seven", "yes" or
     * "skip" are the whole point, so after a question only words that are all
     * the question's own count as its echo, an answer goes at its pause, and
     * nothing said while an answer is being saved is carried into the next question.
     */
    private answers = false,
  ) {}

  /** What to show as being heard right now. */
  live() {
    return `${this.pending?.text ?? ""} ${this.phase === "listening" ? this.interim : ""}`.trim();
  }

  listen(now: number) {
    this.phase = "listening";
    // Words carried over from talking over the reply: the rest of the sentence follows.
    if (this.pending) {
      this.pending.lastAt = now;
      return;
    }
    // Something was said to the assistant while it was busy: the rest of what
    // they were asking for, picked up now rather than being answered with silence.
    const held = this.held;
    this.held = null;
    if (held && now - held.at < HELD_MS) this.start(held.text, held.addressed, now);
  }

  think(now: number) {
    this.phase = "thinking";
    this.pending = null;
    // Last turn's words can still come back late: they stay in what the echo is checked against.
    this.before = now < this.echoUntil ? this.said() : "";
    this.fillers = [];
    this.reply = "";
  }

  speak(reply: string) {
    this.phase = "speaking";
    this.reply = reply;
  }

  /** A click (the clip's button, a twist): the next thing said counts as addressed, without the name, and is let finish. */
  summon(until: number) {
    this.summonedUntil = until;
    this.clicked = true;
  }

  /**
   * The phone heard the name: what's said until `until` is for the assistant, even where
   * transcription didn't spell the name. Unlike a click it doesn't wait for a long quiet: a
   * complete request goes at its pause. Only while listening; during a reply the name is
   * judged in the words themselves, where the reply's own echo can be told apart.
   */
  named(until: number) {
    if (this.phase === "listening") this.summonedUntil = Math.max(this.summonedUntil, until);
  }

  /** A second click while listening: send what's been said now. False when nothing has been said. */
  done() {
    if (!this.pending && !this.interim) return false;
    this.sendNow = true;
    return true;
  }

  /**
   * One of the app's filler lines is playing (`text`), audible until about `until`. Its words are
   * the app's own until its echo has passed.
   */
  hearFiller(text: string, until: number) {
    if (!this.fillers.includes(text)) this.fillers.push(text);
    this.audibleUntil = Math.max(this.audibleUntil, until);
  }

  /** The reply finished (or was cut off). */
  spoke(now: number) {
    this.audibleUntil = Math.max(this.audibleUntil, now);
    this.echoUntil = now + ECHO_MS;
    if (this.room) this.followUpUntil = now + FOLLOW_UP_MS;
  }

  onInterim(text: string, now: number) {
    this.interim = text;
    if (text) this.interimAt = now;
  }

  /**
   * Words that won't change. `sentenceEnd`: the speaker paused after them. `lastWordAt`: when they
   * last changed (earWords.ts), which is when they were said, give or take the recogniser; they
   * are handed on a pause later.
   */
  onFinal(text: string, sentenceEnd: boolean, now: number, lastWordAt = now): GateResult {
    this.interim = "";
    const heard = text;
    const at = Math.min(lastWordAt, now);
    if (this.hearsItself(at)) {
      text = withoutFiller(text, this.fillers);
      if (!text) return { kind: "ignored", text: heard, why: "the filler's own echo" };
    }
    if (this.phase === "thinking") return this.whileThinking(text, now);
    if (this.phase === "speaking") return this.whileSpeaking(text, now, at);
    return this.whileListening(text, sentenceEnd, now, at);
  }

  /** Called a few times a second: ends requests on time. */
  tick(now: number): GateResult {
    if (this.sendNow && this.phase === "listening" && !this.pending && this.interim) {
      this.start(this.interim, true, now);
      this.interim = "";
    }
    const p = this.pending;
    if (this.phase !== "listening" || !p) return null;
    if (this.sendNow) return this.finish();
    const quiet = now - Math.max(p.lastAt, this.interimAt);
    // "Hey OVOA." and nothing after it: not a question, so nothing to answer. It used to be sent,
    // and cost a whole round with the model to say "Yes?" (2026-09-23).
    if (this.waitingForRequest()) return quiet > NAME_WAIT_MS ? this.drop("only the name") : null;
    if (quiet > this.quietNeeded(p.text)) return this.finish();
    const max = this.clicked ? CLICKED_MAX_MS : !this.room ? OPEN_MAX_MS : p.addressed ? NAMED_MAX_MS : ROOM_MAX_MS;
    if (now - p.at > max) return this.finish();
    return null;
  }

  /**
   * While the answer is being worked out. What's said now used to be kept and sent
   * afterwards, and most of it was the app's own filler coming back: "Give me a
   * second. just fine" was answered with "Take your time" eight times in three
   * minutes (2026-09-23). So it's kept only when it's plainly for the assistant
   * (the name, or a turn the user clicked for), and not the app's own words even then.
   */
  private whileThinking(text: string, now: number): GateResult {
    // An answer to a question that hasn't been asked yet would be filed under the wrong one.
    if (this.answers) return { kind: "ignored", text, why: "still saving the last answer" };
    const said = this.said();
    const rest = withoutEcho(text, said);
    if (!rest) return { kind: "ignored", text, why: "the reply's own echo" };
    // "Stop" while it's working the answer out: they changed their mind, so there's nothing to say.
    if (this.stopHeard(rest, said)) return { kind: "interrupt", stopOnly: true };
    const named = this.namedIn(rest, said);
    if (!named && !this.answeringClicked && !this.clicked) return { kind: "ignored", text, why: "said while it was answering, without the name (not kept)" };
    if (!named && !saidOverReply(rest, said)) return { kind: "ignored", text, why: "the app's own echo while it was answering" };
    const held = this.held;
    // Kept after a click, but only the name or a click now vouches that it's for the assistant: in
    // a room, "Did you feed the dog?" from someone else while a clicked request was being
    // answered would skip the server's check that it was meant for it (assistant.tsx ambient).
    this.held = { text: held ? `${held.text} ${rest}`.trim() : rest, at: now, addressed: (held?.addressed ?? false) || named || this.clicked };
    return { kind: "ignored", text, why: "still answering the last one (kept for after)" };
  }

  /** While the reply plays. */
  private whileSpeaking(text: string, now: number, at: number): GateResult {
    const said = this.said();
    if (this.pending) {
      // Already talking over it: this is the rest of what they're saying.
      this.add(withoutEcho(text, said), now, at);
      return null;
    }
    if (!this.talkOver) return { kind: "ignored", text, why: "the reply is playing (talking over it is off)" };
    // "stop" on its own, or inside the echo ("...for you. Hey. Hold on. Stop. You'd like"),
    // as long as the app itself didn't just say it.
    if (this.stopHeard(text, said)) return { kind: "interrupt", stopOnly: true };
    const named = this.namedIn(text, said);
    const forUs = this.room ? named : named || !!saidOverReply(text, said);
    if (!forUs) {
      const why = !this.room
        ? "the reply's own echo"
        : !saysName(text, this.name)
          ? "the reply's own echo (no name heard)"
          : "the reply's own echo (the reply says the name too)";
      return { kind: "ignored", text, why };
    }
    this.start(this.room ? fromName(text, this.name) ?? text : text, this.room, now, at);
    return { kind: "interrupt", stopOnly: false };
  }

  private whileListening(text: string, sentenceEnd: boolean, now: number, at: number): GateResult {
    const said = this.said();
    const tail = this.hearsItself(at);
    if (tail || now < this.echoUntil) {
      // The echo arrives late, misheard, and may come joined to what the user said. In the
      // tail onFinal has already taken the filler lines out.
      const rest = tail ? withoutEcho(text, said) : this.withoutItself(text, said);
      if (!this.theirs(rest, said, tail)) return { kind: "ignored", text, why: tail ? "the reply's own echo" : "the reply's own echo (late)" };
      text = rest;
    }
    if (this.pending) {
      this.add(text, now, at);
      return this.check(sentenceEnd);
    }
    if (!this.room) {
      this.start(text, false, now, at);
      return this.check(sentenceEnd);
    }
    // The name said, or heard by the phone (it may be spelled past recognising), or the clip's
    // button pressed: this is for the assistant.
    let request = fromName(text, this.name) ?? (now < this.summonedUntil ? text : null);
    if (request !== null) {
      if (!contentWords(request, this.name).length) {
        // The name came after the question: "What's the weather? OVOA." in one breath, or a moment apart.
        const before = this.lastIgnored;
        const asked = questionBefore(text, this.name) ?? (before && /\?$/.test(before.text) && now - before.at < NAME_AFTER_MS ? before.text : null);
        if (asked) request = `${asked} ${request}`;
      }
      this.start(request, true, now, at);
      return this.check(sentenceEnd);
    }
    if (now < this.followUpUntil) {
      // An answer without the name, just after a reply: the reply's echo and the filler
      // lines out first, then enough words of their own to be a question.
      const rest = this.withoutItself(text, said);
      if (this.ownEnough(rest, said)) {
        this.start(rest, false, now, at);
        return this.check(sentenceEnd);
      }
    }
    this.lastIgnored = { text, at: now };
    return { kind: "ignored", text, why: now < this.followUpUntil ? "too few words of their own for a follow-up" : "room talk" };
  }

  /** Everything the app has said that can still come back: last turn's words while their echo lasts, this turn's fillers and reply. */
  private said() {
    return [this.before, ...this.fillers, this.reply].filter(Boolean).join(" ");
  }

  /** The reply asked something, so a short answer is expected: "Want me to send it now?" */
  private asked() {
    return /\?["')\s]*$/.test(this.reply);
  }

  /**
   * What's left of heard words once the app's own are out: its filler lines, then its reply's
   * sentences. After a question, "Sure." and "Okay." are answers, so only the lines it played count.
   */
  private withoutItself(text: string, said: string) {
    return withoutEcho(withoutFiller(text, this.fillers, this.asked() ? [] : FILLERS), said);
  }

  /** Enough words of their own, not the app's, to be said to it: see FOLLOW_UP_WORDS. */
  private ownEnough(rest: string, said: string) {
    if (this.asked()) return freshWords(rest, said).length > 0;
    const saidWords = new Set(wordsOf(said));
    return contentWords(rest, this.name).filter((w) => !echoes(w, saidWords)).length >= FOLLOW_UP_WORDS;
  }

  /**
   * Whether words heard while the app's voice can still come back (`rest`, its own taken out)
   * are the user's. The name counts. The rest of a request already under way, words after a
   * click, or a setup answer ("Seven." after "When do you get up?") need only a word of their
   * own. Anything else needs enough of its own (ownEnough) and, in the `tail`, to be plainly
   * someone talking over it: in the orb, one word not in the reply used to be enough once the
   * tail had passed, and "just fine" and "I'm here" were sent as requests again.
   */
  private theirs(rest: string, said: string, tail: boolean) {
    if (!rest) return false;
    if (this.namedIn(rest, said)) return true;
    if (this.pending || this.clicked || (this.answers && !this.room)) return freshWords(rest, said).length > 0;
    return this.ownEnough(rest, said) && (!tail || !!saidOverReply(rest, said));
  }

  /** Words last heard at `at` could be the app's own: it was talking then, or had only just stopped. */
  private hearsItself(at: number) {
    return this.phase !== "listening" || at < this.audibleUntil + ECHO_TAIL_MS;
  }

  /** The name, and not the app saying it: its echo carries the name only if it said it. */
  private namedIn(text: string, said: string) {
    return saysName(text, this.name) && (!saysName(said, this.name) || !!saidOverReply(text, said));
  }

  /** "Stop" on its own (or as a sentence of its own), and not a stop word the app said itself. */
  private stopHeard(text: string, said: string) {
    const saidWords = new Set(wordsOf(said));
    return [text, ...sentencesOf(text)].some((s) => onlyStop(s) && !wordsOf(s).some((w) => STOP_WORDS.has(w) && saidWords.has(w)));
  }

  /** How long a quiet ends this request: see the tiers at the top of the file. */
  private quietNeeded(text: string) {
    const rule = soundsUnfinished(text, this.name)
      ? UNFINISHED_QUIET_MS
      : this.answers || soundsComplete(text, this.name)
        ? COMPLETE_QUIET_MS
        : QUIET_MS;
    return this.clicked ? Math.max(CLICKED_QUIET_MS, rule) : rule;
  }

  private start(text: string, addressed: boolean, now: number, lastWordAt = now) {
    this.pending = { text, addressed, at: now, lastAt: Math.min(lastWordAt, now) };
  }

  private add(text: string, now: number, lastWordAt = now) {
    // Nothing left once the echo is taken out: it doesn't keep the request open either.
    if (!this.pending || !text) return;
    this.pending.text = `${this.pending.text} ${text}`.trim();
    this.pending.lastAt = Math.max(this.pending.lastAt, Math.min(lastWordAt, now));
  }

  /** Only the name so far ("Hey OVOA"): give them a moment to say what they want. */
  private waitingForRequest() {
    const p = this.pending;
    return !!p && this.room && p.addressed && contentWords(p.text, this.name).length === 0;
  }

  /**
   * At a sentence end: a complete request goes now (a setup answer, any that isn't trailing off).
   * The recogniser's own ? or ! ends one too, on words handed on while talk goes on: with a TV
   * or other people talking there is never a pause, and "Hey OVOA, what's the weather
   * tomorrow?" would wait out NAMED_MAX_MS and take their words with it.
   */
  private check(sentenceEnd: boolean): GateResult {
    const p = this.pending;
    if (!p || this.phase !== "listening" || this.clicked || this.waitingForRequest()) return null;
    if (!sentenceEnd && !/[?!]["')\s]*$/.test(p.text)) return null;
    const done = this.answers ? !soundsUnfinished(p.text, this.name) : soundsComplete(p.text, this.name);
    return done ? this.finish() : null;
  }

  /** Drops what's pending without sending it. */
  private drop(why: string): GateResult {
    const p = this.pending;
    this.pending = null;
    return p ? { kind: "ignored", text: p.text, why } : null;
  }

  private finish(): GateResult {
    const p = this.pending;
    this.answeringClicked = this.clicked;
    this.pending = null;
    this.lastIgnored = null;
    this.clicked = false;
    this.sendNow = false;
    // The name or the click was for this request: the next one needs its own.
    this.summonedUntil = 0;
    return p ? { kind: "turn", turn: { text: p.text, addressed: p.addressed, heardAt: Math.max(p.lastAt, this.interimAt) } } : null;
  }
}
