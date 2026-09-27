// Receipts texted to OVOA (texting.ts): the photo's description says whether
// it's a receipt, and OVOA offers to log the spending (money.ts money_update),
// which counts against a matching budget (budget.ts). Card and account numbers
// never go further than the photo: they're taken out of anything kept.

/** Asked of every texted photo (texting.ts lookAt), after the description itself. */
export const RECEIPT_ASK =
  'If it is a receipt or a bill that was paid, end with one last line exactly like: RECEIPT | 42.10 | Trader Joe\'s | 2026-09-27 (the total paid, the store, the date or "unknown").';

export type Receipt = { cents: number; merchant: string; date: string | null };

/** The RECEIPT line off the end of a photo description: the receipt, and the description without it. Pure. */
export function receiptIn(text: string): { receipt: Receipt | null; text: string } {
  const m = /\n?\s*RECEIPT\s*\|\s*\$?([\d,]+(?:\.\d{1,2})?)\s*\|\s*([^|\n]{1,80}?)\s*\|\s*(\d{4}-\d{2}-\d{2}|unknown)\s*$/i.exec(text);
  if (!m) return { receipt: null, text };
  const rest = text.slice(0, m.index).trim();
  const cents = Math.round(Number(m[1]!.replace(/,/g, "")) * 100);
  const merchant = withoutCardNumbers(m[2]!.trim()).slice(0, 60);
  if (!Number.isFinite(cents) || cents <= 0 || cents > 10_000_000 || !merchant) return { receipt: null, text: rest };
  return { receipt: { cents, merchant, date: m[3]!.toLowerCase() === "unknown" ? null : m[3]! }, text: rest };
}

/** The card-number checksum, so a long phone or order number isn't taken for a card. Pure. */
function luhn(digits: string) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

/**
 * Card numbers out of text that's kept: 13 to 19 digits (grouped or not) that
 * pass the card checksum, and masked ones like "**** 1234" or "XXXX-1234". Pure.
 */
export function withoutCardNumbers(text: string): string {
  return text
    .replace(/\b(?:\d[ -]?){12,18}\d\b/g, (m) => (luhn(m.replace(/\D/g, "")) ? "[card number removed]" : m))
    .replace(/(?:[*•xX]{2,}[ -]?){1,4}\d{2,4}\b/g, "[card]")
    .replace(/\b(?:ending|ends) in \d{4}\b/gi, "[card]");
}

/** What the turn is told about a receipt it was sent (texting.ts combine). Pure. */
export function receiptOffer(r: Receipt): string {
  const amount = `$${(r.cents / 100).toFixed(2)}`;
  return `[It looks like a receipt: ${amount} at ${r.merchant}${r.date ? ` on ${r.date}` : ""}. Offer to log it as spending, in a few words with the amount and the place. Only after they say yes, call money_update with kind "spend", amount ${(r.cents / 100).toFixed(2)}, what "${r.merchant}"${r.date ? `, date "${r.date}"` : ""}, and a category (groceries, dinners, travel...) if it's clear, so it counts against a matching budget.]`;
}
