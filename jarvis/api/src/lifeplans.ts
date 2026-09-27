import { validTimeZone } from "./google/assistant";
import type { CallTool, ToolSpec } from "./llm";
import { daysBetween } from "./money";
import { say } from "./obs";
import { reach } from "./reach";
import { inSlice, type Slice } from "./sweep";
import { addDays, buckets, localMinutes } from "./time";
import type { Env } from "./types";

// Plans they mention, followed up usefully (2026-09-26, docs/instinct-more.md).
//
// "I'm traveling to SF next month": OVOA keeps it as a plan (life_plans), gives
// a few concrete options (web_search), says when booking is usually cheapest
// (bookingAdvice, below) and offers to remind them to book, which on their yes
// is an ordinary OVOA reminder (reminder_set), texted first when it's due. It
// also writes one specific question for closer to the date ("Want me to find a
// dinner spot near Union Square for Friday?"), and plansTick texts it on that
// day, as an ask (reach.ts: paced, one a day at most). No model call in the
// background: the question was written with them there.

/** "Sunday, Oct 11" from 2026-10-11. Pure. */
export const humanDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "short", day: "numeric" });

const DAY_OK = /^\d{4}-\d{2}-\d{2}$/;
const day = (v: unknown) => (typeof v === "string" && DAY_OK.test(v.trim()) ? v.trim() : null);

export type Advice = {
  daysAway: number;
  /** In a sentence, for them. */
  advice: string;
  /** The day a "remind me to book" should be for, or null when now is the time. */
  remindOn: string | null;
  /** The day the follow-up question goes, unless they said otherwise. */
  followupOn: string | null;
};

/**
 * When booking is usually cheapest, from how far away it is. Rules of thumb,
 * said as such: domestic flights tend to be cheapest from about three weeks to
 * three months out and climb inside three weeks; international about two to six
 * months; refundable hotel rates can be booked early and rebooked. Pure.
 */
export function bookingAdvice(kind: string, startsOn: string | null, today: string): Advice {
  if (!startsOn) {
    return {
      daysAway: -1,
      advice: "Once you have dates: domestic flights are usually cheapest about 3 weeks to 3 months out, international about 2 to 6 months.",
      remindOn: null,
      followupOn: null,
    };
  }
  const daysAway = daysBetween(today, startsOn);
  const followupOn = daysAway > 10 ? addDays(startsOn, -5) : daysAway > 3 ? addDays(startsOn, -2) : null;
  if (kind !== "trip") {
    return { daysAway, advice: daysAway > 14 ? "Tickets and reservations for popular things tend to go early: worth booking in the next week or two." : "It's close: book whatever needs booking now.", remindOn: daysAway > 14 ? addDays(today, 7) : null, followupOn };
  }
  if (daysAway < 0) return { daysAway, advice: "That date has passed.", remindOn: null, followupOn: null };
  if (daysAway <= 21) {
    return { daysAway, advice: "It's under 3 weeks away, when flight prices usually climb fastest: book the flight now if you can, and a refundable hotel rate.", remindOn: null, followupOn };
  }
  // Inside the sweet spot, a few days before it closes; further out, a week before it opens for international.
  const remindOn = daysAway > 100 ? addDays(startsOn, -90) : daysAway > 35 ? addDays(startsOn, -35) : addDays(today, 2);
  return {
    daysAway,
    advice:
      daysAway > 100
        ? "Flights are usually cheapest about 3 weeks to 3 months out for domestic trips (2 to 6 months for international), so there's no rush yet; a refundable hotel can be booked any time."
        : "Flights are often cheapest around 3 weeks to 3 months out, so now through the next few weeks is a good window; prices tend to climb inside 3 weeks.",
    remindOn,
    followupOn,
  };
}

type PlanRow = {
  id: string;
  user_id: string;
  title: string;
  kind: string;
  place: string | null;
  starts_on: string | null;
  ends_on: string | null;
  detail: string | null;
  followup_on: string | null;
  followup_text: string | null;
  followed_up_at: number | null;
  status: string;
};

