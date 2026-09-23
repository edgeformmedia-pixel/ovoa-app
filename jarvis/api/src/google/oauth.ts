import { Hono } from "hono";
import { base64url, decrypt, encrypt } from "../crypto";
import { finishGoogleSignin, takeGoogleSigninState } from "../signin";
import type { Env, Vars } from "../types";

// Drive is drive.file: only the files OVOA created (the sheets and docs it made),
// never the rest of someone's Drive. Documents and spreadsheets stay whole so it
// can open a Doc or Sheet the user points it to by link.
export const GOOGLE_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/tasks",
  "https://www.googleapis.com/auth/contacts",
];

const STATE_TTL_MS = 10 * 60 * 1000;
// Where the app may ask to be sent back to: Expo Go (exp://) or the installed app (ovoa://).
const RETURN_URL = /^(exps?|ovoa):\/\//;

const redirectUri = (env: Env) => `${env.PUBLIC_URL}/google/callback`;

export class GoogleNotConnected extends Error {
  constructor(readonly email?: string) {
    super(email ? `The Google account ${email} is no longer connected` : "Google account is not connected");
  }
}

/** One connected Google account, as the app and the assistant see it. */
export type GoogleAccount = {
  id: string;
  email: string;
  name: string | null;
  /** Short tag the user or the assistant gave it, e.g. "Work". */
  label: string | null;
  isDefault: boolean;
  scopes: string[];
  connectedAt: number;
};

type AccountRow = {
  id: string;
  email: string;
  name: string | null;
  label: string | null;
  is_default: number;
  scopes: string;
  connected_at: number;
};

type TokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  id_token?: string;
  error?: string;
};

async function tokenRequest(env: Env, params: Record<string, string>) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
      ...params,
    }),
  });
  const body = (await res.json()) as TokenResponse;
  return { ok: res.ok, body };
}

/** The user's connected accounts, default first. */
export async function listGoogleAccounts(db: D1Database, userId: string): Promise<GoogleAccount[]> {
  const { results } = await db
    .prepare(
      `SELECT id, email, name, label, is_default, scopes, connected_at FROM google_accounts
       WHERE user_id = ? ORDER BY is_default DESC, connected_at`,
    )
    .bind(userId)
    .all<AccountRow>();
  return results.map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    label: r.label,
    isDefault: !!r.is_default,
    scopes: r.scopes.split(" "),
    connectedAt: r.connected_at,
  }));
}

/** Makes the oldest account the default when the user still has accounts but none is marked. */
const ensureDefault = (db: D1Database, userId: string) =>
  db.prepare(
    `UPDATE google_accounts SET is_default = 1
     WHERE id = (SELECT id FROM google_accounts WHERE user_id = ?1 ORDER BY connected_at LIMIT 1)
       AND NOT EXISTS (SELECT 1 FROM google_accounts WHERE user_id = ?1 AND is_default = 1)`,
  ).bind(userId);

async function removeAccount(db: D1Database, userId: string, accountId: string) {
  await db.batch([
    db.prepare("DELETE FROM google_accounts WHERE id = ? AND user_id = ?").bind(accountId, userId),
    ensureDefault(db, userId),
  ]);
}

/** A valid access token for one of the user's accounts, refreshing it when needed. */
export async function googleAccessToken(env: Env, userId: string, accountId: string): Promise<string> {
  const row = await env.DB
    .prepare(
      "SELECT email, refresh_token_enc, access_token_enc, access_expires_at FROM google_accounts WHERE id = ? AND user_id = ?",
    )
    .bind(accountId, userId)
    .first<{
      email: string;
      refresh_token_enc: string;
      access_token_enc: string | null;
      access_expires_at: number | null;
    }>();
  if (!row) throw new GoogleNotConnected();

  if (row.access_token_enc && row.access_expires_at && row.access_expires_at > Date.now() + 60_000) {
    return decrypt(env.TOKEN_ENC_KEY, row.access_token_enc);
  }

  const { ok, body } = await tokenRequest(env, {
    grant_type: "refresh_token",
    refresh_token: await decrypt(env.TOKEN_ENC_KEY, row.refresh_token_enc),
  });
  if (!ok) {
    // Revoked, expired (testing apps expire after 7 days), or removed by the user.
    if (body.error === "invalid_grant") {
      await removeAccount(env.DB, userId, accountId);
      throw new GoogleNotConnected(row.email);
    }
    throw new Error(`Google token refresh failed: ${body.error}`);
  }

  await env.DB
    .prepare("UPDATE google_accounts SET access_token_enc = ?, access_expires_at = ? WHERE id = ?")
    .bind(await encrypt(env.TOKEN_ENC_KEY, body.access_token), Date.now() + body.expires_in * 1000, accountId)
    .run();
  return body.access_token;
}

