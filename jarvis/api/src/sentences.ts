// Turns a reply being streamed by the model into whole sentences for the phone
// to speak, and keeps a model that has started looping ("Sure thing... Sure
// thing...") from being read out or saved.

/** A spoken reply longer than this is cut off: nobody listens to a 3-minute answer. */
const SPOKEN_MAX_CHARS = 1800;

const key = (sentence: string) => sentence.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Sentence end: . ! ? (plus closing quotes/brackets) then whitespace, or a line break. */
const BOUNDARY = /^([\s\S]*?(?:[.!?…]+["'”’)\]]*(?=\s)|\n))\s*/;

const ABBREVIATION = /\b(mr|mrs|ms|dr|st|jr|sr|vs|approx|e\.g|i\.e)\.$/i;

export function sentenceStream(emit: (sentence: string) => void, maxChars = SPOKEN_MAX_CHARS) {
  let buffer = "";
  let text = "";
  let stopped = false;
  let repeats = 0;
  let sep = "";
  /** The start of the buffer that ends in an abbreviation, waiting for the rest of its sentence. */
  let held = "";
  const seen = new Set<string>();

  const flush = (raw: string) => {
    const sentence = raw.trim();
    const k = key(sentence);
    if (!k) return;
    // The same sentence again: a loop. Skip it; twice means the model is stuck.
    if (k.length > 12 && seen.has(k)) {
      if (++repeats >= 2) stopped = true;
      return;
    }
    seen.add(k);
    text += (text ? sep : "") + sentence;
    // Keep line breaks, so a written reply keeps its paragraphs.
    sep = raw.includes("\n") ? "\n" : " ";
    emit(sentence);
    if (text.length >= maxChars) stopped = true;
  };

  return {
    /** Adds streamed text. Returns false once the reply should stop. */
    push(delta: string) {
      if (stopped) return false;
      buffer += delta;
      let m: RegExpExecArray | null;
      while (!stopped && (m = BOUNDARY.exec(buffer.slice(held.length)))) {
        const piece = held + m[0];
        buffer = buffer.slice(piece.length);
        held = "";
        // "Mr. Patel": not the end of a sentence.
        if (ABBREVIATION.test(piece.trimEnd())) {
          held = piece;
          buffer = piece + buffer;
          continue;
        }
        flush(piece);
      }
      return !stopped;
    },
    /** The model finished: whatever is left is the last sentence. */
    end() {
      if (!stopped && buffer.trim()) flush(buffer);
      buffer = "";
    },
    /** Everything emitted, without repeats. */
    text: () => text,
    emitted: () => text.length > 0,
    repeated: () => repeats > 0,
  };
}

/** Removes repeated sentences from a finished reply (a model that looped). */
export function dropRepeats(reply: string) {
  const out = sentenceStream(() => {}, Infinity);
  out.push(reply);
  out.end();
  return out.repeated() ? out.text() : reply;
}