/** A generic check-in is no use: a follow-up names something to do. Pure. */
export function usefulQuestion(q: string) {
  const t = q.trim();
  if (t.length < 25 || !t.includes("?")) return false;
  return !/^(any (updates|news)|how('s| is) (it|everything) going|just checking in|anything (else|i can)|need anything)/i.test(t);
}

function specs(): ToolSpec[] {
  return [
    {
      name: "plan_add",
      description:
        "Keeps something they're planning (a trip, an event, a move) so you can follow up closer to the date. Returns when booking is usually cheapest and the day to remind them to book. Call it when they mention a plan with a place or a time.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short: \"SF trip\", \"Mom's 60th\"" },
          kind: { type: "string", enum: ["trip", "event", "other"] },
          place: { type: "string", description: "Where, e.g. San Francisco" },
          startsOn: { type: "string", description: "First day YYYY-MM-DD (best guess from what they said, e.g. mid next month; say it's a guess)" },
          endsOn: { type: "string", description: "Last day YYYY-MM-DD, if known" },
          detail: { type: "string", description: "What else they said: why, with whom, budget" },
          followupQuestion: {
            type: "string",
            description:
              "One specific, useful question to text them a few days before, that offers something concrete (\"Want me to find a dinner spot near your hotel for Friday night?\", \"Should I check if your flight has a cheaper fare to switch to?\"). Never a generic check-in.",
          },
          followupOn: { type: "string", description: "When to ask it, YYYY-MM-DD; leave out for a few days before" },
        },
        required: ["title", "kind"],
      },
    },
    {
      name: "plan_list",
      description: "Their plans (trips, events) still to come, with dates and the follow-up each has.",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "plan_update",
      description: "Changes a plan (new dates, place, follow-up), or marks it done or cancelled.",
      parameters: {
        type: "object",
        properties: {
          plan: { type: "string", description: "Which: its title or place" },
          status: { type: "string", enum: ["active", "done", "cancelled"] },
          startsOn: { type: "string" },
          endsOn: { type: "string" },
          place: { type: "string" },
          followupQuestion: { type: "string" },
          followupOn: { type: "string" },
        },
        required: ["plan"],
      },
    },
  ];
}

const NAMES = new Set(specs().map((t) => t.name));
export const isLifePlanTool = (name: string) => NAMES.has(name);

export function lifePlansAssistant(env: Env, userId: string, timeZone: string) {
  const db = env.DB;
  const find = async (said: string) => {
    const { results } = await db
      .prepare("SELECT * FROM life_plans WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC")
      .bind(userId)
      .all<PlanRow>();
    const w = said.toLowerCase().trim();
    const hits = results.filter((p) => `${p.title} ${p.place ?? ""}`.toLowerCase().includes(w) || w.includes(p.title.toLowerCase()));
    return hits.length === 1 ? hits[0] : hits.length ? { error: `Which one: ${hits.map((p) => p.title).join(", ")}?` } : results.length === 1 ? results[0] : { error: `No plan like "${said}". They have: ${results.map((p) => p.title).join(", ") || "none"}.` };
  };

  const callTool: CallTool = async (name, args) => {
    const today = buckets(Date.now(), timeZone).day;
    if (name === "plan_add") {
      const title = String(args.title ?? "").trim().slice(0, 80);
      if (!title) return { error: "title is needed" };
      const kind = ["trip", "event", "other"].includes(String(args.kind)) ? String(args.kind) : "other";
      const startsOn = day(args.startsOn);
      const endsOn = day(args.endsOn);
      if (startsOn && startsOn < today) return { error: "startsOn has passed. Ask for the date." };
      const tip = bookingAdvice(kind, startsOn, today);
      const question = String(args.followupQuestion ?? "").trim().slice(0, 400);
      const followupOn = day(args.followupOn) ?? tip.followupOn;
      const useful = question && usefulQuestion(question);
      const now = Date.now();
      const id = crypto.randomUUID();
      await db
        .prepare(
          `INSERT INTO life_plans (id, user_id, title, kind, place, starts_on, ends_on, detail, followup_on, followup_text, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .bind(id, userId, title, kind, String(args.place ?? "").trim().slice(0, 80) || null, startsOn, endsOn, String(args.detail ?? "").trim().slice(0, 1_000) || null, useful && followupOn && followupOn > today ? followupOn : null, useful ? question : null, now, now)
        .run();
      say("plan", { outcome: "added", user: userId, kind });
      return {
        saved: title,
        ...(startsOn && { daysAway: tip.daysAway }),
        timing: tip.advice,
        ...(tip.remindOn && { remindToBookOn: tip.remindOn }),
        followUp: useful && followupOn && followupOn > today ? `On ${followupOn} you'll text them: "${question}"` : "none",
        note: [
          "Now be useful in this reply: give 2 or 3 concrete options (web_search for real ones: flights and typical fares, areas to stay, something to do), and say the timing advice in a sentence, as a rule of thumb.",
          tip.remindOn
            ? `End your reply with this exact offer: "Want me to remind you to book on ${humanDay(tip.remindOn)}?" Only if they say yes, call reminder_set for that day at 10:00 with the words "Book your ${title}${startsOn ? ` (${startsOn})` : ""}".`
            : `It's close, so say to book soon, and end your reply with this exact offer: "Want me to remind you tomorrow morning to book?" Only if they say yes, call reminder_set for tomorrow at 10:00 with the words "Book your ${title}".`,
          useful ? "" : "It has no follow-up: call plan_update with one specific followupQuestion (offer something concrete) if you can think of one.",
        ]
          .filter(Boolean)
          .join(" "),
      };
    }
    if (name === "plan_list") {
      const { results } = await db
        .prepare("SELECT * FROM life_plans WHERE user_id = ? AND status = 'active' ORDER BY COALESCE(starts_on, '9999')")
        .bind(userId)
        .all<PlanRow>();
      return {
        plans: results.map((p) => ({
          title: p.title,
          kind: p.kind,
          ...(p.place && { place: p.place }),
          ...(p.starts_on && { from: p.starts_on, daysAway: daysBetween(today, p.starts_on) }),
          ...(p.ends_on && { to: p.ends_on }),
          ...(p.followup_text && { followUp: p.followed_up_at ? "asked" : `${p.followup_on}: ${p.followup_text}` }),
        })),
      };
    }
    if (name === "plan_update") {
      const found = await find(String(args.plan ?? ""));
      if ("error" in found) return found;
      const status = ["active", "done", "cancelled"].includes(String(args.status)) ? String(args.status) : found.status;
      const question = args.followupQuestion !== undefined ? String(args.followupQuestion).trim().slice(0, 400) : found.followup_text;
      if (args.followupQuestion !== undefined && question && !usefulQuestion(question)) return { error: "That follow-up is a generic check-in: make it a specific question that offers something." };
      const startsOn = day(args.startsOn) ?? found.starts_on;
      const followupOn = day(args.followupOn) ?? (day(args.startsOn) ? bookingAdvice(found.kind, startsOn, today).followupOn : found.followup_on);
      await db
        .prepare("UPDATE life_plans SET status = ?, starts_on = ?, ends_on = ?, place = ?, followup_text = ?, followup_on = ?, followed_up_at = CASE WHEN ? <> COALESCE(followup_on, '') THEN NULL ELSE followed_up_at END, updated_at = ? WHERE id = ?")
        .bind(status, startsOn, day(args.endsOn) ?? found.ends_on, String(args.place ?? "").trim() || found.place, question || null, followupOn, followupOn ?? "", Date.now(), found.id)
        .run();
      return { updated: found.title, status, ...(startsOn && { from: startsOn }), ...(question && followupOn && { followUp: `${followupOn}: ${question}` }) };
    }
    return { error: `Unknown tool ${name}` };
  };

  return {
    tools: specs(),
    callTool,
    prompt: [
      "Plans: when they mention a trip or an event with a place or a time (\"I'm going to SF next month\"), call plan_add (a best-guess date is fine; say so) with one specific followupQuestion for a few days before. Then answer usefully: 2 or 3 concrete options (web_search for real flights, fares, neighborhoods, things to do), the timing advice plan_add gives as a rule of thumb (\"flights are often cheapest 3 weeks to 3 months out\"), and always end with the offer to remind them to book (plan_add gives the words); only on their yes, reminder_set for that day.",
      "A follow-up is never a generic check-in: it offers something specific you can do.",
    ].join("\n"),
  };
}

