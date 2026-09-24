import { isPhoneLookup } from "./phone";
import { MORE_TOOLS } from "./toolbelt";

// Said it was done, and nothing was (2026-09-23).
//
// engine-bench against production found both engines saying an action had
// happened in a turn where no tool ran, so nothing was saved, set or scheduled
// and the person was told it was:
//
//   "Add milk and eggs to my notes."                    "Noted — milk and eggs."
//   "Remind me to submit the report on Friday at 9am."  "Reminder set for Friday at 9:00 am — submit the report."
//   "Set an alarm for 6:30 tomorrow."                   "Done — 6:30 alarm set for tomorrow morning."
//
// A rule in the prompt (index.ts, the base section) helped spoken turns and not
// typed ones. So a turn checks its own reply: one that ran no tool, for a
// request asking for something to be done, whose reply says it was done, gets
// one more round telling the model so (llm.ts chatWithTools, repairClaims).
//
// Both tests are pure and narrow on purpose. A claim missed leaves the turn as
// it was before this file; a false alarm costs a model round and invites the
// model to do something nobody asked for. So a request counts only when one of
// its sentences opens with an instruction to do something, and a reply only
// when one of its sentences says the thing is done: not as a question, an
// offer, a negative, an "if", something that was so already, or something the
// person did.

/** What the model is told when its reply claimed an action no tool took. */
export const CLAIM_NUDGE =
  "You said that was done, but no tool ran, so nothing happened. Call the tool now to do exactly what you said; write nothing else.";

/**
 * Whether a tool call does something. more_tools only sends for more tools
 * (toolbelt.ts): a turn whose one call was more_tools has still done nothing,
 * and is one that "ran no tool".
 */
export const doesSomething = (tool: string) => tool !== MORE_TOOLS;

/** Names that only read: alarm_list, note_search, phone_calendar_events, gmail_read (not gmail_mark_read), sheets_get_info. */
const READS = /(?<!_mark)_read$|_(?:list|search|events|get|get_info|find|lookup|status|summary|today)$/;

/**
 * Whether a call only looks something up: a list, a search, the phone's
 * lookups. A repair round that only looked up has changed nothing yet: the
 * alarm the claim cancelled needs its id from alarm_list first (alarms.ts), and
 * "Cancel my seven o'clock alarm" ran alarm_list then alarm_cancel in every
 * bench run (2026-09-23). A name this misses counts as a change, which ends a
 * repair early rather than letting it run the same action twice.
 */
export const onlyReads = (tool: string) => isPhoneLookup(tool) || READS.test(tool);

/** Whether a call changes something: saves, sets, sends, cancels. Only such a call makes a claim true. */
export const changesSomething = (tool: string) => doesSomething(tool) && !onlyReads(tool);

/** Lowercase, one kind of apostrophe and quote, and "a.m." as one word, so sentences split only where they end. */
function normalize(text: string) {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\b([ap])\.m\./g, "$1m");
}

