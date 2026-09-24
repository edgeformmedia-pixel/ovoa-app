import {
  appGoals,
  emptyMade,
  goalKey,
  OBJECTIVE_IDS,
  OBJECTIVES,
  REQUIRED,
  type Effect,
  type Made,
  type ObjectiveId,
  type Priority,
} from "./objectives";
import type { Update } from "./protocol";

// Where a setup conversation is, between turns (the AI-led setup, 2026-09-23).
// One JSON blob in profile.setup_state, versioned by profile.setup_rev
// (migration 0047_setup_state.sql), and saved compare-and-swap: two turns can
// run at once (a reply talked over while its update is still streaming keeps
// running on the server; streamTurn's `gone` only stops the voice), and a
// whole-blob save would otherwise lose one turn's fills. A save that finds the
// rev moved reloads, merges the same update again and retries.
//
// Everything here but the four database functions at the bottom is pure, so
// the rules (what counts as covered, when setup is over) are tested without a
// model or a database.

/** From this answer on, the state tells the model to wrap up once the required ones are covered. */
export const SOFT_TURNS = 9;
/** Setup ends after this many answers, whatever is still open. */
export const HARD_TURNS = 14;
/** Apps made for goals, per setup: each is a model call (myapps.ts designApp). */
export const MAX_GOAL_APPS = 3;
/** A goal app still being made this long after it started is shown as failed (its waitUntil is long gone). */
export const APP_STALE_MS = 3 * 60_000;
/** Lines of conversation kept for the prompt. Cleared at finish, and swept with the state after 14 days. */
const KEEP_LINES = 24;

export type Status = "open" | "partial" | "low" | "filled" | "declined";
export type Slot = {
  status: Status;
  value?: unknown;
  asked: number;
  updatedAt?: number;
  fromBefore?: boolean;
  /** A list's items (by key) sent marked unsure and not yet sent again without it: never stored. */
  unsure?: string[];
};
/** One side of the conversation. `turn`: the turnId it came from, so a retried request replays rather than runs again. */
export type Line = { role: "user" | "ovoa"; text: string; at: number; turn?: string };
export type FinishHow = "complete" | "stopped" | "later" | "budget";

export type SetupState = {
  v: 1;
  /** 'restart': gone through again from Settings, with what was stored before filled in. */
  mode: "first" | "restart";
  startedAt: number;
  updatedAt: number;
  /** Their answers so far (a Skip counts). */
  turns: number;
  slots: Record<ObjectiveId, Slot>;
  /** What the last reply asked about. */
  asking: ObjectiveId[];
  transcript: Line[];
  /** From the last turn: values that didn't fit and stores that failed, for the model to fix. */
  problems: string[];
  /** The last reply's update didn't parse: the next state block asks for it again. */
  lostUpdate: boolean;
  made: Made;
  lastTurn?: { id: string; reply: string };
  finished?: { at: number; how: FinishHow; open: ObjectiveId[] };
};

/** profile.setup_apps: one entry per goal, written only by the app job (turn.ts), one key per statement. */
export type SetupAppEntry = {
  goal: string;
  detail: string;
  status: "queued" | "made" | "failed" | "full";
  appId?: string;
  name?: string;
  /** When it was queued, or last claimed to be made. */
  at: number;
  tries: number;
};
export type SetupApps = Record<string, SetupAppEntry>;

/** What the phone gets: no values it doesn't show, and nothing to count down with. */
export type SetupView = {
  /** Setup is over (finished, put off, or done before): the app moves on. */
  done: boolean;
  /** Nothing said yet: the app picks a voice and starts, rather than resuming. */
  fresh: boolean;
  mode: SetupState["mode"];
  turns: number;
  /** What OVOA's last reply asked about. */
  asking: ObjectiveId[];
  /** Every objective, in order. `resolved`: covered, for the phone's "So far" list; `shown`: its value in a few words. */
  objectives: { id: ObjectiveId; label: string; priority: Priority; status: Status; resolved: boolean; shown?: string; fromBefore?: boolean }[];
  /** For the phone to add to its menu: "calorie". */
  addons: string[];
  apps: { goal: string; status: "making" | "made" | "failed" | "full"; name?: string; id?: string }[];
  finished?: SetupState["finished"];
};

