import { generateText } from "../llm";
import { localMinutes } from "../time";
import type { Env } from "../types";
import { googleAccessToken, listGoogleAccounts, type GoogleAccount } from "./oauth";
import { toolsByName } from "./tools";

// Picking the right Google account without being told (F34).
//
// Before: the default account unless the user named another. Now each account
// has a profile learned from its own mail and calendar (what domains it writes
// to, what its events are about, when it's busy), and a request that doesn't
// name an account is scored against each. A clear winner is used and named in
// the reply; a close call falls back to the default and says so. Anything that
// sends mail or invites people still waits for approval, whatever was picked.

/** Relearned this often; a new account is learned on first use. */
const RELEARN_MS = 7 * 86_400_000;
/** Below this lead over the runner-up, the default account is used instead. */
const CONFIDENT_GAP = 2;

const FREE_MAIL = new Set(["gmail.com", "googlemail.com", "icloud.com", "me.com", "outlook.com", "hotmail.com", "yahoo.com", "proton.me", "protonmail.com", "aol.com"]);
const PERSONAL_WORDS = /\b(mum|mom|dad|doctor|dentist|gym|birthday|dinner|date night|kids?|school pickup|vacation|holiday|family|wedding)\b/i;

export type AccountProfile = {
  account_id: string;
  email_domain: string | null;
  contact_domains: string;
  topics: string;
  work_start: number | null;
  work_end: number | null;
  learned_at: number | null;
};

const domainOf = (email: string) => email.split("@")[1]?.toLowerCase().trim() ?? "";
const emails = (text: string) => [...text.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/g)].map((m) => m[0].toLowerCase());
const list = (json: string) => {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};

/** Learns one account's profile from its last sent mail and its calendar. */
export async function learnAccountProfile(env: Env, userId: string, account: GoogleAccount, timeZone: string) {
  const ctx = { token: await googleAccessToken(env, userId, account.id), timeZone };
  const [sent, events] = await Promise.all([
    account.scopes.some((s) => s.includes("mail"))
      ? (toolsByName.get("gmail_search")!.run(ctx, { query: "in:sent newer_than:60d", maxResults: 20 }).catch(() => []) as Promise<{ to?: string; subject?: string }[]>)
      : Promise.resolve([]),
    account.scopes.some((s) => s.includes("calendar"))
      ? (toolsByName
          .get("calendar_list_events")!
          .run(ctx, { start: new Date(Date.now() - 30 * 86_400_000).toISOString(), end: new Date(Date.now() + 14 * 86_400_000).toISOString(), maxResults: 50 })
          .catch(() => []) as Promise<{ title?: string; start?: string }[]>)
      : Promise.resolve([]),
  ]);

  const counts = new Map<string, number>();
  for (const m of sent) for (const e of emails(m.to ?? "")) {
    const d = domainOf(e);
    if (d && !FREE_MAIL.has(d)) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  const contactDomains = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([d]) => d);

  const timed = events.filter((e) => e.start?.includes("T")).map((e) => localMinutes(Date.parse(e.start!), timeZone)).sort((a, b) => a - b);
  const workStart = timed.length >= 5 ? timed[Math.floor(timed.length * 0.1)] : null;
  const workEnd = timed.length >= 5 ? timed[Math.floor(timed.length * 0.9)] : null;

  let topics: string[] = [];
  const titles = [...events.map((e) => e.title), ...sent.map((m) => m.subject)].filter(Boolean).slice(0, 60);
  if (titles.length) {
    try {
      const raw = await generateText(env, {
        model: env.MEMORY_MODEL,
        fast: true,
        json: { schema: { type: "object", properties: { topics: { type: "array", items: { type: "string" } } }, required: ["topics"] } },
        system: "Give up to ten single lowercase words that say what this account's calendar and mail are about (e.g. standup, client, sprint, gym, dinner). No names of people.",
        turns: [{ role: "user", text: JSON.stringify(titles) }],
      });
      topics = ((JSON.parse(raw) as { topics?: string[] }).topics ?? []).map((t) => t.toLowerCase().trim()).filter(Boolean).slice(0, 10);
    } catch {
      topics = [];
    }
  }

  await env.DB.prepare(
    `INSERT INTO account_profiles (account_id, user_id, email_domain, contact_domains, topics, work_start, work_end, learned_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET email_domain = excluded.email_domain, contact_domains = excluded.contact_domains,
       topics = excluded.topics, work_start = excluded.work_start, work_end = excluded.work_end, learned_at = excluded.learned_at`,
  )
    .bind(account.id, userId, domainOf(account.email), JSON.stringify(contactDomains), JSON.stringify(topics), workStart, workEnd, Date.now())
    .run();
}

