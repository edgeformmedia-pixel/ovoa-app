import { nameCount } from "./turnGate";

// What the phone heard, in the shape the turn gate reads.
//
// The phone's recogniser (modules/name-ear, or Apple's through
// expo-speech-recognition on a phone without one: liveListen.ts) hands over
// the text of the current stretch of speech again and again as it grows or is
// corrected, and now and then a "final" when it settles a stretch. The turn
// gate (turnGate.ts) was written for Deepgram's shape instead: words still
// forming (interim), and words that won't change (final, flagged at a pause).
// This turns the one into the other, and says with each final when its words
// last changed: that is when they were said, give or take the recogniser, and
// the final itself comes a pause later. The gate times the end of a request,
// and tells its own echo from the user, by it. (A third event, "quiet", ended
// requests a second after the last word whether they sounded finished or not,
// and cut "Text Danya ..." off; it went on 2026-09-23, and the gate's tick
// owns the end of a request now.) It has no timers of its own and is fed the
// time, like wakeWindow.ts, so it can be checked in a test that never touches
// audio (api/test/earWords.test.ts).
//
// Two kinds of recogniser feed it, and they cut speech into stretches differently:
//   - iOS 26's SpeechAnalyzer sends each stretch on its own: volatile text,
//     replaced until a final settles it, then the next stretch starts empty.
//   - SFSpeechRecognizer (older iOS, and Apple's servers) sends everything
//     since its task began, growing, until the task ends (a pause, or the ear
//     retiring it at 50 s), then starts again from nothing, sometimes without
//     a final for the old one.
// Both come down to one rule: a stretch goes on while its first word stays
// put; text that starts differently and is much shorter is a new stretch, and
// whatever of the old one wasn't handed on yet goes first.
//
// Words are handed on as final three ways, as Deepgram's were:
//   - at a final from the recogniser;
//   - at a pause (PAUSE_MS with nothing new), flagged as a sentence end;
//   - while talk goes on (a long request, or the user talking over a reply):
//     words unchanged for SETTLE_MS, except the last TAIL_WORDS, which the
//     recogniser is still working out. The gate only acts on finals while a
//     reply plays, so without this a "stop" said over a reply would wait for a
//     pause that the reply's own sound never leaves.
//
// It follows the words whether or not anyone is listening. Closed (room mode
// before the name, the click standby), everything heard counts as dealt with
// and nothing is handed on, but it still knows the current stretch, so the
// name or a click can open it with the few words that came just before.

export type EarWordEvents = {
  /** Words still forming (they may change). "" when there are none. */
  onInterim: (text: string) => void;
  /**
   * Words that won't be handed on again. `sentenceEnd`: the speaker paused after them.
   * `lastWordAt`: when the last of them appeared as it is now.
   */
  onFinal: (text: string, sentenceEnd: boolean, lastWordAt: number) => void;
};

/**
 * This long with nothing new is a pause: what's been said is final and the
 * sentence has ended. Deepgram's endpointing was 500 ms; the phone's words
 * land a little behind the voice.
 */
export const PAUSE_MS = 700;
/** While talk goes on, a word unchanged this long is settled... */
export const SETTLE_MS = 1500;
/** ...except the last few, which the recogniser is still working out. */
export const TAIL_WORDS = 2;
/**
 * When the name opens the ear, this many words before it come too: about
 * the four seconds of audio Deepgram used to be sent from before the name.
 */
export const BEFORE_NAME_WORDS = 10;
/** The name was heard but isn't in the stretch as this file has it: words from this far back count. */
const NAME_LAG_MS = 3000;
/**
 * A final that covered less than had been handed on: if the next stretch
 * starts with the rest, this soon, the rest isn't handed on a second time.
 */
const CARRY_MS = 2000;

const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
const tokens = (text: string) => text.split(/\s+/).filter(Boolean);

/** How many words at the start of `a` and `b` are the same word. */
function sharedStart(a: string[], b: string[]) {
  let i = 0;
  while (i < a.length && i < b.length && norm(a[i]) === norm(b[i])) i++;
  return i;
}

export class EarWords {
  /** The stretch being heard, word by word as the recogniser has it now. */
  private words: string[] = [];
  /** When each word first appeared as it is now. Never decreases along the stretch. */
  private bornAt: number[] = [];
  /** How many words at the start are dealt with: handed on, or heard while closed. */
  private done = 0;
  /** When the stretch last changed: a word added, dropped or corrected. */
  private changedAt = 0;
  /** Words handed on past the end of the last final (see CARRY_MS). */
  private carry: { words: string[]; until: number } | null = null;
  private opened = false;
  private sink: EarWordEvents | null = null;

