// OVOA paying (paycore.ts, stripe.ts): the hold, the limits, which boxes are the
// card's, which checkout clicks go ahead after the YES, and Stripe's signatures.

import { cardPart, cardValue, holdFor, limitCents, needsYes, payLimitProblem } from "../src/paycore";
import { parseMove } from "../src/browsermoves";
import { encodeForm, signStripePayload, verifyStripeSignature } from "../src/stripe";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${g}${ok ? "" : `  (wanted ${w})`}`);
}

// The hold: price plus 10%, at least $5, at most $50.
eq("small: $5 room", holdFor(2_000), 2_500);
eq("middle: 10%", holdFor(12_000), 13_200);
eq("big: $50 room", holdFor(90_000), 95_000);
eq("limit from dollars", limitCents("250", 1), 25_000);
eq("limit unset", limitCents(undefined, 7), 7);
eq("limit nonsense", limitCents("lots", 7), 7);

// Limits.
eq("fits", payLimitProblem(10_000, 11_000, 0, 50_000, 100_000), null);
eq("one purchase too big", payLimitProblem(60_000, 65_000, 0, 50_000, 100_000), "over the $500 OVOA pays for any one purchase");
eq("month used up", payLimitProblem(10_000, 11_000, 95_000, 50_000, 100_000), "past the $1000 a month OVOA pays for ($950 so far)");

// Card boxes.
eq("autocomplete number", cardPart({ autocomplete: "cc-number" }), "number");
eq("autocomplete with section", cardPart({ autocomplete: "section-pay billing cc-exp" }), "exp");
eq("stripe elements number", cardPart({ name: "cardnumber", placeholder: "1234 1234 1234 1234" }), "number");
eq("stripe elements expiry", cardPart({ name: "exp-date", placeholder: "MM / YY" }), "exp");
eq("stripe elements cvc", cardPart({ name: "cvc", placeholder: "CVC" }), "cvc");
eq("braintree cvv", cardPart({ id: "cvv", label: "CVV" }), "cvc");
eq("security code", cardPart({ label: "Security code" }), "cvc");
eq("name on card", cardPart({ label: "Name on card" }), "name");
eq("cardholder isn't the number", cardPart({ name: "cardholderName" }), "name");
eq("month dropdown", cardPart({ name: "expMonth", type: "select", tag: "select" }), "exp_month");
eq("year dropdown", cardPart({ name: "card_exp_year", type: "select", tag: "select" }), "exp_year");
eq("expiry label", cardPart({ label: "Expiration date" }), "exp");
eq("email isn't", cardPart({ type: "email", name: "email" }), null);
eq("first name isn't", cardPart({ name: "firstName", label: "First name" }), null);
eq("zip isn't", cardPart({ name: "postal", label: "ZIP code" }), null);
eq("hidden isn't", cardPart({ type: "hidden", autocomplete: "cc-number" }), null);
eq("gift card code isn't the cvc", cardPart({ label: "Promo code" }), null);

const card = { number: "4000009990000001", cvc: "123", exp_month: 3, exp_year: 2029, name: "OVOA AI" };
eq("exp value", cardValue("exp", card), "03/29");
eq("month value", cardValue("exp_month", card), "03");
eq("year two digits", cardValue("exp_year", card), "29");
eq("year four digits", cardValue("exp_year", card, true), "2029");

// The pay move.
eq("pay parses", parseMove('{"action":"pay"}'), { action: "pay" });

// Clicks: a paying errand places the order without a second YES; nothing else changes.
const marks = [
  { id: 1, tag: "button", type: "", label: "Place order" },
  { id: 2, tag: "button", type: "", label: "Delete account" },
  { id: 3, tag: "button", type: "", label: "Continue to payment" },
  { id: 4, tag: "button", type: "", label: "Subscribe and save" },
  { id: 5, tag: "a", type: "", label: "Menu" },
  { id: 6, tag: "button", type: "submit", label: "Book now" },
];
const click = (id: number) => ({ action: "click" as const, id });
eq("order waits when not paying", needsYes(click(1), marks, false), true);
eq("order goes when paying", needsYes(click(1), marks, true), false);
eq("book now goes when paying", needsYes(click(6), marks, true), false);
eq("delete always waits", needsYes(click(2), marks, true), true);
eq("subscribe always waits", needsYes(click(4), marks, true), true);
eq("menu never waits", needsYes(click(5), marks, true), false);

// Stripe.
eq("form nesting", encodeForm({ a: { b: [{ c: 1 }] }, d: "x y", e: undefined }), "a%5Bb%5D%5B0%5D%5Bc%5D=1&d=x+y");
const now = 1_760_000_000_000;
const t = Math.floor(now / 1000);
const body = '{"id":"evt_1"}';
const sig = await signStripePayload(body, "whsec_test", t);
eq("signature ok", await verifyStripeSignature(body, `t=${t},v1=${sig}`, "whsec_test", { now }), true);
eq("wrong secret", await verifyStripeSignature(body, `t=${t},v1=${sig}`, "whsec_other", { now }), false);
eq("changed body", await verifyStripeSignature('{"id":"evt_2"}', `t=${t},v1=${sig}`, "whsec_test", { now }), false);
eq("too old", await verifyStripeSignature(body, `t=${t},v1=${sig}`, "whsec_test", { now: now + 600_000 }), false);
eq("no header", await verifyStripeSignature(body, null, "whsec_test", { now }), false);

if (fails) {
  console.error(`${fails} failed`);
  process.exit(1);
}
