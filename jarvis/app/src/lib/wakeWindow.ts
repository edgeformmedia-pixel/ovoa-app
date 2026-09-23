// When what the phone hears may reach the assistant, decided without a microphone.
//
// In wake mode the phone listens for the assistant's name on its own (the
// NameEar module, all on the device), and what it hears goes no further than
// this phone until the name is heard, the band's button is pressed, or the
// assistant has just replied and is waiting for a follow-up. This is the clock
// for that: a window that opens on one of those and closes when it has run
// out. liveListen.ts hands the ear's words to the turn gate only while it is
// open (earWords.ts open/close); outside it, room talk isn't even looked at.
// (Until 2026-09-23 the same window decided when the microphone's audio
// streamed to Deepgram. Nothing streams any more; the window stayed.)
//
// It is a plain object with no timers of its own, fed the current time, so the
// whole story (name heard, request sent, reply spoken, window lapses) can be
// checked in a test that never touches audio. api/test/wake.test.ts does.

/** Why the window opened or was kept open. */
export type WakeReason = "name" | "summon" | "speech" | "turn" | "reply" | "busy" | "follow-up";

/** How long each reason keeps the window open, in ms. */
export const WAKE_MS: Record<WakeReason, number> = {
  /** The name was heard: long enough to say the request and for it to be sent. */
  name: 12_000,
  /** The band's button: the same, from the press. */
  summon: 10_000,
  /** Words are still arriving: a long request is not cut off while it is being said. */
  speech: 10_000,
  /** A request is on its way to the server, or being answered. */
  turn: 30_000,
  /** The reply is being read out; the user may talk over it. Audio can outlast the words. */
  reply: 60_000,
  /**
   * The assistant is still thinking, or its reply is still playing: renewed
   * every moment that lasts, so the window outlives a slow first sentence or
   * a long read-aloud by only this much, and the user can still cut in.
   */
  busy: 10_000,
  /** After a reply: an answer without the name still counts (turnGate.ts FOLLOW_UP_MS is 8 s). */
  "follow-up": 10_000,
};

export class WakeWindow {
  private until = 0;
  private openedAt = 0;
  /** How many times the window opened, for the log. */
  opens = 0;

  /** Whether the ear's words should reach the gate right now. */
  awake(now: number) {
    return now < this.until;
  }

  /**
   * Something asked for attention. Returns true when this opened the window
   * (it was closed), which is when the words start going to the gate; false
   * when it only kept an open window open longer.
   */
  wake(reason: WakeReason, now: number): boolean {
    const wasAsleep = !this.awake(now);
    this.until = Math.max(this.until, now + WAKE_MS[reason]);
    if (wasAsleep) {
      this.openedAt = now;
      this.opens++;
    }
    return wasAsleep;
  }

  /** The window is over now, whatever was left of it. */
  close(now: number) {
    this.until = Math.min(this.until, now);
  }

  /** How long the current window has been open, or 0 when closed. */
  openFor(now: number) {
    return this.awake(now) ? now - this.openedAt : 0;
  }
}
