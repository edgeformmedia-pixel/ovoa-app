import { Hono } from "hono";
import { z } from "zod";
import { logAction } from "./actionlog";
import { validTimeZone } from "./google/assistant";
import type { CallTool, ToolSpec } from "./llm";
import { push } from "./push";
import { addDays, buckets } from "./time";
import type { Env, Vars } from "./types";
import { inSlice, type Slice } from "./sweep";

// Money. See migrations/0028_money.sql.
//
// The question this exists to answer is asked standing in a shop: "I like these
// shoes, can I get them?" A good answer is not a budget app. It is the thing a
// friend who knew your situation would say — what's actually in the account,
// what's coming out before you get paid again, that this week's cheque was light,
// and what the shoes would cost you in things you'd already said you wanted to do.
// Then it stops, because the decision is theirs.
//
// So the rules for every answer here: give the number, name the pinch, name the
// trade, hand it back. Never decide for them, never moralise, never round a
// "tight" up into a "no". Money advice that nags gets turned off in a week, and
// an assistant that has been turned off can't help at all.
//
// This is a picture of their money, not their bank. Nothing connects to an
// institution; every number came from the user or from a bill in their mail.
// It says how old a number is whenever it's about to lean on it.

export type Cadence = "weekly" | "biweekly" | "semimonthly" | "monthly" | "yearly" | "once";

/** How far ahead to look when we don't know when they next get paid. */
export const DEFAULT_HORIZON_DAYS = 14;
/** A balance older than this is described as a guess rather than a fact. */
export const STALE_BALANCE_DAYS = 4;
/** Days of spending history averaged into the "the rest of the week will cost something" line. */
const SPEND_WINDOW_DAYS = 28;
/** Below this much history the daily rate is a guess dressed up as a number, so it isn't used at all. */
const SPEND_HISTORY_DAYS = 7;
const SPEND_HISTORY_COUNT = 5;
/** How far back "your usual paycheck" looks. */
const PAY_AVERAGE_DAYS = 92;
/** A cheque under this share of the usual is worth mentioning unprompted. */
const PAY_DIP = 0.05;

// ---------- Dates, which is where this kind of feature usually goes wrong ----------

const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const validDay = (v: unknown) => (typeof v === "string" && DAY.test(v) ? v : null);

/** Whole days from `a` to `b`. Both are local dates, so this is calendar days, not elapsed time. */
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/**
 * The same day-of-month, n months on, clamped to the end of short months: the
 * 31st becomes the 28th in February and the 30th in April. Clamping rather than
 * spilling into the next month is what a person means by "the 31st of every
 * month", and it's the difference between a rent reminder on the 3rd of March
 * and one on the 28th of February.
 */
export function addMonths(day: string, n: number) {
  const [y, m, d] = day.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, "0")}-${String(Math.min(d, lastDay)).padStart(2, "0")}`;
}

/**
 * The first time a repeating thing anchored at `anchor` happens on or after
 * `from`. Null for a one-off that's already been.
 *
 * Weekly and fortnightly step in days, which is right even across a clock
 * change, because a fortnightly payday is every fourteen sleeps and not every
 * 336 hours. Monthly steps in months for the same reason in reverse.
 */
export function nextOccurrence(anchor: string, cadence: Cadence, from: string): string | null {
  if (cadence === "once") return anchor >= from ? anchor : null;
  if (cadence === "weekly" || cadence === "biweekly") {
    const step = cadence === "weekly" ? 7 : 14;
    const gap = daysBetween(anchor, from);
    // Ceiling division that also works for a `from` before the anchor.
    return addDays(anchor, Math.max(0, Math.ceil(gap / step)) * step);
  }
  if (cadence === "semimonthly") {
    // Twice a month, a fortnight apart: the anchor's day and the day fifteen
    // later or earlier, whichever keeps both inside one month (the 1st and the
    // 16th, the 3rd and the 18th). Clamped, so February behaves.
    const d = Number(anchor.slice(8));
    const days = [d, d <= 15 ? d + 15 : d - 15].sort((a, b) => a - b);
    const start = Math.max(0, monthsBetween(anchor, from) - 1);
    for (let i = start; i < start + 3; i++) {
      const month = addMonths(`${anchor.slice(0, 8)}01`, i);
      for (const day of days) {
        const at = clampToMonth(month, day);
        if (at >= from && at >= anchor) return at;
      }
    }
    return null;
  }
  // Monthly and yearly. Every step is measured from the anchor rather than from
  // the last one, because clamping twice loses a day for good: the 31st becomes
  // the 28th in February and would then stay the 28th for the rest of the year.
  const months = cadence === "yearly" ? 12 : 1;
  let k = Math.max(0, Math.floor(monthsBetween(anchor, from) / months) - 1);
  let at = addMonths(anchor, k * months);
  while (at < from) at = addMonths(anchor, ++k * months);
  return at;
}

const monthsBetween = (a: string, b: string) =>
  (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + (Number(b.slice(5, 7)) - Number(a.slice(5, 7)));

function clampToMonth(monthStart: string, day: number) {
  const [y, m] = monthStart.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${monthStart.slice(0, 8)}${String(Math.min(day, lastDay)).padStart(2, "0")}`;
}

