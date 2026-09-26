# Websites at <name>.ovoa.ai

Built 2026-09-26, as part of making texting OVOA (Instinct) do more on its own: someone texts or says
"build a website for my client Tony's Pizza", and a few minutes later OVOA sends the link to a finished,
hosted site: `tonys-pizza.ovoa.ai`, right on a phone and a laptop, with a contact form whose messages
come back to them by text and email. It's for their own business, or for the clients of someone who
builds sites for others, which is why a site can name a `client`.

Code: `jarvis/api/src/sites.ts` (all of it), migration `0050_sites_and_texting_first.sql`, the lane in
`index.ts runTick`, the front door in `index.ts`'s default export. Tests: `test/sites.test.ts`
(everything but serving), `scripts/sites-probe.mjs` (production, end to end).

## How it's used

In a text or in the app, the model has five tools (preloaded when a request says "website", "site",
"landing page", "leads"…, `toolbelt.ts`):

- `site_build` (name, about, subdomain?, forClient?) writes the site down, queues its build and
  answers at once with the link: "it's on its way". The model is told to pass everything it knows and
  never invent contact details.
- `site_change` (site, change) queues a change in their words ("open till 1am Fridays", "bigger call
  button"). The change is added to the site's brief, so it can always be rebuilt from nothing.
- `site_list`, `site_leads` (the contact form's messages, the last 14 days), and `site_manage`
  (take_down, put_back, move to a new address, delete: a deleted site can be put back for 30 days).

At most 25 sites each (deleted ones count until they're gone) and 30 builds or changes a day.
Building is Base, like any model call: the build's call goes through the plan gate, and a build the
gate refuses is failed with the reason, in their words.

## How a site gets built

A build is one model call that writes the whole page: about 14 KB of HTML, 4-5K tokens, a minute or
so on GLM 5.3 Flash (measured 73 s on Z.ai, 2026-09-26). That's longer than a text turn has, so:

1. `site_build` inserts `sites` (status `building`) and a `site_builds` row (`queued`).
2. Every two minutes the cron's **sites lane** (`sitesTick`) takes the oldest queued build whose
   site has nothing older waiting, claims it, and runs it. It runs beside the slow lane, not after
   it (it's waiting on the model, not using the CPU), under its own lease, and only when something is
   queued. It works for up to 10 minutes a tick.
3. `runBuild` asks `generateText` with `maxTokens: 16000`, which also streams the answer, so the
   25 s idle deadline watches it instead of the 20 s start deadline (`llm.ts Options.maxTokens`).
4. `pageFrom` takes the page out of the answer (fences, words around it), or the designer's
   `REFUSED:` line. `cleanSiteHtml` cleans it (below), and it's kept: status `live`, version + 1.
5. They're told (`agent.ts tell`, a note that goes through quiet hours because they asked for it):
   by text when they text OVOA, a notification otherwise.

A build that fails (an engine down, a page cut off) is queued again for the next tick, and after its
second try is given up on, and they're told. A build still `running` after 12 minutes died with its
tick and is picked up again. A refusal fails at once, with the designer's reason.

The designer's instructions are `createPrompt` and `changePrompt`. The rules that matter most: one
self-contained HTML document, no JavaScript, CSS in one `<style>`, Google Fonts only, no photos unless
the owner gave URLs (strong type, color and inline SVG instead), one contact form exactly as specified,
mobile first, accessible, SEO tags and JSON-LD with only facts given, and **never invent facts**
(phone numbers, prices, hours, reviews, awards). It refuses impersonation, credential or payment
collection, illegal goods, adult content, hate and scams.

## How a site is served

`*.ovoa.ai/*` is a route to this Worker (`wrangler.jsonc`), and the default export hands any
`<label>.ovoa.ai` other than `api` to `serveSite` before Hono sees it. `/`, `/robots.txt`,
`/sitemap.xml`, `/favicon.svg` (the name's first letter), `/contact` (POST) and `/thanks`; every other
path is a small 404 page. A site still building answers 503 with Retry-After; one offline or deleted,
404.

### Safe to host under the company's domain

Other people's words on `ovoa.ai` must never be able to hurt `ovoa.ai`, its API, or a visitor:

- **No script runs, ever.** Every response carries `Content-Security-Policy: default-src 'none'` with
  only images (https, data), media, inline styles and Google Fonts, frames from Google Maps, YouTube
  and Vimeo, `form-action 'self'`, `base-uri 'none'`, `frame-ancestors 'none'`. With no script there's
  no `document.cookie`, so a site can't read or set cookies for `.ovoa.ai`.
- **Cleaned twice.** When it's kept (`cleanSiteHtml`, regex, unit-tested) and as it's served
  (`present`, Cloudflare's HTMLRewriter, a real parser): scripts (except JSON-LD, re-written as JSON),
  `on*` handlers, `javascript:` links, `<meta http-equiv>` (no redirects), `<base>`, plugins, frames
  from anywhere else, and any input asking for a password, card, account number or seed phrase are
  removed; every form is made to post to `/contact`.
- **Names.** 3-40 letters, digits and single hyphens (no `xn--` look-alikes). OVOA's own names are
  kept (api, admin, help, www, mail, status, …), and so is anything with a big brand or a sign-in word
  in it (paypal, apple, chase, login, verify, wallet, …): `slugProblem`.
- **Made with OVOA · Report this site** at the foot of every page, styled inline, with a mailto to
  support@ovoa.ai.
- **The preview** (`https://api.ovoa.ai/s/<name>`, below) is on the API's host, so it's also
  sandboxed (`sandbox` without `allow-same-origin`: no origin of its own, no forms) and never indexed.

### The contact form

`POST /contact` on a live site: a hidden field bots fill in (`company_website`) is thanked and dropped;
5 a minute per sender (`RL_FORM`), 5 a day per sender and 20 an hour per site (`site_leads`, by a
daily keyed hash of the sender's address, never the address). The message is kept 14 days, and the
owner gets it twice, straight away: by text or notification (a note, quiet hours respected, framed as
a visitor's words so OVOA never takes it as a request), and by email from no-reply@ovoa.ai with the
visitor as Reply-To, so answering is one tap.

## Routing, and the one DNS record

- `*.ovoa.ai/*` beats a Custom Domain on the same host, so api, admin, help and www each have a
  **route with no Worker** (`api.ovoa.ai/*` and so on), which is more specific and puts them back on
  their Custom Domains. `scripts/sites-routes.mjs` finds every Custom Domain on the zone and adds the
  missing ones (`--dry-run` to look). Run it after adding any subdomain to ovoa.ai, before it sees
  traffic. Checked on 2026-09-26 after the deploy: every host answers as before.
- A **wildcard DNS record** is what sends `<anything>.ovoa.ai` to Cloudflare at all, and only the
  dashboard can add it: ovoa.ai → DNS → Records → Add record: type `AAAA`, name `*`, IPv6 `100::`,
  **Proxied**. Universal SSL already covers `*.ovoa.ai`. Names with records of their own (api, admin,
  help, www, send) aren't affected by a wildcard.
- Until that record exists, links go to the preview instead: `siteLink` asks DNS over HTTPS whether
  `wildcard-check.ovoa.ai` answers (cached 5 minutes while it doesn't, 6 hours once it does), so the
  switch is automatic. `SITES_WILDCARD` = `on` / `off` decides it without looking.
- `SITES_DOMAIN` (wrangler.jsonc) is `ovoa.ai`. Moving the websites to a domain of their own later
  (a separate one keeps any trouble with a customer's site away from ovoa.ai's reputation) is that
  var, the route's pattern, the DNS record, and the routes script.

## Retention

`sites` stay (they set them up); a deleted one goes 30 days after `deleted_at`, one whose first build
never worked after 14. `site_builds` and `site_leads` go after 14 days (docs/retention.md).

## Testing

- `npm test` (`sites.test.ts`): names, what the model's answer becomes, both cleaning rules, the
  contact form's fields, and the tools and the whole build lane on the real schema, against a fake
  model that streams its page the way GLM does (built, changed, refused, failed twice, died half way).
- Serving needs HTMLRewriter, so it's checked on a local worker: `wrangler dev --local` with
  `--local-upstream <name>.ovoa.ai` makes every request that site's, and without it `/s/<name>` is
  the preview. Seed a `sites` row with `wrangler d1 execute --local` (stop the worker first: it holds
  the database).
- `scripts/sites-probe.mjs` against production: a throwaway account builds a client's site by text,
  waits for the cron, checks the page and its policy, changes it by text, and deletes itself.
