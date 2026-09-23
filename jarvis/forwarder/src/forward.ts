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

/**
 * What an old build shows for the two refusals it can do nothing about. Builds
 * from before the move show a failed request's `error` as it is and never read
 * `message`, so "needs_consent" would be the whole of what they said; and they
 * have neither the consent screen nor the code box, so the way on is updating.
 */
export const FOR_OLD_BUILDS: Record<string, string> = {
  needs_consent: "Update OVOA from TestFlight: the new version asks for your OK before using AI.",
  needs_verification: "Update OVOA from TestFlight to enter the code we emailed you.",
};

/** A JSON 403 with one of those codes, its sentence under `error` and the code kept as `code`; anything else as it came. */
export async function forOldBuild(res: Response): Promise<Response> {
  if (res.status !== 403 || !/^application\/json/i.test(res.headers.get("content-type") ?? "")) return res;
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as Record<string, unknown> | null;
  const code = typeof body?.error === "string" ? body.error : "";
  const said = FOR_OLD_BUILDS[code];
  if (!body || !said) return res;
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify({ ...body, error: said, code }), { status: res.status, statusText: res.statusText, headers });
}

/**
 * Hands the request to api.ovoa.ai and returns its answer untouched, streams
 * and redirects included. The one exception: consent and verification
 * refusals are reworded for the old build (forOldBuild).
 */
export async function forward(request: Request): Promise<Response> {
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  try {
    const res = await fetch(upstreamUrl(request.url), {
      method: request.method,
      headers: forwardHeaders(request.headers),
      body: hasBody ? request.body : null,
      redirect: "manual",
    });
    return await forOldBuild(res);
  } catch (err) {
    // Only when api.ovoa.ai can't be reached at all; its own errors come back as they are.
    console.error("forward failed", err);
    return Response.json(
      { error: "unreachable", message: "OVOA can't be reached right now. Try again in a minute." },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
}
