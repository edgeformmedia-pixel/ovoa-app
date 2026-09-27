# Claude overnight build (branch `claude/overnight`)

Goal: OVOA does everything Instinct does, and more, without breaking anything that already works.
The owner is away. Work happens on this branch only; a human reviews, merges and deploys.

## Rules (read every time)

1. Work ONLY on branch `claude/overnight`. Never commit to, merge into, or push `main`. Never rewrite pushed history.
2. Never deploy (`wrangler deploy`), never run D1 migrations with `--remote`, never run `jarvis/api/scripts/*probe*.mjs`
   or anything else that calls https://api.ovoa.ai (they hit production and cost money).
3. Start of every session: `git fetch origin`, then `git pull --rebase origin claude/overnight`. Log whether
   `origin/main` has new commits. If main changed files you are about to touch, `git merge origin/main` into this
   branch first and re-run tests.
4. Claim before working: change the task's box to `[~] claimed <ISO time UTC> by <who>`, commit and push that one
   line FIRST. Skip any task claimed less than 2 hours ago. If a claim is older than 2 hours with no progress, take it.
5. Before every commit, in `jarvis/api`: `npx tsc --noEmit` and `npm test` must pass (60 test files passed at start).
   Never delete or weaken an existing test to make it pass. For app changes also `npx tsc --noEmit` in `jarvis/app`.
6. Additive and feature-flagged: new tools, routes and tables must not change existing behavior when their
   secrets or bindings are missing. New D1 tables go in a NEW numbered migration (next free number after the
   highest in `jarvis/api/migrations`); never edit old migrations.
7. Every new feature ships with tests in `jarvis/api/test/` (plain-script style, see `scripts/test.mjs` and existing tests).
8. Follow the repo's conventions: read `contextforclaude.txt`, `HANDOFF.txt`, the docs/ files for the area, and the
   files you touch. Use `git ls-files` or the Grep tool, not recursive grep (OneDrive). No backslashes in heredocs.
   No em dashes or en dashes in any user-facing text. OVOA sounds like a chill human. Commit messages are plain
   sentences ending with the Co-Authored-By line.
9. Guardrails stay in code, not prompts: anything that sends, books, buys or posts in the user's name goes through
   `pending_actions` approval. Background runs never send, delete or spend on their own; a batch only runs as the
   execution of an approval the user gave. Spend caps and rate limits apply. No bulk texting of strangers (Terms
   forbid bulk messages). Never store users' passwords, card numbers or SSNs.
10. New npm libraries, new paid providers, new secrets, bindings, DNS or routes need the owner: build them behind a
    flag on this branch, but list them under "Needs the owner" at the bottom instead of assuming they exist.
11. Do NOT edit `contextforclaude.txt` on this branch (main rewrites it often and it would conflict). Put the
    proposed new lines under "Proposed contextforclaude.txt" at the bottom of this file.
12. One task per session is fine. Finish it fully (code, tests, a docs line), commit with a clear message,
    `git push origin claude/overnight`, tick the box `[x]`, add a log line. If blocked, write why and move on.
    If `git push` fails for permissions, write that in the log and stop.

## Tasks (top to bottom)

- [~] claimed 2026-09-27T10:56Z by local session. 1. **fetch_url tool** (web agent, read-only): read a full public web page, JSON or CSV by URL. http(s) only;
      refuse private, loopback, link-local and cloud metadata addresses, and re-check after every redirect (max 3);
      15 s timeout; 3 MB cap; HTML to readable text keeping table cells tab-separated and link hrefs; `offset` /
      `maxChars` paging. Offer it next to web_search (see `web.ts`, `toolbelt.ts`). Tests for the address guard,
      redirects and HTML-to-text.
- [ ] 2. **Tone gaps + guest cap**: apply `noDashes` (sentences.ts) to push notifications, email bodies OVOA writes,
      and friend answers sent as a push. Guest texting (`guest.ts`) calls the model with `userId: null`, which the
      model gate lets through (`plans.ts`): add a global daily guest cap (var with a safe default) so guest trials
      can't run up unbounded cost; over the cap, reply with the existing "Get Base" style text. Tests.
- [ ] 3. **Saved lists**: `list_save` / `list_read` tools backed by a new D1 table (user_id, name, rows JSON, unique
      per user+name, ~5,000 row cap, size cap). Lets OVOA build a list across steps and reuse it later. Tests.