/** Every time it happens in [from, to). A weekly bill can fall twice before payday. */
export function occurrencesBetween(anchor: string, cadence: Cadence, from: string, to: string) {
  const out: string[] = [];
  let at = nextOccurrence(anchor, cadence, from);
  // Ten is well past any real cadence inside a pay cycle, and is the guard that
  // stops a bad cadence string spinning forever.
  while (at && at < to && out.length < 10) {
    out.push(at);
    const after = nextOccurrence(anchor, cadence, addDays(at, 1));
    if (!after || after <= at) break;
    at = after;
  }
  return out;
}

// ---------- Saying it ----------

/** "$320", "$18.50". Whole dollars lose the cents, because nobody says "three hundred and twenty point zero zero". */
export function money(cents: number, currency = "USD") {
  const abs = Math.abs(cents);
  const s = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: abs % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(abs / 100);
  return cents < 0 ? `-${s}` : s;
}

/** Dollars from whatever the model said: 40, "40", "$40.50", "40 dollars". */
export function toCents(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v * 100);
  if (typeof v !== "string") return null;
  const m = /-?\d+(\.\d+)?/.exec(v.replace(/,/g, ""));
  return m ? Math.round(Number(m[0]) * 100) : null;
}

// ---------- The picture, and the verdict ----------

export type Picture = {
  currency: string;
  /** Spendable now: checking and cash. Savings is named separately, not counted. */
  balanceCents: number;
  savingsCents: number;
  /** How old the freshest balance is, in days. Null when no balance was ever given. */
  balanceAgeDays: number | null;
  bufferCents: number;
  today: string;
  /** The day the next money lands, and how much. Null when we don't know. */
  nextPayDate: string | null;
  nextPayCents: number | null;
  daysToPay: number;
  /** The last paycheck against the usual one: -0.1 is ten percent light. */
  payDelta: number | null;
  lastPayCents: number | null;
  usualPayCents: number | null;
  billsDue: { id: string; name: string; amountCents: number; date: string; autopay: boolean }[];
  /** Bills due before payday whose amount varies and was never given. */
  unknownBills: string[];
  plans: { id: string; text: string; amountCents: number; date: string | null }[];
  /** Planned spending on the far side of payday: the new money covers it, so it isn't held back — but it's still a thing they said they'd do, and vanishing silently is how a number stops being trusted. */
  plansAfterPay: { text: string; amountCents: number; date: string | null }[];
  /** What the days before payday usually cost, from what they've mentioned spending. */
  dailySpendCents: number;
  spendKnown: boolean;
};

export type Assessment = {
  verdict: "yes" | "tight" | "no";
  askCents: number;
  billsCents: number;
  plansCents: number;
  expectedSpendCents: number;
  /** Spendable after everything already spoken for, and after the cushion. */
  freeCents: number;
  afterCents: number;
  /** How far past `free` the purchase goes. 0 when it fits outright. */
  gapCents: number;
  /** Plans that, dropped, would cover the gap. The trade, named, for them to weigh. */
  dropOneOf: { id: string; text: string; amountCents: number }[];
  /** True when the gap is bigger than everything they could choose to drop. */
  cantCover: boolean;
};

/**
 * Whether the purchase fits, and what it costs if it doesn't.
 *
 * Three answers, not two. "Yes" is money they have spare. "No" is money they
 * don't have. "Tight" is the interesting one: it fits, but only by eating the
 * cushion they keep against being caught out — and that is a real choice a
 * person is allowed to make, so it gets named as a choice rather than refused.
 */
export function assess(p: Picture, askCents: number): Assessment {
  const billsCents = p.billsDue.reduce((n, b) => n + b.amountCents, 0);
  const plansCents = p.plans.reduce((n, x) => n + x.amountCents, 0);
  const expectedSpendCents = Math.max(0, p.daysToPay) * p.dailySpendCents;
  const freeCents = p.balanceCents - billsCents - plansCents - expectedSpendCents - p.bufferCents;
  const afterCents = freeCents - askCents;
  const gapCents = Math.max(0, -afterCents);
  const verdict = afterCents >= 0 ? "yes" : gapCents <= p.bufferCents ? "tight" : "no";

  // The smallest handful of plans that would cover the gap, biggest first: one
  // thing to give up beats a list of five.
  const dropOneOf: Assessment["dropOneOf"] = [];
  let covered = 0;
  for (const plan of [...p.plans].sort((a, b) => b.amountCents - a.amountCents)) {
    if (covered >= gapCents) break;
    dropOneOf.push({ id: plan.id, text: plan.text, amountCents: plan.amountCents });
    covered += plan.amountCents;
  }
  return {
    verdict,
    askCents,
    billsCents,
    plansCents,
    expectedSpendCents,
    freeCents,
    afterCents,
    gapCents,
    dropOneOf: gapCents > 0 ? dropOneOf : [],
    cantCover: gapCents > 0 && covered < gapCents,
  };
}

