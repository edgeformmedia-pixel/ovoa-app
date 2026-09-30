import { Hono } from "hono";
import { startErrand } from "./browser";
import { clip } from "./browsermoves";
import { money } from "./money";
import { say } from "./obs";
import { DEFAULT_MAX_MONTH_CENTS, DEFAULT_MAX_PURCHASE_CENTS, holdFor, limitCents, payLimitProblem } from "./paycore";
import { reach } from "./reach";
import { stripe, StripeError, verifyStripeSignature } from "./stripe";
import type { Env, Vars } from "./types";

// OVOA paying for what they approve (2026-09-30, docs/pay.md).
//
// Until now a purchase ended with "YES, then you finish it at the link"
// (budget.ts). With this on, their YES pays:
//
//   1. Once, they save a card through a link OVOA texts (Stripe Checkout in
//      setup mode: Stripe's page, so the number never reaches OVOA).
//   2. On a YES to a prepared purchase, their card is held for the price plus a
//      little room for taxes and fees (holdFor), a PaymentIntent with manual
//      capture: nothing is charged yet.
//   3. Stripe Issuing makes a one-time virtual card on OVOA's account that can
//      spend no more than that hold, in all, ever.
//   4. The browser agent (browser.ts) checks out on the merchant's site. At the
//      card boxes the model says {"action":"pay"} and the Worker types the card
//      in itself (fillCard), so the number never reaches the model either.
//   5. The merchant charges the one-time card; Stripe's webhook
//      (issuing_transaction.created) captures that amount from their hold,
//      closes the card and texts them what was paid.
//
// If the errand fails before the merchant took anything, the card is closed and
// the hold let go (releaseHold). Nothing here runs without every secret it
// needs (payReady): STRIPE_SECRET_KEY, STRIPE_PAY_WEBHOOK_SECRET and
// STRIPE_ISSUING_CARDHOLDER, put by scripts/pay-setup.mjs.

/** The save-a-card link works this long, and once. */
const LINK_TTL_MS = 60 * 60_000;
/** A hold with no charge on its card after this is let go (the nightly sweep). */
const HOLD_IDLE_MS = 24 * 3_600_000;
/** A card hold lasts 7 days; an authorized charge not captured by then is captured at 6. */
const CAPTURE_BY_MS = 6 * 24 * 3_600_000;

export const payReady = (env: Env) =>
  !!(env.STRIPE_SECRET_KEY && env.STRIPE_PAY_WEBHOOK_SECRET && env.STRIPE_ISSUING_CARDHOLDER && env.BROWSER && env.BROWSER_TASK);

export type SavedCard = { customer_id: string; payment_method_id: string; brand: string | null; last4: string | null };

export const cardName = (c: Pick<SavedCard, "brand" | "last4">) =>
  `${c.brand ? c.brand[0].toUpperCase() + c.brand.slice(1) : "Card"} ending ${c.last4 ?? "????"}`;

export async function cardOf(db: D1Database, userId: string) {
  return db.prepare("SELECT customer_id, payment_method_id, brand, last4 FROM pay_cards WHERE user_id = ?").bind(userId).first<SavedCard>();
}

/** A one-time link to the save-a-card page. */
export async function cardLink(env: Env, userId: string) {
  const token = crypto.randomUUID().replace(/-/g, "");
  await env.DB.prepare("INSERT INTO pay_setups (token, user_id, created_at) VALUES (?, ?, ?)").bind(token, userId, Date.now()).run();
  return `${env.PUBLIC_URL}/pay/card/${token}`;
}

/** Takes their card off OVOA: detached from Stripe's customer, and the row gone. */
export async function forgetCard(env: Env, userId: string) {
  const card = await cardOf(env.DB, userId);
  if (!card) return false;
  await stripe(env, "POST", `/payment_methods/${card.payment_method_id}/detach`).catch((err) => console.error("pay: couldn't detach", err));
  await env.DB.prepare("DELETE FROM pay_cards WHERE user_id = ?").bind(userId).run();
  return true;
}

