// Decides, on the phone and as the words come in, what the user said to the
// assistant. Live transcription never stops (see liveListen.ts), so this sees
// everything: in a full room that's mostly other people talking.
//
// Room mode (Always listen): only what follows the assistant's name counts, or
// a reply shortly after the assistant spoke. Everything else is dropped here,
// without a trip to the server, and a request is sent the moment it looks
// complete instead of when the room goes quiet (it never does).
//
// Open mode (the Assistant tab's orb): everything heard is for the assistant,
// one sentence at a time.

/** Once the name is heard, how long to wait for the request that follows it. */
const NAME_WAIT_MS = 3000;
/** No new words for this long ends a request. */
const QUIET_MS = 900;
/** ...but a request that is plainly mid-sentence gets this long instead (see UNFINISHED). */
const UNFINISHED_QUIET_MS = 2500;
/**
 * After a click on the clip, the user is talking to the assistant on purpose: wait for them to be
 * done (this much quiet) instead of ending at the first sentence break or short pause.
 */
const CLICKED_QUIET_MS = 1800;
/** A clicked turn still ends after this long, in case the room never goes quiet. */
const CLICKED_MAX_MS = 60_000;
/** Longest request in a full room: other people's talk keeps it from ever going quiet. */
const ROOM_MAX_MS = 9000;
const OPEN_MAX_MS = 30_000;
/**
 * After a reply, words that match it are its echo. Transcription finishes the
 * echo's last words a few seconds late (seen: "If you need anything later"
 * arriving 4 s after the reply ended and being sent as a question).
 */
const ECHO_MS = 6000;
/** Right after a reply, an answer without the name still counts (the server double-checks). */
const FOLLOW_UP_MS = 8000;
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
]);

/** Whether what has been heard so far is obviously mid-sentence. */
export function soundsUnfinished(text: string) {
  const words = wordsOf(text);
  const last = words[words.length - 1];
  return !!last && UNFINISHED.has(last);
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
  return wordsOf(text).filter((w) => w.length > 1 && !GREETING.has(w) && !isName(w, name));
}

/** From the sentence with the name onwards ("...so anyway. Hey OVOA, what's the time"), or null. */
function fromName(text: string, name: string) {
  if (!saysName(text, name)) return null;
  const sentences = text.match(/[^.!?]+[.!?]*/g) ?? [text];
  const i = sentences.findIndex((s) => saysName(s, name));
  // Spelled out ("O. V. O. A.") the name spans sentences: keep all of it.
  return i < 0 ? text : sentences.slice(i).join(" ").trim();
}

/** "stop", "okay stop", "hold on": the user only wanted it to be quiet. */
export function onlyStop(text: string) {
  const said = wordsOf(text);
  return said.some((w) => STOP_WORDS.has(w)) && said.every((w) => STOP_WORDS.has(w) || FILLER.has(w));
}

// How sure we need to be that it's the user and not the reply's echo (misheard
// echo often has a word or two that isn't in the reply).
const MIN_NEW_WORDS = 3;
const MIN_NEW_SHARE = 0.7;

/** What the user said over the reply, or "" if it was only the reply's own echo. */
export function saidOverReply(heard: string, reply: string) {
  const said = wordsOf(heard);
  if (!said.length) return "";
  const replyWords = new Set(wordsOf(reply));
  const fresh = said.filter((w) => !replyWords.has(w));
  // "stop" / "okay stop" on its own, not a stop word inside a longer (probably echoed) phrase.
  if (onlyStop(heard) && !said.some((w) => STOP_WORDS.has(w) && replyWords.has(w))) return heard;
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
    return words.filter((w) => replyWords.has(w)).length / words.length < ECHO_SHARE;
  });
  return kept.join(" ");
}

export type Turn = {
  text: string;
  /** The name was said, so there's no need to ask the server whether it was meant for the assistant. */
  addressed: boolean;
};

export type GateResult =
  | { kind: "turn"; turn: Turn }
  /** Cut the reply short. `stopOnly`: they just wanted quiet, nothing to answer. */
  | { kind: "interrupt"; stopOnly: boolean }
  | { kind: "ignored"; text: string; why: string }
  | null;