export function freshState(accountName: string, now: number, mode: SetupState["mode"] = "first"): SetupState {
  const slots = Object.fromEntries(OBJECTIVE_IDS.map((id) => [id, { status: "open", asked: 0 } as Slot])) as Record<ObjectiveId, Slot>;
  // The name on their account, to confirm rather than ask: 'low' until they do.
  // Sign in with Apple can make an account with no name, and then it's open.
  const first = accountName.trim().split(/\s+/)[0];
  if (first) slots.name = { status: "low", value: { call: first }, asked: 0 };
  return { v: 1, mode, startedAt: now, updatedAt: now, turns: 0, slots, asking: [], transcript: [], problems: [], lostUpdate: false, made: emptyMade() };
}

/** A null the model wrote for "not heard yet" is the same as leaving the field out. */
function dropNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.filter((x) => x !== null).map(dropNulls);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, dropNulls(x)]));
  return v;
}

/** Covered: filled or declined, or unsure where unsure is good enough (Def.lowResolves). */
export const isResolved = (id: ObjectiveId, slot: Slot) =>
  slot.status === "filled" || slot.status === "declined" || (slot.status === "low" && !!OBJECTIVES[id].lowResolves);

/** Whether the model may wrap up: every required objective covered. */
export function readyToWrap(state: SetupState) {
  const open = REQUIRED.filter((id) => !isResolved(id, state.slots[id]));
  return { ready: !open.length, open };
}

/**
 * Apps for the goals heard so far, up to MAX_GOAL_APPS, each once. Only called
 * once the talk has moved off goals (or at finish), so "a gallon, no, two
 * litres" makes one app, not two; a goal reworded after that keeps the key its
 * app was queued under (goalKey).
 */
function goalJobs(s: SetupState): Effect[] {
  const out: Effect[] = [];
  for (const g of appGoals(s.slots.goals.value)) {
    const key = goalKey(g);
    if (!key || s.made.goals.includes(key) || s.made.goals.length >= MAX_GOAL_APPS) continue;
    s.made.goals.push(key);
    out.push({ kind: "app", key, goal: g.goal, detail: g.detail ?? "" });
  }
  return out;
}

/**
 * One turn's update applied to the state: each fill checked and merged by its
 * objective, and the stores it calls for. A value marked unsure is kept as
 * 'low' and stores nothing until it's sent again without the mark (the model
 * checks it with them first): a misheard phone number is never texted at SOS.
 * The stores are for the whole merged value, not only the new part, so one
 * confirmed after being unsure is stored whole; every store is idempotent
 * (objectives.ts applyEffects).
 *
 * In a list (reminders, goals, facts) unsure is kept per item: a misheard
 * "Vitamin B" isn't stored as a medication because "Vitamin D" came after it
 * (2026-09-23 review). An item still unsure when the list is next filled
 * without the mark, and not sent again, was never confirmed: it's taken out,
 * and the model is told.
 */
export function mergeUpdate(state: SetupState, update: Update, now: number) {
  const s: SetupState = structuredClone(state);
  const effects: Effect[] = [];
  const problems: string[] = [];
  for (const id of update.decline) {
    if (!(id in update.fill)) s.slots[id] = { ...s.slots[id], status: "declined", updatedAt: now };
  }
  for (const id of OBJECTIVE_IDS) {
    if (!(id in update.fill)) continue;
    const raw = dropNulls(update.fill[id]);
    const o = OBJECTIVES[id];
    const slot = s.slots[id];
    const declined = slot.status === "declined";
    const merged = o.merge(declined ? undefined : slot.value, raw);
    problems.push(...merged.problems);
    if (!merged.changed) continue;
    const unsure = update.unsure.includes(id) || !!merged.unsure;
    const touched = merged.touched ?? [];
    let { value, status } = merged;
    let waiting: string[] = [];
    if (o.without) {
      const before = declined ? [] : (slot.unsure ?? []);
      if (unsure) waiting = [...new Set([...before, ...touched])];
      else {
        const stale = before.filter((k) => !touched.includes(k));
        if (stale.length && value !== undefined) {
          const kept = o.without(value, stale);
          ({ value, status } = kept);
          if (kept.dropped.length) problems.push(`${id}: left out, as it was never confirmed: ${kept.dropped.join(", ")}`);
        }
      }
    }
    s.slots[id] = {
      status: status === "filled" && unsure ? "low" : status,
      ...(value !== undefined && { value }),
      asked: slot.asked,
      updatedAt: now,
      ...(waiting.length && { unsure: waiting }),
    };
    if (!unsure && value !== undefined) effects.push(...o.effects(value, raw, touched));
  }
  // Unsure with nothing new: a value they're about to be asked to confirm.
  for (const id of update.unsure) {
    if (!(id in update.fill) && s.slots[id].status === "filled") s.slots[id] = { ...s.slots[id], status: "low" };
  }
  for (const id of update.asking) s.slots[id] = { ...s.slots[id], asked: s.slots[id].asked + 1 };
  s.asking = update.asking;
  if (s.slots.goals.status === "filled" && !update.asking.includes("goals")) effects.push(...goalJobs(s));
  s.problems = problems;
  s.lostUpdate = false;
  s.updatedAt = now;
  return { state: s, effects, problems };
}

