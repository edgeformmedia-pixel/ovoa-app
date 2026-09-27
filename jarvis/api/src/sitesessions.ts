// Logins without passwords: sites someone signed into themselves, lent to
// OVOA's browser (browser.ts).
//
// OVOA never asks for, sees or keeps a password. The person logs into a site
// in the OVOA app (their own phone, their own 2FA), and the app sends that
// site's cookies here. They're encrypted (crypto.ts, TOKEN_ENC_KEY), last at
// most 30 days, can be removed one by one, and are loaded into a browser
// session only for that site. Money sites (banks, cards, brokerages, payment
// apps, crypto) are refused outright: OVOA doesn't act inside them.

import { Hono } from "hono";
import { decrypt, encrypt } from "./crypto";
import type { Env, Vars } from "./types";

export const SESSION_DAYS = 30;
const DAY_MS = 86_400_000;
export const MAX_SITE_SESSIONS = 30;
const MAX_COOKIES = 150;
const MAX_JSON = 64_000;

export type SiteCookie = {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
};

/**
 * Sites OVOA won't hold a session for: money moves there. Matched on the host's
 * words, so bank.example and mybank.com both count. Pure.
 */
const MONEY_HOSTS =
  /(^|[.-])(bank|banking|creditunion|cu|chase|wellsfargo|citi|capitalone|amex|americanexpress|discover|schwab|fidelity|vanguard|etrade|robinhood|paypal|venmo|cash|zelle|coinbase|kraken|binance|crypto|stripe|wise|revolut|sofi|ally|usbank|pnc|tdbank|irs|ssa)([.-]|$)/i;

export function refusedHost(host: string): string | null {
  const h = host.toLowerCase().replace(/^www\./, "");
  // "bank" or "creditunion" anywhere in the name counts too (bankofamerica.com): a café
  // called Riverbank loses signed-in browsing, which is the right way to be wrong.
  if (MONEY_HOSTS.test(h) || /bank|creditunion|fcu/i.test(h)) {
    return "OVOA doesn't sign into banks, card, payment, brokerage or government money sites.";
  }
  return null;
}

/** The site a cookie list belongs to: the host they signed into, lowercased, no www. Pure. */
export const siteOf = (host: string) => host.trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");

/** Common two-part public suffixes a cookie must never be set for. */
const PUBLIC_SUFFIXES = new Set(["co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.nz", "co.jp", "co.in", "com.br", "com.mx", "co.za", "com.cn", "com.tw", "com.sg", "co.kr"]);

function cleanCookies(value: unknown, host: string): SiteCookie[] | null {
  if (!Array.isArray(value)) return null;
  const site = siteOf(host);
  const out: SiteCookie[] = [];
  for (const raw of value.slice(0, MAX_COOKIES)) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    const domain = String(c.domain ?? "").toLowerCase().replace(/^\./, "");
    // Only cookies for this site and its subdomains, or a parent domain that is itself a real
    // site (two labels or more, not a public suffix): nothing that would ride along to other sites.
    const parentOk = site.endsWith(`.${domain}`) && domain.includes(".") && !PUBLIC_SUFFIXES.has(domain);
    if (!domain || !(domain === site || domain.endsWith(`.${site}`) || parentOk)) continue;
    if (typeof c.name !== "string" || typeof c.value !== "string") continue;
    out.push({
      name: c.name.slice(0, 256),
      value: c.value.slice(0, 4_096),
      domain: String(c.domain),
      ...(typeof c.path === "string" ? { path: c.path } : {}),
      ...(typeof c.expires === "number" ? { expires: c.expires } : {}),
      ...(c.httpOnly === true ? { httpOnly: true } : {}),
      ...(c.secure === true ? { secure: true } : {}),
      ...(c.sameSite === "Strict" || c.sameSite === "Lax" || c.sameSite === "None" ? { sameSite: c.sameSite } : {}),
    });
  }
  return out;
}

