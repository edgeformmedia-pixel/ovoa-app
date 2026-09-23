// The forwarder (../forwarder): the Worker left at the old address that hands
// every request to api.ovoa.ai. Checked with a stand-in fetch, so nothing here
// needs a network: what it sends on (address, method, headers, body, redirect
// handling) and that the answer comes back untouched, streams included.

import worker from "../../forwarder/src/index";
import { forwardHeaders, UPSTREAM, upstreamUrl } from "../../forwarder/src/forward";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${got}${ok ? "" : `  (wanted ${want})`}`);
}

const OLD = "https://jarvis-api.edgeformmedia.workers.dev";

// ---------- The address ----------

eq("upstream", UPSTREAM, "https://api.ovoa.ai");
eq("root", upstreamUrl(`${OLD}/`), "https://api.ovoa.ai/");
eq("path", upstreamUrl(`${OLD}/voice/speak`), "https://api.ovoa.ai/voice/speak");
eq("query kept as sent", upstreamUrl(`${OLD}/debug/logs?since=2h&kind=err&text=a%20b`), "https://api.ovoa.ai/debug/logs?since=2h&kind=err&text=a%20b");
eq("encoded path kept", upstreamUrl(`${OLD}/apps/a%2Fb/state`), "https://api.ovoa.ai/apps/a%2Fb/state");
eq("fragment dropped", upstreamUrl(`${OLD}/x?y=1#z`), "https://api.ovoa.ai/x?y=1");

// ---------- The headers ----------

const sent = new Headers({
  host: "jarvis-api.edgeformmedia.workers.dev",
  authorization: "Bearer abc",
  "content-type": "application/json",
  "x-device-id": "ios-123",
  "user-agent": "OVOA/44",
  "cf-connecting-ip": "203.0.113.9",
  "cf-ray": "abc-LHR",
  "cf-ipcountry": "GB",
});
const passed = forwardHeaders(sent);
eq("authorization passes", passed.get("authorization"), "Bearer abc");
eq("content-type passes", passed.get("content-type"), "application/json");
eq("custom headers pass", passed.get("x-device-id"), "ios-123");
eq("user-agent passes", passed.get("user-agent"), "OVOA/44");
eq("host is left to the URL", passed.get("host"), null);
eq("cf-connecting-ip is left to Cloudflare", passed.get("cf-connecting-ip"), null);
eq("no cf-* header passes", [...passed.keys()].some((k) => k.startsWith("cf-")), false);
eq("the caller's headers are not changed", sent.get("cf-ray"), "abc-LHR");

// ---------- The handler, with a stand-in fetch ----------

type Call = { url: string; init: RequestInit };
const calls: Call[] = [];
let reply: () => Response | Promise<Response> = () => new Response("ok");
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  calls.push({ url: String(input), init: init ?? {} });
  return reply();
}) as typeof fetch;

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const call = (request: Request) =>
  worker.fetch!(request as unknown as Parameters<NonNullable<typeof worker.fetch>>[0], {}, ctx) as Promise<Response>;

// A POST: method, headers and body all go on; redirects are not followed.
const upstream = new Response("from api.ovoa.ai");
reply = () => upstream;
const post = new Request(`${OLD}/chat?stream=1`, {
  method: "POST",
  headers: { authorization: "Bearer t", "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
  body: JSON.stringify({ text: "hello", n: 1 }),
});
const postBody = post.body;
const got = await call(post);
eq("one call", calls.length, 1);
eq("POST: to the new host, same path and query", calls[0].url, "https://api.ovoa.ai/chat?stream=1");
eq("POST: method", calls[0].init.method, "POST");
eq("POST: redirect manual", calls[0].init.redirect, "manual");
const h = new Headers(calls[0].init.headers as HeadersInit);
eq("POST: authorization", h.get("authorization"), "Bearer t");
eq("POST: no cf-connecting-ip", h.get("cf-connecting-ip"), null);
eq("POST: the body is the caller's stream, not a copy", calls[0].init.body, postBody);
eq("POST: the body arrives whole", await new Response(calls[0].init.body as BodyInit).text(), '{"text":"hello","n":1}');
eq("POST: the answer is the upstream Response itself", got, upstream);

// GET and HEAD carry no body.
calls.length = 0;
await call(new Request(`${OLD}/me`, { headers: { authorization: "Bearer t" } }));
await call(new Request(`${OLD}/health`, { method: "HEAD" }));
eq("GET: method", calls[0].init.method, "GET");
eq("GET: no body", calls[0].init.body, null);
eq("HEAD: no body", calls[1].init.body, null);

// DELETE, PATCH and PUT keep their method and body.
for (const method of ["DELETE", "PATCH", "PUT"]) {
  calls.length = 0;
  await call(new Request(`${OLD}/apps/1`, { method, body: `{"m":"${method}"}` }));
  eq(`${method}: method`, calls[0].init.method, method);
  eq(`${method}: body`, await new Response(calls[0].init.body as BodyInit).text(), `{"m":"${method}"}`);
}

// A redirect comes back as a redirect (the Google callback's 302 to ovoa://).
reply = () => new Response(null, { status: 302, headers: { location: "ovoa://google?connected=1" } });
const redirect = await call(new Request(`${OLD}/google/callback?code=c&state=s`));
eq("302 stays a 302", redirect.status, 302);
eq("its location is untouched", redirect.headers.get("location"), "ovoa://google?connected=1");

// A stream comes back piece by piece: the first line is readable before the last is written.
let push: (line: string) => void = () => {};
let end: () => void = () => {};
reply = () =>
  new Response(
    new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        push = (line) => controller.enqueue(enc.encode(line));
        end = () => controller.close();
      },
    }),
    { headers: { "content-type": "application/x-ndjson" } },
  );
const streamed = await call(new Request(`${OLD}/chat`, { method: "POST", body: "{}" }));
eq("stream: content type kept", streamed.headers.get("content-type"), "application/x-ndjson");
const reader = streamed.body!.getReader();
push('{"t":"delta","text":"Hi"}\n');
const first = await reader.read();
eq("stream: the first line arrives on its own", new TextDecoder().decode(first.value), '{"t":"delta","text":"Hi"}\n');
push('{"t":"done"}\n');
end();
const second = await reader.read();
eq("stream: then the next", new TextDecoder().decode(second.value), '{"t":"done"}\n');
eq("stream: then the end", (await reader.read()).done, true);

// Errors from the server come back as they are; only an unreachable server becomes a 502.
reply = () => new Response('{"error":"maintenance"}', { status: 503, headers: { "retry-after": "120" } });
const busy = await call(new Request(`${OLD}/me`));
eq("upstream 503 passes", busy.status, 503);
eq("with its headers", busy.headers.get("retry-after"), "120");
reply = () => {
  throw new TypeError("network down");
};
const realError = console.error;
console.error = () => {};
const down = await call(new Request(`${OLD}/me`));
console.error = realError;
eq("unreachable: 502", down.status, 502);
eq("unreachable: JSON with a sentence", ((await down.json()) as { error: string }).error, "unreachable");

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
