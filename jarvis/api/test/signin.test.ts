// The app's own sign-ins (signin.ts): "Continue with Google" through
// /auth/google/start, /google/callback and /auth/google/redeem, and Sign in
// with Apple through /auth/apple/start and /auth/apple. Then the name +
// password step (/auth/email/signup) making an app session. The SQL runs for
// real, on Node's own SQLite with every migration applied, and the routes run
// through the Worker's own fetch. Google and Apple are stand-ins: the test key
// below signs Apple's tokens, and fetch is replaced for the routes.

import { timingSafeEqual } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { sha256 } from "../src/auth";
import worker from "../src/index";
import {
  appleIdentityFrom,
  appleName,
  appReturnUrl,
  APPLE_AUDIENCE,
  APPLE_ISSUER,
  APPLE_KEYS_URL,
  finishGoogleSignin,
  forgetAppleKeys,
  issueAppleNonce,
  issueSigninCode,
  pruneSignin,
  redeemSigninCode,
  SIGNIN_CODE_TTL_MS,
  SIGNIN_STATE_TTL_MS,
  spendAppleNonce,
  startGoogleSignin,
  takeGoogleSigninState,
  verifyAppleIdentityToken,
} from "../src/signin";
import type { Env } from "../src/types";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const g = typeof got === "object" ? JSON.stringify(got) : got;
  const w = typeof want === "object" ? JSON.stringify(want) : want;
  const ok = g === w;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${g}${ok ? "" : `  (wanted ${w})`}`);
}

// ---------- A D1 over node:sqlite, with every migration ----------

function d1(sqlite: DatabaseSync): D1Database {
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => (sqlite.prepare(sql).get(...(args as never[])) as unknown) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...(args as never[])) }),
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...(args as never[])).changes) } }),
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (list: ReturnType<typeof statement>[]) => {
      sqlite.exec("BEGIN");
      try {
        const out = [];
        for (const s of list) out.push(await s.run());
        sqlite.exec("COMMIT");
        return out;
      } catch (err) {
        sqlite.exec("ROLLBACK");
        throw err;
      }
    },
  } as unknown as D1Database;
}

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations").sort()) sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
  return { sqlite, db: d1(sqlite) };
}

const row = (sqlite: DatabaseSync, sql: string, ...args: unknown[]) =>
  (sqlite.prepare(sql).get(...(args as never[])) as Record<string, unknown> | undefined) ?? null;

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

// ---------- Return URLs ----------

eq("the installed app's return URL is allowed", appReturnUrl("ovoa://google-signin"), "ovoa://google-signin");
eq("so is Expo Go's on a home network", appReturnUrl("exp://192.168.1.5:8081/--/google-signin"), "exp://192.168.1.5:8081/--/google-signin");
eq("and on the other private ranges", [
  appReturnUrl("exp://10.0.0.7:8081/--/google-signin"),
  appReturnUrl("exp://172.20.10.2:8081/--/google-signin"),
  appReturnUrl("exp://127.0.0.1:8081/--/google-signin"),
  appReturnUrl("exps://localhost:8081/--/google-signin"),
].every(Boolean), true);
eq("another path in the app isn't", appReturnUrl("ovoa://anything-else"), null);
eq("nor the right one with more on it", [appReturnUrl("ovoa://google-signin?x=1"), appReturnUrl("ovoa://google-signin/x")], [null, null]);
eq("nor Expo Go at someone's own host", appReturnUrl("exp://attacker.example/--/x"), null);
eq("nor a host that only starts like a private one", [
  appReturnUrl("exp://10.attacker.example/--/x"),
  appReturnUrl("exp://localhost.attacker.example/--/x"),
  appReturnUrl("exp://192.168.evil.com/--/x"),
  appReturnUrl("exp://127.evil.com/--/x"),
], [null, null, null, null]);
eq("nor a private address in front of an @", appReturnUrl("exp://192.168.1.5@attacker.example/--/x"), null);
eq("nor 172.32, outside 172.16/12", appReturnUrl("exp://172.32.0.1:8081/--/x"), null);
eq("nor an Expo tunnel", appReturnUrl("exp://abc-anonymous-8081.exp.direct/--/google-signin"), null);
eq("with Expo Go off, only the installed app's", [
  appReturnUrl("exp://192.168.1.5:8081/--/google-signin", { expoGo: false }),
  appReturnUrl("ovoa://google-signin", { expoGo: false }),
], [null, "ovoa://google-signin"]);
eq("a web page isn't", appReturnUrl("https://evil.example/steal"), null);
eq("nor javascript", appReturnUrl("javascript:alert(1)"), null);
eq("nor another app's scheme", appReturnUrl("evil://x"), null);
eq("nor something that isn't text", appReturnUrl(42), null);
eq("nor a very long one", appReturnUrl(`exp://192.168.1.5:8081/--/${"x".repeat(600)}`), null);

// ---------- Google: the start ----------

const T0 = 1_000_000_000_000;
const googleEnv = (db: D1Database) => ({
  DB: db,
  GOOGLE_CLIENT_ID: "app-client",
  GOOGLE_CLIENT_SECRET: "shh",
  GOOGLE_SIGNIN_CLIENT_IDS: undefined,
  PUBLIC_URL: "https://api.test",
});