type Pending = { text: string; addressed: boolean; at: number; lastAt: number };

export class TurnGate {
  private phase: "listening" | "thinking" | "speaking" = "listening";
  private pending: Pending | null = null;
  private interim = "";
  private interimAt = 0;
  private reply = "";
  private echoUntil = 0;
  private followUpUntil = 0;
  private summonedUntil = 0;
  /** A click opened this turn: it ends on CLICKED_QUIET_MS of quiet, or on a second click. */
  private clicked = false;
  private sendNow = false;
  private lastIgnored: { text: string; at: number } | null = null;
  /** Said while the assistant was busy answering. Kept, not dropped (see onFinal). */
  private held: { text: string; at: number } | null = null;

  constructor(
    public name: string,
    /** Room mode: only the name (or a quick follow-up) gets the assistant's attention. */
    private room: boolean,
    /** Whether talking over a reply cuts it off. */
    private talkOver: boolean,
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
    // Something was said while the assistant was busy. They were plainly talking to
    // it, so it counts as addressed and doesn't need the name again — which is what
    // used to happen: the rest of a request was answered with silence because the
    // user didn't start it "hey OVOA" a second time.
    const held = this.held;
    this.held = null;
    if (held && now - held.at < HELD_MS) this.start(held.text, true, now);
  }

  think() {
    this.phase = "thinking";
    this.pending = null;
  }

  speak(reply: string) {
    this.phase = "speaking";
    this.reply = reply;
  }

  /** A twist (or the clip's button): in room mode, the next thing said counts as addressed, without the name. */
  summon(until: number) {
    this.summonedUntil = until;
    this.clicked = true;
  }

  /** A second click while listening: send what's been said now. False when nothing has been said. */
  done() {
    if (!this.pending && !this.interim) return false;
    this.sendNow = true;
    return true;
  }

  /** The reply finished (or was cut off). */
  spoke(now: number) {
    this.echoUntil = now + ECHO_MS;
    if (this.room) this.followUpUntil = now + FOLLOW_UP_MS;
  }

  onInterim(text: string, now: number) {
    this.interim = text;
    if (text) this.interimAt = now;
  }

  onFinal(text: string, sentenceEnd: boolean, now: number): GateResult {
    this.interim = "";
    if (this.phase === "thinking") {
      // Kept rather than thrown away: while the assistant is working, what the user
      // carries on saying is usually the rest of what they were asking for. It is
      // picked up again by listen().
      const rest = withoutEcho(text, this.reply);
      if (rest) this.held = { text: this.held ? `${this.held.text} ${rest}`.trim() : rest, at: now };
      return { kind: "ignored", text, why: rest ? "still answering the last one (kept for after)" : "still answering the last one" };
    }

    if (this.phase === "speaking") {
      if (this.pending) {
        this.add(withoutEcho(text, this.reply), now);
        return null;
      }
      if (!this.talkOver) return null;
      // "stop" on its own, or inside the echo ("...for you. Hey. Hold on. Stop. You'd like"),
      // as long as the reply itself didn't just say it.
      const said = [text, ...sentencesOf(text)];
      if (said.some((s) => onlyStop(s) && saidOverReply(s, this.reply))) return { kind: "interrupt", stopOnly: true };
      const echoHasName = saysName(this.reply, this.name);
      const heardName = saysName(text, this.name);
      const forUs = this.room
        ? heardName && (!echoHasName || !!saidOverReply(text, this.reply))
        : !!saidOverReply(text, this.reply);
      if (!forUs) {
        const why = !this.room
          ? "the reply's own echo"
          : !heardName
            ? "the reply's own echo (no name heard)"
            : "the reply's own echo (the reply says the name too)";
        return { kind: "ignored", text, why };
      }
      this.start(this.room ? fromName(text, this.name) ?? text : text, this.room, now);
      return { kind: "interrupt", stopOnly: false };
    }

    if (now < this.echoUntil) {
      // The echo arrives late, and may come joined to what the user said.
      const rest = withoutEcho(text, this.reply);
      if (!rest || (!this.pending && !saysName(rest, this.name) && !saidOverReply(rest, this.reply))) {
        return { kind: "ignored", text, why: "the reply's own echo" };
      }
      text = rest;
    }
    if (this.pending) {
      this.add(text, now);
      return this.check(sentenceEnd);
    }
    if (!this.room) {
      this.start(text, false, now);
      return this.check(sentenceEnd);
    }
    if (now < this.summonedUntil) {
      // Summoned by a twist or the clip's button: this is for the assistant, name or not.
      this.summonedUntil = 0;
      this.start(fromName(text, this.name) ?? text, true, now);
      return this.check(sentenceEnd);
    }
    let request = fromName(text, this.name);
    if (request !== null) {
      // The name came after the question: "What's the weather? ... OVOA."
      const before = this.lastIgnored;
      if (!contentWords(request, this.name).length && before && /\?$/.test(before.text) && now - before.at < NAME_AFTER_MS) {
        request = `${before.text} ${request}`;
      }
      this.start(request, true, now);
      return this.check(sentenceEnd);
    }
    if (now < this.followUpUntil && contentWords(text, this.name).length >= 2) {
      this.start(text, false, now);
      return this.check(sentenceEnd);
    }
    this.lastIgnored = { text, at: now };
    return { kind: "ignored", text, why: "room talk" };
  }

