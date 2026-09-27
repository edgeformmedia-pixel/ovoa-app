// The vault: personal details OVOA uses when it acts for someone.
//
// Booking a flight wants a Known Traveler number, a delivery form wants the
// home address, "order me the same shoes" wants a size. Memories are the wrong
// place for these (plain text, summarized, shared with Full-access friends);
// here each value is encrypted (crypto.ts, TOKEN_ENC_KEY, like Google tokens)
// and only the person's own OVOA reads it.
//
// What never goes in: card numbers, bank or routing numbers, SSNs, passwords,
// PINs, one-time codes. Payments go through the merchant's own checkout
// (budget.ts); OVOA never holds a way to pay.
//
// No TOKEN_ENC_KEY, no vault: the tools and routes say so instead of storing
// anything in the clear.

import { Hono } from "hono";
import { decrypt, encrypt } from "./crypto";
import type { CallTool, ToolSpec } from "./llm";
import type { Env, Vars } from "./types";

export const VAULT_CATEGORIES = ["address", "travel", "loyalty", "sizes", "vehicle", "other"] as const;
export type VaultCategory = (typeof VAULT_CATEGORIES)[number];
export const MAX_VAULT_ITEMS = 200;

const FORBIDDEN_WORDS =
  /\b(password|passcode|passwd|pin|cvv|cvc|security code|ssn|social security|routing number|account number|bank account|verification code|one[- ]time code|2fa|otp|credit card|debit card|card number)\b/i;
/** 13 to 19 digits, optionally grouped: the shape of a payment card. */
const CARD_DIGITS = /\b(?:\d[ -]?){13,19}\b/;
const SSN_SHAPE = /\b\d{3}-\d{2}-\d{4}\b/;

/** Why the vault won't hold this, or null. Checked on label and value together. */
export function vaultRefusal(label: string, value: string): string | null {
  const both = `${label} ${value}`;
  if (FORBIDDEN_WORDS.test(both) || CARD_DIGITS.test(value) || SSN_SHAPE.test(value)) {
    return "The vault doesn't hold card or bank numbers, SSNs, passwords or codes. Payments happen at the store's own checkout.";
  }
  return null;
}

type ItemRow = { id: string; category: string; label: string; value_enc: string; updated_at: number };
export type VaultItem = { id: string; category: string; label: string; value: string; updatedAt: number };

const clean = (value: unknown, max: number) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
const categoryOf = (value: unknown): VaultCategory =>
  (VAULT_CATEGORIES as readonly string[]).includes(String(value)) ? (value as VaultCategory) : "other";

async function open(key: string, row: ItemRow): Promise<VaultItem | null> {
  try {
    return { id: row.id, category: row.category, label: row.label, value: await decrypt(key, row.value_enc), updatedAt: row.updated_at };
  } catch {
    // A value that won't decrypt (key rotated) is skipped, never shown as garbage.
    return null;
  }
}

export async function listVault(env: Env, userId: string): Promise<VaultItem[]> {
  if (!env.TOKEN_ENC_KEY) return [];
  const { results } = await env.DB
    .prepare("SELECT id, category, label, value_enc, updated_at FROM vault_items WHERE user_id = ? ORDER BY category, label")
    .bind(userId)
    .all<ItemRow>();
  const opened = await Promise.all(results.map((row) => open(env.TOKEN_ENC_KEY!, row)));
  return opened.filter((item): item is VaultItem => item !== null);
}

/** Saves or replaces (by label, any case) one item. */
export async function saveVaultItem(
  env: Env,
  userId: string,
  input: { category?: unknown; label?: unknown; value?: unknown },
  now = Date.now(),
): Promise<{ item: Omit<VaultItem, "value">; replaced: boolean } | { error: string }> {
  if (!env.TOKEN_ENC_KEY) return { error: "The vault isn't set up on this server." };
  const label = clean(input.label, 80);
  const value = String(input.value ?? "").trim().slice(0, 1_000);
  if (!label) return { error: "label is required" };
  if (!value) return { error: "value is required" };
  const refused = vaultRefusal(label, value);
  if (refused) return { error: refused };
  const category = categoryOf(input.category);
  const existing = await env.DB
    .prepare("SELECT id, label FROM vault_items WHERE user_id = ? AND label = ?")
    .bind(userId, label)
    .first<{ id: string; label: string }>();
  if (!existing) {
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM vault_items WHERE user_id = ?").bind(userId).first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_VAULT_ITEMS) return { error: `The vault holds up to ${MAX_VAULT_ITEMS} items.` };
  }
  const id = existing?.id ?? crypto.randomUUID();
  const sealed = await encrypt(env.TOKEN_ENC_KEY, value);
  await env.DB
    .prepare(
      "INSERT INTO vault_items (id, user_id, category, label, value_enc, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, label) DO UPDATE SET category = excluded.category, value_enc = excluded.value_enc, updated_at = excluded.updated_at",
    )
    .bind(id, userId, category, label, sealed, now, now)
    .run();
  // Replacing keeps the label as first written ("Home address", not "home ADDRESS").
  return { item: { id, category, label: existing?.label ?? label, updatedAt: now }, replaced: !!existing };
}

const TOOLS: ToolSpec[] = [
  {
    name: "vault_lookup",
    description:
      "Looks up their saved personal details for acting on their behalf: addresses, frequent-flyer and loyalty numbers, sizes, seat preference, car. Use it before filling a form or booking instead of asking again.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to match, e.g. 'home address' or 'delta'." },
        category: { type: "string", enum: [...VAULT_CATEGORIES] },
      },
    },
  },
  {
    name: "vault_save",
    description:
      "Saves one personal detail to their encrypted vault when they share it for later use (a label like 'Home address' or 'Delta SkyMiles' and the value). Saving the same label replaces it. It refuses card and bank numbers, SSNs, passwords and codes.",
    parameters: {
      type: "object",
      properties: {
        category: { type: "string", enum: [...VAULT_CATEGORIES] },
        label: { type: "string" },
        value: { type: "string" },
      },
      required: ["label", "value"],
    },
  },
  {
    name: "vault_delete",
    description: "Removes one item from their vault by its label.",
    parameters: { type: "object", properties: { label: { type: "string" } }, required: ["label"] },
  },
];

