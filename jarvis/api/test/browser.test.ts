// The web agent (browser.ts) against a fake browser: reads pages with numbered
// elements, searches and browses freely, never types passwords or card numbers,
// turns anything that commits into an approval, and on YES replays the steps in
// a fresh browser and makes the final click (approvers.ts, approveAction).

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { blocksAssistant } from "../src/blocks";
import {
  type BrowserPage,
  type BrowserSession,
  commits,
  type PageElement,
  type PageState,
  setBrowserFactory,
  typingRefusal,
  view,
} from "../src/browser";
import { approveAction } from "../src/google/assistant";
import type { Env } from "../src/types";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(got)}${ok ? "" : `  (wanted ${JSON.stringify(want)})`}`);
}

function d1(sqlite: DatabaseSync): D1Database {
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => (sqlite.prepare(sql).get(...(args as never[])) as unknown) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...(args as never[])) }),
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...(args as never[])).changes) } }),
  });
  return { prepare: (sql: string) => statement(sql) } as unknown as D1Database;
}

const sqlite = new DatabaseSync(":memory:");
for (const file of readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort()) {
  sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
}
sqlite.prepare("INSERT INTO users (id, email, password_hash, password_salt, name, created_at) VALUES ('sam', 'sam@example.com', '', '', 'Sam', 0)").run();
const env = { DB: d1(sqlite), BROWSER: {} } as unknown as Env;

// ---------- A fake shop ----------

const el = (id: number, kind: PageElement["kind"], label: string, extra: Partial<PageElement> = {}): PageElement => ({
  id,
  kind,
  label,
  selector: `#e-${label.toLowerCase().replace(/\W+/g, "-")}`,
  ...extra,
});

const PAGES: Record<string, PageState> = {
  "https://shop.example.com/": {
    url: "https://shop.example.com/",
    title: "Shop",
    text: "Welcome to Shop.",
    elements: [
      el(1, "input", "Search", { inputType: "search", inForm: true, searchForm: true }),
      el(2, "link", "Running shoes", { href: "https://shop.example.com/shoes" }),
      el(3, "link", "Sign in", { href: "https://shop.example.com/login" }),
    ],
  },
  "https://shop.example.com/search": {
    url: "https://shop.example.com/search?q=shoes",
    title: "Results for shoes",
    text: "3 results",
    elements: [el(1, "link", "Running shoes", { href: "https://shop.example.com/shoes" })],
  },
  "https://shop.example.com/shoes": {
    url: "https://shop.example.com/shoes",
    title: "Running shoes, $80",
    text: "Running shoes. $80. In stock.",
    elements: [
      el(1, "select", "Size", { inForm: true }),
      el(2, "input", "Name", { inputType: "text", inForm: true }),
      el(3, "input", "Card number", { inputType: "text", inForm: true, autocomplete: "cc-number" }),
      el(4, "submit", "Place order", { inForm: true }),
      el(5, "button", "Add to wishlist"),
      el(6, "link", "Evil", { href: "http://169.254.169.254/" }),
    ],
  },
  "https://shop.example.com/login": {
    url: "https://shop.example.com/login",
    title: "Sign in",
    text: "Sign in",
    elements: [el(1, "input", "Email", { inputType: "email", inForm: true }), el(2, "input", "Password", { inputType: "password", inForm: true })],
  },
  "https://shop.example.com/thanks": { url: "https://shop.example.com/thanks", title: "Order placed", text: "Thanks!", elements: [] },
  "http://169.254.169.254/": { url: "http://169.254.169.254/", title: "metadata", text: "secret", elements: [] },
};

type Log = string[];
function fakeFactory(log: Log) {
  let sessions = 0;
  return async (): Promise<BrowserSession> => {
    const n = ++sessions;
    let at = "https://shop.example.com/";
    const history: string[] = [];
    const go = (url: string) => {
      history.push(at);
      at = url;
    };
    const page: BrowserPage = {
      async goto(url) {
        log.push(`s${n} goto ${url}`);
        go(url);
      },
      async state() {
        return PAGES[at] ?? { url: at, title: "?", text: "", elements: [] };
      },
      async click(selector) {
        log.push(`s${n} click ${selector}`);
        if (selector === "#e-running-shoes") go("https://shop.example.com/shoes");
        if (selector === "#e-place-order") go("https://shop.example.com/thanks");
        if (selector === "#e-evil") go("http://169.254.169.254/");
      },
      async type(selector, text) {
        log.push(`s${n} type ${selector} ${text}`);
      },
      async select(selector, value) {
        log.push(`s${n} select ${selector} ${value}`);
      },
      async pressEnter(selector) {
        log.push(`s${n} enter ${selector}`);
        if (selector === "#e-search") go("https://shop.example.com/search");
      },
      async back() {
        log.push(`s${n} back`);
        at = history.pop() ?? at;
      },
    };
    return {
      async page() {
        return page;
      },
      async close() {
        log.push(`s${n} close`);
      },
    };
  };
}

