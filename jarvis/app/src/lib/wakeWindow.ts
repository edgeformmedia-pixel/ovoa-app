// When audio may leave the phone, decided without a microphone.
//
// In wake mode the phone listens for the assistant's name on its own (the
// NameEar module, all on the device). Nothing is sent anywhere until the name
// is heard, the band's button is pressed, or the assistant has just replied and
// is waiting for a follow-up. This is the clock for that: a window that opens
// on one of those and closes when it has run out. liveListen.ts opens and
// closes the live transcription connection to match it.
//
// It is a plain object with no timers of its own, fed the current time, so the
// whole story (name heard, request sent, reply spoken, window lapses) can be
// checked in a test that never touches audio. api/test/wake.test.ts does.

/** Why the window opened or was kept open. */
export type WakeReason = "name" | "summon" | "speech" | "turn" | "reply" | "busy" | "follow-up";

/** How long each reason keeps the connection open, in ms. */
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
   * every moment that lasts, so the connection outlives a slow first sentence
   * or a long read-aloud by only this much, and the user can still cut in.
   */
  busy: 10_000,
  /** After a reply: an answer without the name still counts (turnGate.ts FOLLOW_UP_MS is 8 s). */
  "follow-up": 10_000,
};

/**
 * The fallback, when the phone cannot hear its own name: live transcription
 * runs all the time, as it did before, but switches itself off after this long
 * without anything addressed to the assistant.
 */
export const AUTO_OFF_MS = 10 * 60_000;

/** The fallback's daily allowance of streamed audio, in seconds. */
export const DAILY_STREAM_CAP_S = 60 * 60;

export class WakeWindow {
  private until = 0;
  private lastWakeAt = 0;
  private openedAt = 0;
  /** How many times the window opened, for the log. */
  opens = 0;

  /** Whether audio should be going out right now. */
  awake(now: number) {
    return now < this.until;
  }

  /**
   * Something asked for attention. Returns true when this opened the window
   * (it was closed), which is when the connection has to be made and the
   * pre-roll sent; false when it only kept an open window open longer.
   */
  wake(reason: WakeReason, now: number): boolean {
    const wasAsleep = !this.awake(now);
    this.until = Math.max(this.until, now + WAKE_MS[reason]);
    this.lastWakeAt = now;
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

  /** Nothing has asked for attention in AUTO_OFF_MS: the fallback should stop listening. */
  stale(now: number, sinceStart: number) {
    const last = this.lastWakeAt || sinceStart;
    return now - last >= AUTO_OFF_MS;
  }
}

/**
 * The fallback's daily allowance: seconds of audio streamed today. Kept by the
 * caller in storage as `{ day, seconds }`; this is the arithmetic.
 */
export type DailyMeter = { day: string; seconds: number };

/** The phone's own calendar day, so "it's back tomorrow" means the user's tomorrow. */
export const dayKey = (now: number) => {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** Adds seconds to today's total, starting fresh on a new day. */
export function meterAdd(meter: DailyMeter | null, seconds: number, now: number): DailyMeter {
  const day = dayKey(now);
  const base = meter && meter.day === day ? meter.seconds : 0;
  return { day, seconds: Math.max(0, base + Math.max(0, seconds)) };
}

/** Whether today's allowance is used up. */
export function meterOver(meter: DailyMeter | null, now: number, cap = DAILY_STREAM_CAP_S) {
  return !!meter && meter.day === dayKey(now) && meter.seconds >= cap;
}
