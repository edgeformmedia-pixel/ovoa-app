import { logAction, type ActionSource } from "./actionlog";
import { capabilities } from "./capabilities";
import type { ToolSpec } from "./llm";
import { push } from "./push";
import type { Env } from "./types";

// Reaching the wrist.
//
// The server can't talk to the band: only the phone can, over Bluetooth. So a
// buzz is a push the app acts on. With a band that reported in recently it is a
// silent push, and the app turns it into a vibration. Without one it is an
// ordinary notification with the reason in it — the same nudge, reaching the
// phone instead, which is the standalone rule in docs/feature-plan.md.
//
// The band itself freezes if it is sent commands too quickly, so the app spaces
// buzzes at least 30 s apart and drops repeats. Nothing here needs to know that.

export type BuzzPattern = "ack" | "double" | "reminder" | "meds" | "urgent";
export const BUZZ_PATTERNS: BuzzPattern[] = ["ack", "double", "reminder", "meds", "urgent"];

/** Buzzes the background agent may start on its own, per rolling hour. */
export const AGENT_BUZZ_PER_HOUR = 6;

export async function sendBuzz(
  env: Env,
  userId: string,
  pattern: BuzzPattern,
  reason: string,
  source: ActionSource = "system",
  refId?: string,
) {
  const caps = await capabilities(env.DB, userId);
  // The id lets the app ignore the second copy when iOS hands one push to both the
  // background task and the foreground listener.
  const data = { type: "buzz", id: crypto.randomUUID(), pattern, reason: reason.slice(0, 180) };
  const via = caps.band ? "band" : "notification";
  const sent = caps.band
    ? await push(env, userId, { silent: true, data })
    : await push(env, userId, { title: titleFor(pattern), body: reason.slice(0, 180), data, urgent: pattern === "urgent" });
  await logAction(env.DB, userId, "buzz", `${pattern} buzz (${via}): ${reason}`, source, refId);
  return { via, reached: sent > 0 };
}

const titleFor = (pattern: BuzzPattern) =>
  ({ ack: "OVOA", double: "OVOA", reminder: "Reminder", meds: "Medication", urgent: "OVOA — now" })[pattern];

/** How many buzzes the agent has sent in the last hour. Read from the action log, which every buzz writes to. */
export async function agentBuzzesLastHour(db: D1Database, userId: string) {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM action_log WHERE user_id = ? AND kind = 'buzz' AND source = 'agent' AND ts > ?")
    .bind(userId, Date.now() - 3_600_000)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export const agentBuzzTool: ToolSpec = {
  name: "agent_buzz",
  description: `Taps them on the wrist (or, with no band, sends a short phone notification). For something they should notice now without reading — a meeting starting, something about to be missed. It carries only a short reason, so still use agent_say for anything that needs explaining. At most ${AGENT_BUZZ_PER_HOUR} an hour; most runs should use none.`,
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        enum: BUZZ_PATTERNS,
        description: "ack: one tap. double: two, 'look at your phone'. reminder: a routine is due. meds: medication. urgent: about to be missed.",
      },
      reason: { type: "string", description: "Six words or fewer, shown if the buzz becomes a notification and written to the log." },
    },
    required: ["pattern", "reason"],
  },
};

/** The background agent's buzz, rate-limited and logged. */
export async function agentBuzz(env: Env, userId: string, args: Record<string, unknown>) {
  const pattern = String(args.pattern ?? "") as BuzzPattern;
  const reason = String(args.reason ?? "").trim();
  if (!BUZZ_PATTERNS.includes(pattern)) return { error: `pattern must be one of ${BUZZ_PATTERNS.join(", ")}` };
  if (!reason) return { error: "reason is required" };
  if ((await agentBuzzesLastHour(env.DB, userId)) >= AGENT_BUZZ_PER_HOUR) {
    return { error: `Already buzzed them ${AGENT_BUZZ_PER_HOUR} times this hour. Don't buzz again; use agent_say if it matters.` };
  }
  const result = await sendBuzz(env, userId, pattern, reason, "agent");
  return { buzzed: result.reached, via: result.via };
}