- [ ] 4. **Vault**: encrypted personal details OVOA uses when booking or filling forms (addresses, loyalty and
      frequent-flyer numbers, sizes, seat preferences, car). AES-GCM via existing `crypto.ts` / `TOKEN_ENC_KEY`.
      Tools `vault_lookup` / `vault_save`; refuse card numbers, bank or routing numbers, SSNs, passwords, one-time
      codes. Never write values to action_log or logs. Authed routes GET/POST/PATCH/DELETE `/vault`. Friends and
      friend OVOAs never get vault items. Absent (tools not offered) if TOKEN_ENC_KEY is missing. Tests.
- [ ] 5. **Texting keywords + do-not-contact**: on the iMessage line (`texting.ts`), handle whole-message STOP /
      START / HELP / CARD without changing any existing reply or the YES/NO approval words (a bare "stop" while an
      approval is waiting must still mean NO; decide carefully and test both). CARD resends the existing contact
      card (`contactcard.ts`). New `do_not_contact` table; STOP from any number adds it, START removes it; `reach.ts`
      and future campaigns check it. Optionally call Sendblue's contact sharing API (POST
      /api/v2/contact-sharing/profile then /share, headers sb-api-key-id / sb-api-secret-key, body fromNumber,
      firstName, photoUrl / fromNumber, toNumber; only works in an existing 1:1 iMessage chat) behind a flag. Tests.
- [ ] 6. **Campaigns (one approval, many targets)**: `campaign_start` proposes a plan (mode `email` | `research` |
      `friends`, title, instructions with `{field}` placeholders, items) as ONE pending action showing count and
      estimated cost. The approval is what runs it: after approval, the 2-minute cron works through a few items per
      tick, only inside the user's daytime hours, and only for campaigns with an approved action id. Caps in code:
      research 500 items, email 200 per day (sent from the user's own Gmail via existing google tools), `friends`
      mode only to the user's Friends through the existing OVOA-to-OVOA path. Skip do_not_contact. Results stored
      per item; one summary when done; `campaign_status` / `campaign_stop` tools; authed GET `/campaigns`,
      `/campaigns/:id`, POST `/campaigns/:id/stop`, GET `/campaigns/:id/export.csv` (formula-safe). Counts against
      plan spend via the model gate. Tests.
- [ ] 7. **Web agent: real browser** (needs owner: new library `@cloudflare/puppeteer` + Browser Rendering binding):
      tools browser_open, browser_read (text + numbered clickable elements), browser_click, browser_type,
      browser_back; one session per turn, always closed; only public http(s) URLs (reuse task 1's guard). Anything
      that submits a form, buys, books or posts first creates a pending action describing exactly what it will do.
      Code must compile and all tools must be absent when `env.BROWSER` is missing; test with a fake browser driver.
      Do NOT add the binding to wrangler.jsonc; write the exact snippet under "Needs the owner".
- [ ] 8. **Approval rules**: saved rules like "don't ask before emailing my wife" or "book anything under $50" (per
      recipient, per tool, per amount), checked before creating a pending action; `rule_add` / `rule_list` /
      `rule_remove` tools and authed routes. Never bypass: money over budget limits, Full-access danger items,
      agent-started turns, anything in FORBIDDEN_ALONE. Tests.
- [ ] 9. **Group chats**: OVOA answers in an iMessage group (Sendblue group_id; texting.ts currently ignores groups)
      only when mentioned by name, only if everyone else in the group is the sender's Friend, never shares private
      details there, and sends approvals to the person privately. Group replies via Sendblue send-group-message.
      Everything else about groups stays ignored as today. Tests with a fake Sendblue.
- [ ] 10. **Logins without passwords** (design doc + first slice, only if task 7 landed): per-user saved browser
      session created by the user logging in themselves through a live-view link; OVOA never sees the password.
- [ ] 11. **Server-side calls** (design doc only; needs owner: Twilio or similar is a new paid provider): how OVOA
      would call a business for the user (AI voice that says it's an AI, approval first, per-call cap), reusing the
      Deepgram/voice pieces that exist. No code that needs keys.
- [ ] 12. **App screens** (jarvis/app, Expo SDK 57, read its docs first): Vault, Campaigns, Approval rules, only for
      API parts that landed. Typecheck the app. Never trigger Codemagic.
- [ ] 13. **Final report**: update this file: what shipped (commits), what needs the owner (bindings, libraries,
      secrets, migrations to apply, deploy order), proposed contextforclaude.txt lines, and a short phone test plan.

## Needs the owner

(fill in as tasks land)

## Proposed contextforclaude.txt

(fill in as tasks land)

## Log

- 2026-09-27 11:00 UTC: branch created from origin/main 16c2deb; baseline tsc clean, 60 test files pass.
- 2026-09-27 11:05 UTC: plan rewritten from a full gap audit of 16c2deb (texting exists; no page reader, browser,
  vault, campaigns, keywords, do-not-contact, group chats, server calls; guest trial skips the model gate).