  /** Where handed-on words go. Returns a detach that only detaches this sink, and closes. */
  attach(sink: EarWordEvents) {
    this.sink = sink;
    return () => {
      if (this.sink !== sink) return;
      this.close();
      this.sink = null;
    };
  }

  get isOpen() {
    return this.opened;
  }

  /** What hasn't been handed on yet: the words still forming, while open. */
  live() {
    return this.words.slice(this.done).join(" ");
  }

  /** A new recogniser: nothing heard, nothing carried. Stays open or closed. */
  reset() {
    this.clearStretch();
    this.carry = null;
    this.changedAt = 0;
  }

  /**
   * Hand words on from now. Words of the current stretch that appeared at or
   * after `from` are included (a click, allowing for the recogniser being a
   * moment behind the voice); earlier ones stay dealt with.
   */
  open(now: number, from = now) {
    if (this.opened) return;
    this.opened = true;
    let i = this.words.length;
    while (i > 0 && this.bornAt[i - 1] >= from) i--;
    this.done = Math.min(this.done, i);
    this.showInterim();
  }

  /** The name was heard: hand words on from a few before its last mention ("set an alarm, OVOA, for seven"). */
  openAtName(name: string, now: number) {
    if (this.opened) return;
    let at = -1;
    for (let i = this.words.length - 1; i >= 0 && at < 0; i--) {
      if (nameCount(this.words.slice(i).join(" "), name) > 0) at = i;
    }
    if (at < 0) return this.open(now, now - NAME_LAG_MS);
    this.opened = true;
    this.done = Math.max(0, Math.min(this.done, at - BEFORE_NAME_WORDS));
    this.showInterim();
  }

  /** Stop handing words on. Everything heard so far is dealt with. */
  close() {
    if (!this.opened) return;
    this.opened = false;
    this.done = this.words.length;
    this.sink?.onInterim("");
  }

  /** What the recogniser has for the current stretch now. */
  word(text: string, isFinal: boolean, now: number) {
    const next = tokens(text);
    if (!next.length) {
      if (isFinal) {
        this.handOn(true);
        this.clearStretch();
      }
      return;
    }
    if (this.carry && now > this.carry.until) this.carry = null;
    if (this.startsOver(next)) {
      this.handOn(true);
      this.clearStretch();
    }
    if (!this.words.length && this.carry) {
      this.done = sharedStart(this.carry.words, next) === this.carry.words.length ? this.carry.words.length : 0;
      this.carry = null;
    }
    const prev = this.words;
    const prevDone = this.done;
    const same = sharedStart(prev, next);
    if (same !== prev.length || same !== next.length) this.changedAt = now;
    this.bornAt = next.map((_, i) => (i < same ? this.bornAt[i] : now));
    this.words = next;
    this.done = this.opened ? Math.min(prevDone, next.length) : next.length;
    if (isFinal) {
      this.handOn(true);
      // Handed on already, past where this final ends: the next stretch may start with them.
      const extra = this.opened && prevDone > next.length ? prev.slice(next.length, prevDone) : [];
      this.clearStretch();
      this.carry = extra.length ? { words: extra, until: now + CARRY_MS } : null;
      return;
    }
    this.showInterim();
  }

  /** A few times a second: pauses and settled words. */
  tick(now: number) {
    if (this.done >= this.words.length) return;
    if (now - this.changedAt >= PAUSE_MS) return this.handOn(true);
    let settled = this.done;
    const limit = this.words.length - TAIL_WORDS;
    while (settled < limit && now - this.bornAt[settled] >= SETTLE_MS) settled++;
    this.handOn(false, settled);
  }

  /** Text that starts differently and is much shorter: the recogniser started a new stretch. */
  private startsOver(next: string[]) {
    if (!this.words.length) return false;
    if (norm(next[0]) === norm(this.words[0])) return false;
    return next.length < this.done || next.length * 2 <= this.words.length;
  }

  private handOn(sentenceEnd: boolean, upTo = this.words.length) {
    if (upTo <= this.done) return;
    const text = this.words.slice(this.done, upTo).join(" ");
    this.done = upTo;
    if (!this.opened || !this.sink) return;
    // The whole stretch: its last change (a word dropped at the end counts too). Part of it,
    // while talk goes on: when its own last word appeared, not the words still forming after it.
    const lastWordAt = upTo === this.words.length ? this.changedAt : this.bornAt[upTo - 1];
    this.sink.onFinal(text, sentenceEnd, lastWordAt);
    this.showInterim();
  }

  private showInterim() {
    if (this.opened) this.sink?.onInterim(this.live());
  }

  private clearStretch() {
    this.words = [];
    this.bornAt = [];
    this.done = 0;
  }
}
