// What the forwarder does to a request (index.ts says why it exists). Kept out
// of index.ts so the Worker's module exports only its handler, and so
// ../api/test/forwarder.test.ts can check it with a stand-in fetch.

/** Where the server lives now. */
export const UPSTREAM = "https://api.ovoa.ai";

/** The same path and query, on the new host. */
export function upstreamUrl(url: string) {
  const { pathname, search } = new URL(url);
  return `${UPSTREAM}${pathname}${search}`;
}

/** Every header the caller sent, except the ones Cloudflare writes itself on the next hop. */
export function forwardHeaders(from: Headers) {
  const headers = new Headers(from);
  for (const name of [...headers.keys()]) {
    if (name === "host" || name.startsWith("cf-")) headers.delete(name);
  }
  return headers;
}

/** Hands the request to api.ovoa.ai and returns its answer untouched, streams and redirects included. */
export async function forward(request: Request): Promise<Response> {
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  try {
    return await fetch(upstreamUrl(request.url), {
      method: request.method,
      headers: forwardHeaders(request.headers),
      body: hasBody ? request.body : null,
      redirect: "manual",
    });
  } catch (err) {
    // Only when api.ovoa.ai can't be reached at all; its own errors come back as they are.
    console.error("forward failed", err);
    return Response.json(
      { error: "unreachable", message: "OVOA can't be reached right now. Try again in a minute." },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
}