/**
 * The cron's follow-ups (index.ts runTick, the slow lane): each plan's one
 * question, on its day, between 9 and 8 their time, as an ask (reach.ts paces
 * it). Held for pacing: tried again on a later tick, until the plan starts.
 */
export async function plansTick(env: Env, slice?: Slice, now = Date.now()) {
  const db = env.DB;
  const { results } = await db
    .prepare(
      `SELECT p.*, s.time_zone FROM life_plans p JOIN settings s ON s.user_id = p.user_id
        WHERE p.status = 'active' AND p.followed_up_at IS NULL AND p.followup_text IS NOT NULL AND p.followup_on IS NOT NULL
          AND p.followup_on <= ? LIMIT 100`,
    )
    // The furthest-ahead time zone's today: finer checks per person below.
    .bind(addDays(new Date(now).toISOString().slice(0, 10), 1))
    .all<PlanRow & { time_zone: string | null }>();
  let asked = 0;
  for (const p of results) {
    if (!inSlice(p.user_id, slice)) continue;
    const tz = validTimeZone(p.time_zone);
    const today = buckets(now, tz).day;
    if (p.followup_on! > today) continue;
    if (p.starts_on && p.starts_on < today) {
      await db.prepare("UPDATE life_plans SET followed_up_at = ? WHERE id = ?").bind(now, p.id).run();
      continue;
    }
    const minutes = localMinutes(now, tz);
    if (minutes < 9 * 60 || minutes > 20 * 60) continue;
    const how = await reach(env, p.user_id, {
      kind: "followup",
      text: p.followup_text!,
      push: { title: p.title, body: p.followup_text!.slice(0, 180), data: { type: "plan", id: p.id } },
    });
    if (how === "held") continue;
    await db.prepare("UPDATE life_plans SET followed_up_at = ? WHERE id = ?").bind(now, p.id).run();
    asked++;
  }
  return { asked };
}
