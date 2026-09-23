// Whether an exchange is worth a trip to the model to update long-term memory.
//
// After every reply, a second model call read the exchange and decided what to
// remember. That doubled the model calls per turn, and each one ran just as the
// person's next question might: it goes to GLM on Z.ai first (llm.ts), the
// engine a spoken turn falls back to and every typed turn starts on, so with
// more than one person using the app the memory pass was contending with
// everyone's next question for the same engine. Most turns can't hold a fact
// about the person at all: "set an alarm for seven", "what's the weather", "stop".
//
// What people say about themselves is said in the first person ("I'm vegan",
// "my sister is Sarah", "we moved to Denver") or is an explicit instruction
// ("remember that…", "forget that…"). Anything without one of those is skipped.
// A missed fact costs little: the next time it comes up, it's caught then.

const ABOUT_THEM =
  /\b(i|i'm|im|i've|ive|i'd|i'll|me|my|mine|myself|we|we're|we've|our|ours|us|remember|forget|call me)\b/;

// A request says "me" and "my" too, and tells OVOA nothing about the person:
// "remind me to call my mum", "text my girlfriend I'm on the 7th floor",
// "what's on my calendar". Each of those started a memory pass, a second
// model call on the same key fired just as a quick follow-up might arrive
// (2026-09-23). So a sentence shaped like an instruction or a question is
// skipped. A statement next to it still counts ("set an alarm for six. I have
// a flight"), and so does anything that says remember or forget.

/** What opens a request once the greeting and the name are gone. "Call me Tom" is a name, not a call. */
const REQUEST =
  /^(?!call me\b)(?:remind|call|text|message|send|email|set|wake|turn|play|pause|stop|cancel|add|put|schedule|book|open|show|find|look|check|search|read|tell|give|start|what|what's|whats|when|where|who|how|is|are|do|does|did|can|could|would|will|any)\b/;
/** Greetings and politeness before the request: "hey", "okay so", "can you", "I need you to". */
const LEAD =
  /^(?:(?:hey|hi|ok|okay|so|um|uh|oh|and|alright|yo|please|ovoa|i need you to|i want you to|i'?d like you to|can you|could you|would you|will you)\b[,.!]?\s*)+/;
/** "Ovo," or "Hey Ooa,": the name as the recogniser heard it, then a comma. */
const NAMED = /^[a-z'.]+(?:\s+[a-z'.]+)?,\s*/;

function withoutLeadIn(sentence: string, name: string) {
  const byName = name ? new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b[,.!]?\\s*`) : null;
  let s = sentence;
  for (let i = 0; i < 4; i++) {
    let next = s.replace(LEAD, "");
    if (byName) next = next.replace(byName, "");
    // Not when the chunk is itself about them: "I'm vegan, text my mum" keeps "I'm vegan".
    next = next.replace(NAMED, (chunk) => (ABOUT_THEM.test(chunk) ? chunk : ""));
    if (next === s) break;
    s = next;
  }
  return s;
}

/** `assistantName`: what they call OVOA, which can open a request with no comma after it ("Max remind me…"). */
export function mightBeAboutThem(said: string, assistantName?: string) {
  const name = assistantName ? assistantName.toLowerCase().trim() : "";
  const sentences = said.toLowerCase().replace(/[‘’]/g, "'").split(/[.!?;\n]+\s*/);
  return sentences.some((sentence) => {
    if (!ABOUT_THEM.test(sentence)) return false;
    if (/\b(remember|forget)\b/.test(sentence)) return true;
    return !REQUEST.test(withoutLeadIn(sentence.trim(), name));
  });
}

// Which memories are kept (docs/retention.md). A memory the background pass
// learned from a conversation is deleted after 14 days; one the person
// explicitly told OVOA to remember ("remember that I'm vegan", "don't forget my
// sister is Sarah") is theirs, and stays. The model marks each new memory, but
// a mark is only believed when the message really was an instruction to
// remember (index.ts updateMemories), so a model that marks everything can't
// keep everything.
//
// An instruction, not the word: "do you remember what I said?" and "I can't
// remember where I put it" are not asking for anything to be kept.

/**
 * What can come just before "remember": "please", "and", "OVOA", "I want you
 * to", "make sure you"… The assistant's own name, when they gave it one, is
 * added per call: speech transcripts rarely put a comma after it ("Max
 * remember that I'm vegan").
 */
const LEAD_INS = "please|pls|also|and|so|oh|ok|okay|hey|just|ovoa|(?:i )?(?:want|need) you to|i'?d like you to|i would like you to|make sure(?: you)?";
const VERBS = "remember|don't forget|do not forget|never forget|keep in mind|make a note|note that|note down";
/** "remember what I said" is a question about the past, not something to keep. */
const NOT_A_QUESTION = String.raw`(?!\s+(?:what|where|when|who|whom|how|why|if|whether)\b)`;
const rememberThis = (leadIns: string) =>
  new RegExp(String.raw`(?:^|[.!?;:,]\s*|\b(?:${leadIns})[,!]?\s+)(?:${VERBS})\b${NOT_A_QUESTION}`);
/** "remember…", "don't forget…", "keep in mind…" at the start of a sentence or after a lead-in. */
const REMEMBER_THIS = rememberThis(LEAD_INS);
/** "can you remember that…", "would you keep in mind my…" */
const WILL_YOU_REMEMBER =
  /\b(?:can|could|will|would) you (?:please )?(?:remember|keep in mind|note)\s+(?:that|this|my|i|i'm|im|i've|ive|we|we're|our|me)\b/;

const plain = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").trim();

/** `assistantName`: what they call OVOA, which can lead in too ("Max, remember…", "Max remember…"). */
export function askedToRemember(said: string, assistantName?: string) {
  const s = plain(said);
  const name = assistantName ? plain(assistantName) : "";
  const re = name && name !== "ovoa" ? rememberThis(`${LEAD_INS}|${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) : REMEMBER_THIS;
  return re.test(s) || WILL_YOU_REMEMBER.test(s);
}