{
  const { sqlite, db } = freshDb();
  const { url, key } = await startGoogleSignin(googleEnv(db), "ovoa://google-signin", T0);
  const u = new URL(url);
  const q = Object.fromEntries(u.searchParams);
  eq("it's Google's sign-in page", `${u.origin}${u.pathname}`, "https://accounts.google.com/o/oauth2/v2/auth");
  eq("for the app's client", q.client_id, "app-client");
  eq("back through the registered callback", q.redirect_uri, "https://api.test/google/callback");
  eq("asking only who they are", q.scope, "openid email profile");
  eq("for a code", q.response_type, "code");
  eq("no offline access asked for", "access_type" in q || "include_granted_scopes" in q, false);
  eq("with PKCE, S256", q.code_challenge_method, "S256");
  const state = row(sqlite, "SELECT * FROM signin_states WHERE state = ?", q.state);
  eq("the state is kept", state?.provider, "google");
  eq("with where to go back to", state?.return_url, "ovoa://google-signin");
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(state?.code_verifier)))));
  eq("the challenge is the kept verifier's", q.code_challenge, challenge);
  eq("for ten minutes", state?.expires_at, T0 + SIGNIN_STATE_TTL_MS);
  eq("the key is 64 hex characters", /^[0-9a-f]{64}$/.test(key), true);
  eq("and only its hash is kept", state?.key_hash, await sha256(key));
  eq("the key isn't in the URL", url.includes(key), false);

  eq("a sign-in state is taken once", (await takeGoogleSigninState(db, q.state!))?.returnUrl, "ovoa://google-signin");
  eq("and then it's gone", await takeGoogleSigninState(db, q.state!), null);
  eq("an Apple nonce's state is no Google state", await takeGoogleSigninState(db, await sha256(await issueAppleNonce(db, T0))), null);
  eq("nor is a missing table a throw", await takeGoogleSigninState(d1(new DatabaseSync(":memory:")), "x"), null);
}

// ---------- Google: the callback ----------

type Call = { url: string; body: string };
/** Google's token endpoint and tokeninfo, answering with these claims. */
function fakeGoogle(claims: Record<string, unknown> | null, calls: Call[] = [], tokenStatus = 200) {
  return async (url: string, init?: RequestInit) => {
    calls.push({ url, body: String(init?.body ?? "") });
    if (url === "https://oauth2.googleapis.com/token") {
      return Response.json(tokenStatus === 200 ? { id_token: "id.token.x", access_token: "a" } : { error: "invalid_grant" }, {
        status: tokenStatus,
      });
    }
    if (url.startsWith("https://oauth2.googleapis.com/tokeninfo")) {
      return claims ? Response.json(claims) : new Response("{}", { status: 400 });
    }
    return new Response("unexpected", { status: 500 });
  };
}
const googleClaims = (over: Record<string, unknown> = {}) => ({
  aud: "app-client",
  iss: "https://accounts.google.com",
  exp: String(T0 / 1000 + 600),
  email: "Ada@Example.com",
  email_verified: "true",
  name: "Ada Lovelace",
  ...over,
});

{
  const { sqlite, db } = freshDb();
  const env = googleEnv(db);
  const begin = async () => {
    const { url, key } = await startGoogleSignin(env, "ovoa://google-signin", T0);
    const state = new URL(url).searchParams.get("state")!;
    return { key, signin: (await takeGoogleSigninState(db, state))! };
  };

  const calls: Call[] = [];
  const { key, signin } = await begin();
  const res = await finishGoogleSignin(env, signin, { code: "google-code" }, fakeGoogle(googleClaims(), calls), T0 + 1000);
  const location = res.headers.get("location") ?? "";
  eq("it sends the browser back to the app", res.status, 302);
  eq("with a one-time code", /^ovoa:\/\/google-signin\?code=[0-9a-f]{48}$/.test(location), true);
  eq("and no session in the URL", /token|ticket/i.test(location), false);
  const exchange = new URLSearchParams(calls[0]?.body);
  eq("Google's code is swapped with the secret", exchange.get("client_secret"), "shh");
  eq("and the PKCE verifier", exchange.get("code_verifier"), signin.codeVerifier);
  eq("and the same redirect", exchange.get("redirect_uri"), "https://api.test/google/callback");
  eq("then the ID token is checked with Google", calls[1]?.url.startsWith("https://oauth2.googleapis.com/tokeninfo?id_token="), true);
  const code = new URL(location).searchParams.get("code")!;
  const kept = row(sqlite, "SELECT * FROM signin_codes");
  eq("only the code's hash is kept", kept?.code_hash, await sha256(code));
  eq("with who it was, from the token", [kept?.email, kept?.name], ["ada@example.com", "Ada Lovelace"]);
  eq("for sixty seconds", kept?.expires_at, T0 + 1000 + SIGNIN_CODE_TTL_MS);

  eq("the wrong key gets nothing", await redeemSigninCode(db, code, "0".repeat(64), T0 + 2000), null);
  eq("and the code is gone after it", await redeemSigninCode(db, code, key, T0 + 2000), null);

  const again = await begin();
  const res2 = await finishGoogleSignin(env, again.signin, { code: "c" }, fakeGoogle(googleClaims()), T0);
  const code2 = new URL(res2.headers.get("location")!).searchParams.get("code")!;
  eq("the right key gets who it was", await redeemSigninCode(db, code2, again.key, T0 + 59_000), {
    email: "ada@example.com",
    name: "Ada Lovelace",
  });
  eq("once", await redeemSigninCode(db, code2, again.key, T0 + 59_500), null);

  const late = await begin();
  const res3 = await finishGoogleSignin(env, late.signin, { code: "c" }, fakeGoogle(googleClaims()), T0);
  const code3 = new URL(res3.headers.get("location")!).searchParams.get("code")!;
  eq("after sixty seconds it has run out", await redeemSigninCode(db, code3, late.key, T0 + SIGNIN_CODE_TTL_MS), null);
  eq("junk is nothing", await redeemSigninCode(db, "'; DROP TABLE users; --", late.key, T0), null);

  const back = async (query: { code?: string; error?: string }, google = fakeGoogle(googleClaims()), at = T0) => {
    const { signin } = await begin();
    return (await finishGoogleSignin(env, signin, query, google, at)).headers.get("location");
  };
  eq("Cancel on Google's page goes back as cancelled", await back({ error: "access_denied" }), "ovoa://google-signin?error=cancelled");
  eq("another Google error as google", await back({ error: "server_error" }), "ovoa://google-signin?error=google");
  eq("no code at all as google", await back({}), "ovoa://google-signin?error=google");
  eq("a refused swap as google", await back({ code: "c" }, fakeGoogle(googleClaims(), [], 400)), "ovoa://google-signin?error=google");
  eq(
    "an address Google hasn't verified proves nothing",
    await back({ code: "c" }, fakeGoogle(googleClaims({ email_verified: "false" }))),
    "ovoa://google-signin?error=unconfirmed",
  );
  eq(
    "nor does a token for another client",
    await back({ code: "c" }, fakeGoogle(googleClaims({ aud: "someone-else" }))),
    "ovoa://google-signin?error=unconfirmed",
  );
  eq(
    "a state past its ten minutes goes back as expired",
    await back({ code: "c" }, fakeGoogle(googleClaims()), T0 + SIGNIN_STATE_TTL_MS + 1),
    "ovoa://google-signin?error=expired",
  );

  const { url } = await startGoogleSignin(env, "exp://192.168.1.5:8081/--/google-signin", T0);
  const expo = (await takeGoogleSigninState(db, new URL(url).searchParams.get("state")!))!;
  const res4 = await finishGoogleSignin(env, expo, { code: "c" }, fakeGoogle(googleClaims()), T0);
  eq(
    "Expo Go's return URL keeps its path",
    /^exp:\/\/192\.168\.1\.5:8081\/--\/google-signin\?code=[0-9a-f]{48}$/.test(res4.headers.get("location") ?? ""),
    true,
  );

  // The nightly tidy-up.
  await issueSigninCode(db, "k", { email: "x@example.com", name: null }, T0);
  await db.batch(pruneSignin(db, T0 + SIGNIN_STATE_TTL_MS + 1));
  eq(
    "the tidy-up drops states and codes that have run out",
    [row(sqlite, "SELECT count(*) n FROM signin_states")?.n, row(sqlite, "SELECT count(*) n FROM signin_codes")?.n],
    [0, 0],
  );
}

