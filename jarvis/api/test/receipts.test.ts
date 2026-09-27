// Receipts into money (receipts.ts, money.ts, budget.ts): the RECEIPT line a
// photo's description ends with, card numbers kept out of anything saved, and
// logged spending counting against a matching budget.

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { budgetAssistant } from "../src/budget";
import { moneyAssistant } from "../src/money";
import { receiptIn, receiptOffer, withoutCardNumbers } from "../src/receipts";
import type { Env } from "../src/types";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(got)}${ok ? "" : `  (wanted ${JSON.stringify(want)})`}`);
}

function d1(sqlite: DatabaseSync): D1Database {
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => (sqlite.prepare(sql).get(...(args as never[])) as unknown) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...(args as never[])) }),
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...(args as never[])).changes) } }),
  });
  return { prepare: (sql: string) => statement(sql) } as unknown as D1Database;
}

const sqlite = new DatabaseSync(":memory:");
for (const file of readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort()) {
  sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
}
sqlite.prepare("INSERT INTO users (id, email, password_hash, password_salt, name, created_at) VALUES ('sam', 'sam@example.com', '', '', 'Sam', 0)").run();
const env = { DB: d1(sqlite) } as unknown as Env;

async function main() {
  // The RECEIPT line.
  eq("a receipt", receiptIn("A receipt from Trader Joe's.\nRECEIPT | 42.10 | Trader Joe's | 2026-09-27"), {
    receipt: { cents: 4210, merchant: "Trader Joe's", date: "2026-09-27" },
    text: "A receipt from Trader Joe's.",
  });
  eq("dollar signs, commas, no date", receiptIn("Dinner.\nRECEIPT | $1,204.50 | Nobu | unknown").receipt, { cents: 120450, merchant: "Nobu", date: null });
  eq("a photo that isn't one", receiptIn("A dog on a beach."), { receipt: null, text: "A dog on a beach." });
  eq("a zero total is no receipt", receiptIn("x\nRECEIPT | 0.00 | Shop | unknown").receipt, null);
  eq("the offer names the amount and the place", receiptOffer({ cents: 4210, merchant: "Trader Joe's", date: null }).includes("$42.10 at Trader Joe's"), true);

  // Card numbers.
  eq("a card number goes", withoutCardNumbers("Paid with 4111 1111 1111 1111 today"), "Paid with [card number removed] today");
  eq("and a masked one", withoutCardNumbers("VISA **** 1111, ending in 1111"), "VISA [card], [card]");
  eq("a phone number stays", withoutCardNumbers("Call +44 20 7946 0958"), "Call +44 20 7946 0958");
  eq("an order number that isn't a card stays", withoutCardNumbers("Order 1234567812345678"), "Order 1234567812345678");

  // Logged spending counts against a matching budget.
  const budget = budgetAssistant(env, "sam", "UTC");
  const moneyTools = moneyAssistant(env, "sam", "UTC");
  await budget.callTool("budget_set", { category: "groceries", amount: 400, period: "month" });
  const saved = (await moneyTools.callTool("money_update", { kind: "spend", amount: 42.1, what: "Trader Joe's, Visa 4111 1111 1111 1111", category: "groceries" })) as {
    saved: string;
    countedAgainst?: string;
  };
  eq("logged", saved.saved, "spent $42.10");
  eq("against the groceries budget", saved.countedAgainst?.includes("groceries"), true);
  const status = (await budget.callTool("budget_status", {})) as { budgets?: { category: string; spent: string; left: string }[] };
  const groceries = (status.budgets ?? (status as unknown as { category: string; spent: string; left: string }[])).find?.((b) => b.category === "groceries");
  eq("budget_status counts it", [groceries?.spent, groceries?.left], ["$42.10", "$357.90"]);
  const kept = sqlite.prepare("SELECT what FROM money_spend WHERE user_id = 'sam'").get() as { what: string };
  eq("no card number is saved with it", kept.what, "Trader Joe's, Visa [card number removed]");
  const plain = (await moneyTools.callTool("money_update", { kind: "spend", amount: 5, what: "coffee" })) as { countedAgainst?: string };
  eq("without a category, nothing is counted against a budget", plain.countedAgainst, undefined);

  console.log(fails ? `\n${fails} failed` : "\nall passed");
  if (fails) process.exit(1);
}

main();
