import type { CallTool, ToolSpec } from "./llm";
import { money, toCents } from "./money";
import { say } from "./obs";
import { addDays, atLocalTime, buckets, localWeekday } from "./time";
import type { Env } from "./types";

// "Pay for me, with a budget" (2026-09-26, docs/instinct-more.md).
//
// They set a spending budget by text: an amount a week, a month or once, for a
// category, with a cap on any one purchase. OVOA finds options within it
// (web_search), prepares one (what, price, the link to buy it), and texts "Book
// this for $X? Reply YES". Only their YES, in a later message of their own,
// records it against the budget and hands them the link to complete it.
//
// OVOA never pays. It holds no card and asks for none, and there is no payment
// integration for people's own purchases (OVOA's Stripe is only for OVOA's own
// plans). Paying hands-off would need virtual cards from a provider like Stripe
// Issuing, one per budget with its own limits, which is later work.
//
// A background run can't reach any of this: none of these tools are in
// agent.ts READ_ALONE, and the spending ones are in commands.ts
// FORBIDDEN_FOR_COMMANDS. purchase_confirm also refuses a proposal made in the
// same turn, so a model can never propose and approve at once.

export type Period = "week" | "month" | "once";
/** A prepared purchase waits this long for its YES. */
export const PROPOSAL_TTL_MS = 24 * 3_600_000;
/** Past this share of a budget, they're warned. */
export const WARN_AT = 0.8;
/** Purchases waiting for a YES at once, at most. */
const OPEN_MAX = 5;

type Budget = {
  id: string;
  category: string;
  amount_cents: number;
  period: Period;
  per_purchase_cents: number | null;
  currency: string;
  created_at: number;
};
type Purchase = { id: string; budget_id: string | null; what: string; merchant: string | null; url: string | null; price_cents: number; status: string; created_at: number };

/** When the budget's current period began: Monday for a week, the 1st for a month, its creation for once. Pure. */
export function periodStart(period: Period, now: number, timeZone: string, createdAt: number) {
  if (period === "once") return createdAt;
  const today = buckets(now, timeZone).day;
  if (period === "month") return atLocalTime(`${today.slice(0, 8)}01`, 0, timeZone);
  const back = (localWeekday(now, timeZone) + 6) % 7;
  return atLocalTime(addDays(today, -back), 0, timeZone);
}

/** Whether a price fits: the per-purchase cap, then what's left. Pure. */
export function fits(b: Pick<Budget, "amount_cents" | "per_purchase_cents">, spent: number, price: number): { ok: true; left: number } | { ok: false; why: string } {
  if (b.per_purchase_cents != null && price > b.per_purchase_cents) return { ok: false, why: `over the ${money(b.per_purchase_cents)} limit for one purchase` };
  const left = b.amount_cents - spent;
  if (price > left) return { ok: false, why: `only ${money(Math.max(left, 0))} left in the budget` };
  return { ok: true, left: left - price };
}

/** A link fit to hand over: https, a real host, no credentials in it. Pure. */
export function linkProblem(url: string) {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "not a link";
  }
  if (u.protocol !== "https:") return "not https";
  if (u.username || u.password) return "has credentials in it";
  if (!/\.[a-z]{2,}$/i.test(u.hostname)) return "not a real site";
  return null;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").trim();

async function budgetsOf(db: D1Database, userId: string) {
  const { results } = await db
    .prepare("SELECT id, category, amount_cents, period, per_purchase_cents, currency, created_at FROM spend_budgets WHERE user_id = ? AND active = 1 ORDER BY created_at")
    .bind(userId)
    .all<Budget>();
  return results;
}

/** The budget for a category: its own, or a general one ("anything"). */
function budgetFor(budgets: Budget[], category: string) {
  const c = norm(category);
  return (
    budgets.find((b) => norm(b.category) === c) ??
    budgets.find((b) => c && (norm(b.category).includes(c) || c.includes(norm(b.category)))) ??
    budgets.find((b) => ["anything", "general", "everything", "any"].includes(norm(b.category))) ??
    null
  );
}

