// Reading one page by its address (fetchurl.ts): only public http(s), every
// redirect checked again, tables kept as tables, long pages in parts.

import { assertPublicUrl, fetchPage, FetchRefused, htmlToText, isPrivateAddress } from "../src/fetchurl";
import { namedTools } from "../src/toolbelt";
import { webAssistant } from "../src/web";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(got)}${ok ? "" : `  (wanted ${JSON.stringify(want)})`}`);
}

function refused(raw: string): string {
  try {
    assertPublicUrl(raw);
    return "allowed";
  } catch (err) {
    return err instanceof FetchRefused ? "refused" : "threw something else";
  }
}

async function refusedAsync(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return "allowed";
  } catch (err) {
    return err instanceof FetchRefused ? (err as Error).message : `other: ${String(err)}`;
  }
}

const page = (body: string, init: ResponseInit = {}) =>
  new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, ...init });

async function main() {
  // The address guard.
  for (const ip of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.5.4", "192.168.1.1", "100.64.0.1", "0.0.0.0", "::1", "[fd00::1]", "::ffff:10.0.0.1", "fe80::1"]) {
    eq(`private ${ip}`, isPrivateAddress(ip), true);
  }
  for (const ip of ["93.184.216.34", "8.8.8.8", "2606:4700::1111", "house.gov"]) {
    eq(`public ${ip}`, isPrivateAddress(ip), false);
  }
  eq("localhost", refused("http://localhost:8787/debug"), "refused");
  eq("cloud metadata", refused("http://169.254.169.254/latest/meta-data"), "refused");
  eq("internal name", refused("https://db.internal/"), "refused");
  eq("single-label host", refused("http://intranet/"), "refused");
  eq("file://", refused("file:///etc/passwd"), "refused");
  eq("credentials in the link", refused("https://user:pw@example.com/"), "refused");
  eq("not a URL", refused("house dot gov"), "refused");
  eq("a normal page", refused("https://www.house.gov/representatives"), "allowed");

  // Redirects are checked again: a public page can't bounce OVOA somewhere private.
  const hops: string[] = [];
  const bounce = (async (url: string) => {
    hops.push(url);
    return new Response(null, { status: 302, headers: { location: "http://10.0.0.5/admin" } });
  }) as unknown as typeof fetch;
  eq("redirect to a private address", await refusedAsync(() => fetchPage("https://example.com/start", {}, bounce)), "That address isn't public.");
  eq("only the public hop was fetched", hops, ["https://example.com/start"]);

  let count = 0;
  const loop = (async () => {
    count++;
    return new Response(null, { status: 301, headers: { location: `https://example.com/${count}` } });
  }) as unknown as typeof fetch;
  eq("too many redirects", await refusedAsync(() => fetchPage("https://example.com/", {}, loop)), "Too many redirects.");

  const relative = (async (url: string) =>
    url.endsWith("/old")
      ? new Response(null, { status: 302, headers: { location: "/new" } })
      : page("<p>moved here</p>")) as unknown as typeof fetch;
  const moved = await fetchPage("https://example.com/old", {}, relative);
  eq("a relative redirect is followed", [moved.url, moved.text], ["https://example.com/new", "moved here"]);

  // Pages to text.
  const html = `<html><head><title>x</title><style>p{}</style></head><body><script>alert(1)</script>
    <h1>Members</h1><table><tr><th>Name</th><th>Phone</th></tr><tr><td>Rep. Kim</td><td>(202) 555-0100</td></tr></table>
    <p>More at <a href="https://www.house.gov">House</a> &amp; elsewhere.</p></body></html>`;
  const text = htmlToText(html);
  eq("table cells stay tab-separated", text.includes("Rep. Kim\t(202) 555-0100"), true);
  eq("links keep where they go", text.includes("[https://www.house.gov]"), true);
  eq("entities decoded", text.includes("& elsewhere"), true);
  eq("no script or style", /alert|p\{\}/.test(text), false);

  // Long pages come in parts.
  const long = `<p>${"a".repeat(7000)}</p>`;
  const one = (async () => page(long)) as unknown as typeof fetch;
  const first = await fetchPage("https://example.com/long", {}, one);
  eq("first part fits in a tool result", first.text.length <= 5200 && first.nextOffset === first.text.length, true);
  const second = await fetchPage("https://example.com/long", { offset: first.nextOffset ?? 0 }, one);
  eq("second part continues and ends", [second.offset, second.nextOffset === null || second.nextOffset > second.offset], [first.nextOffset, true]);

  // Non-text and oversized responses are refused, not dumped into the model.
  const image = (async () => new Response("x", { headers: { "content-type": "image/png" } })) as unknown as typeof fetch;
  eq("images aren't read as text", await refusedAsync(() => fetchPage("https://example.com/a.png", {}, image)), "That link isn't a page OVOA can read as text.");
  const huge = (async () => page("x", { headers: { "content-type": "text/html", "content-length": "9000000" } })) as unknown as typeof fetch;
  eq("too big by header", await refusedAsync(() => fetchPage("https://example.com/big", {}, huge)), "That page is too big to read.");

  // It's a web tool: offered with web_search, and a pasted link brings it along.
  const web = webAssistant({} as never, "u", "America/New_York");
  eq("offered with web_search", web.tools.map((t) => t.name), ["web_search", "fetch_url"]);
  eq("a pasted link names it", namedTools(web.tools, "what does this link say https://example.com/x").map((t) => t.name), ["fetch_url"]);

  // The per-reply limit, and a refused address answers as an error, not a throw.
  globalThis.fetch = (async () => page("<p>hi</p>")) as typeof fetch;
  const results: unknown[] = [];
  for (let i = 0; i < 7; i++) results.push(await web.callTool("fetch_url", { url: "https://example.com/" }));
  eq("six reads a reply, then a stop", (results[6] as { error?: string }).error?.startsWith("That's the 6 page reads"), true);
  const web2 = webAssistant({} as never, "u", "America/New_York");
  eq("a private link is an error for the model", await web2.callTool("fetch_url", { url: "http://127.0.0.1/" }), { error: "That address isn't public." });

  console.log(fails ? `\n${fails} failed` : "\nall passed");
  if (fails) process.exit(1);
}

main();