const NAMES = new Set(TOOLS.map((t) => t.name));
export const isVaultTool = (name: string) => NAMES.has(name);

const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);

/** The vault's tools, or none at all when the server has no encryption key. */
export function vaultAssistant(env: Env, userId: string) {
  if (!env.TOKEN_ENC_KEY) return { tools: [] as ToolSpec[], callTool: (async () => ({ error: "The vault isn't set up." })) as CallTool, prompt: "" };

  const callTool: CallTool = async (name, args) => {
    if (name === "vault_lookup") {
      const all = await listVault(env, userId);
      const category = args.category ? categoryOf(args.category) : null;
      const inCategory = category ? all.filter((i) => i.category === category) : all;
      const wanted = words(String(args.query ?? ""));
      const scored = wanted.length
        ? inCategory
            .map((item) => ({ item, score: wanted.filter((w) => `${item.label} ${item.value}`.toLowerCase().includes(w)).length }))
            .filter((m) => m.score > 0)
            .sort((a, b) => b.score - a.score)
            .map((m) => m.item)
        : inCategory;
      // Nothing matched the words: hand back the category (or everything) and let the model choose.
      const items = scored.length ? scored : inCategory;
      return { count: items.length, items: items.slice(0, 30).map(({ category: c, label, value }) => ({ category: c, label, value })) };
    }
    if (name === "vault_save") {
      const saved = await saveVaultItem(env, userId, args);
      return "error" in saved ? saved : { status: saved.replaced ? "updated" : "saved", label: saved.item.label, category: saved.item.category };
    }
    if (name === "vault_delete") {
      const label = clean(args.label, 80);
      const done = await env.DB.prepare("DELETE FROM vault_items WHERE user_id = ? AND label = ?").bind(userId, label).run();
      return done.meta.changes ? { deleted: label } : { error: `Nothing in their vault is called "${label}".` };
    }
    return { error: `Unknown tool ${name}` };
  };

  return {
    tools: TOOLS,
    callTool,
    prompt: [
      "Vault: their saved details for acting on their behalf (addresses, loyalty and frequent-flyer numbers, sizes, seat preference, car). Check vault_lookup before asking them again when you fill a form or book something.",
      "When they tell you a detail like that for later, offer to save it (vault_save). Never save card or bank numbers, SSNs, passwords or codes, and never pass vault details to another person or their OVOA unless they ask you to for this task.",
    ].join("\n"),
  };
}

/** The app's vault screen: list, add, change, remove. Values come back decrypted to their owner only. */
export const vaultRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

vaultRoutes.get("/vault", async (c) => {
  if (!c.env.TOKEN_ENC_KEY) return c.json({ error: "The vault isn't set up." }, 503);
  return c.json({ items: await listVault(c.env, c.var.userId), categories: VAULT_CATEGORIES });
});

vaultRoutes.post("/vault", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { category?: unknown; label?: unknown; value?: unknown } | null;
  const saved = await saveVaultItem(c.env, c.var.userId, body ?? {});
  if ("error" in saved) return c.json(saved, saved.error.includes("isn't set up") ? 503 : 400);
  return c.json(saved.item, saved.replaced ? 200 : 201);
});

vaultRoutes.patch("/vault/:id", async (c) => {
  if (!c.env.TOKEN_ENC_KEY) return c.json({ error: "The vault isn't set up." }, 503);
  const row = await c.env.DB
    .prepare("SELECT id, category, label, value_enc, updated_at FROM vault_items WHERE id = ? AND user_id = ?")
    .bind(c.req.param("id"), c.var.userId)
    .first<ItemRow>();
  if (!row) return c.json({ error: "Not found." }, 404);
  const current = await open(c.env.TOKEN_ENC_KEY, row);
  const body = ((await c.req.json().catch(() => null)) ?? {}) as { category?: unknown; label?: unknown; value?: unknown };
  const label = body.label === undefined ? row.label : clean(body.label, 80);
  const value = body.value === undefined ? (current?.value ?? "") : String(body.value).trim().slice(0, 1_000);
  if (!label || !value) return c.json({ error: "label and value can't be empty" }, 400);
  const refused = vaultRefusal(label, value);
  if (refused) return c.json({ error: refused }, 400);
  if (label.toLowerCase() !== row.label.toLowerCase()) {
    const taken = await c.env.DB.prepare("SELECT 1 FROM vault_items WHERE user_id = ? AND label = ? AND id <> ?").bind(c.var.userId, label, row.id).first();
    if (taken) return c.json({ error: "Another item already has that label." }, 409);
  }
  const now = Date.now();
  await c.env.DB
    .prepare("UPDATE vault_items SET category = ?, label = ?, value_enc = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .bind(body.category === undefined ? row.category : categoryOf(body.category), label, await encrypt(c.env.TOKEN_ENC_KEY, value), now, row.id, c.var.userId)
    .run();
  return c.json({ id: row.id, label, updatedAt: now });
});

vaultRoutes.delete("/vault/:id", async (c) => {
  const done = await c.env.DB.prepare("DELETE FROM vault_items WHERE id = ? AND user_id = ?").bind(c.req.param("id"), c.var.userId).run();
  return done.meta.changes ? c.body(null, 204) : c.json({ error: "Not found." }, 404);
});