async function spentIn(db: D1Database, b: Budget, now: number, timeZone: string) {
  const row = await db
    .prepare("SELECT COALESCE(SUM(price_cents), 0) AS n FROM purchases WHERE budget_id = ? AND status = 'approved' AND decided_at >= ?")
    .bind(b.id, periodStart(b.period, now, timeZone, b.created_at))
    .first<{ n: number }>();
  return row?.n ?? 0;
}

function view(b: Budget, spent: number) {
  return {
    category: b.category,
    budget: `${money(b.amount_cents)} ${b.period === "once" ? "in all" : `a ${b.period}`}`,
    spent: money(spent),
    left: money(Math.max(b.amount_cents - spent, 0)),
    ...(b.per_purchase_cents != null && { perPurchaseMax: money(b.per_purchase_cents) }),
    ...(spent >= b.amount_cents * WARN_AT && { warning: spent >= b.amount_cents ? "used up" : "nearly used up" }),
  };
}

function specs(): ToolSpec[] {
  return [
    {
      name: "budget_set",
      description:
        "Sets (or changes, or removes) a spending budget OVOA books within: an amount a week, a month or once, for a category (travel, dinners, gifts, or anything), with an optional limit for any one purchase. OVOA never pays: it prepares purchases and they complete them.",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string", description: "What it's for: travel, dinners, gifts, groceries, or anything" },
          amount: { type: "number", description: "Dollars for the period" },
          period: { type: "string", enum: ["week", "month", "once"] },
          perPurchaseMax: { type: "number", description: "Dollars, the most for any one purchase" },
          remove: { type: "boolean", description: "Removes the budget for this category" },
        },
        required: ["category"],
      },
    },
    {
      name: "budget_status",
      description: "Their spending budgets: how much each has, what's been booked against it this period, and what's left.",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "purchase_propose",
      description:
        "Prepares one purchase for their YES, after you found it (web_search): what it is, the price, the merchant and the https link to buy it. Checks it against their budget. It does not buy anything.",
      parameters: {
        type: "object",
        properties: {
          what: { type: "string", description: "What it is, specifically: \"Hotel Zephyr, 2 nights Oct 17-19, queen room\"" },
          price: { type: "number", description: "Total in dollars, taxes and fees in if known" },
          merchant: { type: "string" },
          url: { type: "string", description: "The https page where they can book or buy it" },
          category: { type: "string", description: "Which budget: travel, dinners, gifts…" },
        },
        required: ["what", "price", "url", "category"],
      },
    },
    {
      name: "purchase_confirm",
      description:
        "Their answer to a purchase you prepared, from their own reply: yes records it against the budget and gives the link to complete it; no drops it. Only for a purchase prepared before this message, and only on their explicit yes.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The prepared purchase's id" },
          decision: { type: "string", enum: ["yes", "no"] },
        },
        required: ["id", "decision"],
      },
    },
  ];
}

const NAMES = new Set(specs().map((t) => t.name));
export const isBudgetTool = (name: string) => NAMES.has(name);
/** The ones that commit to spending: never for the agent's queued commands (commands.ts). */
export const SPENDING_TOOLS = ["budget_set", "purchase_propose", "purchase_confirm"];

/**
 * `born`: when this turn began. A purchase prepared at or after it can't be
 * confirmed in it: the YES has to be a reply of theirs that came after.
 */