// ---------- Apple: the token ----------

const appleKeyPair = (await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;
const otherKeyPair = (await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;
const appleJwk = { ...(await crypto.subtle.exportKey("jwk", appleKeyPair.publicKey)), kid: "test-kid", alg: "RS256", use: "sig" };

let appleKeyFetches = 0;
async function fakeApple(url: string) {
  if (url !== APPLE_KEYS_URL) return new Response("unexpected", { status: 500 });
  appleKeyFetches++;
  return Response.json({ keys: [appleJwk] });
}

const nowSec = () => Math.floor(T0 / 1000);
const appleClaims = (over: Record<string, unknown> = {}) => ({
  iss: APPLE_ISSUER,
  aud: APPLE_AUDIENCE,
  exp: nowSec() + 600,
  iat: nowSec(),
  sub: "001234.abcdef.0123",
  email: "Grace@Example.com",
  email_verified: "true",
  is_private_email: "false",
  nonce: "n",
  ...over,
});

async function appleToken(claims: Record<string, unknown>, { kid = "test-kid", alg = "RS256", key = appleKeyPair.privateKey } = {}) {
  const enc = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)));
  const signed = `${enc({ alg, kid })}.${enc(claims)}`;
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signed)));
  return `${signed}.${b64url(sig)}`;
}