async function tell(env: Env, userId: string, text: string) {
  await env.DB.prepare("INSERT INTO messages (id, user_id, role, content, created_at, source) VALUES (?, ?, 'assistant', ?, ?, NULL)")
    .bind(crypto.randomUUID(), userId, text, Date.now())
    .run()
    .catch((err) => console.error("pay: couldn't write the message", err));
  await reach(env, userId, { kind: "pay", text, push: { title: "OVOA", body: clip(text, 160) }, asked: true });
}

type PayRow = {
  id: string;
  user_id: string;
  what: string;
  merchant: string | null;
  url: string | null;
  price_cents: number;
  details: string | null;
  pay_status: string | null;
  hold_intent_id: string | null;
  hold_cents: number | null;
  issuing_card_id: string | null;
  authorized_cents: number | null;
  charged_cents: number | null;
  browser_task_id: string | null;
};
const ROW = "id, user_id, what, merchant, url, price_cents, details, pay_status, hold_intent_id, hold_cents, issuing_card_id, authorized_cents, charged_cents, browser_task_id";

/** What OVOA has paid or is holding for them this month (UTC), in cents. */
async function monthSoFar(db: D1Database, userId: string, now: number) {
  const d = new Date(now);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const row = await db
    .prepare("SELECT COALESCE(SUM(COALESCE(charged_cents, hold_cents)), 0) AS n FROM purchases WHERE user_id = ? AND pay_status IN ('holding','authorized','paid') AND decided_at >= ?")
    .bind(userId, start)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** What the browser is told to do. The card never appears in it: it's filled in by the Worker. */
export function checkoutGoal(p: { what: string; price_cents: number; details: string | null; merchant: string | null }, holdCents: number, billing: string | null) {
  return [
    `Buy this and check out: ${p.what}${p.merchant ? ` (from ${p.merchant})` : ""}. They approved it at about ${money(p.price_cents)}.`,
    `Don't pay more than ${money(holdCents)} in total: if the checkout total is higher, stop with fail and say the total.`,
    p.details ? `Details for the checkout: ${p.details}` : "Use the details on the page; if the checkout needs something you weren't given, stop with fail and say what's needed.",
    billing ? `Billing address for the card: ${billing}.` : "",
    'When the page asks for card details, answer {"action":"pay"}: OVOA fills the card in itself. Choose "credit/debit card" first if there are payment options.',
    "Checkout without an account (guest checkout) when the site offers it.",
    "When the order is placed, answer done with the confirmation number and the total.",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Their YES to a prepared purchase, with a card saved: holds their card, makes
 * the one-time card and starts the checkout. `ok: false` says why it can't, and
 * nothing is left held.
 */
export async function startPaid(env: Env, userId: string, purchaseId: string): Promise<{ ok: true; hold: number; card: string; taskId: string } | { ok: false; why: string }> {
  const card = await cardOf(env.DB, userId);
  if (!card) return { ok: false, why: "no card saved" };
  const p = await env.DB.prepare(`SELECT ${ROW} FROM purchases WHERE id = ? AND user_id = ?`).bind(purchaseId, userId).first<PayRow>();
  if (!p || !p.url) return { ok: false, why: "that purchase has no link to buy it at" };
  if (p.pay_status) return { ok: false, why: `it's already ${p.pay_status}` };
  const now = Date.now();
  const hold = holdFor(p.price_cents);
  const problem = payLimitProblem(
    p.price_cents,
    hold,
    await monthSoFar(env.DB, userId, now),
    limitCents(env.PAY_MAX_PURCHASE, DEFAULT_MAX_PURCHASE_CENTS),
    limitCents(env.PAY_MAX_MONTH, DEFAULT_MAX_MONTH_CENTS),
  );
  if (problem) return { ok: false, why: problem };

  // 1. The hold on their card.
  let intent: { id: string; status: string };
  try {
    intent = await stripe(
      env,
      "POST",
      "/payment_intents",
      {
        amount: hold,
        currency: "usd",
        customer: card.customer_id,
        payment_method: card.payment_method_id,
        capture_method: "manual",
        confirm: true,
        off_session: true,
        description: clip(`OVOA: ${p.what}`, 200),
        metadata: { purchase_id: p.id, user_id: userId },
      },
      { idempotencyKey: `hold-${p.id}` },
    );
  } catch (err) {
    say("pay", { outcome: "hold refused", user: userId });
    const why = err instanceof StripeError ? (err.declineCode ?? err.code ?? err.message) : "Stripe didn't answer";
    return { ok: false, why: `your ${cardName(card)} was declined (${why})` };
  }
  if (intent.status !== "requires_capture") {
    await stripe(env, "POST", `/payment_intents/${intent.id}/cancel`).catch(() => {});
    return { ok: false, why: `your ${cardName(card)} needs you to confirm it with your bank, which OVOA can't do for you` };
  }

  // 2. The one-time card, limited to the hold.
  let issued: { id: string; cardholder?: { name?: string; billing?: { address?: Record<string, string | null> } } };
  try {
    issued = await stripe(
      env,
      "POST",
      "/issuing/cards",
      {
        cardholder: env.STRIPE_ISSUING_CARDHOLDER,
        currency: "usd",
        type: "virtual",
        status: "active",
        spending_controls: { spending_limits: [{ amount: hold, interval: "all_time" }] },
        metadata: { purchase_id: p.id, user_id: userId },
      },
      { idempotencyKey: `card-${p.id}` },
    );
  } catch (err) {
    await stripe(env, "POST", `/payment_intents/${intent.id}/cancel`).catch(() => {});
    console.error("pay: couldn't issue a card", err);
    say("pay", { outcome: "issue failed", user: userId });
    return { ok: false, why: "OVOA couldn't make a card for it just now" };
  }
  const a = issued.cardholder?.billing?.address;
  const billing = a ? [a.line1, a.line2, a.city, a.state, a.postal_code, a.country].filter(Boolean).join(", ") : null;

  await env.DB
    .prepare("UPDATE purchases SET pay_status = 'holding', hold_intent_id = ?, hold_cents = ?, issuing_card_id = ? WHERE id = ?")
    .bind(intent.id, hold, issued.id, p.id)
    .run();

  // 3. The checkout.
  const taskId = await startErrand(env, userId, checkoutGoal(p, hold, billing), p.url, p.id);
  await env.DB.prepare("UPDATE purchases SET browser_task_id = ? WHERE id = ?").bind(taskId, p.id).run();
  say("pay", { outcome: "paying", user: userId });
  return { ok: true, hold, card: cardName(card), taskId };
}

/** The one-time card's details, for the browser to type in. Never logged, stored or shown to a model. */
export async function cardSecrets(env: Env, userId: string, purchaseId: string) {
  const p = await env.DB.prepare("SELECT issuing_card_id, pay_status FROM purchases WHERE id = ? AND user_id = ?")
    .bind(purchaseId, userId)
    .first<{ issuing_card_id: string | null; pay_status: string | null }>();
  if (!p?.issuing_card_id || !["holding", "authorized"].includes(p.pay_status ?? "")) return null;
  const c = await stripe<{ number: string; cvc: string; exp_month: number; exp_year: number; cardholder?: { name?: string } }>(env, "GET", `/issuing/cards/${p.issuing_card_id}`, {
    expand: ["number", "cvc"],
  });
  if (!c.number || !c.cvc) return null;
  return { number: c.number, cvc: c.cvc, exp_month: c.exp_month, exp_year: c.exp_year, name: c.cardholder?.name ?? "" };
}

const closeCard = (env: Env, cardId: string) =>
  stripe(env, "POST", `/issuing/cards/${cardId}`, { status: "canceled" }).catch((err) => console.error("pay: couldn't close the card", err));

/**
 * The errand ended without the order going through: close the card, and let
 * the hold go unless the merchant already took something on it (then it waits
 * for the charge like any other).
 */
export async function releaseHold(env: Env, purchaseId: string, why: string) {
  const p = await env.DB.prepare(`SELECT ${ROW} FROM purchases WHERE id = ?`).bind(purchaseId).first<PayRow>();
  if (!p || p.pay_status !== "holding") return;
  if (p.issuing_card_id) await closeCard(env, p.issuing_card_id);
  // An approval can land a moment before its webhook: ask Stripe, not the table.
  if (p.issuing_card_id) {
    const auths = await stripe<{ data: { approved: boolean; amount: number }[] }>(env, "GET", "/issuing/authorizations", { card: p.issuing_card_id, limit: 10 }).catch(() => null);
    const taken = (auths?.data ?? []).filter((x) => x.approved).reduce((n, x) => n + Math.abs(x.amount), 0);
    if (taken > 0) {
      await env.DB.prepare("UPDATE purchases SET pay_status = 'authorized', authorized_cents = ? WHERE id = ?").bind(taken, p.id).run();
      return;
    }
  }
  if (p.hold_intent_id) await stripe(env, "POST", `/payment_intents/${p.hold_intent_id}/cancel`).catch((err) => console.error("pay: couldn't let the hold go", err));
  await env.DB.prepare("UPDATE purchases SET pay_status = 'released' WHERE id = ?").bind(p.id).run();
  say("pay", { outcome: "released", user: p.user_id, why: clip(why, 60) });
}

/** Captures `cents` of the hold (at most the hold) and marks it paid. */
async function captureHold(env: Env, p: PayRow, cents: number) {
  const amount = Math.min(cents, p.hold_cents ?? cents);
  if (p.hold_intent_id) {
    await stripe(env, "POST", `/payment_intents/${p.hold_intent_id}/capture`, { amount_to_capture: amount }, { idempotencyKey: `capture-${p.id}` });
  }
  await env.DB.prepare("UPDATE purchases SET pay_status = 'paid', charged_cents = ?, paid_at = ? WHERE id = ?").bind(cents, Date.now(), p.id).run();
  return amount;
}

/** A second charge on a purchase already captured (rare: a split shipment, a fee): charged to their card on its own. */
async function chargeExtra(env: Env, p: PayRow, cents: number, key: string) {
  const card = await cardOf(env.DB, p.user_id);
  if (!card) throw new Error("no card to charge the rest to");
  await stripe(
    env,
    "POST",
    "/payment_intents",
    { amount: cents, currency: "usd", customer: card.customer_id, payment_method: card.payment_method_id, confirm: true, off_session: true, description: clip(`OVOA: ${p.what} (more)`, 200), metadata: { purchase_id: p.id } },
    { idempotencyKey: key },
  );
}

/** Stripe's events for the one-time cards. */
export async function handlePayEvent(env: Env, event: { id: string; type: string; data: { object: any } }) {
  const o = event.data.object;
  if (event.type === "issuing_authorization.created") {
    if (!o.approved) return;
    const cardId = typeof o.card === "string" ? o.card : o.card?.id;
    await env.DB.prepare("UPDATE purchases SET pay_status = 'authorized', authorized_cents = COALESCE(authorized_cents, 0) + ? WHERE issuing_card_id = ? AND pay_status = 'holding'")
      .bind(Math.abs(o.amount ?? 0), cardId)
      .run();
    return;
  }
  if (event.type !== "issuing_transaction.created") return;
  const cardId = typeof o.card === "string" ? o.card : o.card?.id;
  const p = await env.DB.prepare(`SELECT ${ROW} FROM purchases WHERE issuing_card_id = ?`).bind(cardId).first<PayRow>();
  if (!p) return void say("pay", { outcome: "charge on an unknown card" });
  const card = await cardOf(env.DB, p.user_id);
  const on = card ? ` on your ${cardName(card)}` : "";
  const merchant = clip(o.merchant_data?.name ?? p.merchant ?? "the merchant", 60);
  if (o.type === "refund") {
    const back = Math.min(Math.abs(o.amount), p.charged_cents ?? 0);
    if (back > 0 && p.hold_intent_id) {
      await stripe(env, "POST", "/refunds", { payment_intent: p.hold_intent_id, amount: back }, { idempotencyKey: `refund-${event.id}` });
      await env.DB.prepare("UPDATE purchases SET charged_cents = charged_cents - ? WHERE id = ?").bind(back, p.id).run();
      await tell(env, p.user_id, `${merchant} refunded ${money(back)} for ${p.what}. It's going back${on}.`);
    }
    return;
  }
  // A capture: the merchant took the money. Amounts on the card's side are negative.
  const cents = Math.abs(o.amount);
  if (p.pay_status === "paid") {
    await chargeExtra(env, p, cents, `extra-${event.id}`);
    await env.DB.prepare("UPDATE purchases SET charged_cents = COALESCE(charged_cents, 0) + ? WHERE id = ?").bind(cents, p.id).run();
    await tell(env, p.user_id, `${merchant} charged another ${money(cents)} for ${p.what}. Paid${on}.`);
    return;
  }
  if (p.pay_status !== "holding" && p.pay_status !== "authorized") return;
  const taken = await captureHold(env, p, cents);
  if (cents > taken) await chargeExtra(env, p, cents - taken, `over-${event.id}`);
  if (p.issuing_card_id) await closeCard(env, p.issuing_card_id);
  say("pay", { outcome: "paid", user: p.user_id });
  await tell(env, p.user_id, `Paid: ${p.what}, ${money(cents)} to ${merchant}${on}.`);
}

/**
 * Nightly: holds with nothing charged after a day are let go, and a charge the
 * merchant approved but hasn't taken by day six is captured before the hold on
 * their card runs out (OVOA would owe the merchant either way).
 */
export async function payTick(env: Env, now = Date.now()) {
  if (!payReady(env)) return;
  const { results: idle } = await env.DB.prepare(`SELECT ${ROW} FROM purchases WHERE pay_status = 'holding' AND decided_at < ?`).bind(now - HOLD_IDLE_MS).all<PayRow>();
  for (const p of idle) {
    // A browser still at it (waiting on a sign-in or a YES) is past its own limits long before this.
    await releaseHold(env, p.id, "no charge after a day");
    const after = await env.DB.prepare("SELECT pay_status FROM purchases WHERE id = ?").bind(p.id).first<{ pay_status: string }>();
    if (after?.pay_status === "released") await tell(env, p.user_id, `Nothing was charged for ${p.what}, so I've let the hold on your card go.`);
  }
  const { results: late } = await env.DB.prepare(`SELECT ${ROW} FROM purchases WHERE pay_status = 'authorized' AND decided_at < ?`).bind(now - CAPTURE_BY_MS).all<PayRow>();
  for (const p of late) {
    const cents = p.authorized_cents ?? p.hold_cents ?? 0;
    if (cents <= 0) continue;
    await captureHold(env, p, cents);
    say("pay", { outcome: "captured late", user: p.user_id });
  }
}

// ---------- The save-a-card page and Stripe's webhook ----------

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:17px/1.5 -apple-system,system-ui,sans-serif;background:#fafafa;color:#111;margin:0;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}main{max-width:420px;text-align:center}h1{font-size:24px;margin:0 0 8px}p{color:#555;margin:0}@media (prefers-color-scheme:dark){body{background:#111;color:#eee}p{color:#aaa}}</style></head>
<body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;

async function tokenUser(db: D1Database, token: string) {
  const row = await db.prepare("SELECT user_id, created_at, used_at FROM pay_setups WHERE token = ?").bind(token).first<{ user_id: string; created_at: number; used_at: number | null }>();
  if (!row || row.used_at || Date.now() - row.created_at > LINK_TTL_MS) return null;
  return row.user_id;
}

export const payRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

// The texted link: straight on to Stripe's own page for saving a card.
payRoutes.get("/pay/card/:token", async (c) => {
  const env = c.env;
  if (!payReady(env)) return c.html(page("Not yet", "OVOA can't pay for things yet."), 503);
  const token = c.req.param("token");
  const userId = await tokenUser(env.DB, token);
  if (!userId) return c.html(page("This link has expired", "Text OVOA “save my card” for a new one."), 410);
  let customer = (await cardOf(env.DB, userId))?.customer_id;
  if (!customer) {
    const user = await env.DB.prepare("SELECT email, name FROM users WHERE id = ?").bind(userId).first<{ email: string; name: string }>();
    const made = await stripe<{ id: string }>(env, "POST", "/customers", { email: user?.email || undefined, name: user?.name || undefined, metadata: { user_id: userId } }, { idempotencyKey: `customer-${userId}` });
    customer = made.id;
  }
  const back = `${env.PUBLIC_URL}/pay/card/${token}/saved`;
  const session = await stripe<{ url: string }>(env, "POST", "/checkout/sessions", {
    mode: "setup",
    customer,
    payment_method_types: ["card"],
    success_url: `${back}?session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.PUBLIC_URL}/pay/card/${token}/cancelled`,
    metadata: { user_id: userId },
    setup_intent_data: { metadata: { user_id: userId } },
  });
  return c.redirect(session.url, 303);
});

payRoutes.get("/pay/card/:token/cancelled", (c) => c.html(page("No card saved", "Nothing changed. You can close this.")));

payRoutes.get("/pay/card/:token/saved", async (c) => {
  const env = c.env;
  if (!payReady(env)) return c.html(page("Not yet", "OVOA can't pay for things yet."), 503);
  const token = c.req.param("token");
  const userId = await tokenUser(env.DB, token);
  if (!userId) return c.html(page("This link has expired", "Text OVOA “save my card” for a new one."), 410);
  const session = await stripe<any>(env, "GET", `/checkout/sessions/${encodeURIComponent(c.req.query("session") ?? "")}`, {
    expand: ["setup_intent.payment_method"],
  }).catch(() => null);
  const pm = session?.setup_intent?.payment_method;
  if (!session || session.status !== "complete" || session.metadata?.user_id !== userId || !pm?.id) {
    return c.html(page("That didn't go through", "No card was saved. Try the link again."), 400);
  }
  const old = await cardOf(env.DB, userId);
  const now = Date.now();
  await env.DB
    .prepare(
      `INSERT INTO pay_cards (user_id, customer_id, payment_method_id, brand, last4, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET customer_id = excluded.customer_id, payment_method_id = excluded.payment_method_id, brand = excluded.brand, last4 = excluded.last4, updated_at = excluded.updated_at`,
    )
    .bind(userId, String(session.customer), pm.id, pm.card?.brand ?? null, pm.card?.last4 ?? null, now, now)
    .run();
  await env.DB.prepare("UPDATE pay_setups SET used_at = ? WHERE token = ?").bind(now, token).run();
  if (old && old.payment_method_id !== pm.id) await stripe(env, "POST", `/payment_methods/${old.payment_method_id}/detach`).catch(() => {});
  const name = cardName({ brand: pm.card?.brand ?? null, last4: pm.card?.last4 ?? null });
  say("pay", { outcome: "card saved", user: userId });
  c.executionCtx.waitUntil(tell(env, userId, `Card saved: your ${name}. When you say YES to something I found, I'll pay for it with it.`));
  return c.html(page("Card saved", `Your ${name} is saved. OVOA only charges it after you reply YES to a purchase. You can go back to Messages.`));
});

payRoutes.post("/pay/webhook", async (c) => {
  const env = c.env;
  if (!env.STRIPE_PAY_WEBHOOK_SECRET || !env.STRIPE_SECRET_KEY) return c.json({ error: "Paying isn't set up" }, 503);
  const raw = await c.req.text();
  if (!(await verifyStripeSignature(raw, c.req.header("stripe-signature"), env.STRIPE_PAY_WEBHOOK_SECRET))) return c.json({ error: "Bad signature" }, 400);
  const event = JSON.parse(raw) as { id: string; type: string; data: { object: any } };
  const fresh = await env.DB.prepare("INSERT OR IGNORE INTO pay_events (id, type, created_at) VALUES (?, ?, ?)").bind(event.id, event.type, Date.now()).run();
  if (!fresh.meta.changes) return c.json({ ok: true, repeat: true });
  try {
    await handlePayEvent(env, event);
  } catch (err) {
    // Let Stripe retry: forget the event so the retry isn't taken for a repeat.
    await env.DB.prepare("DELETE FROM pay_events WHERE id = ?").bind(event.id).run();
    console.error("ovoa.err pay webhook", event.type, err);
    return c.json({ error: "Failed, retry" }, 500);
  }
  return c.json({ ok: true });
});
