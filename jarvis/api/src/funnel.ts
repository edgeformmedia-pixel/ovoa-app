// The texting trial's funnel, as counts: how many numbers started the free
// texts, how far each got, how many reached the paywall (all FREE texts used,
// guest.ts), and how many linked a real account since. Counts only: no
// numbers, emails or words. Read by GET /debug/funnel (index.ts).
//
// text_trial_numbers is the true count of trial starts (it is kept for good).
// text_guests holds each trial number's progress, but a number's row is removed
// once it links to an account, so "used" describes numbers still on the trial;
// linked accounts are counted from text_links instead.

import { FREE } from "./guest";

type GuestRow = { used: number; email: string | null; join_token: string | null; told_at: number | null };

export type Funnel = {
  from: string;
  days: number;
  trialStarts: { total: number; byDay: Record<string, number> };
  // Numbers still on the trial, by free texts used.
  stillTrial: {
    total: number;
    used: { none: number; some: number; most: number; all: number };
    gaveEmail: number;
    toldOutOfFree: number;
    payLinkOutstanding: number;
  };
  // Of the numbers still on the trial, the share that used all their free texts.
  paywallHit: { count: number; share: number };
  linkedAccounts: { total: number; byDay: Record<string, number> };
};

const DAY_MS = 86_400_000;
export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function byDay(times: number[]) {
  const out: Record<string, number> = {};
  for (const t of [...times].sort((a, b) => a - b)) out[dayOf(t)] = (out[dayOf(t)] ?? 0) + 1;
  return out;
}

export function foldFunnel(days: number, now: number, trials: number[], guests: GuestRow[], linked: number[]): Funnel {
  const used = { none: 0, some: 0, most: 0, all: 0 };
  for (const g of guests) {
    if (g.used >= FREE) used.all++;
    else if (g.used >= 5) used.most++;
    else if (g.used >= 1) used.some++;
    else used.none++;
  }
  return {
    from: dayOf(now - (days - 1) * DAY_MS),
    days,
    trialStarts: { total: trials.length, byDay: byDay(trials) },
    stillTrial: {
      total: guests.length,
      used,
      gaveEmail: guests.filter((g) => g.email).length,
      toldOutOfFree: guests.filter((g) => g.told_at).length,
      payLinkOutstanding: guests.filter((g) => g.join_token).length,
    },
    paywallHit: { count: used.all, share: guests.length ? Math.round((used.all / guests.length) * 100) / 100 : 0 },
    linkedAccounts: { total: linked.length, byDay: byDay(linked) },
  };
}

export async function textFunnel(db: D1Database, days: number, now = Date.now()): Promise<Funnel> {
  const since = dayStart(now - (days - 1) * DAY_MS);
  const [trials, guests, linked] = await Promise.all([
    db.prepare("SELECT created_at FROM text_trial_numbers WHERE created_at >= ?").bind(since).all<{ created_at: number }>(),
    db
      .prepare("SELECT used, email, join_token, told_at FROM text_guests WHERE created_at >= ?")
      .bind(since)
      .all<GuestRow>(),
    db.prepare("SELECT linked_at FROM text_links WHERE linked_at >= ?").bind(since).all<{ linked_at: number }>(),
  ]);
  return foldFunnel(
    days,
    now,
    trials.results.map((r) => r.created_at),
    guests.results,
    linked.results.map((r) => r.linked_at),
  );
}

/** Midnight UTC of the day `ms` falls in. */
const dayStart = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS;