/**
 * Whether this turn ends setup. An early wrap-up is honoured, with what was
 * still open written down: they've already heard the goodbye, and a setup that
 * carries on after it is one they hang up on. The prompt is told beforehand
 * whether it may wrap up (stateBlock's "Ready to wrap up").
 */
export function finishDecision(state: SetupState, update: Update | null): Exclude<FinishHow, "later"> | null {
  if (update?.end === "stop") return "stopped";
  if (update?.end === "complete") return "complete";
  if (state.turns >= HARD_TURNS) return "budget";
  return null;
}

/**
 * Setup over: what was still open written down, the conversation cleared (it
 * holds contact numbers and medication names), apps queued for any goals not
 * yet made, and the values still marked unsure stored where that's safe (a
 * wake time, work, workouts; never a contact, a medication or the name). A
 * list's items never confirmed are taken out, so what's left counts as it is:
 * goals heard for sure still get their apps.
 */
export function finishState(state: SetupState, how: FinishHow, now: number) {
  const s: SetupState = structuredClone(state);
  const effects: Effect[] = [];
  for (const id of OBJECTIVE_IDS) {
    const o = OBJECTIVES[id];
    let slot = s.slots[id];
    if (slot.unsure?.length && o.without && slot.value !== undefined && slot.status !== "declined") {
      const { unsure, value, ...rest } = slot;
      const kept = o.without(value, unsure);
      slot = s.slots[id] = { ...rest, status: kept.status, ...(kept.value !== undefined && { value: kept.value }) };
    }
    if (slot.status === "low" && o.applyLow && slot.value !== undefined) effects.push(...o.effects(slot.value, {}, []));
  }
  if (s.slots.goals.status === "filled") effects.push(...goalJobs(s));
  s.finished = { at: now, how, open: readyToWrap(s).open };
  s.transcript = [];
  s.asking = [];
  s.updatedAt = now;
  return { state: s, effects };
}

/**
 * Skip: what the last reply asked about, still uncovered, is declined. `ids`:
 * the ones a Skip already named, applied again to a state reloaded after a
 * conflict (whose own `asking` may be another turn's).
 */
export function declineAsked(state: SetupState, now: number, ids: ObjectiveId[] = state.asking) {
  const skipped = ids.filter((id) => !isResolved(id, state.slots[id]));
  if (!skipped.length) return { state, skipped };
  const s: SetupState = structuredClone(state);
  for (const id of skipped) s.slots[id] = { ...s.slots[id], status: "declined", updatedAt: now };
  return { state: s, skipped };
}

/** Their words and the reply, onto the conversation. `answered`: it was their answer (or a Skip), and counts. */
export function appendTurn(state: SetupState, lines: Line[], answered: boolean, now: number): SetupState {
  return {
    ...state,
    transcript: [...state.transcript, ...lines].slice(-KEEP_LINES),
    turns: state.turns + (answered ? 1 : 0),
    updatedAt: now,
  };
}

/** The reply already given to this turnId, for a request sent twice: no second model call, no second store. */
export function replayIfSame(state: SetupState, turnId: string): string | null {
  if (state.lastTurn?.id === turnId) return state.lastTurn.reply;
  return state.transcript.find((l) => l.role === "ovoa" && l.turn === turnId)?.text ?? null;
}

/** A goal app as the phone shows it. 'queued' is being made, until it has been too long. */
function appView(e: SetupAppEntry, now: number): SetupView["apps"][number] {
  if (e.status === "made") return { goal: e.goal, status: "made", ...(e.name && { name: e.name }), ...(e.appId && { id: e.appId }) };
  if (e.status === "queued") return { goal: e.goal, status: now - e.at > APP_STALE_MS ? "failed" : "making" };
  return { goal: e.goal, status: e.status };
}

export const appsView = (apps: SetupApps, now: number) => Object.values(apps).map((e) => appView(e, now));

