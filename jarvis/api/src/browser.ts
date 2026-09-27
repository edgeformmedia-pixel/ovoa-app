// The web agent: a real browser OVOA drives for someone, one session per reply.
//
// fetch_url (fetchurl.ts) reads a page; this uses one: open a page, read it with
// its clickable things numbered, click, type, pick from a menu, go back. Built
// on Cloudflare Browser Rendering through a small driver (BrowserSession below),
// so the rules live here and the browser library lives in one adapter file
// (optional/browser-puppeteer.ts) that the owner switches on. With no driver
// registered, none of these tools exist.
//
// The rules, in code:
//   - Public http(s) pages only (fetchurl.ts assertPublicUrl), checked again
//     after every step that can navigate.
//   - Anything that commits, like placing an order, booking, paying, sending,
//     posting, signing up or submitting a filled-in form, is never clicked in
//     the turn. It becomes an approval (pending_actions) that says exactly what
//     will happen; on YES the steps are replayed in a fresh browser and the
//     final click is made (approvers.ts).
//   - Never types into a password field and never types a card number: logins
//     are the person's to do themselves (no passwords held), and payment is
//     finished by them at the merchant (budget.ts).

import { registerApprover } from "./approvers";
import { assertPublicUrl, FetchRefused } from "./fetchurl";
import { parkAction } from "./google/assistant";
import type { CallTool, ToolSpec } from "./llm";
import type { Env } from "./types";

// ---------- The driver the adapter provides ----------

export type ElementKind = "link" | "button" | "submit" | "input" | "textarea" | "select" | "checkbox";

export type PageElement = {
  /** 1-based, in page order: what the model refers to. */
  id: number;
  kind: ElementKind;
  label: string;
  /** A CSS path that finds the same element again, in this session or a replay. */
  selector: string;
  href?: string;
  /** For inputs: text, email, search, password, tel, ... */
  inputType?: string;
  /** Inside a <form>, and whether that form looks like a search box. */
  inForm?: boolean;
  searchForm?: boolean;
  /** The browser's autocomplete hint, e.g. "cc-number". */
  autocomplete?: string;
};

export type PageState = { url: string; title: string; text: string; elements: PageElement[] };

