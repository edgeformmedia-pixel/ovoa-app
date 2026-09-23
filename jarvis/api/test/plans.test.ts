// Plans (plans.ts): which route needs which plan, how a tier is worked out and
// remembered, what happens when the site is down, the override, and the
// allowance arithmetic. Checked without a Worker; the database and the site
// are small fakes that count what was asked of them.

import {
  ALLOWANCES,
  allowanceFor,
  allowanceMessage,
  BASE_DAILY_CEILING_MICRO,
  BASE_REPLIES_PER_DAY,
  fetchMembership,
  forgetPlan,
  loadPlan,
  needsPlanBody,
  nextUtcMidnight,
  parseMembership,
  PLAN_FRESH_MS,
  PLAN_GRACE_MS,
  planFromRow,
  planView,
  PRO_DAILY_CEILING_MICRO,
  PRO_REPLIES_PER_DAY,
  resetPhrase,
  SPOKEN_REPLY_MICRO,
  spendStopMicro,
  tierForRoute,
  type PlanRow,
} from "../src/plans";
import type { Env } from "../src/types";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const g = typeof got === "object" ? JSON.stringify(got) : got;
  const w = typeof want === "object" ? JSON.stringify(want) : want;
  const ok = g === w;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${g}${ok ? "" : `  (wanted ${w})`}`);
}

// ---------- The route table ----------

eq("chat is base", tierForRoute("POST", "/chat"), "base");
eq("resuming a turn is base", tierForRoute("POST", "/chat/resume"), "base");
eq("Siri is base", tierForRoute("POST", "/siri"), "base");
eq("the brief is base", tierForRoute("GET", "/brief"), "base");
eq("voicing is base", tierForRoute("POST", "/voice/speak"), "base");
eq("a clip is base", tierForRoute("POST", "/voice/transcribe"), "base");
eq("a live-listening token is base", tierForRoute("POST", "/voice/token"), "base");
eq("the wake word's token is pro", tierForRoute("POST", "/voice/token", (k) => (k === "mode" ? "wake" : undefined)), "pro");
eq("email and calendar are base", tierForRoute("POST", "/google/connect"), "base");
eq("approving an email is base", tierForRoute("POST", "/actions/abc/approve"), "base");
eq("the timeline is base", tierForRoute("POST", "/context/blocks"), "base");
eq("a timeline day is base", tierForRoute("GET", "/context/days/2026-09-22"), "base");
eq("setting up background work is pro", tierForRoute("POST", "/agent/jobs"), "pro");
eq("running it now is pro", tierForRoute("POST", "/agent/jobs/j1/run"), "pro");
eq("a standing goal is pro", tierForRoute("POST", "/agent/goals"), "pro");
eq("seeing what the agent did is free", tierForRoute("GET", "/agent/runs"), "free");
eq("pausing it is free", tierForRoute("PATCH", "/agent/jobs/j1"), "free");
eq("/me is free", tierForRoute("GET", "/me"), "free");
eq("settings are free", tierForRoute("PATCH", "/me"), "free");
eq("refreshing the plan is free", tierForRoute("POST", "/me/plan/refresh"), "free");
eq("notes are free", tierForRoute("POST", "/notes"), "free");
eq("a note is free", tierForRoute("PATCH", "/notes/n1"), "free");
eq("heart rate is free", tierForRoute("POST", "/hr"), "free");
eq("workouts are free", tierForRoute("GET", "/workouts"), "free");
eq("steps are free", tierForRoute("PUT", "/steps"), "free");
eq("emergency contacts are free", tierForRoute("POST", "/contacts"), "free");
eq("push registration is free", tierForRoute("POST", "/push/token"), "free");
eq("the phone's state is free", tierForRoute("PUT", "/device/state"), "free");
eq("the home feed is free", tierForRoute("GET", "/feed"), "free");
eq("reporting mic seconds is free (it has to be, to be counted)", tierForRoute("POST", "/usage/stream"), "free");
eq("deleting anything is free", tierForRoute("DELETE", "/google"), "free");
eq("including the account", tierForRoute("DELETE", "/me"), "free");
eq("money is base (assistant, no model: the safer side)", tierForRoute("POST", "/money/afford"), "base");
eq("an unknown route is base, never free by accident", tierForRoute("POST", "/something/new"), "base");

// ---------- What the row says ----------

const NOW = Date.UTC(2026, 8, 22, 18);
const row = (p: Partial<PlanRow> = {}): PlanRow => ({
  email: "a@example.com",
  plan_tier: null,
  plan_status: null,
  plan_checked_at: null,
  plan_trial_ends_at: null,
  plan_renews_at: null,
  plan_override: null,
  ...p,
});

eq("the override beats everything", planFromRow(row({ plan_override: "base", plan_tier: "pro", plan_checked_at: NOW }), NOW, true).plan.tier, "base");
eq("and never asks the site", planFromRow(row({ plan_override: "free" }), NOW, true).ask, false);
eq("a pro override reads as comp", planFromRow(row({ plan_override: "pro" }), NOW, true).plan.status, "comp");
eq("a free override has nothing to comp", planFromRow(row({ plan_override: "free" }), NOW, true).plan.status, "none");
eq("the override beats the missing key too", planFromRow(row({ plan_override: "free" }), NOW, false).plan.tier, "free");
eq("no key: pro", planFromRow(row(), NOW, false).plan, { tier: "pro", status: "comp", trialEndsAt: null, renewsAt: null, from: "no_key" });
eq("no key: never asks", planFromRow(row(), NOW, false).ask, false);
eq("never asked: free for now, and ask", planFromRow(row(), NOW, true), {
  plan: { tier: "free", status: "none", trialEndsAt: null, renewsAt: null, from: "fallback" },
  ask: true,
});
const answered = row({ plan_tier: "base", plan_status: "trialing", plan_trial_ends_at: "2026-09-29", plan_checked_at: NOW - 60_000 });
eq("asked a minute ago: the cache", planFromRow(answered, NOW, true).plan.from, "cache");
eq("and no need to ask", planFromRow(answered, NOW, true).ask, false);
eq("with the trial date kept", planFromRow(answered, NOW, true).plan.trialEndsAt, "2026-09-29");
eq("ten minutes on: ask again", planFromRow(answered, NOW + PLAN_FRESH_MS, true).ask, true);
eq("but keep the tier meanwhile", planFromRow(answered, NOW + PLAN_FRESH_MS, true).plan.tier, "base");
eq("23 hours on (site down): still base", planFromRow(answered, NOW + 23 * 3_600_000, true).plan.tier, "base");
eq("marked stale", planFromRow(answered, NOW + 23 * 3_600_000, true).plan.from, "stale");
eq("a day on: free", planFromRow(answered, NOW - 60_000 + PLAN_GRACE_MS, true).plan.tier, "free");
eq("a junk status reads as none", planFromRow(row({ plan_tier: "pro", plan_status: "gold", plan_checked_at: NOW }), NOW, true).plan.status, "none");
eq("a junk override is ignored", planFromRow(row({ plan_override: "gold" }), NOW, false).plan.from, "no_key");

// ---------- What the site says ----------

eq("a good answer", parseMembership({ tier: "pro", status: "active", trialEndsAt: null, renewsAt: "2026-10-22", source: "stripe" }), {
  tier: "pro",
  status: "active",
  trialEndsAt: null,
  renewsAt: "2026-10-22",
});
eq("a tier it doesn't know is not an answer", parseMembership({ tier: "gold" }), null);
eq("nothing is not an answer", parseMembership(null), null);

type Call = { url: string; auth: string | null };
function site(answer: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    calls.push({ url, auth: new Headers(init.headers).get("authorization") });
    return answer();
  };
  return { calls, fetcher };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const env0 = { MEMBERSHIP_API_KEY: "k", MEMBERSHIP_URL: "https://test.example/api/public/membership" };

{
  const s = site(() => json({ tier: "base", status: "trialing", trialEndsAt: "2026-09-29", renewsAt: null, source: "band_trial" }));
  const got = await fetchMembership(env0, "A+b@example.com", s.fetcher);
  eq("the site's answer comes back", got?.tier, "base");
  eq("asked at the configured URL, email encoded", s.calls[0].url, "https://test.example/api/public/membership?email=A%2Bb%40example.com");
  eq("with the key as a bearer", s.calls[0].auth, "Bearer k");
}
eq("404: no such member, free", (await fetchMembership(env0, "a@example.com", site(() => new Response("", { status: 404 })).fetcher))?.tier, "free");
eq("500: couldn't say", await fetchMembership(env0, "a@example.com", site(() => new Response("", { status: 500 })).fetcher), null);
eq("unreachable: couldn't say", await fetchMembership(env0, "a@example.com", site(() => Promise.reject(new Error("down"))).fetcher), null);
eq("nonsense: couldn't say", await fetchMembership(env0, "a@example.com", site(() => json({ hello: 1 })).fetcher), null);

// ---------- Remembering it (loadPlan, with a fake users table) ----------

function fakeDb(r: PlanRow) {
  const writes: unknown[][] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              return /FROM users/.test(sql) ? { ...r } : null;
            },
            async run() {
              if (/UPDATE users SET plan_tier/.test(sql)) {
                writes.push(args);
                [r.plan_tier, r.plan_status, r.plan_checked_at, r.plan_trial_ends_at, r.plan_renews_at] = args as [string, string, number, string, string];
              }
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  return { db, writes, row: r };
}
const envWith = (db: unknown, key = "k") => ({ ...env0, MEMBERSHIP_API_KEY: key, DB: db }) as unknown as Env;
const U = "user-1";

{
  forgetPlan();
  const f = fakeDb(row());
  const s = site(() => json({ tier: "pro", status: "active", trialEndsAt: null, renewsAt: "2026-10-22" }));
  const first = await loadPlan(envWith(f.db), U, { now: NOW, fetcher: s.fetcher });
  eq("first look: asks the site", s.calls.length, 1);
  eq("and says pro", first?.plan.tier, "pro");
  eq("and keeps the answer", f.row.plan_checked_at, NOW);
  await loadPlan(envWith(f.db), U, { now: NOW + 2 * 60_000, fetcher: s.fetcher });
  eq("two minutes on: from the cache, no second ask", s.calls.length, 1);
  const later = await loadPlan(envWith(f.db), U, { now: NOW + PLAN_FRESH_MS + 1, fetcher: s.fetcher });
  eq("ten minutes on: asks again", s.calls.length, 2);
  eq("still pro", later?.plan.from, "site");
  await loadPlan(envWith(f.db), U, { now: NOW + PLAN_FRESH_MS + 2, force: true, fetcher: s.fetcher });
  eq("a refresh always asks", s.calls.length, 3);
}

{
  forgetPlan();
  const f = fakeDb(row({ plan_tier: "base", plan_status: "active", plan_checked_at: NOW }));
  const down = site(() => Promise.reject(new Error("ovoa.ai is down")));
  const hour = await loadPlan(envWith(f.db), U, { now: NOW + 3_600_000, fetcher: down.fetcher });
  eq("site down an hour later: tried", down.calls.length, 1);
  eq("and the last answer stands", hour?.plan.tier, "base");
  eq("marked stale", hour?.plan.from, "stale");
  eq("and the failure doesn't move the clock", f.row.plan_checked_at, NOW);
  forgetPlan(U); // past this isolate's memory of the person, but inside the site's backoff
  await loadPlan(envWith(f.db), U, { now: NOW + 3_600_000 + 30_000, fetcher: down.fetcher });
  eq("not asked again inside the backoff", down.calls.length, 1);
  const dayLater = await loadPlan(envWith(f.db), U, { now: NOW + PLAN_GRACE_MS + 5 * 60_000, fetcher: down.fetcher });
  eq("a day later, still down: free", dayLater?.plan.tier, "free");
  const back = site(() => json({ tier: "base", status: "active", trialEndsAt: null, renewsAt: null }));
  const again = await loadPlan(envWith(f.db), U, { now: NOW + PLAN_GRACE_MS + 10 * 60_000, fetcher: back.fetcher });
  eq("and base again the moment it answers", again?.plan.tier, "base");
}

{
  forgetPlan();
  const f = fakeDb(row({ plan_override: "pro", plan_tier: "free", plan_checked_at: NOW }));
  const s = site(() => json({ tier: "free", status: "none" }));
  const got = await loadPlan(envWith(f.db), U, { now: NOW + PLAN_FRESH_MS * 3, force: true, fetcher: s.fetcher });
  eq("override: pro, whatever the site says", got?.plan.tier, "pro");
  eq("and the site isn't asked, even on a refresh", s.calls.length, 0);
}

{
  forgetPlan();
  const f = fakeDb(row());
  const s = site(() => json({ tier: "free", status: "none" }));
  const got = await loadPlan(envWith(f.db, ""), U, { now: NOW, fetcher: s.fetcher });
  eq("no key: pro without asking", `${got?.plan.tier} ${s.calls.length}`, "pro 0");
}

// ---------- The allowance arithmetic ----------

eq("one spoken reply: $0.0022 + $0.0066 + $0.0028", SPOKEN_REPLY_MICRO, 11_600);
eq("Base at its cap stays under $0.25", BASE_REPLIES_PER_DAY * SPOKEN_REPLY_MICRO <= 250_000, true);
eq("Pro at its cap stays under $0.65", PRO_REPLIES_PER_DAY * SPOKEN_REPLY_MICRO <= 650_000, true);
eq("the ceilings are the spec's", `${BASE_DAILY_CEILING_MICRO} ${PRO_DAILY_CEILING_MICRO}`, "250000 650000");
eq("Pro is at least two and a half times Base", PRO_REPLIES_PER_DAY >= 2.5 * BASE_REPLIES_PER_DAY, true);
eq("and 3x would break the ceiling (why it isn't)", 3 * BASE_REPLIES_PER_DAY * SPOKEN_REPLY_MICRO > 650_000, true);
eq("new work stops one reply short of the ceiling", spendStopMicro("base"), 250_000 - 11_600);
eq("so the last reply can't cross it", spendStopMicro("pro") + SPOKEN_REPLY_MICRO <= PRO_DAILY_CEILING_MICRO, true);
eq("free has nothing", ALLOWANCES.free.replies, 0);

eq("base, fresh day", allowanceFor("base", 0, 0), { limit: 20, used: 0, left: 20, over: null });
eq("base, 19 used", allowanceFor("base", 19, 100_000).left, 1);
eq("base, 20 used: over on replies", allowanceFor("base", 20, 100_000), { limit: 20, used: 20, left: 0, over: "replies" });
eq("base, an hour of mic: over on spend", allowanceFor("base", 2, 288_000).over, "spend");
eq("pro, the same hour: fine", allowanceFor("pro", 2, 288_000).over, null);
eq("free: always over", allowanceFor("free", 0, 0).over, "replies");

const evening = Date.UTC(2026, 8, 22, 18); // 1 PM in Chicago, 8 PM in Berlin
eq("resets at the next UTC midnight", new Date(nextUtcMidnight(evening)).toISOString(), "2026-09-23T00:00:00.000Z");
eq("which is this evening in Chicago", resetPhrase(evening, "America/Chicago"), "at 7:00 PM");
eq("and tomorrow in Berlin", resetPhrase(evening, "Europe/Berlin"), "at 2:00 AM tomorrow");
eq(
  "said plainly, with the number",
  allowanceMessage(allowanceFor("base", 20, 0), evening, "America/Chicago"),
  "That's all 20 of today's replies on your plan, so I'll pick up again at 7:00 PM.",
);
eq(
  "or the allowance, when the spend ran out first",
  allowanceMessage(allowanceFor("base", 3, 300_000), evening, "America/Chicago"),
  "I've used up today's allowance on your plan, so I'll pick up again at 7:00 PM.",
);

// ---------- What the app is told ----------

eq("the 402 body", Object.keys(needsPlanBody("base")).join(","), "error,needs,message");
eq("keyed on error", needsPlanBody("pro").error, "needs_plan");
const view = planView({ tier: "base", status: "active", trialEndsAt: null, renewsAt: "2026-10-22", from: "site" }, allowanceFor("base", 5, 0), evening);
eq("/me.plan, base", view, {
  tier: "base",
  status: "active",
  trialEndsAt: null,
  renewsAt: "2026-10-22",
  limits: { repliesLeftToday: 15, resetsAt: "2026-09-23T00:00:00.000Z" },
  features: { chat: true, voice: true, wake: false, agent: false },
});
eq("a development account has no daily number", planView({ tier: "pro", status: "comp", trialEndsAt: null, renewsAt: null, from: "no_key" }, null, evening).limits.repliesLeftToday, null);

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