export function viewOf(state: SetupState, apps: SetupApps, now: number, done = !!state.finished): SetupView {
  return {
    done,
    fresh: !state.transcript.length && !state.turns,
    mode: state.mode,
    turns: state.turns,
    asking: state.asking,
    objectives: OBJECTIVE_IDS.map((id) => {
      const o = OBJECTIVES[id];
      const slot = state.slots[id];
      const shown = slot.value !== undefined && slot.status !== "declined" ? String(o.show(slot.value)).slice(0, 200) : "";
      return {
        id,
        label: o.label,
        priority: o.priority,
        status: slot.status,
        resolved: isResolved(id, slot),
        ...(shown && { shown }),
        ...(slot.fromBefore && { fromBefore: true }),
      };
    }),
    addons: state.made.addons,
    apps: appsView(apps, now),
    ...(state.finished && { finished: state.finished }),
  };
}

// ---------- Stored ----------

/** A stored blob as a state, whatever version of this file wrote it. Null when it isn't one. */
function readState(text: string | null): SetupState | null {
  if (!text) return null;
  try {
    const s = JSON.parse(text) as SetupState;
    if (s?.v !== 1 || !s.slots) return null;
    for (const id of OBJECTIVE_IDS) s.slots[id] ??= { status: "open", asked: 0 };
    s.made = { ...emptyMade(), ...s.made };
    s.transcript ??= [];
    s.problems ??= [];
    s.asking ??= [];
    return s;
  } catch {
    return null;
  }
}

export function readApps(text: string | null): SetupApps {
  try {
    const v = text ? JSON.parse(text) : {};
    return v && typeof v === "object" && !Array.isArray(v) ? (v as SetupApps) : {};
  } catch {
    return {};
  }
}

export type Loaded = { state: SetupState | null; rev: number; onboardedAt: number | null; apps: SetupApps };

/** The setup state, its rev, whether setup is done, and the goal apps. Makes the profile row for someone who has none. */
export async function loadSetup(db: D1Database, userId: string): Promise<Loaded> {
  await db.prepare("INSERT OR IGNORE INTO profile (user_id, updated_at) VALUES (?, ?)").bind(userId, Date.now()).run();
  const row = await db
    .prepare("SELECT onboarded_at, setup_state, setup_rev, setup_apps FROM profile WHERE user_id = ?")
    .bind(userId)
    .first<{ onboarded_at: number | null; setup_state: string | null; setup_rev: number | null; setup_apps: string | null }>();
  return { state: readState(row?.setup_state ?? null), rev: row?.setup_rev ?? 0, onboardedAt: row?.onboarded_at ?? null, apps: readApps(row?.setup_apps ?? null) };
}

/** Compare-and-swap: saved only if nobody saved since `rev` was read. False on a conflict. */
export async function saveSetup(db: D1Database, userId: string, state: SetupState, rev: number) {
  const res = await db
    .prepare("UPDATE profile SET setup_state = ?, setup_rev = setup_rev + 1, updated_at = ? WHERE user_id = ? AND setup_rev = ?")
    .bind(JSON.stringify(state), Date.now(), userId, rev)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * Load, change, save; on a conflict, load and change again (up to three
 * retries). `change` is pure and is run again on whatever the other turn left,
 * so both turns' fills end up saved. `fresh`: the state to start from when
 * there is none yet.
 */
export async function updateSetup<T>(
  db: D1Database,
  userId: string,
  change: (current: SetupState) => { state: SetupState; out: T },
  fresh: () => SetupState,
): Promise<{ state: SetupState; out: T }> {
  for (let attempt = 0; ; attempt++) {
    const loaded = await loadSetup(db, userId);
    const next = change(loaded.state ?? fresh());
    if (await saveSetup(db, userId, next.state, loaded.rev)) return next;
    if (attempt >= 3) throw new Error("setup: the saved state kept changing under this turn");
  }
}

/**
 * The 14-day rule (retention.ts, docs/retention.md): a setup left untouched for
 * RETAIN_DAYS goes, conversation and all. It can hold an emergency number and
 * medication names, and someone who starts and never comes back would
 * otherwise keep them there for good. What setup stored is in tables of its
 * own and stays. The rev moves, so a turn still in flight starts over rather
 * than writing the old state back. Returns the rows cleared.
 */
export async function sweepStaleSetup(db: D1Database, cutoff: number) {
  const { meta } = await db
    .prepare(
      `UPDATE profile SET setup_state = NULL, setup_apps = NULL, setup_rev = setup_rev + 1
        WHERE setup_state IS NOT NULL
          AND CASE WHEN json_valid(setup_state) THEN COALESCE(json_extract(setup_state, '$.updatedAt'), 0) ELSE 0 END < ?`,
    )
    .bind(cutoff)
    .run();
  return meta.changes ?? 0;
}
