// The moving switch (maintenance.ts): with it on, no request reaches the app
// and no tick reaches the crons; with it off, or unset, everything does.
// Checked with stand-in handlers, so nothing here needs a Worker or a database.

import { inMaintenance, MAINTENANCE_MESSAGE, maintenanceResponse, withMaintenance } from "../src/maintenance";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${got}${ok ? "" : `  (wanted ${want})`}`);
}

type TestEnv = { MAINTENANCE?: string };

// ---------- Reading the switch ----------

eq("unset is off", inMaintenance({}), false);
eq("the file's default is off", inMaintenance({ MAINTENANCE: "off" }), false);
eq("empty is off", inMaintenance({ MAINTENANCE: "" }), false);
eq("on is on", inMaintenance({ MAINTENANCE: "on" }), true);
eq("ON with spaces is on", inMaintenance({ MAINTENANCE: " ON " }), true);
eq("1 is on", inMaintenance({ MAINTENANCE: "1" }), true);
eq("true is on", inMaintenance({ MAINTENANCE: "true" }), true);
eq("0 is off", inMaintenance({ MAINTENANCE: "0" }), false);
eq("nonsense is off", inMaintenance({ MAINTENANCE: "maybe" }), false);

// ---------- The answer ----------

const res = maintenanceResponse();
eq("503", res.status, 503);
eq("JSON", res.headers.get("content-type")?.startsWith("application/json"), true);
eq("says when to try again", Number(res.headers.get("retry-after")) > 0, true);
eq("a browser may read it", res.headers.get("access-control-allow-origin"), "*");
eq("never cached", res.headers.get("cache-control"), "no-store");
const body = (await res.json()) as { error: string; message: string };
eq("error", body.error, "maintenance");
eq("message", body.message, "OVOA is moving to a new home. Back in a few minutes.");
eq("message is the exported one", body.message, MAINTENANCE_MESSAGE);

// ---------- The wrapper ----------

let fetched = 0;
let ticked = 0;
const worker = withMaintenance<TestEnv>({
  fetch: async () => {
    fetched++;
    return new Response("from the app");
  },
  scheduled: async () => {
    ticked++;
  },
});
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const controller = { cron: "*/2 * * * *", scheduledTime: Date.now(), noRetry: () => {} } as unknown as ScheduledController;
const request = (method: string, path: string) =>
  new Request(`https://api.ovoa.ai${path}`, method === "GET" ? { method } : { method, body: "{}" }) as unknown as Parameters<
    NonNullable<typeof worker.fetch>
  >[0];

const realLog = console.log;
const logged: string[] = [];

// On: nothing gets through, whatever the route or method.
const on: TestEnv = { MAINTENANCE: "on" };
for (const [method, path] of [
  ["GET", "/"],
  ["POST", "/chat"],
  ["POST", "/auth/login"],
  ["DELETE", "/me"],
  ["OPTIONS", "/chat"],
  ["GET", "/google/callback?code=x&state=y"],
]) {
  const r = await worker.fetch!(request(method, path), on, ctx);
  eq(`on: ${method} ${path} is 503`, r.status, 503);
}
eq("on: the app never ran", fetched, 0);
console.log = (...args: unknown[]) => void logged.push(args.join(" "));
await worker.scheduled!(controller, on, ctx);
await worker.scheduled!({ ...controller, cron: "13 4 * * *" } as ScheduledController, on, ctx);
console.log = realLog;
eq("on: no tick ran, the nightly one included", ticked, 0);
eq("on: a skipped tick says why", logged.some((l) => l.startsWith("ovoa.cron ") && l.includes("skipped=maintenance")), true);

// Off, or unset: everything goes through untouched.
for (const env of [{ MAINTENANCE: "off" }, {}] as TestEnv[]) {
  const label = env.MAINTENANCE ?? "unset";
  const r = await worker.fetch!(request("POST", "/chat"), env, ctx);
  eq(`${label}: the app answers`, await r.text(), "from the app");
  await worker.scheduled!(controller, env, ctx);
}
eq("off and unset: both requests reached the app", fetched, 2);
eq("off and unset: both ticks ran", ticked, 2);

// A handler without one of the two keeps it missing, rather than inventing one.
const fetchOnly = withMaintenance<TestEnv>({ fetch: async () => new Response("ok") });
eq("no scheduled handler invented", fetchOnly.scheduled, undefined);

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