export function budgetAssistant(env: Env, userId: string, timeZone: string, born = Date.now()) {
  const db = env.DB;
  const callTool: CallTool = async (name, args) => {
    const now = Date.now();
    if (name === "budget_set") {
      const category = String(args.category ?? "").trim().slice(0, 40);
      if (!category) return { error: "category is needed" };
      const existing = (await budgetsOf(db, userId)).find((b) => norm(b.category) === norm(category));
      if (args.remove === true) {
        if (!existing) return { error: `There's no ${category} budget.` };
        await db.prepare("UPDATE spend_budgets SET active = 0, updated_at = ? WHERE id = ?").bind(now, existing.id).run();
        return { removed: category };
      }
      const amount = toCents(args.amount);
      if (!amount || amount <= 0) return { error: "amount is needed: dollars for the period" };
      const period: Period = ["week", "month", "once"].includes(String(args.period)) ? (String(args.period) as Period) : existing?.period ?? "month";
      const cap = args.perPurchaseMax === undefined ? existing?.per_purchase_cents ?? null : toCents(args.perPurchaseMax);
      if (existing) {
        await db
          .prepare("UPDATE spend_budgets SET amount_cents = ?, period = ?, per_purchase_cents = ?, updated_at = ? WHERE id = ?")
          .bind(amount, period, cap, now, existing.id)
          .run();
      } else {
        await db
          .prepare("INSERT INTO spend_budgets (id, user_id, category, amount_cents, period, per_purchase_cents, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(crypto.randomUUID(), userId, category, amount, period, cap, now, now)
          .run();
      }
      say("budget", { outcome: existing ? "changed" : "set", user: userId });
      return {
        set: `${category}: ${money(amount)} ${period === "once" ? "in all" : `a ${period}`}${cap ? `, at most ${money(cap)} a purchase` : ""}`,
        note: "Say it's set, and how it works in a sentence: you find options within it and prepare them, they reply YES to one, and they complete the booking at the link (you never pay or hold a card).",
      };
    }
    if (name === "budget_status") {
      const budgets = await budgetsOf(db, userId);
      if (!budgets.length) return { budgets: 0, note: "None yet: budget_set makes one." };
      const out = [];
      for (const b of budgets) out.push(view(b, await spentIn(db, b, now, timeZone)));
      return { budgets: out };
    }
    if (name === "purchase_propose") {
      const what = String(args.what ?? "").trim().slice(0, 300);
      const price = toCents(args.price);
      const url = String(args.url ?? "").trim().slice(0, 1_000);
      if (!what || !price || price <= 0) return { error: "what and price are needed" };
      const bad = linkProblem(url);
      if (bad) return { error: `The link is ${bad}: give the https page where it can be bought.` };
      const open = await db
        .prepare("SELECT COUNT(*) AS n FROM purchases WHERE user_id = ? AND status = 'proposed' AND created_at > ?")
        .bind(userId, now - PROPOSAL_TTL_MS)
        .first<{ n: number }>();
      if ((open?.n ?? 0) >= OPEN_MAX) return { error: `${OPEN_MAX} purchases are already waiting for their answer. Ask about those first.` };
      const budget = budgetFor(await budgetsOf(db, userId), String(args.category ?? ""));
      let left: number | null = null;
      if (budget) {
        const spent = await spentIn(db, budget, now, timeZone);
        const fit = fits(budget, spent, price);
        if (!fit.ok) return { error: `That's ${money(price)}, ${fit.why} (${budget.category}). Look for a cheaper option, or ask whether to go over.` };
        left = fit.left;
      }
      const id = crypto.randomUUID().slice(0, 8);
      await db
        .prepare("INSERT INTO purchases (id, user_id, budget_id, what, merchant, url, price_cents, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?)")
        .bind(id, userId, budget?.id ?? null, what, String(args.merchant ?? "").trim().slice(0, 80) || null, url, price, now)
        .run();
      say("budget", { outcome: "proposed", user: userId });
      return {
        prepared: id,
        ask: `Book this for ${money(price)}? Reply YES`,
        ...(budget ? { budget: budget.category, leftAfter: money(left!) } : { budget: "none", note2: "They have no budget for this: mention it." }),
        note: `Nothing is bought. End your reply by asking exactly: "Book this for ${money(price)}? Reply YES" after saying what it is and where. Don't say it's booked.`,
      };
    }
    if (name === "purchase_confirm") {
      const id = String(args.id ?? "").trim();
      const p = await db
        .prepare("SELECT id, budget_id, what, merchant, url, price_cents, status, created_at FROM purchases WHERE id = ? AND user_id = ?")
        .bind(id, userId)
        .first<Purchase>();
      if (!p) return { error: "No purchase with that id is waiting." };
      if (p.status !== "proposed") return { error: `That one was already ${p.status}.` };
      if (p.created_at >= born) return { error: "It was only just prepared: ask them, and confirm only when their own reply says yes." };
      if (now - p.created_at > PROPOSAL_TTL_MS) {
        await db.prepare("UPDATE purchases SET status = 'expired', decided_at = ? WHERE id = ?").bind(now, p.id).run();
        return { error: "That was prepared over a day ago and the price may have changed: look again and prepare it fresh." };
      }
      if (String(args.decision) !== "yes") {
        await db.prepare("UPDATE purchases SET status = 'declined', decided_at = ? WHERE id = ?").bind(now, p.id).run();
        return { dropped: p.what };
      }
      const budget = p.budget_id
        ? await db.prepare("SELECT id, category, amount_cents, period, per_purchase_cents, currency, created_at FROM spend_budgets WHERE id = ?").bind(p.budget_id).first<Budget>()
        : null;
      if (budget) {
        const fit = fits(budget, await spentIn(db, budget, now, timeZone), p.price_cents);
        if (!fit.ok) return { error: `It no longer fits: ${fit.why}. Say so and ask whether to go over (a new budget_set) or find another.` };
      }
      await db.prepare("UPDATE purchases SET status = 'approved', decided_at = ? WHERE id = ?").bind(now, p.id).run();
      say("budget", { outcome: "approved", user: userId });
      const after = budget ? view(budget, await spentIn(db, budget, now, timeZone)) : null;
      return {
        approved: p.what,
        price: money(p.price_cents),
        link: p.url,
        ...(after && { budget: after }),
        note: [
          `Give them the link to finish booking it themselves (you don't pay and never ask for a card): ${p.url}`,
          after?.warning ? `Warn them: the ${budget!.category} budget is ${after.warning} (${after.spent} of ${after.budget}).` : after ? `Say what's left: ${after.left}.` : "",
        ]
          .filter(Boolean)
          .join(" "),
      };
    }
    return { error: `Unknown tool ${name}` };
  };
  return {
    tools: specs(),
    callTool,
    prompt: [
      "Budgets: they can give you a spending budget (budget_set). To buy something within it, find real options (web_search), pick the best that fits, and prepare it with purchase_propose (what, total price, merchant, the https link), then ask \"Book this for $X? Reply YES\".",
      "Only when their own next reply says yes, call purchase_confirm: it counts it against the budget and you give them the link to complete it. You never pay, never hold or ask for card details, and never say something is booked or paid.",
    ].join("\n"),
  };
}

/** What waits for their YES, for the turn's prompt (like network.ts networkContext). Empty for most people. */
export async function budgetContext(env: Env, userId: string, now = Date.now()): Promise<{ prompt: string; carry: string[] }> {
  const { results } = await env.DB.prepare("SELECT id, what, price_cents, created_at FROM purchases WHERE user_id = ? AND status = 'proposed' AND created_at > ? ORDER BY created_at")
    .bind(userId, now - PROPOSAL_TTL_MS)
    .all<{ id: string; what: string; price_cents: number }>();
  if (!results.length) return { prompt: "", carry: [] };
  return {
    prompt: [
      "Purchases you prepared, waiting for their yes or no (purchase_confirm with the id; a plain \"yes\" or \"book it\" is to the latest):",
      ...results.map((p) => `- id ${p.id}: ${p.what}, ${money(p.price_cents)}`),
    ].join("\n"),
    carry: ["purchase_confirm"],
  };
}