{
  eq("a good token's claims are who it says", appleIdentityFrom(appleClaims(), T0), {
    sub: "001234.abcdef.0123",
    email: "grace@example.com",
    nonce: "n",
  });
  eq("a boolean email_verified counts too", appleIdentityFrom(appleClaims({ email_verified: true }), T0) !== null, true);
  eq("a Hide My Email address is fine", appleIdentityFrom(appleClaims({ email: "x1y2@privaterelay.appleid.com" }), T0)?.email, "x1y2@privaterelay.appleid.com");
  eq("another issuer's isn't", appleIdentityFrom(appleClaims({ iss: "https://evil.example" }), T0), null);
  eq("nor one for another app", appleIdentityFrom(appleClaims({ aud: "com.someone.else" }), T0), null);
  eq("nor an expired one", appleIdentityFrom(appleClaims({ exp: nowSec() - 1 }), T0), null);
  eq("nor one issued an hour from now", appleIdentityFrom(appleClaims({ iat: nowSec() + 3600 }), T0), null);
  eq("nor an unverified address", appleIdentityFrom(appleClaims({ email_verified: "false" }), T0), null);
  eq("nor no address", appleIdentityFrom(appleClaims({ email: undefined }), T0), null);
  eq("nor no sub", appleIdentityFrom(appleClaims({ sub: "" }), T0), null);

  forgetAppleKeys();
  appleKeyFetches = 0;
  eq("a token signed with Apple's key passes", (await verifyAppleIdentityToken(await appleToken(appleClaims()), fakeApple, T0))?.sub, "001234.abcdef.0123");
  await verifyAppleIdentityToken(await appleToken(appleClaims()), fakeApple, T0 + 1000);
  eq("Apple's keys are fetched once and kept", appleKeyFetches, 1);
  eq(
    "a token signed with another key under the same id fails",
    await verifyAppleIdentityToken(await appleToken(appleClaims(), { key: otherKeyPair.privateKey }), fakeApple, T0),
    null,
  );
  const good = await appleToken(appleClaims());
  const [h, , s] = good.split(".");
  const forged = `${h}.${b64url(new TextEncoder().encode(JSON.stringify(appleClaims({ email: "mallory@example.com" }))))}.${s}`;
  eq("changed claims under a real signature fail", await verifyAppleIdentityToken(forged, fakeApple, T0), null);
  eq("alg none fails", await verifyAppleIdentityToken(await appleToken(appleClaims(), { alg: "none" }), fakeApple, T0), null);
  eq("an unverified address fails after the signature too", await verifyAppleIdentityToken(await appleToken(appleClaims({ email_verified: false })), fakeApple, T0), null);
  eq("junk fails without a throw", await verifyAppleIdentityToken("not.a.jwt", fakeApple, T0), null);
  eq("an unknown key id fetches again", await verifyAppleIdentityToken(await appleToken(appleClaims(), { kid: "new-kid" }), fakeApple, T0 + 61_000), null);
  eq("once", appleKeyFetches, 2);
  await verifyAppleIdentityToken(await appleToken(appleClaims(), { kid: "newer-kid" }), fakeApple, T0 + 62_000);
  eq("and not again within the minute, however many arrive", appleKeyFetches, 2);
  forgetAppleKeys();
  eq(
    "Apple being unreachable is a no, not a throw",
    await verifyAppleIdentityToken(good, async () => {
      throw new Error("offline");
    }, T0),
    null,
  );

  eq("Apple's name is one line", appleName({ givenName: " Grace ", familyName: "Hopper" }), "Grace Hopper");
  eq("a given name alone is fine", appleName({ givenName: "Grace", familyName: null }), "Grace");
  eq("no name is null", appleName(null), null);

  const { db } = freshDb();
  const nonce = await issueAppleNonce(db, T0);
  eq("a nonce is 48 hex characters", /^[0-9a-f]{48}$/.test(nonce), true);
  eq("it works once", await spendAppleNonce(db, nonce, T0 + 1), true);
  eq("and only once", await spendAppleNonce(db, nonce, T0 + 2), false);
  const old = await issueAppleNonce(db, T0);
  eq("ten minutes later it has run out", await spendAppleNonce(db, old, T0 + SIGNIN_STATE_TTL_MS + 1), false);
  eq("one this server never issued doesn't work", await spendAppleNonce(db, "a".repeat(48), T0), false);
}

// ---------- Through the routes ----------

// Workers' own addition to crypto.subtle, which Node hasn't got (auth.ts verifyPassword).
const subtle = crypto.subtle as unknown as { timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean };
subtle.timingSafeEqual ??= (a, b) => timingSafeEqual(a, b);