export const LABEL_MAX = 24;

/** Trims a tag to something safe to show and to put in the assistant's prompt. "" means no tag. */
export function cleanLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value
    .replace(/[^\p{L}\p{N} &'._-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, LABEL_MAX);
}

/** Tags an account (or, with "", removes its tag). Returns an error message when it can't. */
export async function setAccountLabel(db: D1Database, userId: string, accountId: string, label: string) {
  try {
    const res = await db
      .prepare("UPDATE google_accounts SET label = ? WHERE id = ? AND user_id = ?")
      .bind(label || null, accountId, userId)
      .run();
    return res.meta.changes ? null : "That Google account isn't connected";
  } catch (err) {
    if (String(err).includes("UNIQUE")) return `Another Google account is already tagged "${label}"`;
    throw err;
  }
}

export async function setDefaultAccount(db: D1Database, userId: string, accountId: string) {
  const exists = await db
    .prepare("SELECT 1 FROM google_accounts WHERE id = ? AND user_id = ?")
    .bind(accountId, userId)
    .first();
  if (!exists) return "That Google account isn't connected";
  await db
    .prepare("UPDATE google_accounts SET is_default = (id = ?) WHERE user_id = ?")
    .bind(accountId, userId)
    .run();
  return null;
}

async function revoke(env: Env, refreshTokenEnc: string) {
  const token = await decrypt(env.TOKEN_ENC_KEY, refreshTokenEnc);
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: "POST" }).catch(
    () => {},
  );
}

// ---------- Routes that need a signed-in OVOA user ----------

export const googleAuthed = new Hono<{ Bindings: Env; Variables: Vars }>();

googleAuthed.post("/google/connect", async (c) => {
  if (!c.env.GOOGLE_CLIENT_SECRET) return c.json({ error: "Google sign-in isn't set up on the server yet" }, 503);
  const body = (await c.req.json().catch(() => ({}))) as { returnUrl?: string; accountId?: string };
  const returnUrl = body.returnUrl && RETURN_URL.test(body.returnUrl) ? body.returnUrl : null;

  // Reconnecting a particular account: ask Google to preselect it.
  const reconnect = body.accountId
    ? await c.env.DB
        .prepare("SELECT email FROM google_accounts WHERE id = ? AND user_id = ?")
        .bind(body.accountId, c.var.userId)
        .first<{ email: string }>()
    : null;

  const state = base64url(crypto.getRandomValues(new Uint8Array(24)));
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );

  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM oauth_states WHERE expires_at < ?").bind(Date.now()),
    c.env.DB
      .prepare("INSERT INTO oauth_states (state, user_id, code_verifier, return_url, expires_at) VALUES (?, ?, ?, ?, ?)")
      .bind(state, c.var.userId, verifier, returnUrl, Date.now() + STATE_TTL_MS),
  ]);

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(c.env),
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    // select_account so a second account can be added without signing out of the first.
    prompt: "consent select_account",
    // No include_granted_scopes: it would fold an earlier full-Drive grant into
    // this one, and a reconnect is how an account moves to drive.file.
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...(reconnect && { login_hint: reconnect.email }),
  }).toString();

  return c.json({ url: url.toString() });
});

googleAuthed.get("/google/status", async (c) => {
  const accounts = await listGoogleAccounts(c.env.DB, c.var.userId);
  const main = accounts[0];
  // The top-level fields describe the default account, for app builds that only know about one.
  return c.json(
    main
      ? {
          connected: true,
          email: main.email,
          name: main.name,
          scopes: main.scopes,
          connectedAt: main.connectedAt,
          accounts,
        }
      : { connected: false, accounts },
  );
});

googleAuthed.patch("/google/accounts/:id", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { label?: unknown; isDefault?: unknown };

  if (body.label !== undefined) {
    const label = cleanLabel(body.label);
    if (label === null) return c.json({ error: "Tag must be text" }, 400);
    const error = await setAccountLabel(c.env.DB, c.var.userId, id, label);
    if (error) return c.json({ error }, 400);
  }
  if (body.isDefault === true) {
    const error = await setDefaultAccount(c.env.DB, c.var.userId, id);
    if (error) return c.json({ error }, 404);
  }
  return c.json({ accounts: await listGoogleAccounts(c.env.DB, c.var.userId) });
});