  /** Nobody has said a new word for a moment. */
  onQuiet(): GateResult {
    if (this.phase !== "listening" || !this.pending || this.waitingForRequest() || this.clicked) return null;
    return this.finish();
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
    if (this.clicked) {
      return now - Math.max(p.lastAt, this.interimAt) > CLICKED_QUIET_MS || now - p.at > CLICKED_MAX_MS ? this.finish() : null;
    }
    if (this.waitingForRequest()) return now - p.at > NAME_WAIT_MS ? this.finish() : null;
    // Mid-sentence gets longer to finish: people pause to think about what the
    // message should say, and that pause is not the end of the request.
    const quiet = soundsUnfinished(p.text) ? UNFINISHED_QUIET_MS : QUIET_MS;
    if (now - Math.max(p.lastAt, this.interimAt) > quiet) return this.finish();
    if (now - p.at > (this.room ? ROOM_MAX_MS : OPEN_MAX_MS)) return this.finish();
    return null;
  }

  private start(text: string, addressed: boolean, now: number) {
    this.pending = { text, addressed, at: now, lastAt: now };
  }

  private add(text: string, now: number) {
    // Nothing left once the echo is taken out: it doesn't keep the request open either.
    if (!this.pending || !text) return;
    this.pending.text = `${this.pending.text} ${text}`.trim();
    this.pending.lastAt = now;
  }

  /** Only the name so far ("Hey OVOA"): give them a moment to say what they want. */
  private waitingForRequest() {
    const p = this.pending;
    return !!p && this.room && p.addressed && contentWords(p.text, this.name).length === 0;
  }

  private check(sentenceEnd: boolean): GateResult {
    const p = this.pending;
    if (!p || this.phase !== "listening" || this.waitingForRequest()) return null;
    if (this.clicked) return null; // tick ends it after CLICKED_QUIET_MS of quiet
    // "Send a text to Ty," with the message still to come: a full stop there is
    // transcription punctuating a pause, not the user finishing. Wait for quiet
    // (tick, below) rather than sending half a request.
    if (soundsUnfinished(p.text)) return null;
    if (sentenceEnd) return this.finish();
    // In a room it never goes quiet: a finished sentence is enough.
    if (this.room && /[.?!]$/.test(p.text) && contentWords(p.text, this.name).length >= 2) return this.finish();
    if (/\?$/.test(p.text)) return this.finish();
    return null;
  }

  private finish(): GateResult {
    const p = this.pending;
    this.pending = null;
    this.lastIgnored = null;
    this.clicked = false;
    this.sendNow = false;
    return p ? { kind: "turn", turn: { text: p.text, addressed: p.addressed } } : null;
  }
}