{
  const { sqlite, db } = freshDb();
  const env = {
    DB: db,
    GOOGLE_CLIENT_ID: "app-client",
    GOOGLE_CLIENT_SECRET: "shh",
    PUBLIC_URL: "https://api.test",
    TOKEN_ENC_KEY: Buffer.alloc(32).toString("base64"),
    CHAT_MODEL: "test",
    MEMORY_MODEL: "test",
    FALLBACK_MODEL: "test",
    DEEPSEEK_MODEL: "test",
  } as unknown as Env;
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await worker.fetch!(
      new Request(`https://api.test${path}`, {
        method,
        headers: { "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
      }) as unknown as Request<unknown, IncomingRequestCfProperties>,
      env,
      ctx,
    );
    return { status: res.status, location: res.headers.get("location"), body: (await res.json().catch(() => null)) as Record<string, any> };
  };
  const realFetch = globalThis.fetch;
  let google = googleClaims({ exp: String(Math.floor(Date.now() / 1000) + 600) });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === APPLE_KEYS_URL) return fakeApple(url);
    if (url.startsWith("https://oauth2.googleapis.com/")) return fakeGoogle(google)(url, init);
    return new Response("offline in tests", { status: 503 });
  }) as typeof fetch;

  try {
    // Google, a new person.
    eq("a web page can't be the return URL", (await call("POST", "/auth/google/start", { returnUrl: "https://evil.example" })).status, 400);
    eq("nor someone's Expo project", (await call("POST", "/auth/google/start", { returnUrl: "exp://attacker.example/--/x" })).status, 400);
    eq("nor another path in the app", (await call("POST", "/auth/google/start", { returnUrl: "ovoa://anything-else" })).status, 400);
    const expoGo = { returnUrl: "exp://192.168.1.5:8081/--/google-signin" };
    eq("Expo Go on a home network starts", (await call("POST", "/auth/google/start", expoGo)).status, 200);
    (env as { EXPO_GO_SIGNIN?: string }).EXPO_GO_SIGNIN = "off";
    eq("unless EXPO_GO_SIGNIN is off", (await call("POST", "/auth/google/start", expoGo)).status, 400);
    delete (env as { EXPO_GO_SIGNIN?: string }).EXPO_GO_SIGNIN;
    const start = await call("POST", "/auth/google/start", { returnUrl: "ovoa://google-signin" });
    eq("start gives a Google URL and a key", [start.status, String(start.body?.url).startsWith("https://accounts.google.com/"), typeof start.body?.key], [200, true, "string"]);
    const state = new URL(start.body.url).searchParams.get("state")!;
    const cb = await call("GET", `/google/callback?state=${state}&code=abc`);
    eq("the callback sends the app a code", [cb.status, /^ovoa:\/\/google-signin\?code=[0-9a-f]{48}$/.test(cb.location ?? "")], [302, true]);
    const code = new URL(cb.location!).searchParams.get("code")!;
    eq("redeeming without the key gets nothing", (await call("POST", "/auth/google/redeem", { code })).status, 400);
    // That spent nothing: a malformed request never reaches the code.
    const redeemed = await call("POST", "/auth/google/redeem", { code, key: start.body.key });
    eq("a new address gets a ticket, Google's name, and no session", [redeemed.body?.email, redeemed.body?.name, !!redeemed.body?.ticket, "token" in (redeemed.body ?? {})], ["ada@example.com", "Ada Lovelace", true, false]);
    eq("the code works once", (await call("POST", "/auth/google/redeem", { code, key: start.body.key })).body?.expired, true);

    const made = await call("POST", "/auth/email/signup", { ticket: redeemed.body.ticket, name: "Ada L", password: "password123", session: "app" });
    eq("the name + password step makes the account", [made.status, made.body?.user?.email, made.body?.user?.name], [201, "ada@example.com", "Ada L"]);
    const ada = row(sqlite, "SELECT id, email_verified_at FROM users WHERE email = 'ada@example.com'");
    eq("proven by Google, so verified", typeof ada?.email_verified_at, "number");
    eq("with an app session", row(sqlite, "SELECT kind FROM sessions WHERE token_hash = ?", await sha256(made.body.token))?.kind, "app");
    eq("which works", (await call("GET", "/me", undefined, { authorization: `Bearer ${made.body.token}` })).body?.user?.email, "ada@example.com");

    // A Google sign-in as far as the app's redeem, for whoever `google` says.
    const viaGoogle = async (email: string, name: string | null) => {
      google = googleClaims({ email, name, exp: String(Math.floor(Date.now() / 1000) + 600) });
      const s = await call("POST", "/auth/google/start", { returnUrl: "ovoa://google-signin" });
      const cb = await call("GET", `/google/callback?state=${new URL(s.body.url).searchParams.get("state")}&code=abc`);
      return call("POST", "/auth/google/redeem", { code: new URL(cb.location!).searchParams.get("code"), key: s.body.key });
    };
    const me = async (token: string) => (await call("GET", "/me", undefined, { authorization: `Bearer ${token}` })).status;
    const login = async (email: string, password: string) => (await call("POST", "/auth/login", { email, password })).status;
    const sessionsOf = (email: string) =>
      row(sqlite, "SELECT count(*) n FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = ?)", email)?.n;

    // Google, an address someone else registered first with a password, never proven.
    const pw = await call("POST", "/auth/signup", { email: "bob@example.com", password: "password123", name: "Mallory" });
    eq("it was made with a password first", pw.status, 201);
    eq("an unverified account to start with", row(sqlite, "SELECT email_verified_at v FROM users WHERE email = 'bob@example.com'")?.v, null);
    eq("whose token works", await me(pw.body.token), 200);
    const bobId = String(row(sqlite, "SELECT id FROM users WHERE email = 'bob@example.com'")?.id);
    sqlite
      .prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at, kind) VALUES (?, ?, ?, ?, 'siri')")
      .run(await sha256("siri-key"), bobId, Date.now(), Date.now() + 86_400_000);
    sqlite
      .prepare("INSERT INTO push_tokens (token, user_id, platform, created_at) VALUES (?, ?, 'ios', ?)")
      .run("ExponentPushToken[mallory]", bobId, Date.now());
    const r2 = await viaGoogle("bob@example.com", "Robert");
    eq("the owner's proof isn't signed in to someone else's account", "token" in (r2.body ?? {}), false);
    eq("it gets a ticket to set a new password", [!!r2.body?.ticket, r2.body?.existing, r2.body?.email], [true, true, "bob@example.com"]);
    eq("the registrant's password stops working at the proof", await login("bob@example.com", "password123"), 401);
    eq("and their session with it", await me(pw.body.token), 401);
    eq("every session goes, the Siri key too", sessionsOf("bob@example.com"), 0);
    eq("and their phone stops getting its notifications", row(sqlite, "SELECT count(*) n FROM push_tokens WHERE user_id = ?", bobId)?.n, 0);
    eq("it isn't verified until the owner picks a password", row(sqlite, "SELECT email_verified_at v FROM users WHERE id = ?", bobId)?.v, null);
    const bob = await call("POST", "/auth/email/signup", { ticket: r2.body.ticket, name: "Robert", password: "newpassword1", session: "app" });
    eq("the step signs the owner in to it", [bob.status, bob.body?.user?.id, bob.body?.user?.name, bob.body?.passwordChanged], [200, bobId, "Robert", true]);
    eq("now verified", typeof row(sqlite, "SELECT email_verified_at v FROM users WHERE id = ?", bobId)?.v, "number");
    eq("with the owner's password", await login("bob@example.com", "newpassword1"), 200);
    eq("and not the registrant's", await login("bob@example.com", "password123"), 401);
    eq("with an app session", row(sqlite, "SELECT kind FROM sessions WHERE token_hash = ?", await sha256(bob.body.token))?.kind, "app");

    // Google, an account whose address was proven before: signed straight in, password kept.
    const r3 = await viaGoogle("bob@example.com", "Robert");
    eq("a verified account is signed straight in", [r3.body?.user?.id, "ticket" in (r3.body ?? {})], [bobId, false]);
    eq("with an app session", row(sqlite, "SELECT kind FROM sessions WHERE token_hash = ?", await sha256(r3.body.token))?.kind, "app");
    eq("and its password is left alone", await login("bob@example.com", "newpassword1"), 200);

    // Registered by someone else after the owner's proof, before the owner's step.
    const late = await viaGoogle("dan@example.com", "Dan");
    const squat = await call("POST", "/auth/signup", { email: "dan@example.com", password: "password123", name: "Mallory" });
    eq("an address can still be registered meanwhile", squat.status, 201);
    const dan = await call("POST", "/auth/email/signup", { ticket: late.body.ticket, name: "Dan", password: "danspassword", session: "app" });
    eq("the ticket takes it over", [dan.status, dan.body?.user?.name, dan.body?.passwordChanged], [200, "Dan", true]);
    eq("the registrant is signed out", await me(squat.body.token), 401);
    eq("and their password is gone", [await login("dan@example.com", "password123"), await login("dan@example.com", "danspassword")], [401, 200]);

    // Two tickets for one new address: the second finds a proven account and keeps its password.
    const t1 = await viaGoogle("eve@example.com", null);
    const t2 = await viaGoogle("eve@example.com", null);
    eq("a new address twice is two tickets", [!!t1.body?.ticket, !!t2.body?.ticket, "existing" in (t2.body ?? {})], [true, true, false]);
    const eve = await call("POST", "/auth/email/signup", { ticket: t1.body.ticket, name: "Eve", password: "firstpassword", session: "app" });
    eq("the first makes the account", [eve.status, "passwordChanged" in (eve.body ?? {})], [201, false]);
    const second = await call("POST", "/auth/email/signup", { ticket: t2.body.ticket, name: "Eve", password: "otherpassword", session: "app" });
    eq("the second signs in to it and says the password didn't change", [second.status, second.body?.passwordChanged], [200, false]);
    eq("so the first password is still the one", [await login("eve@example.com", "firstpassword"), await login("eve@example.com", "otherpassword")], [200, 401]);

    // An account from before sign-ups had to prove their address: a proof only stamps it.
    const old = await call("POST", "/auth/signup", { email: "olga@example.com", password: "password123", name: "Olga" });
    const olgaId = String(row(sqlite, "SELECT id FROM users WHERE email = 'olga@example.com'")?.id);
    eq("a sign-up where no code can go isn't held, but isn't from before", row(sqlite, "SELECT must_verify m FROM users WHERE id = ?", olgaId)?.m, 2);
    sqlite.prepare("UPDATE users SET must_verify = 0 WHERE id = ?").run(olgaId);
    sqlite
      .prepare("INSERT INTO google_accounts (id, user_id, email, is_default, scopes, refresh_token_enc, connected_at) VALUES (?, ?, ?, 1, '', 'x', ?)")
      .run("g-olga", olgaId, "olga@gmail.com", Date.now());
    const rOlga = await viaGoogle("olga@example.com", "Olga");
    eq("an account from before is signed straight in, not taken back", [rOlga.body?.user?.id, "ticket" in (rOlga.body ?? {})], [olgaId, false]);
    eq("and is proven now", typeof row(sqlite, "SELECT email_verified_at v FROM users WHERE id = ?", olgaId)?.v, "number");
    eq("its phone stays signed in", await me(old.body.token), 200);
    eq("its password still works", await login("olga@example.com", "password123"), 200);
    eq("and its Google account stays", row(sqlite, "SELECT count(*) n FROM google_accounts WHERE user_id = ?", olgaId)?.n, 1);

    // A Google connect the registrant had open can't finish into the account once it's taken back.
    const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
    const connectState = async (token: string) =>
      new URL((await call("POST", "/google/connect", { returnUrl: "ovoa://google-callback" }, bearer(token))).body.url).searchParams.get("state")!;
    const googlesOf = (id: string) => row(sqlite, "SELECT count(*) n FROM google_accounts WHERE user_id = ?", id)?.n;
    const sq = await call("POST", "/auth/signup", { email: "gus@example.com", password: "password123", name: "Mallory" });
    const gusId = String(row(sqlite, "SELECT id FROM users WHERE email = 'gus@example.com'")?.id);
    const early = await connectState(sq.body.token);
    const rGus = await viaGoogle("gus@example.com", "Gus");
    eq("the owner's proof takes it back", rGus.body?.existing, true);
    eq("and the registrant's connect in progress with it", row(sqlite, "SELECT count(*) n FROM oauth_states WHERE user_id = ?", gusId)?.n, 0);
    const lateCb = await call("GET", `/google/callback?state=${early}&code=abc`);
    eq("so finishing Google's page afterwards connects nothing", [lateCb.location, googlesOf(gusId)], [null, 0]);
    // One started from a session another isolate still trusted for its last minute.
    sqlite
      .prepare("INSERT INTO oauth_states (state, user_id, code_verifier, return_url, expires_at, session_hash) VALUES (?, ?, 'v', ?, ?, ?)")
      .run("cached-state", gusId, "ovoa://google-callback", Date.now() + 60_000, await sha256(sq.body.token));
    const cachedCb = await call("GET", "/google/callback?state=cached-state&code=abc");
    eq(
      "nor one from a signed-out session",
      [cachedCb.location, googlesOf(gusId)],
      ["ovoa://google-callback?google=error&message=You+were+signed+out.+Sign+in+and+connect+again.", 0],
    );
    const gus = await call("POST", "/auth/email/signup", { ticket: rGus.body.ticket, name: "Gus", password: "guspassword1", session: "app" });
    const stub = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === "https://oauth2.googleapis.com/token") {
        return Response.json({ access_token: "a", refresh_token: "r", expires_in: 3600, scope: "openid" });
      }
      if (url.startsWith("https://openidconnect.googleapis.com/")) return Response.json({ email: "gus@gmail.com", name: "Gus" });
      return stub(input, init);
    }) as typeof fetch;
    try {
      const okCb = await call("GET", `/google/callback?state=${await connectState(gus.body.token)}&code=abc`);
      eq("the owner's own connect still works", [okCb.location, googlesOf(gusId)], ["ovoa://google-callback?google=connected", 1]);
    } finally {
      globalThis.fetch = stub;
    }

    // Cancelling on Google's page.
    const s3 =await call("POST", "/auth/google/start", { returnUrl: "ovoa://google-signin" });
    const cb3 = await call("GET", `/google/callback?state=${new URL(s3.body.url).searchParams.get("state")}&error=access_denied`);
    eq("cancelling goes back to the app quietly", cb3.location, "ovoa://google-signin?error=cancelled");

    // The connect flow still owns its own states.
    sqlite
      .prepare("INSERT INTO oauth_states (state, user_id, code_verifier, return_url, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run("connect-state", String(ada?.id), "v", "ovoa://google-callback", Date.now() + 60_000);
    const connect = await call("GET", "/google/callback?state=connect-state&error=access_denied");
    eq("a connect state still runs the connect flow", connect.location, "ovoa://google-callback?google=error&message=You+cancelled");

    // The site's ticket signup is unchanged: a web session.
    google = googleClaims({ email: "carol@example.com", name: null, exp: String(Math.floor(Date.now() / 1000) + 600) });
    const s4 = await call("POST", "/auth/google/start", { returnUrl: "ovoa://google-signin" });
    const cb4 = await call("GET", `/google/callback?state=${new URL(s4.body.url).searchParams.get("state")}&code=abc`);
    const r4 = await call("POST", "/auth/google/redeem", { code: new URL(cb4.location!).searchParams.get("code"), key: s4.body.key });
    const web = await call("POST", "/auth/email/signup", { ticket: r4.body.ticket, name: "Carol", password: "password123" });
    eq("without session: app the ticket makes a web session, as before", row(sqlite, "SELECT kind FROM sessions WHERE token_hash = ?", await sha256(web.body.token))?.kind, "web");

    // Apple, a new person.
    forgetAppleKeys();
    const now = () => Math.floor(Date.now() / 1000);
    const live = (over: Record<string, unknown>) => appleClaims({ exp: now() + 600, iat: now(), ...over });
    const n1 = (await call("POST", "/auth/apple/start")).body?.nonce as string;
    eq("Apple's start gives a nonce", /^[0-9a-f]{48}$/.test(n1), true);
    const token1 = await appleToken(live({ nonce: n1 }));
    eq("a token without the nonce it carries is refused", (await call("POST", "/auth/apple", { identityToken: token1, nonce: "b".repeat(48) })).status, 401);
    const a1 = await call("POST", "/auth/apple", { identityToken: token1, nonce: n1, fullName: { givenName: "Grace", familyName: "Hopper" } });
    eq("a new Apple ID gets an account straight away, no step", [a1.status, a1.body?.created, a1.body?.user?.email, "ticket" in (a1.body ?? {})], [201, true, "grace@example.com", false]);
    eq("named as Apple said", a1.body?.user?.name, "Grace Hopper");
    eq("the nonce works once", (await call("POST", "/auth/apple", { identityToken: token1, nonce: n1 })).status, 401);
    const g = row(sqlite, "SELECT apple_sub, email_verified_at FROM users WHERE email = 'grace@example.com'");
    eq("it keeps the Apple ID", g?.apple_sub, "001234.abcdef.0123");
    eq("and counts as verified", typeof g?.email_verified_at, "number");
    eq("with an app session", row(sqlite, "SELECT kind FROM sessions WHERE token_hash = ?", await sha256(a1.body.token))?.kind, "app");
    eq("which works", await me(a1.body.token), 200);
    eq("and no password matches it", [await login("grace@example.com", "password123"), await login("grace@example.com", "")], [401, 401]);

    // Apple, returning, after the address behind the Apple ID changed.
    const n2 = (await call("POST", "/auth/apple/start")).body.nonce as string;
    const a2 = await call("POST", "/auth/apple", { identityToken: await appleToken(live({ nonce: n2, email: "grace@new.example" })), nonce: n2 });
    eq("a returning Apple ID is found by its id, not its address", [a2.status, a2.body?.user?.email, "ticket" in (a2.body ?? {})], [200, "grace@example.com", false]);
    eq("signed in with an app session", row(sqlite, "SELECT kind FROM sessions WHERE token_hash = ?", await sha256(a2.body.token))?.kind, "app");

    // Apple, a new person who didn't share their name (or it isn't their first time).
    const apple = async (over: Record<string, unknown>, fullName?: unknown) => {
      const nonce = (await call("POST", "/auth/apple/start")).body.nonce as string;
      return call("POST", "/auth/apple", { identityToken: await appleToken(live({ nonce, ...over })), nonce, fullName });
    };
    const hidden = await apple({ sub: "001.hidden", email: "x1y2@privaterelay.appleid.com" });
    eq("no name is still an account, not a step", [hidden.status, !!hidden.body?.token, "ticket" in (hidden.body ?? {}), hidden.body?.user?.name], [201, true, false, ""]);
    const hiddenAgain = await apple({ sub: "001.hidden", email: "x1y2@privaterelay.appleid.com" });
    eq("and the next Apple sign-in finds it by its id", [hiddenAgain.status, hiddenAgain.body?.user?.id], [200, hidden.body?.user?.id]);

    // Apple, an address someone else registered first with a password, never proven.
    const pw2 = await call("POST", "/auth/signup", { email: "fay@example.com", password: "password123", name: "Mallory" });
    const a3 = await apple({ sub: "009999.fay", email: "fay@example.com" });
    eq("Apple signs the owner in to it, no step", [a3.status, a3.body?.created, a3.body?.user?.email], [200, false, "fay@example.com"]);
    eq("the registrant's password stops working", await login("fay@example.com", "password123"), 401);
    eq("and their session with it", await me(pw2.body.token), 401);
    const fay = row(sqlite, "SELECT apple_sub s, email_verified_at v FROM users WHERE email = 'fay@example.com'");
    eq("it's verified and remembers the Apple ID from now on", [fay?.s, typeof fay?.v], ["009999.fay", "number"]);
    eq("the owner's own session works", await me(a3.body.token), 200);

    // Apple, an account whose address was proven before: signed in, password kept.
    const a4 = await apple({ sub: "000777.bob", email: "bob@example.com" });
    eq("a verified account is signed straight in", [a4.status, a4.body?.user?.id, a4.body?.created], [200, bobId, false]);
    eq("keeping its password", await login("bob@example.com", "newpassword1"), 200);
    eq("and remembers the Apple ID", row(sqlite, "SELECT apple_sub s FROM users WHERE id = ?", bobId)?.s, "000777.bob");

    const n4 = (await call("POST", "/auth/apple/start")).body.nonce as string;
    eq(
      "an address Apple hasn't verified is refused",
      (await call("POST", "/auth/apple", { identityToken: await appleToken(live({ nonce: n4, sub: "new.sub", email_verified: "false" })), nonce: n4 })).status,
      401,
    );
    const n5 = (await call("POST", "/auth/apple/start")).body.nonce as string;
    eq(
      "a token for another app is refused",
      (await call("POST", "/auth/apple", { identityToken: await appleToken(live({ nonce: n5, aud: "host.exp.Exponent" })), nonce: n5 })).status,
      401,
    );
    eq("a bad token is refused", (await call("POST", "/auth/apple", { identityToken: "x".repeat(40), nonce: n5 })).status, 401);

    // With email codes on (verify.ts): an app sign-up is held until its code is typed.
    const codesEnv = env as { EMAIL_CODES_TO_LOG?: string; DEBUG_KEY?: string };
    codesEnv.EMAIL_CODES_TO_LOG = "1";
    codesEnv.DEBUG_KEY = "dk";
    const auth = (token: string) => ({ authorization: `Bearer ${token}` });
    const debugCode = async (email: string) =>
      (await call("POST", "/debug/email/code", { email }, { "x-debug-key": "dk" })).body?.code as string;
    const routinesFor = async (token: string) => (await call("GET", "/routines", undefined, auth(token))).status;

    // Proving the address of the account you're signed in to: a stamp, never a take-back.
    const hal = await call("POST", "/auth/signup", { email: "hal@example.com", password: "password123", name: "Hal" });
    eq("a new app sign-up must prove its address", [hal.status, hal.body?.user?.mustVerify, hal.body?.user?.emailVerified], [201, true, false]);
    eq("and is held until then", await routinesFor(hal.body.token), 403);
    const halProof = await call("POST", "/me/email/verify", { code: await debugCode("hal@example.com") }, auth(hal.body.token));
    eq("the code in the app proves it", [halProof.status, halProof.body?.emailVerified], [200, true]);
    eq("without signing anyone out", await me(hal.body.token), 200);
    eq("or taking the password", await login("hal@example.com", "password123"), 200);
    eq("and everything opens up", await routinesFor(hal.body.token), 200);

    // Proven by Google while still waiting for its code: taken back, Google connection and all.
    const ivy = await call("POST", "/auth/signup", { email: "ivy@example.com", password: "password123", name: "Mallory" });
    const ivyId = String(row(sqlite, "SELECT id FROM users WHERE email = 'ivy@example.com'")?.id);
    sqlite
      .prepare("INSERT INTO google_accounts (id, user_id, email, is_default, scopes, refresh_token_enc, connected_at) VALUES (?, ?, ?, 1, '', 'x', ?)")
      .run("g-ivy", ivyId, "mallory@gmail.com", Date.now());
    const rIvy = await viaGoogle("ivy@example.com", "Ivy");
    eq("Google takes back a sign-up still waiting for its code", [!!rIvy.body?.ticket, rIvy.body?.existing], [true, true]);
    eq("its sessions go", await me(ivy.body.token), 401);
    eq("and so does the Google account connected to it", row(sqlite, "SELECT count(*) n FROM google_accounts WHERE user_id = ?", ivyId)?.n, 0);
    const ivyStep = await call("POST", "/auth/email/signup", { ticket: rIvy.body.ticket, name: "Ivy", password: "ivyspassword", session: "app" });
    eq("the step makes it the owner's", [ivyStep.status, ivyStep.body?.user?.id, ivyStep.body?.passwordChanged], [200, ivyId, true]);
    eq("proven, so no longer held", [ivyStep.body?.user?.emailVerified, ivyStep.body?.user?.mustVerify], [true, false]);
    eq("everything opens up for the owner", await routinesFor(ivyStep.body.token), 200);

    // New accounts from Google and Apple are proven already, and start where an email sign-up does.
    const kim = await viaGoogle("kim@example.com", "Kim");
    const kimMade = await call("POST", "/auth/email/signup", { ticket: kim.body.ticket, name: "Kim", password: "password123", session: "app" });
    const fresh = (u: Record<string, any> | undefined) => [u?.emailVerified, u?.mustVerify, u?.aiConsent?.given, u?.onboarded];
    eq("a Google sign-up: proven, not held, no consent yet, setup to do", fresh(kimMade.body?.user), [true, false, false, false]);
    eq("and it isn't held", await routinesFor(kimMade.body.token), 200);
    const lee = await apple({ sub: "002.lee", email: "lee@example.com" });
    eq("an Apple sign-up: the same", fresh(lee.body?.user), [true, false, false, false]);
    delete codesEnv.EMAIL_CODES_TO_LOG;
    delete codesEnv.DEBUG_KEY;
  } finally {
    globalThis.fetch = realFetch;
  }
}

if (fails) {
  console.log(`\n${fails} check(s) failed`);
  process.exit(1);
}
