import type { Env } from "./types";

// A small Stripe client over fetch, for OVOA paying for people's purchases
// (pay.ts): their saved card, the hold on it, and the one-time Issuing card the
// browser pays with. The site's Worker has its own for plans
// (ovoa-team/src/lib/membership/stripe.server.ts); this is the same shape.

/** Pinned so field names don't move under us. */
export const STRIPE_API_VERSION = "2024-06-20";

export class StripeError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly declineCode?: string,
  ) {
    super(message);
  }
}

type FormValue = string | number | boolean | null | undefined | FormValue[] | { [key: string]: FormValue };

/** Stripe takes nested form fields: a[b]=1, a[0]=x. Pure. */
export function encodeForm(params: Record<string, FormValue>): string {
  const out = new URLSearchParams();
  const walk = (value: FormValue, key: string) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((item, i) => walk(item, `${key}[${i}]`));
    else if (typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, `${key}[${k}]`);
    else out.append(key, String(value));
  };
  for (const [k, v] of Object.entries(params)) walk(v, k);
  return out.toString();
}

/**
 * idempotencyKey: Stripe answers a repeat of the same POST (within 24 hours)
 * with the first result instead of doing it twice.
 */
export async function stripe<T = Record<string, any>>(
  env: Env,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params?: Record<string, FormValue>,
  { idempotencyKey }: { idempotencyKey?: string } = {},
): Promise<T> {
  if (!env.STRIPE_SECRET_KEY) throw new StripeError("STRIPE_SECRET_KEY is not set", 500);
  const base = env.STRIPE_API_BASE ?? "https://api.stripe.com/v1";
  const form = params ? encodeForm(params) : "";
  const url = method === "POST" || !form ? `${base}${path}` : `${base}${path}?${form}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Stripe-Version": STRIPE_API_VERSION,
      ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    ...(method === "POST" ? { body: form } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: string; decline_code?: string } };
  if (!res.ok) throw new StripeError(json.error?.message ?? `Stripe returned ${res.status}`, res.status, json.error?.code, json.error?.decline_code);
  return json as T;
}

// ---------- Webhook signatures ----------
//
// Stripe-Signature: t=<unix seconds>,v1=<hex hmac>[,v1=...]. The HMAC is
// SHA-256 over "<t>.<raw body>" keyed with the whole whsec_... secret.

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

function sameString(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signStripePayload(payload: string, secret: string, timestamp: number) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(`${timestamp}.${payload}`)));
}

export async function verifyStripeSignature(payload: string, header: string | null | undefined, secret: string, { toleranceSeconds = 300, now = Date.now() } = {}) {
  if (!header) return false;
  let timestamp = NaN;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2);
    if (k === "t") timestamp = Number(v);
    else if (k === "v1" && v) signatures.push(v);
  }
  if (!Number.isFinite(timestamp) || !signatures.length) return false;
  if (Math.abs(now / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = await signStripePayload(payload, secret, timestamp);
  return signatures.some((s) => sameString(s, expected));
}