/**
 * The answer as a sentence, for when there's no model in the loop (a push, the
 * morning brief, a fallback). The spoken version is the model's job; this is
 * the same facts in the same order, so the two never disagree.
 */
const sentence = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;

export function headline(p: Picture, a: Assessment) {
  const c = p.currency;
  const pinch: string[] = [];
  if (p.payDelta !== null && p.payDelta <= -PAY_DIP) pinch.push(`this cheque was ${Math.round(-p.payDelta * 100)}% under your usual`);
  if (p.billsDue.length) {
    const first = p.billsDue[0];
    pinch.push(`${first.name} (${money(first.amountCents, c)}) is due${p.nextPayDate ? " before you're paid again" : ` on the ${Number(first.date.slice(8))}`}`);
  }
  const trade = a.dropOneOf.length && !a.cantCover ? ` If you're fine skipping ${a.dropOneOf.map((d) => d.text).join(" and ")}, it works — your call.` : "";
  if (a.verdict === "yes") {
    // The pinch is a whole clause, so on a yes it gets its own sentence rather
    // than being bolted on: "spare, even with this cheque was light" is not English.
    return `${money(a.askCents, c)} is fine — that leaves ${money(a.afterCents, c)} spare.${pinch.length ? ` Worth knowing: ${pinch.join(", and ")}.` : ""}`;
  }
  if (a.verdict === "tight") {
    return `${money(a.askCents, c)} would make things tight${pinch.length ? `: ${pinch.join(", and ")}` : ""}. It'd put you ${money(a.gapCents, c)} into your cushion.${trade}`;
  }
  return `${money(a.askCents, c)} is more than you've got spare — you'd be ${money(a.gapCents, c)} short.${pinch.length ? ` ${sentence(pinch.join(", and "))}` : ""}${a.cantCover ? "" : trade}`;
}

// ---------- Reading it out of the database ----------

async function settingsFor(db: D1Database, userId: string) {
  const row = await db.prepare("SELECT currency, buffer_cents FROM money_settings WHERE user_id = ?").bind(userId).first<{ currency: string; buffer_cents: number }>();
  return { currency: row?.currency ?? "USD", bufferCents: row?.buffer_cents ?? 10_000 };
}

