// The vault (vault.ts): values encrypted at rest, refused when they're card or
// bank numbers, SSNs, passwords or codes, theirs only, gone with the account,
// and absent entirely when the server has no key.

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { blockRoutes, blocksAssistant } from "../src/blocks";
import type { Env, Vars } from "../src/types";
import { vaultAssistant, vaultRefusal } from "../src/vault";

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
sqlite.exec("PRAGMA foreign_keys = ON");
for (const id of ["sam", "alex"]) {
  sqlite.prepare("INSERT INTO users (id, email, password_hash, password_salt, name, created_at) VALUES (?, ?, '', '', ?, 0)").run(id, `${id}@example.com`, id);
}
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const env = { DB: d1(sqlite), TOKEN_ENC_KEY: KEY } as unknown as Env;

function appFor(userId: string, e: Env = env) {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();
  app.use("*", async (c, next) => {
    c.set("userId", userId);
    await next();
  });
  app.route("/", blockRoutes);
  return (path: string, init?: RequestInit) => app.request(path, init, e);
}

async function main() {
  // What the vault refuses.
  for (const [label, value] of [
    ["Visa", "4111 1111 1111 1111"],
    ["card", "4111-1111-1111-1111"],
    ["SSN", "123-45-6789"],
    ["Bank routing number", "021000021"],
    ["Gmail password", "hunter2"],
    ["Bank login", "my password is hunter2"],
    ["2FA backup", "code 123456"],
  ]) {
    eq(`refuses ${label}`, vaultRefusal(label!, value!) !== null, true);
  }
  for (const [label, value] of [
    ["Home address", "12 Main St, Apt 4, Austin TX 78701"],
    ["Delta SkyMiles", "9876543210"],
    ["Known Traveler Number", "TT12345"],
    ["Shoe size", "US 10.5"],
    ["Car", "Blue 2021 Civic, ABC 1234"],
  ]) {
    eq(`keeps ${label}`, vaultRefusal(label!, value!), null);
  }

  const sam = blocksAssistant(env, "sam", "America/New_York");
  eq("offered", sam.tools.filter((t) => t.name.startsWith("vault_")).map((t) => t.name), ["vault_lookup", "vault_save", "vault_delete"]);

  eq("save", await sam.callTool("vault_save", { category: "address", label: "Home address", value: "12 Main St, Austin TX" }), { status: "saved", label: "Home address", category: "address" });
  eq("same label, any case, replaces", await sam.callTool("vault_save", { category: "address", label: "home ADDRESS", value: "40 Oak Ave, Denver CO" }), { status: "updated", label: "Home address", category: "address" });
  await sam.callTool("vault_save", { category: "loyalty", label: "Delta SkyMiles", value: "9876543210" });
  await sam.callTool("vault_save", { category: "sizes", label: "Shoe size", value: "US 10.5" });
  eq("a card number is refused", ((await sam.callTool("vault_save", { label: "Visa", value: "4111 1111 1111 1111" })) as { error?: string }).error?.startsWith("The vault doesn't hold"), true);

  // Encrypted at rest.
  const stored = sqlite.prepare("SELECT value_enc FROM vault_items WHERE label = 'Delta SkyMiles'").get() as { value_enc: string };
  eq("the value isn't stored in the clear", stored.value_enc.includes("9876543210"), false);

  // Lookup.
  const delta = (await sam.callTool("vault_lookup", { query: "delta number" })) as { items: { label: string; value: string }[] };
  eq("lookup by words", delta.items[0], { category: "loyalty", label: "Delta SkyMiles", value: "9876543210" });
  const addresses = (await sam.callTool("vault_lookup", { category: "address" })) as { count: number; items: { value: string }[] };
  eq("lookup by category", [addresses.count, addresses.items[0]?.value], [1, "40 Oak Ave, Denver CO"]);
  const fallback = (await sam.callTool("vault_lookup", { query: "passport" })) as { count: number };
  eq("no word matches: everything, for the model to choose", fallback.count, 3);

  // Theirs only.
  const alex = blocksAssistant(env, "alex", "America/New_York");
  eq("another person sees nothing", await alex.callTool("vault_lookup", {}), { count: 0, items: [] });
  eq("and can't delete it", await alex.callTool("vault_delete", { label: "Shoe size" }), { error: 'Nothing in their vault is called "Shoe size".' });
  eq("delete", await sam.callTool("vault_delete", { label: "shoe size" }), { deleted: "shoe size" });

  // The app's routes.
  const asSam = appFor("sam");
  const listed = (await (await asSam("/vault")).json()) as { items: { id: string; label: string; value: string }[] };
  eq("GET /vault", listed.items.map((i) => [i.label, i.value]), [["Home address", "40 Oak Ave, Denver CO"], ["Delta SkyMiles", "9876543210"]]);
  const created = await asSam("/vault", { method: "POST", body: JSON.stringify({ category: "travel", label: "Seat", value: "Aisle" }), headers: { "content-type": "application/json" } });
  eq("POST /vault", created.status, 201);
  const refusedPost = await asSam("/vault", { method: "POST", body: JSON.stringify({ label: "PIN", value: "1234" }), headers: { "content-type": "application/json" } });
  eq("POST refuses a PIN", refusedPost.status, 400);
  const home = listed.items.find((i) => i.label === "Home address")!;
  const patched = await asSam(`/vault/${home.id}`, { method: "PATCH", body: JSON.stringify({ value: "1 New Rd, Boise ID" }), headers: { "content-type": "application/json" } });
  eq("PATCH /vault/:id", patched.status, 200);
  eq("really changed", ((await sam.callTool("vault_lookup", { category: "address" })) as { items: { value: string }[] }).items[0]?.value, "1 New Rd, Boise ID");
  const asAlex = appFor("alex");
  eq("someone else's item is not found", (await asAlex(`/vault/${home.id}`, { method: "DELETE" })).status, 404);
  eq("DELETE /vault/:id", (await asSam(`/vault/${home.id}`, { method: "DELETE" })).status, 204);

  // No key on the server: no vault at all, and nothing stored.
  const keyless = { DB: env.DB } as unknown as Env;
  eq("no key, no tools", vaultAssistant(keyless, "sam").tools.length, 0);
  eq("no key, the route says so", (await appFor("sam", keyless)("/vault")).status, 503);
  const before = (sqlite.prepare("SELECT COUNT(*) AS n FROM vault_items").get() as { n: number }).n;
  await appFor("sam", keyless)("/vault", { method: "POST", body: JSON.stringify({ label: "x", value: "y" }), headers: { "content-type": "application/json" } });
  eq("and nothing was stored", (sqlite.prepare("SELECT COUNT(*) AS n FROM vault_items").get() as { n: number }).n, before);

  // An account that goes takes its vault with it.
  sqlite.prepare("DELETE FROM users WHERE id = 'sam'").run();
  eq("gone with the account", (sqlite.prepare("SELECT COUNT(*) AS n FROM vault_items").get() as { n: number }).n, 0);

  console.log(fails ? `\n${fails} failed` : "\nall passed");
  if (fails) process.exit(1);
}

main();
