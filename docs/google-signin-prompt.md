# Continue with Google in the app

Written 2026-09-23. The Google side is done. The app side isn't built yet.

## Where things are

| What | Where |
|---|---|
| Google Cloud project | **OVOA**, id `ovoa-509511`, owned by admin@ovoa.ai: https://console.cloud.google.com/auth/clients?project=ovoa-509511 |
| OAuth client (Web application, "OVOA") | `681579233268-eegju2n5qcpg6ja35np11vpl9fic51pf.apps.googleusercontent.com` |
| Client secret | `ovoa-team/google/.env` → `GOOGLE_CLIENT_SECRET` (gitignored, never commit it) |
| Server's Google config | `jarvis/api/wrangler.jsonc` var `GOOGLE_CLIENT_ID` (still the old `736336639952-…` client) and secret `GOOGLE_CLIENT_SECRET` |
| Connecting Gmail/Calendar/… (already works) | `jarvis/api/src/google/oauth.ts` (`/google/connect`, `/google/callback`, `GOOGLE_SCOPES`), app side `jarvis/app/src/lib/google.ts` |
| Checking Google ID tokens | `jarvis/api/src/emailauth.ts` (`verifyGoogleIdToken`, `googleAudiences`) |
| Google sign-in for ovoa.ai | `POST /auth/google` and `afterProven()` in `jarvis/api/src/index.ts` (around lines 508–660) |
| App sign-in screen | `jarvis/app/src/app/sign-in.tsx` (email + password today, no Google) |
| App identity | scheme `ovoa`, bundle id `com.ovoa.app`; `expo-web-browser` is installed |
| Server move | `docs/release-v1-prompt.md`: everything moves to `https://api.ovoa.ai` on the admin@ovoa.ai Cloudflare account |

## What Google has registered

- **Redirect URIs:** `https://api.ovoa.ai/google/callback`, `https://ovoa.ai/api/public/account/google-callback`,
  `https://ovoa-site.ovoa.workers.dev/api/public/account/google-callback`, and
  `https://api.ovoa.ai/auth/google/callback` for the sign-in flow in the prompt below.
- **Scopes declared:** `openid`, `userinfo.email`, `userinfo.profile`, `gmail.modify` (restricted), `calendar`,
  `documents`, `spreadsheets`, `tasks`, `contacts`, `drive.file`.
  - Note that it's **`drive.file`, not `drive`**. The code still asks for `drive`.
- **Status:** External, **In production**, not verified yet. Sign-in (name and email) works for everyone; Gmail,
  Calendar and the rest show Google's "unverified app" warning, capped at 100 users, until Google verifies the app.
- **Website:** ovoa.ai already has "Continue with Google" live, on the Worker `ovoa-site` (`ovoa-team`).
- **Old live server:** `jarvis-api.edgeformmedia.workers.dev` accepts sign-ins from the new client, through
  `GOOGLE_SIGNIN_CLIENT_IDS`.

## Prompt

> Add "Continue with Google" to the OVOA app's sign-in screen, so people can create an OVOA account or sign in
> with Google. Read `docs/google-signin-prompt.md` first. Build on top of the api.ovoa.ai move in
> `docs/release-v1-prompt.md`, where `GOOGLE_CLIENT_ID` becomes the new client `681579233268-eegju2n5…` and its
> secret comes from `ovoa-team/google/.env`.
>
> 1. **Server (`jarvis/api`):**
>    - `POST /auth/google/start {returnUrl}` returns a Google URL: scopes `openid email profile`, PKCE, and state
>      in D1. Only `ovoa://` and `exp://` return URLs are allowed, like `RETURN_URL` in `google/oauth.ts`.
>    - `GET /auth/google/callback` swaps the code using the client secret and checks the ID token with
>      `verifyGoogleIdToken`. It runs the same logic as `afterProven()`, but with an **app** session, not a web
>      one. It keeps the result behind a one-time code that lasts 60 seconds, then redirects to
>      `ovoa://google-signin?code=…`. Never put the session token in the URL.
>    - `POST /auth/google/redeem {code}` returns `{token, user}` for an existing account, or `{ticket, email, name}`
>      for a new one.
> 2. **App (`sign-in.tsx`):**
>    - Add a "Continue with Google" button. It opens the start URL with `WebBrowser.openAuthSessionAsync`, the same
>      way `lib/google.ts` does, then redeems the code.
>    - A token means the person is signed in. A ticket goes to the existing name + password step
>      (`/auth/email/signup`), with Google's name filled in. Make sure that step makes an app session.
> 3. **Apple:** App Store rule 4.8 means offering Google login also needs **Sign in with Apple**. Add it with
>    `expo-apple-authentication` and a server route that checks Apple's identity token, or App Review will reject
>    the build.
> 4. While you're in `google/oauth.ts`, change the `drive` scope to `drive.file`, which is what Google has on file.
>    Update the Drive tools to match (release plan, Phase "Google scopes").
> 5. Add tests next to `test/emailauth.test.ts`. Migrate before deploying (`npm run db:migrate`, then
>    `npm run deploy`, with `CLOUDFLARE_ACCOUNT_ID` pinned). Try it on a phone: a new Google account, an existing
>    email, and cancelling.
