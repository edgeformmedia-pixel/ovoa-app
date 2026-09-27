// OPTIONAL: the real browser behind OVOA's web agent (src/browser.ts), on
// Cloudflare Browser Rendering. Not built or imported until the owner switches
// it on, because it needs a library and two config changes:
//
//   1. cd jarvis/api && npm i @cloudflare/puppeteer
//   2. wrangler.jsonc: add
//        "compatibility_flags": ["nodejs_compat"],
//        "browser": { "binding": "BROWSER" },
//      (Browser Rendering is part of Workers Paid; nodejs_compat is what the
//      library needs. Run the full test + smoke suites after, since the flag is
//      Worker-wide.)
//   3. Move this file to src/browser-puppeteer.ts and add one line near the top of
//      src/index.ts:   import "./browser-puppeteer";
//   4. The library brings Node's type definitions, and with them `npx tsc` flags
//      src/llm.ts where clearTimeout is given a value that may be null: write
//      `clearTimeout(timer ?? undefined)` there (or the like). Nothing else changed.
//
// Then the browser_* tools appear in chat for everyone (browser.ts
// browserReady), and approved form submits are replayed here.

import puppeteer from "@cloudflare/puppeteer";
import { type BrowserPage, type PageState, setBrowserFactory, SNAPSHOT_SCRIPT } from "./browser";
import type { Env } from "./types";

const SETTLE_MS = 1_500;
const NAV_TIMEOUT_MS = 15_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

setBrowserFactory(async (env: Env) => {
  const browser = await puppeteer.launch(env.BROWSER as never, { keep_alive: 60_000 });
  let page: Awaited<ReturnType<typeof browser.newPage>> | null = null;

  // After anything that can navigate: wait for the navigation if one starts, else a short settle.
  const settle = async () => {
    await Promise.race([page!.waitForNavigation({ timeout: NAV_TIMEOUT_MS }).catch(() => undefined), sleep(SETTLE_MS)]);
  };

  const wrapped: BrowserPage = {
    async goto(url) {
      await page!.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    },
    async state() {
      return (await page!.evaluate(SNAPSHOT_SCRIPT)) as PageState;
    },
    async click(selector) {
      await page!.click(selector);
      await settle();
    },
    async type(selector, text) {
      await page!.click(selector, { clickCount: 3 });
      await page!.type(selector, text, { delay: 10 });
    },
    async select(selector, value) {
      // Runs in the page, as a string: this Worker's types have no DOM.
      const option = (await page!.evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const want = ${JSON.stringify(value.trim().toLowerCase())}; const match = [...el.options].find((o) => o.text.trim().toLowerCase() === want); return match ? match.value : null; })()`,
      )) as string | null;
      if (option === null) throw new Error(`No option "${value}"`);
      await page!.select(selector, option);
    },
    async pressEnter(selector) {
      await page!.focus(selector);
      await page!.keyboard.press("Enter");
      await settle();
    },
    async back() {
      await page!.goBack({ timeout: NAV_TIMEOUT_MS }).catch(() => undefined);
    },
  };

  return {
    async page() {
      page ??= await browser.newPage();
      return wrapped;
    },
    async close() {
      await browser.close();
    },
  };
});
