// Whether an exchange is worth a trip to the model to update long-term memory.
//
// After every reply, a second model call read the exchange and decided what to
// remember. That doubled the model calls per turn, and it spent the same free
// Workers AI allocation spoken turns answer on first (llm.ts), so with more than
// one person using the app the memory pass was using up the fast engine for
// everyone's next question. Most turns can't hold a fact about the person at
// all: "set an alarm for seven", "what's the weather", "stop".
//
// What people say about themselves is said in the first person ("I'm vegan",
// "my sister is Sarah", "we moved to Denver") or is an explicit instruction
// ("remember that…", "forget that…"). Anything without one of those is skipped.
// A missed fact costs little: the next time it comes up, it's caught then.

const ABOUT_THEM =
  /\b(i|i'm|im|i've|ive|i'd|i'll|me|my|mine|myself|we|we're|we've|our|ours|us|remember|forget|call me)\b/;

export function mightBeAboutThem(said: string) {
  return ABOUT_THEM.test(said.toLowerCase().replace(/[‘’]/g, "'"));
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

/** "remember…", "don't forget…", "keep in mind…" at the start of a sentence or after "please", "and", "OVOA"… */
const REMEMBER_THIS =
  /(?:^|[.!?;:,]\s*|\b(?:please|pls|also|and|so|oh|ok|okay|hey|just|ovoa)[,!]?\s+)(?:remember|don't forget|do not forget|never forget|keep in mind|make a note|note that|note down)\b(?!\s+(?:what|where|when|who|whom|how|why|if|whether)\b)/;
/** "can you remember that…", "would you keep in mind my…" */
const WILL_YOU_REMEMBER =
  /\b(?:can|could|will|would) you (?:please )?(?:remember|keep in mind|note)\s+(?:that|this|my|i|i'm|im|i've|ive|we|we're|our|me)\b/;

export function askedToRemember(said: string) {
  const s = said.toLowerCase().replace(/[‘’]/g, "'").trim();
  return REMEMBER_THIS.test(s) || WILL_YOU_REMEMBER.test(s);
}
