import { isRisky, type Mark, type Move } from "./browsermoves";

// The rules of OVOA paying (pay.ts) that need no Stripe and no browser, kept
// apart so they can be tested: how much to hold, the limits, which boxes on a
// checkout page are the card's, and which clicks a paid errand may make without
// asking again.

/** The most for one purchase and for a calendar month, unless PAY_MAX_PURCHASE / PAY_MAX_MONTH (dollars) say otherwise. */
export const DEFAULT_MAX_PURCHASE_CENTS = 50_000;
export const DEFAULT_MAX_MONTH_CENTS = 100_000;

/**
 * What to hold on their card and let the one-time card spend: the approved
 * price plus room for taxes and fees the listing didn't show, 10%, at least $5
 * and at most $50. Only what the merchant actually charges is captured. Pure.
 */
export function holdFor(priceCents: number) {
  return priceCents + Math.min(5_000, Math.max(500, Math.ceil(priceCents * 0.1)));
}

/** Dollars from an env var, as cents; the fallback when unset or nonsense. Pure. */
export function limitCents(raw: string | undefined, fallback: number) {
  const n = Number(raw);
  return raw && Number.isFinite(n) && n > 0 ? Math.round(n * 100) : fallback;
}

/** Whether OVOA may pay this, against the per-purchase and monthly limits. Pure. */
export function payLimitProblem(priceCents: number, holdCents: number, monthCents: number, maxPurchase: number, maxMonth: number) {
  if (priceCents > maxPurchase) return `over the ${dollars(maxPurchase)} OVOA pays for any one purchase`;
  if (monthCents + holdCents > maxMonth) return `past the ${dollars(maxMonth)} a month OVOA pays for (${dollars(monthCents)} so far)`;
  return null;
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;

// ---------- Card boxes on a checkout page ----------

export type CardPart = "number" | "exp" | "exp_month" | "exp_year" | "cvc" | "name";
export type FieldFacts = { autocomplete?: string; name?: string; id?: string; placeholder?: string; label?: string; type?: string; tag?: string };

const AUTOCOMPLETE: Record<string, CardPart> = {
  "cc-number": "number",
  "cc-exp": "exp",
  "cc-exp-month": "exp_month",
  "cc-exp-year": "exp_year",
  "cc-csc": "cvc",
  "cc-name": "name",
};

/**
 * Which part of the card a box is for, from what the page says about it, or
 * null. autocomplete first (checkout pages mostly set it), then the name, id,
 * placeholder and label. Pure.
 */
export function cardPart(f: FieldFacts): CardPart | null {
  const type = (f.type ?? "").toLowerCase();
  if (["hidden", "submit", "button", "checkbox", "radio", "email", "password", "search", "file"].includes(type)) return null;
  for (const token of (f.autocomplete ?? "").toLowerCase().split(/\s+/)) if (AUTOCOMPLETE[token]) return AUTOCOMPLETE[token];
  const s = [f.name, f.id, f.placeholder, f.label].filter(Boolean).join(" | ").toLowerCase().replace(/[_\-.[\]]+/g, " ");
  if (!s.trim()) return null;
  if (/\b(cvc|cvv2?|csc|cvn|cid)\b|security ?code|card ?code|card ?verification|securitycode|cardcvc|cardcvv/.test(s)) return "cvc";
  if (/card ?holder|name on (?:the )?card|nameoncard|cc ?name|card ?name\b/.test(s)) return "name";
  if (/card ?number|cardnumber|credit ?card(?! ?holder)|debit ?card|\bcc ?num|ccnum|\bcard ?no\b|\bpan\b|1234 ?1234/.test(s)) return "number";
  const exp = /\bexp|expir|valid ?(?:thru|through|until)/.test(s);
  if ((exp || /\bcc\b|card/.test(s)) && /month|\bmm\b(?! ?\/)/.test(s) && !/year|yy/.test(s)) return "exp_month";
  if ((exp || /\bcc\b|card/.test(s)) && /year|\byy(?:yy)?\b/.test(s) && !/month|mm ?\//.test(s)) return "exp_year";
  if (exp || /mm ?\/ ?yy/.test(s)) return "exp";
  return null;
}

/** What to put in each part. MM/YY for a combined expiry box. Pure. */
export function cardValue(part: CardPart, c: { number: string; cvc: string; exp_month: number; exp_year: number; name: string }, fourDigitYear = false) {
  const mm = String(c.exp_month).padStart(2, "0");
  const yy = String(c.exp_year % 100).padStart(2, "0");
  switch (part) {
    case "number": return c.number;
    case "cvc": return c.cvc;
    case "name": return c.name;
    case "exp": return `${mm}/${yy}`;
    case "exp_month": return mm;
    case "exp_year": return fourDigitYear ? String(c.exp_year) : yy;
  }
}

// ---------- Clicks in an errand that is paying ----------

/** The steps of checking out: after their YES to the purchase, these go ahead without another. */
const CHECKOUT_STEP = /\b(pay|buy|purchase|place (?:your )?order|complete (?:order|purchase|booking|reservation)|checkout|check out|confirm (?:order|booking|purchase|payment|reservation)|book|reserve|submit|continue|next)\b/i;
/** Still asked about, whatever the errand: nothing here is part of buying the thing. */
const NEVER_ASSUMED = /\b(delete|remove|cancel|close account|unsubscribe|transfer|withdraw|deposit|donate|subscribe|membership|change (?:password|email)|save changes|post|publish|tweet|send|apply|sign up|register)\b/i;

/**
 * Whether a move waits for a YES. In an errand paying for an approved purchase
 * the checkout steps don't: they asked once, and the one-time card can't spend
 * more than the hold. Anything else risky still waits. Pure.
 */
export function needsYes(move: Move, marks: Mark[], paying: boolean) {
  if (!isRisky(move, marks)) return false;
  if (!paying) return true;
  const label = move.action === "click" || move.action === "type" ? (marks.find((m) => m.id === move.id)?.label ?? "") : "";
  return !(CHECKOUT_STEP.test(label) && !NEVER_ASSUMED.test(label));
}
