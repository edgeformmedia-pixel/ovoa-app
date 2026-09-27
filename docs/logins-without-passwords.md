# Logins without passwords

How OVOA's browser (jarvis/api/src/browser.ts) can act inside sites that need someone signed in,
without OVOA ever asking for, seeing or keeping a password.

## The idea

The person signs into the site themselves, on their own phone, inside the OVOA app. The app then
lends OVOA that site's signed-in session (its cookies). OVOA's browser loads those cookies before it
opens a page on that site, so it acts as them, the same way their own browser would the next day.

- Passwords and 2FA codes are typed only by the person, into the real site. OVOA's server never gets them.
- Only the cookies for that one site are kept (other sites' cookies in the jar are dropped server side).
- Encrypted at rest with TOKEN_ENC_KEY (crypto.ts), like Google tokens.
- 30 days at most, then gone (retention.ts sweeps them). Re-signing refreshes it.
- Removable one site at a time from the app (Settings, Signed-in sites), and all of them go with the account.
- Money sites are refused outright, in code (sitesessions.ts refusedHost): banks, cards, payment apps,
  brokerages, crypto, government money sites. OVOA doesn't act inside those.
- Everything that commits (order, book, pay, send, post) is still an approval first (browser.ts).

## What's built (server, this branch)

- `site_sessions` table (migration 0067) and `sitesessions.ts`:
  - `POST /browser/sites` `{ host, cookies: [{ name, value, domain, path, expires, httpOnly, secure, sameSite }] }`
    stores them (201), refuses money sites (400), 503 without TOKEN_ENC_KEY.
  - `GET /browser/sites` lists `{ host, since, expiresAt, lastUsed }` (never cookie values).
  - `DELETE /browser/sites/:host` removes one.
- The browser loads a site's cookies before `browser_open` on it (and its subdomains), tells the model
  `signedIn`, and loads them again when an approved action is replayed.

## What the app needs (jarvis/app, not built yet)

A "Signed-in sites" screen under Settings:

1. "Add a site": the person types or picks a site (OpenTable, Amazon, Delta, ...).
2. Open it in an in-app browser (react-native-webview, already an Expo-compatible package) at the
   site's sign-in page. They sign in as usual, including any 2FA.
3. A "Done, let OVOA use this" button reads that site's cookies from the WebView's cookie store,
   including HttpOnly ones. On iOS that needs native cookie access:
   `@react-native-cookies/cookies` (`CookieManager.getAll(true)` reads WKWebView's store), which is a
   new native library, so it needs the owner's OK and a development build (not Expo Go).
4. POST them to `/browser/sites` with the site's host, then clear them from the WebView so the app
   itself doesn't stay signed in.
5. The list shows each site with "last used" and a Remove button (`DELETE /browser/sites/:host`).

What to tell people on that screen, in OVOA's voice: "Sign into a site here once and I can use it for
you, like booking a table or checking an order. I never see your password, anything I'd buy or book
still waits for your OK, and I never sign into banks or payment apps."

## Browser Rendering notes

- The adapter (jarvis/api/optional/browser-puppeteer.ts) implements `setCookies` with puppeteer's
  `page.setCookie(...)`, before the first `goto` on that site.
- Sessions are fresh each reply; cookies are loaded per session, not kept in Browser Rendering.
- Some sites tie a session to the device or IP and will ask to sign in again from Cloudflare's
  network. Then the page shows a sign-in form: OVOA says it couldn't get in and asks them to re-add
  the site. It never types a password.