export async function saveSiteSession(
  env: Env,
  userId: string,
  hostIn: unknown,
  cookiesIn: unknown,
  now = Date.now(),
): Promise<{ error: string } | { host: string; cookies: number; expiresAt: number }> {
  if (!env.TOKEN_ENC_KEY) return { error: "Signed-in sites aren't set up on this server." };
  const host = siteOf(String(hostIn ?? ""));
  if (!host || !host.includes(".")) return { error: "host is required" };
  const refused = refusedHost(host);
  if (refused) return { error: refused };
  const cookies = cleanCookies(cookiesIn, host);
  if (!cookies || !cookies.length) return { error: "No cookies for that site came with it." };
  const json = JSON.stringify(cookies);
  if (json.length > MAX_JSON) return { error: "That's more than a sign-in's worth of cookies." };
  const existing = await env.DB.prepare("SELECT 1 AS x FROM site_sessions WHERE user_id = ? AND host = ?").bind(userId, host).first();
  if (!existing) {
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM site_sessions WHERE user_id = ?").bind(userId).first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_SITE_SESSIONS) return { error: `They already have ${MAX_SITE_SESSIONS} signed-in sites. Remove one first.` };
  }
  const expires = now + SESSION_DAYS * DAY_MS;
  await env.DB
    .prepare(
      "INSERT INTO site_sessions (user_id, host, cookies_enc, created_at, expires_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, host) DO UPDATE SET cookies_enc = excluded.cookies_enc, created_at = excluded.created_at, expires_at = excluded.expires_at, used_at = NULL",
    )
    .bind(userId, host, await encrypt(env.TOKEN_ENC_KEY, json), now, expires)
    .run();
  return { host, cookies: cookies.length, expiresAt: expires };
}

/** The cookies to load for a page on `host` (the site or any parent it signed into), or none. */
export async function cookiesFor(env: Env, userId: string, host: string, now = Date.now()): Promise<SiteCookie[]> {
  if (!env.TOKEN_ENC_KEY) return [];
  const h = siteOf(host);
  if (refusedHost(h)) return [];
  const parts = h.split(".");
  const candidates = parts.map((_, i) => parts.slice(i).join(".")).filter((c) => c.includes("."));
  for (const site of candidates) {
    const row = await env.DB
      .prepare("SELECT cookies_enc FROM site_sessions WHERE user_id = ? AND host = ? AND expires_at > ?")
      .bind(userId, site, now)
      .first<{ cookies_enc: string }>();
    if (!row) continue;
    try {
      const cookies = JSON.parse(await decrypt(env.TOKEN_ENC_KEY, row.cookies_enc)) as SiteCookie[];
      await env.DB.prepare("UPDATE site_sessions SET used_at = ? WHERE user_id = ? AND host = ?").bind(now, userId, site).run();
      return cookies;
    } catch {
      return [];
    }
  }
  return [];
}

export async function listSiteSessions(db: D1Database, userId: string, now = Date.now()) {
  const { results } = await db
    .prepare("SELECT host, created_at, expires_at, used_at FROM site_sessions WHERE user_id = ? AND expires_at > ? ORDER BY host")
    .bind(userId, now)
    .all<{ host: string; created_at: number; expires_at: number; used_at: number | null }>();
  return results.map((r) => ({ host: r.host, since: r.created_at, expiresAt: r.expires_at, lastUsed: r.used_at }));
}

/** The app: send a site's cookies after signing in there, list them, remove one. */
export const siteSessionRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

siteSessionRoutes.get("/browser/sites", async (c) => c.json({ sites: await listSiteSessions(c.env.DB, c.var.userId) }));

siteSessionRoutes.post("/browser/sites", async (c) => {
  const body = ((await c.req.json().catch(() => null)) ?? {}) as { host?: unknown; cookies?: unknown };
  const saved = await saveSiteSession(c.env, c.var.userId, body.host, body.cookies);
  if ("error" in saved && saved.error) return c.json(saved, saved.error.includes("set up") ? 503 : 400);
  return c.json(saved, 201);
});

siteSessionRoutes.delete("/browser/sites/:host", async (c) => {
  const done = await c.env.DB.prepare("DELETE FROM site_sessions WHERE user_id = ? AND host = ?").bind(c.var.userId, siteOf(c.req.param("host"))).run();
  return done.meta.changes ? c.body(null, 204) : c.json({ error: "Not found." }, 404);
});