/** Everything the verdict leans on, gathered once. */
export async function picture(db: D1Database, userId: string, timeZone: string): Promise<Picture> {
  const now = Date.now();
  const today = buckets(now, timeZone).day;
  const [settings, accounts, incomes, paychecks, bills, plans, spend] = await Promise.all([
    settingsFor(db, userId),
    db.prepare("SELECT kind, balance_cents, updated_at FROM money_accounts WHERE user_id = ?").bind(userId).all<{ kind: string; balance_cents: number; updated_at: number }>(),
    db.prepare("SELECT id, name, amount_cents, cadence, anchor FROM money_income WHERE user_id = ? AND active = 1").bind(userId).all<{ id: string; name: string; amount_cents: number | null; cadence: string; anchor: string }>(),
    db
      .prepare("SELECT date, amount_cents FROM money_paychecks WHERE user_id = ? AND date >= ? ORDER BY date DESC")
      .bind(userId, addDays(today, -PAY_AVERAGE_DAYS))
      .all<{ date: string; amount_cents: number }>(),
    db
      .prepare("SELECT id, name, amount_cents, cadence, next_due, autopay FROM money_bills WHERE user_id = ? AND active = 1")
      .bind(userId)
      .all<{ id: string; name: string; amount_cents: number | null; cadence: string; next_due: string; autopay: number }>(),
    db
      .prepare("SELECT id, text, amount_cents, on_date FROM money_plans WHERE user_id = ? AND status = 'planned'")
      .bind(userId)
      .all<{ id: string; text: string; amount_cents: number; on_date: string | null }>(),
    db
      .prepare("SELECT SUM(amount_cents) AS total, MIN(ts) AS first, COUNT(*) AS n FROM money_spend WHERE user_id = ? AND ts >= ?")
      .bind(userId, now - SPEND_WINDOW_DAYS * 86_400_000)
      .first<{ total: number | null; first: number | null; n: number }>(),
  ]);

  const spendable = accounts.results.filter((a) => a.kind === "checking" || a.kind === "cash");
  const freshest = accounts.results.reduce<number | null>((max, a) => (max === null || a.updated_at > max ? a.updated_at : max), null);

  // The next payday across every income, and what it should bring. A cheque with
  // no stated amount is worth the recent average, which is the only honest guess
  // for shift work — and the same average the dip is measured against.
  const cheques = paychecks.results;
  const usualPayCents = cheques.length >= 2 ? Math.round(cheques.reduce((n, p) => n + p.amount_cents, 0) / cheques.length) : null;
  let nextPayDate: string | null = null;
  let nextPayCents: number | null = null;
  for (const income of incomes.results) {
    const at = nextOccurrence(income.anchor, income.cadence as Cadence, today);
    if (!at || (nextPayDate && at >= nextPayDate)) continue;
    nextPayDate = at;
    nextPayCents = income.amount_cents ?? usualPayCents;
  }

  // Anything due between now and the money landing. On payday itself the money
  // is there, so the window stops at it.
  const horizon = nextPayDate ?? addDays(today, DEFAULT_HORIZON_DAYS);
  const billsDue: Picture["billsDue"] = [];
  const unknownBills: string[] = [];
  for (const b of bills.results) {
    const dates = occurrencesBetween(b.next_due, b.cadence as Cadence, today, horizon);
    if (!dates.length) continue;
    if (b.amount_cents === null) {
      unknownBills.push(b.name);
      continue;
    }
    for (const date of dates) billsDue.push({ id: b.id, name: b.name, amountCents: b.amount_cents, date, autopay: !!b.autopay });
  }
  billsDue.sort((x, y) => x.date.localeCompare(y.date));

  // A day of spending, from what they've actually mentioned. Averaged over the
  // days we have rather than the full window, so one week of notes isn't read
  // as four weeks of thrift — but only once there's enough to average. One
  // mentioned lunch is not eleven dollars a day for a fortnight, and guessing
  // that it is quietly eats a hundred and fifty pounds of their own money.
  const spentDays = spend?.first ? Math.max(1, Math.ceil((now - spend.first) / 86_400_000)) : 0;
  const rateKnown = spentDays >= SPEND_HISTORY_DAYS && (spend?.n ?? 0) >= SPEND_HISTORY_COUNT;
  const lastPay = cheques[0] ?? null;
  const priorAvg = cheques.length >= 3 ? Math.round(cheques.slice(1).reduce((n, p) => n + p.amount_cents, 0) / (cheques.length - 1)) : null;

  return {
    currency: settings.currency,
    balanceCents: spendable.reduce((n, a) => n + a.balance_cents, 0),
    savingsCents: accounts.results.filter((a) => a.kind === "savings").reduce((n, a) => n + a.balance_cents, 0),
    balanceAgeDays: freshest === null ? null : Math.floor((now - freshest) / 86_400_000),
    bufferCents: settings.bufferCents,
    today,
    nextPayDate,
    nextPayCents,
    daysToPay: daysBetween(today, horizon),
    payDelta: lastPay && priorAvg ? (lastPay.amount_cents - priorAvg) / priorAvg : null,
    lastPayCents: lastPay?.amount_cents ?? null,
    usualPayCents: priorAvg ?? usualPayCents,
    billsDue,
    unknownBills,
    plans: plans.results
      .filter((p) => !p.on_date || p.on_date < horizon)
      .map((p) => ({ id: p.id, text: p.text, amountCents: p.amount_cents, date: p.on_date })),
    plansAfterPay: plans.results
      .filter((p) => p.on_date && p.on_date >= horizon)
      .map((p) => ({ text: p.text, amountCents: p.amount_cents, date: p.on_date })),
    dailySpendCents: rateKnown ? Math.round((spend!.total ?? 0) / spentDays) : 0,
    spendKnown: rateKnown,
  };
}

/** Everything the model needs, and nothing it would have to do arithmetic on. */
function facts(p: Picture, a: Assessment | null) {
  const c = p.currency;
  return {
    balance: p.balanceCents ? money(p.balanceCents, c) : null,
    balanceIs: p.balanceAgeDays === null ? "unknown" : p.balanceAgeDays >= STALE_BALANCE_DAYS ? `${p.balanceAgeDays} days old — check it's still right` : "current",
    savings: p.savingsCents ? money(p.savingsCents, c) : null,
    cushion: money(p.bufferCents, c),
    nextPay: p.nextPayDate ? { date: p.nextPayDate, inDays: p.daysToPay, amount: p.nextPayCents ? money(p.nextPayCents, c) : null } : null,
    lastPaycheck:
      p.payDelta === null
        ? null
        : {
            amount: money(p.lastPayCents!, c),
            usual: money(p.usualPayCents!, c),
            versusUsual: `${p.payDelta >= 0 ? "+" : ""}${Math.round(p.payDelta * 100)}%`,
            worthMentioning: p.payDelta <= -PAY_DIP,
          },
    billsBeforePay: p.billsDue.map((b) => `${b.name} ${money(b.amountCents, c)} on ${b.date}${b.autopay ? " (autopay)" : ""}`),
    billsWithNoAmount: p.unknownBills,
    alreadyPlanned: p.plans.map((x) => ({ id: x.id, what: x.text, cost: money(x.amountCents, c), when: x.date })),
    plannedAfterPayday: p.plansAfterPay.map((x) => `${x.text} (${money(x.amountCents, c)}) on ${x.date} — their next pay covers it, so it isn't held back here`),
    everydaySpending: p.spendKnown ? `about ${money(p.dailySpendCents, c)} a day` : "not tracked",
    ...(a && {
      verdict: a.verdict,
      asking: money(a.askCents, c),
      spareBefore: money(a.freeCents, c),
      leftAfter: money(a.afterCents, c),
      short: a.gapCents ? money(a.gapCents, c) : null,
      couldFreeUpBy: a.dropOneOf.map((d) => `${d.text} (${money(d.amountCents, c)})`),
      evenDroppingThoseItDoesntFit: a.cantCover,
      say: headline(p, a),
    }),
  };
}

