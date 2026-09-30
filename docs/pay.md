# OVOA pays (2026-09-30)

Before this, a purchase ended with "YES, then you finish it at the link". With
paying on and a card saved, a YES pays for the purchase. The code is in
`jarvis/api/src/pay.ts`, `paycore.ts` and `stripe.ts`; the checkout itself is
the browser agent (`browser.ts`).

## How a purchase goes

1. **The card.** Someone texts "save my card". `payment_card` sends a one-time
   link, which works for an hour: `api.ovoa.ai/pay/card/<token>`. The link opens
   Stripe Checkout in setup mode. OVOA keeps only Stripe's customer and
   payment-method ids plus "Visa ending 4242" (`pay_cards`), never the number.
2. **The purchase.** `purchase_propose` works as before, with a new `details`
   field for everything the checkout will ask for (travelers' names as on their
   ID, dates of birth, email, phone, address). The question becomes "Buy this
   for about $X with your Visa ending 4242? Reply YES".
3. **YES** (`purchase_confirm`, then `startPaid`):
   - Their card is **held** for the price plus room for taxes and fees
     (`holdFor`: 10%, at least $5, at most $50). This is a manual-capture
     PaymentIntent, so nothing is charged yet.
   - Stripe Issuing makes a **one-time virtual card** on OVOA's account. Its
     `all_time` spending limit equals the hold.
   - A **browser errand** starts at the purchase link with the purchase id.
4. **Checkout.** The model drives the site as usual. At the card boxes it
   answers `{"action":"pay"}`, and `fillCard` fetches the card from Stripe and
   types it in, in whichever frame the boxes are.
   - The card number never reaches the model: it isn't in the prompt, the
     history or the page text, and the boxes are masked before the next
     screenshot. Only a button's value counts as its label, so a typed value
     never becomes one.
   - Checkout clicks (place order, pay, book, continue) don't ask for a second
     YES. Anything else risky still does: subscribing, deleting, sending.
5. **The charge.** When the merchant charges the one-time card, Stripe sends
   `issuing_transaction.created` to `/pay/webhook`. That captures the same
   amount from their hold, closes the card and texts "Paid: …". A refund from
   the merchant is refunded to their card.
6. **If it fails.** When the errand fails or is cancelled, the card is closed and
   the hold let go (`releaseHold`), unless the merchant already took something.
   In that case it waits for the charge like any other. The nightly sweep
   (`payTick`) does two things:
   - lets go of holds that have had no charge for a day;
   - captures an approved charge that the merchant hasn't taken by day 6, since
     a card hold only lasts 7 days.

## Limits

- $500 per purchase and $1,000 per month per person. `PAY_MAX_PURCHASE` and
  `PAY_MAX_MONTH` (dollars, as vars or secrets) change them.
- Budgets still apply on top (`budget.ts`).
- A purchase is only ever confirmed from a later reply. Background runs can't
  reach any of this: all four spending tools are in `FORBIDDEN_FOR_COMMANDS`.

## Turning it on

It is off until all three secrets are on the Worker:

- `STRIPE_SECRET_KEY`
- `STRIPE_PAY_WEBHOOK_SECRET`
- `STRIPE_ISSUING_CARDHOLDER`

`scripts/pay-setup.mjs` puts them there. While they're missing, purchases work
exactly as before.

What only the account owner can do in Stripe, in this order:

1. **Apply for Issuing** (Dashboard → Issuing) on the live account, admin@ovoa.ai.
   Describe the use honestly: "an AI assistant buys things on its users' behalf
   after each purchase is approved; one single-use virtual card per purchase,
   funded by charging the user's saved card".
2. **Ask Stripe for full card numbers through the API.** Retrieving `number` and
   `cvc` for virtual cards (`expand[]=number`) needs Stripe to enable it, and
   they ask for PCI DSS compliance. Until then, `cardSecrets` gets no number and
   the errand fails at the pay step, which lets the hold go.
3. **Fund the Issuing balance.** The one-time cards spend from it; each user's
   card is charged back afterwards. Keep more in it than the largest purchase
   allowed.
4. Put the business address in `ovoa-team/stripe/pay.env` and run
   `XDG_CONFIG_HOME=C:/Users/thoma/.wrangler-ovoa node scripts/pay-setup.mjs`.

## Costs (Stripe's, at the time of writing)

- Charging their card costs the usual card fee, about 2.9% + 30¢, and is paid
  from OVOA's margin.
- Issuing adds a small fee per virtual card.
- There's no fee to users yet. Adding one is a pricing decision.
