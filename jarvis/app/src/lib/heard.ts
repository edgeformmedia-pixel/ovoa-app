import { api } from "./api";
import { logFail } from "./devlog";

// Everything the phone overheard and decided was not for the assistant. Until
// now it went to the device log and no further, so "what did I say today" could
// only answer from the few sentences OVOA happened to reply to.
//
// Batched on purpose: the microphone produces far more of these than it does
// requests, and a round trip each would be most of what the radio was doing.
// Whether any of it is stored at all is the server's call (transcripts.ts,
// storeLines) -- nothing is kept unless capture-everything is on.

const FLUSH_AFTER_MS = 15_000;
/** Send early rather than hold more than this. Also the server's per-request cap. */
const MAX_PENDING = 200;

let pending: { ts: number; text: string }[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

/** Remembers one overheard line. Sent with the others a few seconds later. */
export function keepHeard(token: string, text: string) {
  const clean = text.trim();
  if (!token || !clean) return;
  pending.push({ ts: Date.now(), text: clean });
  if (pending.length >= MAX_PENDING) {
    void flushHeard(token);
    return;
  }
  timer ??= setTimeout(() => void flushHeard(token), FLUSH_AFTER_MS);
}

/**
 * Sends what is waiting. On a timer, when the buffer fills, and when the app goes
 * away. A failed send is dropped rather than retried: this is a record of the
 * room, not of anything anyone is waiting on, and a queue that only grows is
 * worse than a gap.
 */
export async function flushHeard(token: string) {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const lines = pending;
  pending = [];
  if (!token || !lines.length) return;
  await api.keepHeard(token, lines).catch(logFail("heard: api.keepHeard"));
}