// ---------- Writing to it ----------

export async function setBalance(db: D1Database, userId: string, cents: number, name = "Checking", kind = "checking") {
  const existing = await db.prepare("SELECT id FROM money_accounts WHERE user_id = ? AND kind = ? AND name = ?").bind(userId, kind, name).first<{ id: string }>();
  if (existing) {
    await db.prepare("UPDATE money_accounts SET balance_cents = ?, updated_at = ? WHERE id = ?").bind(cents, Date.now(), existing.id).run();
    return existing.id;
  }
  const id = crypto.randomUUID();
  await db
    .prepare("INSERT INTO money_accounts (id, user_id, name, kind, balance_cents, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, userId, name, kind, cents, Date.now())
    .run();
  return id;
}

/**
 * A paycheck landed. The balance moves with it, because the most common way
 * for this feature to be wrong is a balance from before payday.
 */
export async function recordPaycheck(db: D1Database, userId: string, cents: number, date: string) {
  await db
    .prepare("INSERT INTO money_paychecks (id, user_id, date, amount_cents, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), userId, date, cents, Date.now())
    .run();
  await db
    .prepare("UPDATE money_accounts SET balance_cents = balance_cents + ?, updated_at = ? WHERE user_id = ? AND kind = 'checking'")
    .bind(cents, Date.now(), userId)
    .run();
}

/**
 * A bill found in the user's mail (extras.ts, F25). Matched on the payee, so a
 * bill that arrives every month updates the one row rather than piling up, and
 * one the user set up by hand keeps their amount if the mail didn't have one.
 */
export async function recordBillFromMail(db: D1Database, userId: string, name: string, due: string, cents: number | null) {
  const existing = await db
    .prepare("SELECT id, amount_cents FROM money_bills WHERE user_id = ? AND lower(name) = lower(?)")
    .bind(userId, name)
    .first<{ id: string; amount_cents: number | null }>();
  if (existing) {
    await db
      .prepare("UPDATE money_bills SET next_due = ?, amount_cents = COALESCE(?, amount_cents), active = 1 WHERE id = ?")
      .bind(due, cents, existing.id)
      .run();
    return existing.id;
  }
  const id = crypto.randomUUID();
  await db
    .prepare("INSERT INTO money_bills (id, user_id, name, amount_cents, cadence, next_due, source, created_at) VALUES (?, ?, ?, ?, 'monthly', ?, 'mail', ?)")
    .bind(id, userId, name.slice(0, 80), cents, due, Date.now())
    .run();
  return id;
}

// ---------- The tick ----------

/**
 * Twice a day, and only when there's something to say: bills whose date has
 * passed roll forward so tomorrow's answers aren't computed against last
 * month's calendar, and a pay cycle that genuinely doesn't cover what's due
 * gets said out loud once — before the payment bounces, not after.
 */
export async function moneyTick(env: Env, slice?: Slice) {
  const db = env.DB;
  const now = Date.now();
  const { results } = await db
    .prepare(
      `SELECT s.user_id, s.time_zone FROM settings s
        WHERE EXISTS (SELECT 1 FROM money_accounts a WHERE a.user_id = s.user_id)`,
    )
    .all<{ user_id: string; time_zone: string | null }>();

  let rolled = 0;
  let warned = 0;
  for (const u of results) {
    if (!inSlice(u.user_id, slice)) continue;
    const timeZone = validTimeZone(u.time_zone);
    const today = buckets(now, timeZone).day;
    const { results: stale } = await db
      .prepare("SELECT id, cadence, next_due FROM money_bills WHERE user_id = ? AND active = 1 AND next_due < ?")
      .bind(u.user_id, today)
      .all<{ id: string; cadence: string; next_due: string }>();
    for (const b of stale) {
      const next = nextOccurrence(b.next_due, b.cadence as Cadence, today);
      await db
        .prepare(next ? "UPDATE money_bills SET next_due = ? WHERE id = ?" : "UPDATE money_bills SET active = 0 WHERE id = ?")
        .bind(...(next ? [next, b.id] : [b.id]))
        .run();
      rolled++;
    }

    // The warning goes out mid-morning, once for a pay cycle. An overdraft
    // warning at eleven at night is just something to lie awake about.
    const hour = Number(buckets(now, timeZone).hour.slice(11));
    if (hour !== 10) continue;
    const p = await picture(db, u.user_id, timeZone);
    if (!p.balanceCents || p.balanceAgeDays === null || p.balanceAgeDays > 7) continue;
    const a = assess(p, 0);
    if (a.afterCents >= 0) continue;
    const key = `shortfall|${p.nextPayDate ?? p.today}`;
    const claimed = await db
      .prepare("INSERT OR IGNORE INTO daily_marks (user_id, kind, day, at) VALUES (?, 'money', ?, ?)")
      .bind(u.user_id, key, now)
      .run();
    if (!claimed.meta.changes) continue;
    await push(env, u.user_id, {
      title: p.nextPayDate ? `Tight until ${p.nextPayDate}` : "Money's tight this week",
      body: headline(p, a).slice(0, 180),
      data: { type: "money" },
    });
    await logAction(db, u.user_id, "money", `Short ${money(a.gapCents, p.currency)} before payday`, "system");
    warned++;
  }
  return { rolled, warned };
}

/** One line for the morning brief, only when there's a pinch worth knowing about before the day starts. */
export async function moneyBriefLine(db: D1Database, userId: string, timeZone: string) {
  const p = await picture(db, userId, timeZone);
  if (p.balanceAgeDays === null || p.balanceAgeDays > 7) return null;
  const a = assess(p, 0);
  const dip = p.payDelta !== null && p.payDelta <= -PAY_DIP;
  if (a.afterCents >= 0 && !dip) return null;
  return headline(p, a);
}

// ---------- In conversation ----------

const TOOLS: ToolSpec[] = [
  {
    name: "money_afford",
    description:
      "Whether they can afford something they're thinking of buying, right now. Use for 'can I get these', 'can I afford X', 'should I buy this'. Returns the numbers and what they'd have to give up; the decision stays with the user.",
    parameters: {
      type: "object",
      properties: {
        amount: { type: "number", description: "What it costs, in dollars." },
        what: { type: "string", description: "What it is, e.g. 'shoes'. Optional." },
      },
      required: ["amount"],
    },
  },
  {
    name: "money_status",
    description: "Where their money stands: balance, next payday, bills due before it, what's already planned, what's spare. Use for 'how am I doing', 'can I make it to payday', 'what's left'.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "money_update",
    description:
      "Records a money fact they just said. balance: what's in the account now. paycheck: one that landed (also adds it to the balance). spend: money that went out. income: how often they're paid — needs cadence and a recent payday. cushion: how low they're willing to go.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["balance", "paycheck", "spend", "income", "cushion"] },
        amount: { type: "number", description: "Dollars." },
        what: { type: "string", description: "For spend, what it was on. For balance or income, which account or job." },
        date: { type: "string", description: "YYYY-MM-DD. For income, a payday that actually happened. Defaults to today." },
        cadence: { type: "string", enum: ["weekly", "biweekly", "semimonthly", "monthly"], description: "For income." },
        account: { type: "string", enum: ["checking", "savings", "cash"], description: "For balance. Defaults to checking." },
      },
      required: ["kind", "amount"],
    },
  },
  {
    name: "money_bill",
    description: "A recurring bill. add needs a name, a due date and, when they know it, an amount. paid marks this one off and moves it to the next one. remove stops tracking it.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "paid", "remove"] },
        name: { type: "string" },
        amount: { type: "number", description: "Dollars. Leave out when it varies." },
        date: { type: "string", description: "YYYY-MM-DD the next one is due." },
        cadence: { type: "string", enum: ["monthly", "weekly", "biweekly", "yearly", "once"] },
        autopay: { type: "boolean" },
        id: { type: "string", description: "For paid or remove; from money_status." },
      },
      required: ["action"],
    },
  },
  {
    name: "money_plan",
    description:
      "Something they've said they're going to spend money on soon — a date on Saturday, a trip. Keeping these is what lets money_afford name a real trade-off instead of just saying no. drop or did removes it from what's set aside.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "drop", "did"] },
        text: { type: "string", description: "What it is, in their words." },
        amount: { type: "number", description: "Roughly what it'll cost, in dollars." },
        date: { type: "string", description: "YYYY-MM-DD, if they said when." },
        id: { type: "string", description: "For drop or did; from money_status." },
      },
      required: ["action"],
    },
  },
];