async function main() {
  // Pure rules.
  eq("a link never commits", commits(el(1, "link", "Buy now"), true), false);
  eq("a submit commits", commits(el(1, "submit", "Continue"), false), true);
  eq("a search box's submit doesn't", commits(el(1, "submit", "Search", { searchForm: true }), false), false);
  eq("a 'Book now' button commits", commits(el(1, "button", "Book now"), false), true);
  eq("a plain button doesn't", commits(el(1, "button", "Show more"), false), false);
  eq("any button in a form they typed into commits", commits(el(1, "button", "Next", { inForm: true }), true), true);
  eq("no passwords", typingRefusal(el(1, "input", "Password", { inputType: "password" }), "x") !== null, true);
  eq("no card numbers, even in a normal field", typingRefusal(el(1, "input", "Notes"), "4111 1111 1111 1111") !== null, true);
  eq("no card fields", typingRefusal(el(1, "input", "CVV"), "123") !== null, true);
  eq("a name is fine", typingRefusal(el(1, "input", "Name"), "Sam Lee"), null);
  const big: PageState = { url: "https://x.example.com/", title: "t", text: "a".repeat(9000), elements: Array.from({ length: 80 }, (_, i) => el(i + 1, "link", `L${i}`)) };
  eq("a page view fits a tool result", JSON.stringify(view(big)).length < 6000, true);

  // No driver: no tools.
  setBrowserFactory(null);
  eq("absent until the adapter is on", blocksAssistant(env, "sam", "UTC").tools.some((t) => t.name.startsWith("browser_")), false);
  setBrowserFactory(fakeFactory([]));
  eq("and absent without the BROWSER binding", blocksAssistant({ DB: env.DB } as Env, "sam", "UTC").tools.some((t) => t.name.startsWith("browser_")), false);

  // A turn.
  const log: Log = [];
  setBrowserFactory(fakeFactory(log));
  const b = blocksAssistant(env, "sam", "UTC");
  eq("offered", b.tools.filter((t) => t.name.startsWith("browser_")).map((t) => t.name), ["browser_open", "browser_click", "browser_type", "browser_select", "browser_back"]);
  eq("private addresses refused", await b.callTool("browser_open", { url: "http://localhost/admin" }), { error: "That address isn't public." });
  eq("click before open", await b.callTool("browser_click", { id: 1 }), { error: "Open a page first (browser_open)." });

  const home = (await b.callTool("browser_open", { url: "https://shop.example.com/" })) as { title: string; elements: { id: number; label: string }[] };
  eq("opens with numbered elements", [home.title, home.elements.map((e) => e.label)], ["Shop", ["Search", "Running shoes", "Sign in"]]);
  const results = (await b.callTool("browser_type", { id: 1, text: "shoes", enter: true })) as { title: string };
  eq("a search with Enter just runs", results.title, "Results for shoes");
  const shoes = (await b.callTool("browser_click", { id: 1 })) as { title: string };
  eq("following a link just runs", shoes.title, "Running shoes, $80");
  eq("wishlist isn't committing", ((await b.callTool("browser_click", { id: 5 })) as { title: string }).title, "Running shoes, $80");
  await b.callTool("browser_select", { id: 1, value: "10" });
  await b.callTool("browser_type", { id: 2, text: "Sam Lee" });
  eq("card number refused", ((await b.callTool("browser_type", { id: 3, text: "4111111111111111" })) as { error?: string }).error?.includes("card"), true);
  eq("an unknown element", ((await b.callTool("browser_click", { id: 99 })) as { error?: string }).error?.startsWith("There's no element 99"), true);

  const order = (await b.callTool("browser_click", { id: 4 })) as { status: string; will: string };
  eq("placing the order waits for approval", order.status, "waiting_for_user_approval");
  eq("and says exactly what", order.will, 'On shop.example.com: click "Place order" after filling in Name');
  eq("nothing was clicked", log.some((l) => l.includes("#e-place-order")), false);
  const parked = sqlite.prepare("SELECT id, tool, args FROM pending_actions WHERE user_id = 'sam'").get() as { id: string; tool: string; args: string };
  eq("parked as browser_submit", parked.tool, "browser_submit");
  eq("with no card number in it", parked.args.includes("4111"), false);

  // A page that navigates somewhere private is dropped.
  const evil = (await b.callTool("browser_click", { id: 6 })) as { error?: string };
  eq("navigating to a private address stops", evil.error, "That address isn't public.");

  // YES: replayed in a fresh browser, then the final click.
  log.length = 0;
  const approved = await approveAction(env, "sam", parked.id);
  eq("approved", approved?.content.startsWith("Done: On shop.example.com"), true);
  eq("replayed in a new session and closed", [log[0], log.at(-1)], ["s2 goto https://shop.example.com/", "s2 close"]);
  eq("the final click happened", log.includes("s2 click #e-place-order"), true);
  eq("and the filled fields were filled again first", log.indexOf("s2 type #e-name Sam Lee") < log.indexOf("s2 click #e-place-order"), true);
  eq("the result names the page", approved?.content.includes('"Order placed"'), true);

  // Login pages: OVOA doesn't type passwords.
  const b2 = blocksAssistant(env, "sam", "UTC");
  await b2.callTool("browser_open", { url: "https://shop.example.com/login" });
  eq("no password typing", ((await b2.callTool("browser_type", { id: 2, text: "hunter2" })) as { error?: string }).error, "OVOA doesn't type passwords. Ask them to log in themselves.");

  console.log(fails ? `\n${fails} failed` : "\nall passed");
  if (fails) process.exit(1);
}

main();
