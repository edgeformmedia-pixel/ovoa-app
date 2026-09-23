// A ceiling on replies per person per month (cost pass, Phase 8, 2026-09-22).
//
// One person asking a thousand questions a month is the plan; one phone stuck
// in a loop asking ten thousand is a bill. The cap is counted from usage_daily
// (a turn row per answered reply), so it costs nothing extra to keep. Since the
// v1 release it is per plan, the daily replies × 31: Base 620, Pro 1,860
// (plans.ts ALLOWANCES.monthly). This file is only the arithmetic and the
// words; development accounts are never capped (index.ts standingFor).

/** At this share of the cap the person is told once, in the reply they were getting anyway. */
export const WARN_AT = 0.8;

export type CapVerdict = "ok" | "warn" | "over";

/**
 * Where a person stands: `used` replies so far this month against `cap`.
 * "warn" is the first reply at or past the warning line; the caller marks that
 * it was said, so it is said once.
 */
export function capVerdict(used: number, cap: number, warned: boolean): CapVerdict {
  if (!cap) return "ok";
  if (used >= cap) return "over";
  if (!warned && used >= Math.ceil(cap * WARN_AT)) return "warn";
  return "ok";
}

/** The first of next month, in the person's own time zone, said the way a person would. */
export function nextMonthStart(now: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric" }).formatToParts(new Date(now));
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value); // 1-12
  const next = new Date(Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1, 12));
  return next.toLocaleDateString("en-US", { month: "long", day: "numeric" });
}

/** The calendar month `now` falls in for this person, as "2026-09". Keys the once-only warning. */
export function monthKey(now: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit" }).formatToParts(new Date(now));
  return `${parts.find((p) => p.type === "year")?.value}-${parts.find((p) => p.type === "month")?.value}`;
}

/** One sentence, spoken or shown, when the month's replies are used up. */
export function overCapMessage(cap: number, now: number, timeZone: string) {
  return `I've reached this month's limit of ${cap.toLocaleString("en-US")} replies, so I'll pick up again on ${nextMonthStart(now, timeZone)}.`;
}

/** One sentence added to a reply, once, when most of the month's replies are gone. */
export function warnMessage(used: number, cap: number) {
  return `Heads up: that's ${used.toLocaleString("en-US")} of this month's ${cap.toLocaleString("en-US")} replies.`;
}
