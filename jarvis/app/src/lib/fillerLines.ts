// The filler lines themselves, apart from fillers.ts so the turn gate can know
// them without loading the file system and the voice. Every line the app can
// say as a filler is here and nowhere else: the gate strips them from what the
// microphone hears back (turnGate.ts withoutFiller), so a line said from
// anywhere else would be answered as if the user had said it. The server
// keeps a copy for its own check (api/src/ambient.ts FILLER_LINES), and
// api/test/ambient.test.ts fails when the two differ.

/**
 * Said the moment a request is sent. Short on purpose (0.7 s or less): the old
 * lines ran 1.3-1.6 s ("One second while I get that."), so a quick answer
 * queued behind them, and their echo came back as the next question — "Give me
 * a second. just fine" and "Sure one sec say?" were both answered with "Take
 * your time" (messages, 2026-09-23).
 */
export const SHORT_FILLERS = ["One moment.", "Let me see.", "One sec.", "Sure.", "Okay."];

/** Said once, only when nothing of the answer has arrived a few seconds after the request (voice.ts STILL_ON_IT_MS). */
export const STILL_ON_IT = ["Still on it.", "Bear with me."];

export const FILLERS = [...SHORT_FILLERS, ...STILL_ON_IT];