export interface BrowserPage {
  goto(url: string): Promise<void>;
  state(): Promise<PageState>;
  click(selector: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  select(selector: string, value: string): Promise<void>;
  pressEnter(selector: string): Promise<void>;
  back(): Promise<void>;
}

export interface BrowserSession {
  page(): Promise<BrowserPage>;
  close(): Promise<void>;
}

type Factory = (env: Env) => Promise<BrowserSession>;
let factory: Factory | null = null;

/** The adapter calls this once (optional/browser-puppeteer.ts). Tests pass a fake. */
export function setBrowserFactory(make: Factory | null) {
  factory = make;
}

export const browserReady = (env: Env) => factory !== null && !!(env as { BROWSER?: unknown }).BROWSER;

// ---------- What counts as committing ----------

const COMMIT_WORDS =
  /\b(buy|purchase|pay|payment|order|checkout|check out|book|booking|reserve|reservation|confirm|submit|send|post|publish|sign up|signup|register|subscribe|donate|apply|transfer|delete|remove account|place order|complete|finish)\b/i;

/** Would clicking this commit something in the person's name? Pure. */
export function commits(el: PageElement, typedInForm: boolean): boolean {
  if (el.kind === "link") return false;
  if (el.kind === "submit") return !el.searchForm;
  if (el.kind === "button" && COMMIT_WORDS.test(el.label)) return true;
  // Any button in a form they've typed into, unless it's a search box.
  return el.kind === "button" && !!el.inForm && typedInForm && !el.searchForm;
}

const CARD_DIGITS = /\b(?:\d[ -]?){13,19}\b/;
const CARD_FIELD = /\b(card|cc|cvv|cvc|security code|expir)/i;

/** Why OVOA won't type this here, or null. Pure. */
export function typingRefusal(el: PageElement, text: string): string | null {
  if (el.inputType === "password" || /password|passcode/i.test(el.label)) {
    return "OVOA doesn't type passwords. Ask them to log in themselves.";
  }
  if (CARD_DIGITS.test(text) || CARD_FIELD.test(el.label) || /^cc-/.test(el.autocomplete ?? "")) {
    return "OVOA doesn't enter card details. They finish payment themselves at the store.";
  }
  return null;
}

// ---------- Steps, so an approval can be replayed ----------

type Step =
  | { op: "goto"; url: string }
  | { op: "click"; selector: string }
  | { op: "type"; selector: string; text: string; search?: boolean }
  | { op: "select"; selector: string; value: string }
  | { op: "enter"; selector: string }
  | { op: "back" };

async function run(page: BrowserPage, step: Step) {
  if (step.op === "goto") return page.goto(step.url);
  if (step.op === "click") return page.click(step.selector);
  if (step.op === "type") return page.type(step.selector, step.text);
  if (step.op === "select") return page.select(step.selector, step.value);
  if (step.op === "enter") return page.pressEnter(step.selector);
  return page.back();
}

const TEXT_CHARS = 2_800;
const MAX_ELEMENTS = 50;
export const MAX_BROWSER_STEPS = 25;

/** What the model sees of a page: under the 6,000-character tool-result cap. */
export function view(state: PageState) {
  return {
    url: state.url,
    title: state.title.slice(0, 120),
    text: state.text.length > TEXT_CHARS ? `${state.text.slice(0, TEXT_CHARS)}…` : state.text,
    elements: state.elements.slice(0, MAX_ELEMENTS).map((e) => ({
      id: e.id,
      kind: e.kind,
      label: e.label.slice(0, 60),
      ...(e.inputType && e.kind === "input" ? { type: e.inputType } : {}),
    })),
    ...(state.elements.length > MAX_ELEMENTS ? { moreElements: state.elements.length - MAX_ELEMENTS } : {}),
  };
}

function assertStillPublic(state: PageState) {
  assertPublicUrl(state.url);
}

// ---------- Tools ----------

const TOOLS: ToolSpec[] = [
  {
    name: "browser_open",
    description:
      "Opens a web page in a real browser to use it for them (search a site, check availability, fill a form). Returns the page's text and its clickable things, numbered. For just reading a page, fetch_url is faster.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "browser_click",
    description:
      "Clicks element `id` on the open page. Anything that commits (order, book, pay, send, post, sign up, submit a filled form) isn't clicked now: it's sent to them to approve, with exactly what will happen.",
    parameters: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  },
  {
    name: "browser_type",
    description:
      "Types text into field `id` on the open page. enter=true presses Enter after (fine for search boxes; for other forms it goes to them to approve). Never passwords or card numbers.",
    parameters: {
      type: "object",
      properties: { id: { type: "number" }, text: { type: "string" }, enter: { type: "boolean" } },
      required: ["id", "text"],
    },
  },
  {
    name: "browser_select",
    description: "Picks `value` (the option's visible text) in dropdown `id` on the open page.",
    parameters: { type: "object", properties: { id: { type: "number" }, value: { type: "string" } }, required: ["id", "value"] },
  },
  {
    name: "browser_back",
    description: "Goes back one page in the open browser.",
    parameters: { type: "object", properties: {} },
  },
];

const NAMES = new Set(TOOLS.map((t) => t.name));
export const isBrowserTool = (name: string) => NAMES.has(name);

export const WAITING = { status: "waiting_for_user_approval" } as const;

function describeSteps(steps: Step[], labels: Map<string, string>) {
  const typed = steps
    .filter((s): s is Extract<Step, { op: "type" }> => s.op === "type" && !s.search)
    .map((s) => labels.get(s.selector) || "a field");
  return typed.length ? ` after filling in ${[...new Set(typed)].slice(0, 6).join(", ")}` : "";
}

export function browserAssistant(env: Env, userId: string) {
  if (!browserReady(env)) return { tools: [] as ToolSpec[], callTool: (async () => ({ error: "The browser isn't set up." })) as CallTool, prompt: "" };

  let session: BrowserSession | null = null;
  let page: BrowserPage | null = null;
  let state: PageState | null = null;
  const steps: Step[] = [];
  const labels = new Map<string, string>();
  let typedInForm = false;

  const current = async () => {
    state = await page!.state();
    assertStillPublic(state);
    for (const e of state.elements) labels.set(e.selector, e.label);
    return view(state);
  };
  const find = (id: unknown) => {
    const el = state?.elements.find((e) => e.id === Number(id));
    if (!el) throw new FetchRefused(`There's no element ${String(id)} on this page. Use the numbers from the last page.`);
    return el;
  };
  const record = (step: Step) => {
    steps.push(step);
    if (steps.length > MAX_BROWSER_STEPS) throw new FetchRefused(`That's ${MAX_BROWSER_STEPS} browser steps in one reply. Stop and tell them where things stand.`);
  };

  const approve = async (el: PageElement, final: Step) => {
    const host = state ? new URL(state.url).hostname : "the site";
    const summary = `On ${host}: ${el.kind === "submit" || el.kind === "button" ? `click "${el.label || "Submit"}"` : "submit the form"}${describeSteps(steps, labels)}`;
    await parkAction(env, userId, "browser_submit", { steps: [...steps, final], label: el.label, host }, summary, false);
    return { ...WAITING, will: summary };
  };

  const callTool: CallTool = async (name, args) => {
    try {
      if (name === "browser_open") {
        const url = assertPublicUrl(String(args.url ?? "")).toString();
        if (!session) {
          session = await factory!(env);
          page = await session.page();
        }
        steps.length = 0;
        typedInForm = false;
        record({ op: "goto", url });
        await page!.goto(url);
        return await current();
      }
      if (!page || !state) return { error: "Open a page first (browser_open)." };
      if (name === "browser_click") {
        const el = find(args.id);
        if (commits(el, typedInForm)) return await approve(el, { op: "click", selector: el.selector });
        record({ op: "click", selector: el.selector });
        await page.click(el.selector);
        return await current();
      }
      if (name === "browser_type") {
        const el = find(args.id);
        const text = String(args.text ?? "").slice(0, 500);
        const refused = typingRefusal(el, text);
        if (refused) return { error: refused };
        record({ op: "type", selector: el.selector, text, ...(el.searchForm || el.inputType === "search" ? { search: true } : {}) });
        await page.type(el.selector, text);
        if (el.inForm && !el.searchForm) typedInForm = true;
        if (args.enter) {
          // Enter on a search box is a search; on any other form it submits it.
          if (el.inForm && !el.searchForm) return await approve(el, { op: "enter", selector: el.selector });
          record({ op: "enter", selector: el.selector });
          await page.pressEnter(el.selector);
        }
        return await current();
      }
      if (name === "browser_select") {
        const el = find(args.id);
        const value = String(args.value ?? "").slice(0, 200);
        record({ op: "select", selector: el.selector, value });
        await page.select(el.selector, value);
        return await current();
      }
      if (name === "browser_back") {
        record({ op: "back" });
        await page.back();
        return await current();
      }
      return { error: `Unknown tool ${name}` };
    } catch (err) {
      if (err instanceof FetchRefused) return { error: err.message };
      console.error("browser tool failed", err);
      return { error: "The browser didn't manage that. Say what you tried and offer another way." };
    }
  };

  return {
    tools: TOOLS,
    callTool,
    prompt: [
      "Browser: to actually use a website for them (search it, check availability or prices, fill in a form), browser_open it, then browser_click / browser_type / browser_select by the element numbers it gives you. To just read a page, use fetch_url.",
      "Anything that commits (place an order, book, pay, send, post, sign up, submit a form) goes to them to approve; say plainly what you set up and that it's waiting for their YES. Never try to log in for them or enter card details; tell them to do that part.",
    ].join("\n"),
  };
}

// ---------- The approved final step ----------

/** Replays the steps in a fresh browser and makes the final click. Registered with approvers.ts. */
export async function runApprovedBrowser(env: Env, _userId: string, args: Record<string, unknown>, summary: string): Promise<string> {
  if (!browserReady(env)) return "That didn't work: the browser isn't available right now.";
  const steps = Array.isArray(args.steps) ? (args.steps as Step[]) : [];
  if (!steps.length || steps[0]?.op !== "goto") return "That didn't work: nothing to replay.";
  const session = await factory!(env);
  try {
    const page = await session.page();
    for (const step of steps) {
      if (step.op === "goto") assertPublicUrl(step.url);
      await run(page, step);
    }
    const after = await page.state();
    const note = after.title || new URL(after.url).hostname;
    return `Done: ${summary.split("\n")[0]}. The page now shows "${note.slice(0, 80)}".`;
  } catch (err) {
    return `That didn't work: ${err instanceof FetchRefused ? err.message : "the page changed or didn't load"}. Nothing else was done.`;
  } finally {
    await session.close().catch(() => {});
  }
}

registerApprover("browser_submit", runApprovedBrowser);

/**
 * Runs in the page (the adapter passes it to page.evaluate): the visible text,
 * and the things that can be clicked or typed into, numbered, each with a CSS
 * path that finds it again. Plain ES5 so any page can run it.
 */
export const SNAPSHOT_SCRIPT = `(() => {
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const path = (el) => { const parts = []; while (el && el.nodeType === 1 && el !== document.body) { let i = 1, sib = el; while ((sib = sib.previousElementSibling)) if (sib.tagName === el.tagName) i++; parts.unshift(el.tagName.toLowerCase() + ":nth-of-type(" + i + ")"); el = el.parentElement; } return "body > " + parts.join(" > "); };
  const labelOf = (el) => { const l = (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") || el.innerText || el.value || ""; return String(l).replace(/\\s+/g, " ").trim().slice(0, 80); };
  const kindOf = (el) => { const t = el.tagName.toLowerCase(); const type = (el.getAttribute("type") || "").toLowerCase(); if (t === "a") return "link"; if (t === "select") return "select"; if (t === "textarea") return "textarea"; if (t === "button") return type === "submit" || (!type && el.form) ? "submit" : "button"; if (t === "input") { if (type === "submit" || type === "image") return "submit"; if (type === "button" || type === "reset") return "button"; if (type === "checkbox" || type === "radio") return "checkbox"; if (type === "hidden") return null; return "input"; } if (el.getAttribute("role") === "button") return "button"; return null; };
  const isSearch = (form) => !!form && (form.getAttribute("role") === "search" || /search/i.test(form.action || "") || !!form.querySelector("input[type=search], input[name=q], input[name=query], input[name=search]"));
  const out = []; let id = 0;
  document.querySelectorAll("a[href], button, input, select, textarea, [role=button]").forEach((el) => {
    const kind = kindOf(el); if (!kind || !visible(el)) return;
    id++;
    out.push({ id, kind, label: labelOf(el), selector: path(el), href: el.href || undefined, inputType: el.tagName === "INPUT" ? (el.getAttribute("type") || "text").toLowerCase() : undefined, inForm: !!el.form, searchForm: isSearch(el.form), autocomplete: el.getAttribute("autocomplete") || undefined });
  });
  return { url: location.href, title: document.title, text: (document.body ? document.body.innerText : "").replace(/\\n{3,}/g, "\\n\\n").trim(), elements: out };
})()`;
