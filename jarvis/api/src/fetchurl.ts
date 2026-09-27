// Reading one web page by its address.
//
// web_search answers questions; this reads a page someone points at ("what does
// this link say", "pull the office list off house.gov"). It is the first piece
// of the web agent: read-only, no clicking, no forms, nothing sent anywhere but
// a plain GET.
//
// Public addresses only. A Worker can't reach a private network, but the guard
// is still the rule in code rather than a property of where it runs: plain
// http(s), no credentials in the link, no IP literals in private, loopback,
// link-local or metadata ranges, no internal-looking host names, and the same
// check again after every redirect.

const MAX_BYTES = 3_000_000;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 15_000;
// A tool result reaches the model capped at 6,000 characters (llm.ts), so a
// page comes back in slices under that, and nextOffset asks for the rest.
export const FETCH_DEFAULT_CHARS = 4_500;
export const FETCH_MAX_CHARS = 5_200;

export class FetchRefused extends Error {}

function isPrivateV4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a = 0, b = 0] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

const V4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** True for IP literals that point somewhere no page should send OVOA. */
export function isPrivateAddress(host: string): boolean {
  const ip = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (V4.test(ip)) return isPrivateV4(ip);
  if (!ip.includes(":")) return false;
  if (ip.startsWith("::ffff:")) {
    const tail = ip.slice(7);
    return V4.test(tail) ? isPrivateV4(tail) : true;
  }
  return (
    ip === "::" ||
    ip === "::1" ||
    ip.startsWith("fc") ||
    ip.startsWith("fd") ||
    /^fe[89ab]/.test(ip) ||
    ip.startsWith("ff")
  );
}

const INTERNAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home", ".corp", ".intranet"];

/** Throws FetchRefused unless the address is a public http(s) URL. */
export function assertPublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new FetchRefused("That isn't a web address.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new FetchRefused("Only http and https links work.");
  if (url.username || url.password) throw new FetchRefused("Links with a username or password in them aren't allowed.");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || !host.includes(".") && !host.includes(":")) {
    throw new FetchRefused("That address isn't public.");
  }
  if (INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) throw new FetchRefused("That address isn't public.");
  if (isPrivateAddress(host)) throw new FetchRefused("That address isn't public.");
  return url;
}

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };

/** Readable text from HTML: drops scripts and styles, keeps line breaks, table cells (tab-separated) and link targets. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|template|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\s*(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article|\/header|\/footer)\s*\/?>/gi, "\n")
    .replace(/<\/t[dh]\s*>/gi, "\t")
    .replace(/<a\s[^>]*href\s*=\s*"([^"#][^"]*)"[^>]*>/gi, " [$1] ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(nbsp|amp|lt|gt|quot|apos|#39);/g, (_m, name: string) => ENTITIES[name] ?? " ")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)))
    // Collapse runs of spaces but keep the tabs between cells, so a table stays a table.
    .replace(/[ \f\v\r]+/g, " ")
    .replace(/ *\t */g, "\t")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

async function readCapped(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) throw new FetchRefused("That page is too big to read.");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new FetchRefused("That page is too big to read.");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

export type FetchedPage = {
  url: string;
  status: number;
  contentType: string;
  totalChars: number;
  offset: number;
  nextOffset: number | null;
  text: string;
};

/** GET one public page, following at most three redirects, each re-checked. */
export async function fetchPage(
  raw: string,
  options: { offset?: number; maxChars?: number; raw?: boolean } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<FetchedPage> {
  let url = assertPublicUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetchImpl(url.toString(), {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        "user-agent": "OVOA/1.0 (+https://ovoa.ai)",
        accept: "text/html,application/json,text/csv,text/plain;q=0.9,*/*;q=0.5",
      },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new FetchRefused("The page redirected nowhere.");
      url = assertPublicUrl(new URL(location, url).toString());
      continue;
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (/^(image|audio|video)\//i.test(contentType) || /octet-stream|zip|pdf/i.test(contentType)) {
      throw new FetchRefused("That link isn't a page OVOA can read as text.");
    }
    const body = await readCapped(response);
    const text = !options.raw && /html/i.test(contentType) ? htmlToText(body) : body;
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const maxChars = Math.min(FETCH_MAX_CHARS, Math.max(200, Math.floor(options.maxChars ?? FETCH_DEFAULT_CHARS)));
    const slice = text.slice(offset, offset + maxChars);
    return {
      url: url.toString(),
      status: response.status,
      contentType,
      totalChars: text.length,
      offset,
      nextOffset: offset + slice.length < text.length ? offset + slice.length : null,
      text: slice,
    };
  }
  throw new FetchRefused("Too many redirects.");
}
