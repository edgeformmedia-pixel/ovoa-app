# Claude overnight build (branch `claude/overnight`)

Goal: OVOA does everything Instinct does, and more, without breaking anything that already works.
Owner is away; work happens on this branch only. A human reviews, merges and deploys.

## Rules (read every time)

1. Work ONLY on branch `claude/overnight`. Never commit to, merge into, or push `main`.
2. Never deploy (`wrangler deploy`), never run remote D1 migrations (`--remote`), never run anything in
   `jarvis/api/scripts/*probe*.mjs` or other scripts that call https://api.ovoa.ai (they hit production).
3. Start of every session: `git fetch origin`, then `git pull --rebase origin claude/overnight`.
   Note in the log below if `origin/main` has new commits. If main changed files you are about to touch,
   `git merge origin/main` into this branch first and re-run tests.
4. Before every commit, in `jarvis/api`: `npx tsc --noEmit` and `npm test` must pass (60+ test files, all
   passed at start). Never delete or weaken an existing test to make it pass.
5. Additive and feature-flagged: new tools, routes and tables must not change existing behavior when their
   secrets/bindings are missing. New D1 tables go in a new numbered migration file; never edit old ones.
6. Every new feature ships with tests in `jarvis/api/test/` (plain-script style, see `scripts/test.mjs`).
7. Follow the repo's conventions: read `contextforclaude.txt`, `HANDOFF.txt`, and the files you touch.
   No em dashes or en dashes in any user-facing text. OVOA sounds like a chill human.
8. Guardrails stay in code, not prompts: anything that sends, books, buys or posts in the user's name goes
   through `pending_actions` approval. Spend caps and rate limits apply. No bulk texting of strangers.
   Never store users' passwords, card numbers or SSNs.
9. One task per session is fine. Finish it fully (code, tests, docs line), commit with a clear message,
   `git push origin claude/overnight`, tick the box, add a log line. If blocked, write why and move on.
10. Reference implementations (a separate Node codebase, already tested) live in the user's local
    `instinct-clone` repo; the ideas are summarized in each task here. Port the idea, not the code style.

## Tasks (top to bottom)

- [ ] 1. **fetch_url tool**: read a full public web page / JSON / CSV by URL. http(s) only, refuse private,
      loopback, link-local and metadata addresses (check again after each redirect, max 3), 15 s timeout,
      3 MB cap, HTML to readable text keeping table cells tab-separated and link hrefs, `offset`/`maxChars`
      paging. Offered with web_search. Tests for the address guard and HTML-to-text.
- [ ] 2. **Saved lists**: `list_save` / `list_read` tools backed by a D1 table (user_id, name, rows JSON,
      unique per user+name, row cap ~5,000). Lets OVOA build a list across steps (e.g. every office and its
      number) and reuse it later.
- [ ] 3. **Vault**: encrypted personal details OVOA uses when booking or filling forms (addresses, loyalty and
      frequent-flyer numbers, sizes, seat preferences, car). AES-GCM with the existing `crypto.ts` /
      `TOKEN_ENC_KEY`. Tools `vault_lookup` / `vault_save`; refuse card numbers, bank/routing numbers, SSNs,
      passwords, one-time codes. Never write values to action_log/audit. Authed routes GET/POST/PATCH/DELETE
      `/vault` for the app. Friends never get vault items.
- [ ] 4. **Campaigns (one approval, many targets)**: `campaign_start` proposes a plan (mode email | research |
      text, title, instructions with `{field}` placeholders, items) as ONE pending action showing count and
      estimated cost. After approval the existing 2-minute cron works through a few items per tick inside
      the user's daytime hours. Hard caps in code: research 500, email 200/day, text 25 and only to Friends
      or people who texted OVOA first. Do-not-contact table (anyone replying STOP to OVOA's line is added).
      Results stored per item; one summary message when done; `campaign_status` / `campaign_stop` tools;
      GET `/campaigns`, `/campaigns/:id`, POST `/campaigns/:id/stop`, CSV export.
- [ ] 5. **Web agent (real browser)**: Cloudflare Browser Rendering (`browser` binding, `@cloudflare/puppeteer`).
      Tools: browser_open, browser_read (text + list of clickable elements with ids), browser_click,
      browser_type, browser_screenshot (for the model when it can take images). Session per turn, closed after.
      Anything that submits a form, buys, books or posts must first create a pending action describing it.
      Entirely absent when the binding is missing (so deploy is a no-op until the owner adds it). Document the
      wrangler.jsonc change needed in the handoff instead of adding the binding if it would break deploy.
- [ ] 6. **Approval rules**: let the user say "don't ask me before emailing my wife" or "book anything under $50"
      as saved rules (per recipient, per tool, per amount) checked before creating a pending action; rules are
      listed and removable; never apply to money over the user's budget limits or to Full-access danger items.
- [ ] 7. **Invite a friend**: check what exists. If missing: referral code per user, link, count of joins,
      text-an-invite through OVOA's iMessage line (max 10/day), attribution on sign-up.
- [ ] 8. **Group chats**: check Sendblue group support in texting. If missing: OVOA answers in an iMessage group
      only when mentioned by name, only if everyone else in the group is the sender's Friend, never shares private
      details there, approvals go to the person privately.
- [ ] 9. **Keywords**: confirm STOP/START/HELP and CARD (resend the contact card) on the texting line; add what's
      missing without changing existing replies.
- [ ] 10. **Logins without passwords** (design + first slice): per-user saved browser session (cookies) created by
      the user logging in themselves through a live-view link; OVOA never sees the password. Only if task 5 landed.
- [ ] 11. **App screens** (jarvis/app, Expo SDK 57, read its docs first): Vault, Campaigns, Approval rules. Only after
      the API parts exist; typecheck the app (`npx tsc --noEmit` in jarvis/app). Never trigger Codemagic.
- [ ] 12. **Final report**: update this file with what shipped, what needs the owner (bindings, secrets, deploy
      order, migrations to apply), and a short test plan for a phone.

## Log

- 2026-09-27 07:00 ET: branch created from origin/main 16c2deb; baseline tsc clean, 60 test files pass.
