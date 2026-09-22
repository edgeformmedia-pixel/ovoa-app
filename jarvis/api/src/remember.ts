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
