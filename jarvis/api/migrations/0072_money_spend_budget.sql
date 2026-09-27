-- Spending they record (money.ts money_update, a receipt they texted) can count
-- against one of their budgets (budget.ts), like an approved purchase does.
ALTER TABLE money_spend ADD COLUMN budget_id TEXT;