function sentencesOf(text: string) {
  return normalize(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------- The request ----------

/**
 * What the person said, without the context index.ts puts in front of it
 * (runTurn's `moment`: "[It is now …]\n\n"). The last "]\n\n" ends it. An open
 * app's instructions ride in there and are full of instructions of their own
 * ("Log each glass they mention"), which must never be read as the person's;
 * a message of the person's own with "]\n\n" in it only loses its start.
 */
export function requestOf(turn: string) {
  if (!turn.startsWith("[")) return turn;
  const end = turn.lastIndexOf("]\n\n");
  return end < 0 ? turn : turn.slice(end + 3);
}

/** Words in front of the instruction itself: "hey", "okay, also", "can you", "please", "Ovoa,". */
const LEAD =
  /^(?:(?:hey|hi|ok|okay|so|and|also|oh|um|uh|right|now|then|please|pls|just|actually|sure|yes|yeah|great|thanks|thank you|alright|all right|go ahead and|can you|could you|would you|will you|i need you to|i want you to|i'd like you to)\b[\s,.!:;—–-]*|[a-z']+,\s+)/;

/** A first word that makes the sentence a statement or a question: "I set…", "did you set…", "can I afford…". */
const NOT_AN_INSTRUCTION =
  /^(?:i|i'm|i've|i'll|i'd|you|we|they|he|she|it|my|did|do|does|is|are|was|were|should|what|when|where|who|why|how|which|have|has|had|can|could|would|will)\b/;

/**
 * An instruction to do something OVOA has a tool for, opening the sentence.
 * "make" and "keep" count only with what they make or keep, and "write" only as
 * "write down": "Write two sentences about why sleep matters" asks for words.
 * "Remember that…" counts: note_add is the tool for it (notes.ts), and the
 * background memory pass (remember.ts) keeps it only while memory is on.
 * "Remind me what my wifi password is" and "remind me of the gate code" ask to
 * be told, not reminded later: memories ride in the prompt, so they're
 * answered with no tool, and a repair round would save or set something for a
 * question.
 */
const ACTION = new RegExp(
  `^(?:${[
    "add",
    "put",
    "save",
    "store",
    "jot",
    "note",
    "log",
    "track",
    "record",
    "set",
    "schedule",
    "book",
    "remind(?! me (?:again )?(?:what|who|whom|whose|when|where|how|why|which|whether|if|of|about)\\b)",
    "create",
    "cancel",
    "delete",
    "remove",
    "clear",
    "move",
    "reschedule",
    "change",
    "update",
    "rename",
    "mark",
    "snooze",
    "text",
    "message",
    "send",
    "email",
    "call",
    "ring",
    "dial",
    "wake me",
    "turn (?:on|off)",
    "check off",
    "tick off",
    "remember (?:that|this|to|my|i|me)",
    "don't (?:let me )?forget",
    "make (?:a |an |me a |me an )?(?:note|reminder|alarm|timer|event|appointment|list|to-?do)",
    "keep (?:a note|note|track|this|that|it)",
    "take (?:a )?note",
    "write (?:it |this |that )?down",
  ].join("|")})\\b|^(?:note|reminder|to-?do|memo)\\s*:`,
);

function isInstruction(sentence: string) {
  let s = sentence;
  for (let before = ""; before !== s; ) {
    before = s;
    s = s.replace(LEAD, "");
  }
  if (NOT_AN_INSTRUCTION.test(s)) return false;
  // One word in front is allowed for a spoken line, which comes with the name in it ("ovoa add milk").
  return ACTION.test(s) || ACTION.test(s.replace(/^[a-z']+\s+/, ""));
}

/**
 * Whether the person asked for something to be done: saved, set, sent,
 * scheduled, cancelled. Takes the turn as the model got it (requestOf drops the
 * context in front). A question isn't a request here ("Do I have any alarms
 * set?"), and neither is a request for words ("Tell me something interesting").
 */
export function asksForAction(turn: string) {
  return sentencesOf(requestOf(turn)).some(isInstruction);
}

// ---------- The reply ----------

/** A sentence that isn't saying something was done: a question, an offer, a negative, a condition, or something that was so already. */
function notAClaim(s: string) {
  return (
    s.endsWith("?") ||
    /\b(?:not|never|cannot|nothing|unable|failed|already)\b|n't\b/.test(s) ||
    /^(?:if|once|when|after|as soon as|whenever|unless)\b/.test(s) ||
    /\b(?:want me to|should i|shall i|would you like|do you want|let me know)\b/.test(s)
  );
}

/** Words that say a thing was done, wherever they fall: "milk and eggs saved". */
const DONE = "saved|added|noted|logged|scheduled|booked|cancell?ed|deleted|removed|jotted|stored";

const DONE_WORD = new RegExp(`\\b(?:${DONE})\\b`);

/**
 * A DONE word anywhere in a clause, unless "you" comes before it there. "You
 * saved it last week: the password is BlueFox42", "you have the dentist
 * scheduled for 3" and "Sarah is married to Tom — you added him in June" say
 * what the person did, not what OVOA just did, and they are how a question
 * about what's stored gets answered.
 */
function doneInAClause(s: string) {
  return s.split(/[,;:—–]|\s-\s/).some((clause) => {
    const done = DONE_WORD.exec(clause);
    return !!done && !/\byou\b/.test(clause.slice(0, done.index));
  });
}

const CLAIMS = [
  // "Done —", "Noted:", "Set for Friday", "All set", "Kept —", after an "okay" or a "got it" or nothing.
  new RegExp(
    `^(?:(?:ok|okay|alright|all right|got it|sure|right|perfect|great)[\\s,.!:;—–-]+)*(?:done|${DONE}|kept|set|sorted|created|updated|sent|(?:you're )?all set|you're set|consider it done)\\b`,
  ),
  // "6:30 alarm set", "the reminder's set", "it's done", "your alarm is off": what was acted on, then how it stands.
  /\b(?:alarm|alarms|reminder|reminders|timer|note|event|appointment|meeting|to-?do|task|it|that|this|everything|you're|you are)(?:'s| is| are| was| has been| have been| got)?\s+(?:now\s+|all\s+)?(?:set|done|sent|created|updated|sorted|off|taken care of)\b/,
  // "I've set…", "I just put it on your list".
  /\bi(?:'ve| have)?\s+(?:just\s+|gone ahead and\s+)?(?:set|added|saved|noted|put|logged|scheduled|booked|created|cancell?ed|deleted|removed|updated|sent|texted|messaged|emailed|wrote|written|jotted|stored|turned|cleared|moved|changed|marked)\b/,
  // "On today's list: buy a gift for Jake", "milk and eggs are on your notes".
  /(?:^|'s|'re|\bis|\bare|\bnow)\s*(?:on|in)\s+(?:your|the|today's|tomorrow's)\s+(?:list|notes|to-?do list|to-?dos|shopping list|calendar|reminders)\b/,
  // "Calling Mom.", "Setting that now.": doing it, as the sentence opens.
  /^(?:calling|texting|messaging|emailing|sending|setting|adding|saving|noting|booking|scheduling|cancell?ing|deleting|removing|logging|creating)\b/,
  // "I'll buzz you Friday at nine": a reminder promised, which only a tool makes true.
  /\bi'll\s+(?:remind|buzz|ping|nudge|wake|alert)\s+you\b/,
];

/** Whether a reply says something was done: saved, set, sent, scheduled, cancelled, or a reminder promised. */
export function claimsDone(reply: string) {
  return sentencesOf(reply).some((s) => !notAClaim(s) && (doneInAClause(s) || CLAIMS.some((claim) => claim.test(s))));
}