const NAMES = new Set(TOOLS.map((t) => t.name));
export const isMoneyTool = (name: string) => NAMES.has(name);

export const MONEY_PROMPT = [
  "You keep a rough picture of their money: what's in the account, when they're next paid, what's due before then, and what they've already said they want to spend on.",
  "When they ask whether they can buy something, call money_afford and answer with its numbers. Say the verdict first, then the one fact that drives it (a light paycheck, a bill landing before payday), then the trade — what they'd have to skip for it to work.",
  "The decision is always theirs. Offer the trade and hand it back: \"if you're okay skipping X, sure — your call.\" Never lecture, never moralise, never refuse to answer. \"Tight\" means tight, not no.",
  "These numbers come from what they told you, not from a bank. If the balance is a few days old, say so in passing rather than pretending to certainty.",
  "When they mention money in passing — what they got paid, what they spent, a bill, something they're planning this weekend — quietly record it with money_update, money_bill or money_plan so the next answer is right. Don't announce that you saved it.",
  "Without a balance or a payday there is nothing to work from: ask for the one missing thing in a short question instead of guessing.",
].join(" ");

/**
 * The same, for a spoken turn: what to say and what to record, without the
 * worked examples. Read before every spoken word, so it earns its length.
 */
export const MONEY_PROMPT_SPOKEN = [
  "You keep a rough picture of their money from what they've told you, not a bank. Asked whether they can buy something, call money_afford and say the verdict first, then the one fact behind it, then the trade (what they'd skip). The decision is theirs; \"tight\" means tight, not no.",
  "Money mentioned in passing (paid, spent, a bill, a plan) is recorded quietly with the money tools. Without a balance or a payday, ask for the one missing thing.",
].join(" ");