/** Nightly: relearn any account that hasn't been looked at in a week. */
export async function relearnAccounts(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT g.user_id, s.time_zone FROM google_accounts g JOIN settings s ON s.user_id = g.user_id
       LEFT JOIN account_profiles p ON p.account_id = g.id
      WHERE p.learned_at IS NULL OR p.learned_at < ?
      GROUP BY g.user_id HAVING COUNT(*) >= 1`,
  )
    .bind(Date.now() - RELEARN_MS)
    .all<{ user_id: string; time_zone: string | null }>();
  let learned = 0;
  for (const u of results) {
    const accounts = await listGoogleAccounts(env.DB, u.user_id);
    if (accounts.length < 2) continue;
    for (const a of accounts) {
      await learnAccountProfile(env, u.user_id, a, u.time_zone ?? "UTC").catch((err) => console.error("routing: couldn't learn an account", err));
      learned++;
    }
  }
  return learned;
}

export type Pick = { account: GoogleAccount; confident: boolean; why: string };

/**
 * Scores each account for one request. Pure: the request is the tool's own
 * arguments, `at` the event time if it has one.
 *
 *   +4 a recipient or attendee is at the account's domain or a domain it writes to
 *   +2 per topic word in the title, subject or body
 *   +1 the event falls inside the account's usual hours
 *   -2 personal words (mum, dentist, gym…) on an account tagged work
 */
export function scoreAccounts(
  accounts: GoogleAccount[],
  profiles: AccountProfile[],
  args: Record<string, unknown>,
  timeZone: string,
): Pick {
  const text = [args.title, args.summary, args.subject, args.body, args.description, args.notes].filter((v) => typeof v === "string").join(" ").toLowerCase();
  const people = emails([args.to, args.cc, args.attendees].flat().filter(Boolean).join(" "));
  const at = typeof args.start === "string" ? Date.parse(args.start) : NaN;
  const fallback = accounts.find((a) => a.isDefault) ?? accounts[0];

  const scored = accounts.map((a) => {
    const p = profiles.find((x) => x.account_id === a.id);
    const why: string[] = [];
    let score = 0;
    if (p) {
      const domains = new Set([p.email_domain, ...list(p.contact_domains)].filter((d): d is string => !!d && !FREE_MAIL.has(d)));
      const match = people.find((e) => domains.has(domainOf(e)));
      if (match) {
        score += 4;
        why.push(`${match} is someone it writes to`);
      }
      const topics = list(p.topics).filter((t) => t.length > 2 && new RegExp(`\\b${t.replace(/[^a-z0-9]/g, "")}`).test(text));
      if (topics.length) {
        score += 2 * Math.min(topics.length, 2);
        why.push(`it's about ${topics.slice(0, 2).join(" and ")}`);
      }
      if (!Number.isNaN(at) && p.work_start != null && p.work_end != null) {
        const m = localMinutes(at, timeZone);
        if (m >= p.work_start && m <= p.work_end) score += 1;
      }
    }
    if (a.label?.toLowerCase() === "work" && PERSONAL_WORDS.test(text)) {
      score -= 2;
      why.push("it sounds personal");
    }
    return { a, score, why };
  });
  scored.sort((x, y) => y.score - x.score);
  const [best, next] = scored;
  if (!best || best.score - (next?.score ?? 0) < CONFIDENT_GAP || best.score <= 0) {
    return { account: fallback, confident: false, why: "nothing in the request pointed to one account" };
  }
  return { account: best.a, confident: true, why: best.why.join("; ") };
}

/** Loads the profiles and scores. Profiles missing for an account are learned on the spot, once. */
export async function pickAccountFor(env: Env, userId: string, accounts: GoogleAccount[], args: Record<string, unknown>, timeZone: string) {
  const { results } = await env.DB.prepare("SELECT * FROM account_profiles WHERE user_id = ?").bind(userId).all<AccountProfile>();
  const missing = accounts.filter((a) => !results.some((p) => p.account_id === a.id));
  for (const a of missing.slice(0, 2)) await learnAccountProfile(env, userId, a, timeZone).catch(() => {});
  const profiles = missing.length
    ? (await env.DB.prepare("SELECT * FROM account_profiles WHERE user_id = ?").bind(userId).all<AccountProfile>()).results
    : results;
  return scoreAccounts(accounts, profiles, args, timeZone);
}