googleAuthed.delete("/google/accounts/:id", async (c) => {
  const row = await c.env.DB
    .prepare("SELECT refresh_token_enc FROM google_accounts WHERE id = ? AND user_id = ?")
    .bind(c.req.param("id"), c.var.userId)
    .first<{ refresh_token_enc: string }>();
  if (row) {
    await revoke(c.env, row.refresh_token_enc);
    await removeAccount(c.env.DB, c.var.userId, c.req.param("id"));
  }
  return c.json({ accounts: await listGoogleAccounts(c.env.DB, c.var.userId) });
});

/** Disconnects every account. */
googleAuthed.delete("/google", async (c) => {
  const { results } = await c.env.DB
    .prepare("SELECT refresh_token_enc FROM google_accounts WHERE user_id = ?")
    .bind(c.var.userId)
    .all<{ refresh_token_enc: string }>();
  await Promise.all(results.map((r) => revoke(c.env, r.refresh_token_enc)));
  await c.env.DB.prepare("DELETE FROM google_accounts WHERE user_id = ?").bind(c.var.userId).run();
  return c.json({ ok: true });
});

// ---------- Public callback Google redirects to ----------

export const googlePublic = new Hono<{ Bindings: Env }>();

function finish(returnUrl: string | null, result: "connected" | "error", message?: string) {
  if (returnUrl) {
    const url = new URL(returnUrl);
    url.searchParams.set("google", result);
    if (message) url.searchParams.set("message", message);
    return new Response(null, { status: 302, headers: { location: url.toString() } });
  }
  const text = result === "connected" ? "Google account connected. You can close this page." : `Couldn't connect: ${message}`;
  const escaped = text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  return new Response(
    `<!doctype html><meta name="viewport" content="width=device-width"><p style="font:18px system-ui;padding:24px">${escaped}</p>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

googlePublic.get("/google/callback", async (c) => {
  const { code, state, error } = c.req.query();
  if (!state) return finish(null, "error", "Missing state");

  // "Continue with Google" in the app comes back here too, since this is the
  // redirect registered with Google. Its state is its own (signin.ts).
  const signin = await takeGoogleSigninState(c.env.DB, state);
  if (signin) return finishGoogleSignin(c.env, signin, { code, error });

  const row = await c.env.DB
    .prepare("DELETE FROM oauth_states WHERE state = ? RETURNING user_id, code_verifier, return_url, expires_at")
    .bind(state)
    .first<{ user_id: string; code_verifier: string; return_url: string | null; expires_at: number }>();
  if (!row || row.expires_at < Date.now()) return finish(null, "error", "This link expired. Try connecting again.");
  if (error || !code) return finish(row.return_url, "error", error === "access_denied" ? "You cancelled" : error);

  const { ok, body } = await tokenRequest(c.env, {
    grant_type: "authorization_code",
    code,
    code_verifier: row.code_verifier,
    redirect_uri: redirectUri(c.env),
  });
  if (!ok || !body.refresh_token) {
    console.error("Google code exchange failed", body.error);
    return finish(row.return_url, "error", "Google didn't return access. Try again.");
  }

  const profile = (await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${body.access_token}` },
  }).then((r) => r.json())) as { email?: string; name?: string };

  // A new email becomes another account (the first one connected is the default);
  // the same email again just refreshes its tokens, keeping its tag and default flag.
  const now = Date.now();
  await c.env.DB
    .prepare(
      `INSERT INTO google_accounts
         (id, user_id, email, name, is_default, scopes, refresh_token_enc, access_token_enc, access_expires_at, connected_at)
       VALUES (?1, ?2, ?3, ?4, NOT EXISTS (SELECT 1 FROM google_accounts WHERE user_id = ?2), ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT (user_id, email) DO UPDATE SET
         name = excluded.name, scopes = excluded.scopes,
         refresh_token_enc = excluded.refresh_token_enc, access_token_enc = excluded.access_token_enc,
         access_expires_at = excluded.access_expires_at, connected_at = excluded.connected_at`,
    )
    .bind(
      crypto.randomUUID(),
      row.user_id,
      profile.email ?? "Google account",
      profile.name ?? null,
      body.scope,
      await encrypt(c.env.TOKEN_ENC_KEY, body.refresh_token),
      await encrypt(c.env.TOKEN_ENC_KEY, body.access_token),
      now + body.expires_in * 1000,
      now,
    )
    .run();

  return finish(row.return_url, "connected");
});
