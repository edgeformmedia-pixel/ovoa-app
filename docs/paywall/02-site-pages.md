# 02 · Site pages and copy: beta, new prices, Band $89.99

Run **after 01 is committed**. Repo: `C:\Users\thoma\OneDrive\Documents\GitHub\ovoa-team`.
Read first: `…\ovoa-app\docs\paywall\SPEC.md`, then 01's commits (`git log -p -5`), `src/routes/index.tsx`, `checkout.tsx`, `early-access/*`, `faq.tsx`, `src/components/SiteFooter.tsx`, and `src/lib/order-receipt*`.

## Goal
Every page tells one true story:
- OVOA is in **beta**. The iPhone app is in TestFlight and the Band is beta hardware.
- The app is **free** for health and notes.
- **Base** ($9.95/mo, $95.99/yr) turns on the AI assistant. **Pro** ($25.95/mo, $195.99/yr) adds the Pro features in SPEC §1.
- The **Band is $89.99** and comes with a week of Base free.

## Do
1. **One price source.** Every price on the site comes from `plans.ts` / the Stripe plans loader. Search for hard-coded prices and remove them. Known ones: the $99 in the home page hero, meta description and JSON-LD `Offer`, and the $89.99, $9.99 and $19.99 on `/checkout`. The JSON-LD becomes $89.99. Use `PreOrder` or `LimitedAvailability` for `availability`, whichever is true; if you can't tell, ask in your summary.
2. **`/early-access` becomes the plans page.**
   - Columns: Free, Base, Pro.
   - A Monthly/Yearly toggle that shows the real savings.
   - A "Beta" badge.
   - Remove the lifetime card. Keep the "founding price, kept while you're a member" line. No crossed-out "was" prices; see setup.md about the FTC.
3. **`/checkout` (Band).**
   - One Band at $89.99.
   - "Includes 7 days of OVOA Base, then $9.95/mo; cancel anytime", with a clear "Band only" choice.
   - It calls 01's checkout (`?band=1`, or `?band=1&ai=0` for Band only). Remove the fake local order-receipt flow once 01's Stripe flow replaces it.
   - Say that shipping and timing are beta: no delivery promise the user hasn't given.
4. **`/early-access/welcome`.**
   - It works for Band buyers too: "your Band is on its way" plus the TestFlight steps.
   - The upsell becomes Base monthly → Base yearly, and Base → Pro.
5. **Admin**
   - Add a tier picker (Base/Pro) to "give free access".
   - Add a **Band orders** list with the shipping address and a "mark shipped" action.
6. **Home, FAQ and footer.** Fix the hero and meta description, add FAQ entries (What's free? What's in Pro? Is this finished? How does TestFlight work?), and link the plans page.
7. **Privacy and terms.**
   - There's no `/privacy` yet, and external TestFlight needs one.
   - Draft `/privacy` and `/terms` from what the app actually collects. Read `ovoa-app/jarvis/api/migrations/*.sql` for the tables: health samples, notes, 14-day retention, no ambient audio, and on-phone transcription for free notes.
   - Tell the user in your summary that these are drafts and not legal advice. Don't put that label on the pages.
8. Keep the landing page's look (the `landing-*` tokens). Use plain English, never jargon like "entitlement" or "tier" in copy; say "plan".

## Verify
- `npm run build`.
- Run `npm run dev` or the local test Worker and check `/`, `/early-access`, `/checkout`, `/early-access/welcome`, `/faq` and `/privacy` at phone width (375 px) and desktop, in light and dark mode. Take screenshots.
- Click through each checkout button against the fake Stripe.

## Finish
Commit and push `main`, then deploy the test Worker (edgeformmedia profile, as in 01). Tell the user Lovable needs a Publish.