export function moneyAssistant(env: Env, userId: string, timeZone: string, { voice = false } = {}) {
  const db = env.DB;
  const today = () => buckets(Date.now(), timeZone).day;

  const callTool: CallTool = async (name, args) => {
    if (name === "money_afford" || name === "money_status") {
      const p = await picture(db, userId, timeZone);
      if (p.balanceAgeDays === null && !p.nextPayDate) {
        return { error: "Nothing to go on yet. Ask what's in their account right now, and record it with money_update." };
      }
      if (name === "money_status") return facts(p, null);
      const cents = toCents(args.amount);
      if (cents === null || cents <= 0) return { error: "amount is required, in dollars" };
      return { what: args.what ?? null, ...facts(p, assess(p, cents)) };
    }

    if (name === "money_update") {
      const cents = toCents(args.amount);
      if (cents === null) return { error: "amount is required, in dollars" };
      const kind = String(args.kind ?? "");
      const date = validDay(args.date) ?? today();
      if (kind === "balance") {
        const account = ["checking", "savings", "cash"].includes(String(args.account)) ? String(args.account) : "checking";
        await setBalance(db, userId, cents, typeof args.what === "string" && args.what.trim() ? args.what.trim().slice(0, 60) : account === "checking" ? "Checking" : account, account);
        return { saved: `${account} is ${money(cents)}` };
      }
      if (kind === "paycheck") {
        await recordPaycheck(db, userId, cents, date);
        const p = await picture(db, userId, timeZone);
        return {
          saved: `paycheck of ${money(cents)} on ${date}`,
          versusUsual: p.payDelta === null ? null : `${p.payDelta >= 0 ? "+" : ""}${Math.round(p.payDelta * 100)}%`,
        };
      }
      if (kind === "spend") {
        await db
          .prepare("INSERT INTO money_spend (id, user_id, ts, amount_cents, what, created_at) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(crypto.randomUUID(), userId, Date.now(), cents, typeof args.what === "string" ? args.what.slice(0, 120) : null, Date.now())
          .run();
        await db.prepare("UPDATE money_accounts SET balance_cents = balance_cents - ?, updated_at = ? WHERE user_id = ? AND kind = 'checking'").bind(cents, Date.now(), userId).run();
        return { saved: `spent ${money(cents)}` };
      }
      if (kind === "income") {
        const cadence = String(args.cadence ?? "");
        if (!["weekly", "biweekly", "semimonthly", "monthly"].includes(cadence)) return { error: "cadence must be weekly, biweekly, semimonthly or monthly" };
        const anchor = validDay(args.date);
        if (!anchor) return { error: "date must be a payday that actually happened, YYYY-MM-DD" };
        await db.prepare("UPDATE money_income SET active = 0 WHERE user_id = ? AND name = ?").bind(userId, String(args.what ?? "Pay")).run();
        await db
          .prepare("INSERT INTO money_income (id, user_id, name, amount_cents, cadence, anchor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .bind(crypto.randomUUID(), userId, String(args.what ?? "Pay").slice(0, 60), cents > 0 ? cents : null, cadence, anchor, Date.now())
          .run();
        const next = nextOccurrence(anchor, cadence as Cadence, today());
        return { saved: `paid ${cadence}`, nextPayday: next };
      }
      if (kind === "cushion") {
        await db
          .prepare("INSERT INTO money_settings (user_id, buffer_cents, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET buffer_cents = excluded.buffer_cents, updated_at = excluded.updated_at")
          .bind(userId, Math.max(0, cents), Date.now())
          .run();
        return { saved: `cushion is ${money(Math.max(0, cents))}` };
      }
      return { error: "kind must be balance, paycheck, spend, income or cushion" };
    }

    if (name === "money_bill") {
      const action = String(args.action ?? "");
      if (action === "add") {
        const name_ = String(args.name ?? "").trim();
        const due = validDay(args.date);
        if (!name_ || !due) return { error: "name and date (YYYY-MM-DD, the next one) are required" };
        const cadence = ["monthly", "weekly", "biweekly", "yearly", "once"].includes(String(args.cadence)) ? String(args.cadence) : "monthly";
        const cents = toCents(args.amount);
        await db
          .prepare("INSERT INTO money_bills (id, user_id, name, amount_cents, cadence, next_due, autopay, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(crypto.randomUUID(), userId, name_.slice(0, 80), cents && cents > 0 ? cents : null, cadence, due, args.autopay ? 1 : 0, Date.now())
          .run();
        return { saved: `${name_}${cents ? `, ${money(cents)}` : ""}, next due ${due}` };
      }
      const id = String(args.id ?? "");
      if (!id) return { error: "id is required; get it from money_status" };
      if (action === "paid") {
        const bill = await db.prepare("SELECT name, cadence, next_due FROM money_bills WHERE id = ? AND user_id = ?").bind(id, userId).first<{ name: string; cadence: string; next_due: string }>();
        if (!bill) return { error: "No such bill" };
        const next = nextOccurrence(bill.next_due, bill.cadence as Cadence, addDays(bill.next_due, 1));
        await db
          .prepare(next ? "UPDATE money_bills SET last_paid = ?, next_due = ? WHERE id = ?" : "UPDATE money_bills SET last_paid = ?, active = 0 WHERE id = ?")
          .bind(...(next ? [today(), next, id] : [today(), id]))
          .run();
        return { paid: bill.name, nextDue: next };
      }
      if (action === "remove") {
        await db.prepare("UPDATE money_bills SET active = 0 WHERE id = ? AND user_id = ?").bind(id, userId).run();
        return { removed: true };
      }
      return { error: "action must be add, paid or remove" };
    }

    if (name === "money_plan") {
      const action = String(args.action ?? "");
      if (action === "add") {
        const text = String(args.text ?? "").trim();
        const cents = toCents(args.amount);
        if (!text || cents === null || cents <= 0) return { error: "text and amount (dollars) are required" };
        await db
          .prepare("INSERT INTO money_plans (id, user_id, text, amount_cents, on_date, created_at) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(crypto.randomUUID(), userId, text.slice(0, 120), cents, validDay(args.date), Date.now())
          .run();
        return { saved: `${text}, about ${money(cents)}` };
      }
      if (action === "drop" || action === "did") {
        const id = String(args.id ?? "");
        if (!id) return { error: "id is required; get it from money_status" };
        const row = await db
          .prepare("UPDATE money_plans SET status = ? WHERE id = ? AND user_id = ? AND status = 'planned' RETURNING text, amount_cents")
          .bind(action === "did" ? "done" : "dropped", id, userId)
          .first<{ text: string; amount_cents: number }>();
        if (!row) return { error: "No such plan" };
        // Money that went out is money that went out, whatever it was set aside for.
        if (action === "did") {
          await db
            .prepare("INSERT INTO money_spend (id, user_id, ts, amount_cents, what, created_at) VALUES (?, ?, ?, ?, ?, ?)")
            .bind(crypto.randomUUID(), userId, Date.now(), row.amount_cents, row.text, Date.now())
            .run();
          await db.prepare("UPDATE money_accounts SET balance_cents = balance_cents - ?, updated_at = ? WHERE user_id = ? AND kind = 'checking'").bind(row.amount_cents, Date.now(), userId).run();
        }
        return { [action === "did" ? "done" : "dropped"]: row.text };
      }
      return { error: "action must be add, drop or did" };
    }
    return { error: `Unknown tool ${name}` };
  };

  return { tools: TOOLS, callTool, prompt: voice ? MONEY_PROMPT_SPOKEN : MONEY_PROMPT };
}

// ---------- Routes ----------

export const moneyRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

async function tzOf(db: D1Database, userId: string) {
  const row = await db.prepare("SELECT time_zone FROM settings WHERE user_id = ?").bind(userId).first<{ time_zone: string | null }>();
  return validTimeZone(row?.time_zone);
}

moneyRoutes.get("/money", async (c) => {
  const p = await picture(c.env.DB, c.var.userId, await tzOf(c.env.DB, c.var.userId));
  return c.json({ picture: p, facts: facts(p, null) });
});

moneyRoutes.post("/money/afford", async (c) => {
  const parsed = z.object({ amount: z.number().positive() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "amount (dollars) is required" }, 400);
  const p = await picture(c.env.DB, c.var.userId, await tzOf(c.env.DB, c.var.userId));
  const a = assess(p, Math.round(parsed.data.amount * 100));
  return c.json({ assessment: a, say: headline(p, a), facts: facts(p, a) });
});

moneyRoutes.post("/money/balance", async (c) => {
  const parsed = z
    .object({ amount: z.number(), kind: z.enum(["checking", "savings", "cash"]).default("checking"), name: z.string().max(60).optional() })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "amount is required" }, 400);
  const { amount, kind, name } = parsed.data;
  await setBalance(c.env.DB, c.var.userId, Math.round(amount * 100), name ?? (kind === "checking" ? "Checking" : kind), kind);
  return c.json({ ok: true });
});

moneyRoutes.post("/money/spend", async (c) => {
  const parsed = z.object({ amount: z.number().positive(), what: z.string().max(120).optional() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "amount is required" }, 400);
  const cents = Math.round(parsed.data.amount * 100);
  await c.env.DB.prepare("INSERT INTO money_spend (id, user_id, ts, amount_cents, what, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), c.var.userId, Date.now(), cents, parsed.data.what ?? null, Date.now())
    .run();
  await c.env.DB.prepare("UPDATE money_accounts SET balance_cents = balance_cents - ?, updated_at = ? WHERE user_id = ? AND kind = 'checking'")
    .bind(cents, Date.now(), c.var.userId)
    .run();
  return c.json({ ok: true });
});
