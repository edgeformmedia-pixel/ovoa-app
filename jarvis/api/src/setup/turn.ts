import { z } from "zod";
import { validTimeZone } from "../google/assistant";
import { listGoogleAccounts } from "../google/oauth";
import { AI_UNREACHABLE, chatWithTools, generateText, isAiUnreachable, isModelRefused, type EngineAttempt, type LlmUsage } from "../llm";
import { designApp, saveApp } from "../myapps";
import { noteEngines, say } from "../obs";
import { glmPriceFrom } from "../pricing";
import { routinesChanged } from "../routines";
import { sentenceStream } from "../sentences";
import { settingsFor } from "../settings";
import { llmRow, recordUsage } from "../usage";
import type { Env } from "../types";
import { VOICES } from "../voice";
import { applyEffects, OBJECTIVES, storedValues, type Effect, type Made } from "./objectives";
import { parseUpdate, replySplitter, type Update } from "./protocol";
import { eventLine, EXTRACT_SYSTEM, NO_WORDS, SETUP_SYSTEM, stateBlock, transcriptTurns } from "./prompt";
import {
  appendTurn,
  appsView,
  declineAsked,
  finishDecision,
  finishState,
  freshState,
  loadSetup,
  mergeUpdate,
  readApps,
  replayIfSame,
  updateSetup,
  viewOf,
  type FinishHow,
  type Line,
  type SetupAppEntry,
  type SetupState,
  type SetupView,
} from "./state";

// One turn of the AI-led setup (2026-09-23): the model says what it likes and
// fills in what it learned, and the server checks, stores and decides when
// setup is over. It runs the way a spoken Talk turn does: one streamed call on
// the spoken-turn engines (chatWithTools voice: Workers AI's GLM first, no
// thinking), each sentence out as soon as it's written, voiced by streamTurn in
// index.ts. The routes (index.ts POST /onboarding/turn; onboarding.ts state,
// finish, restart) and the nightly purge call only this file's exports.
//
// It writes no turn row, so setup doesn't use the day's replies (the user's
// call); the model gate's spend ceiling still applies to every call (plans.ts
// modelGate), and the route asks it before streaming so a refusal comes back
// as the 402/403/429 the app already handles.

// For the routes and the nightly purge, from one place.
export { sweepStaleSetup } from "./state";
export type { FinishHow, SetupView } from "./state";

export const setupTurnSchema = z
  .object({
    /** Made by the phone per request. The same one again replays the reply: no second call, nothing stored twice. */
    turnId: z.string().min(8).max(64),
    /** start: the call begins. resume: they came back. answer: their words. skip: they pressed Skip. */
    action: z.enum(["start", "resume", "answer", "skip"]),
    text: z.string().trim().min(1).max(1000).optional(),
    typed: z.boolean().optional(),
    timeZone: z.string().max(64).optional(),
    stream: z.boolean().optional(),
    speak: z.object({ voice: z.enum(VOICES) }).optional(),
  })
  .refine((d) => d.action !== "answer" || !!d.text, { message: "An answer needs its words", path: ["text"] });
export type SetupTurnInput = z.infer<typeof setupTurnSchema>;

export type SetupMeta = {
  ms: number;
  turn: number;
  engine?: string;
  firstSentenceMs?: number | null;
  /** The reply's own update was read. */
  parsed: boolean;
  /** It wasn't, and the second call read the exchange instead. */
  extracted?: boolean;
  /** The objectives the update filled in, by id: what the probe (scripts/setup-probe.mjs) counts. */
  fillIds?: string[];
  /** What the turn's model calls cost, as a Talk turn's meta.usage.microUsd. */
  usage?: { microUsd: number };
  /** Engines tried, "workers:ok", as a Talk turn's meta. */
  tried?: string;
  replayed?: boolean;
  unreachable?: boolean;
};
export type SetupTurnResult = { reply: string; view: SetupView; meta: SetupMeta };

type Ctx = Pick<ExecutionContext, "waitUntil">;

/** A time zone Intl knows, as sent, or null. Garbage isn't written down as UTC. */
const zoneOf = (raw: string | undefined) => (raw && validTimeZone(raw) === raw ? raw : null);

const accountNameOf = async (db: D1Database, userId: string) =>
  (await db.prepare("SELECT name FROM users WHERE id = ?").bind(userId).first<{ name: string }>())?.name ?? "";

/** A reply said again, sentence by sentence, for a request that came twice. */
function sayAgain(reply: string, onSentence?: (s: string) => void) {
  if (!onSentence) return;
  const s = sentenceStream(onSentence, Infinity);
  s.push(reply);
  s.end();
}

/**
 * What applyEffects made, onto whatever the state holds now: its routines,
 * contact and memories win, and a routine it turned off is gone from the map.
 */
function joinMade(now: Made, before: Made, after: Made): Made {
  const routines = { ...now.routines, ...after.routines };
  for (const key of Object.keys(before.routines)) if (!(key in after.routines)) delete routines[key];
  return {
    routines,
    contactId: after.contactId ?? now.contactId,
    memories: { ...now.memories, ...after.memories },
    goals: [...new Set([...now.goals, ...after.goals])],
    addons: [...new Set([...now.addons, ...after.addons])],
  };
}

/**
 * Stores what one turn (or a finish) called for, then writes down what the
 * stores made and anything that failed, for the next turn's model to fix.
 * Goal apps are queued here and made in the background.
 */
async function store(env: Env, ctx: Ctx, userId: string, saved: SetupState, effects: Effect[], accountName: string) {
  const applied = await applyEffects(env, userId, effects, { accountName, made: saved.made });
  if (applied.routinesChanged) ctx.waitUntil(routinesChanged(env, userId));
  if (applied.jobs.length) {
    await queueApps(env.DB, userId, applied.jobs);
    ctx.waitUntil(Promise.all(applied.jobs.map((j) => makeApp(env, userId, j.key))));
  }
  if (!applied.problems.length && JSON.stringify(applied.made) === JSON.stringify(saved.made)) return saved;
  const fresh = () => freshState(accountName, Date.now());
  const next = await updateSetup(
    env.DB,
    userId,
    (current) => ({
      state: { ...current, problems: [...current.problems, ...applied.problems], made: joinMade(current.made, saved.made, applied.made) },
      out: null,
    }),
    fresh,
  );
  return next.state;
}

/** Setup over, for the phone and for everything that asks whether they're set up (GET /me onboarded). */
const markOnboarded = (db: D1Database, userId: string, at: number) =>
  db.prepare("UPDATE profile SET onboarded_at = ?, step = NULL, updated_at = ? WHERE user_id = ?").bind(at, at, userId).run();

async function currentApps(db: D1Database, userId: string) {
  const row = await db.prepare("SELECT setup_apps FROM profile WHERE user_id = ?").bind(userId).first<{ setup_apps: string | null }>();
  return readApps(row?.setup_apps ?? null);
}

/**
 * One setup turn. `onSentence` gets each sentence of the reply as it's
 * written (streamTurn voices them); without it the reply comes back whole.
 * The model gate's refusals (plan, consent, spend) are thrown as ModelRefused,
 * for the route to answer.
 */
export async function setupTurn(
  env: Env,
  ctx: Ctx,
  userId: string,
  input: SetupTurnInput,
  onSentence?: (sentence: string) => void,
  requestId?: string,
): Promise<SetupTurnResult> {
  const started = Date.now();
  const db = env.DB;
  const zone = zoneOf(input.timeZone);
  const [loaded, accountName, settings, prefs, accounts] = await Promise.all([
    loadSetup(db, userId),
    accountNameOf(db, userId),
    db.prepare("SELECT assistant_name, time_zone FROM settings WHERE user_id = ?").bind(userId).first<{ assistant_name: string; time_zone: string | null }>(),
    settingsFor(env, userId),
    listGoogleAccounts(db, userId),
    // Written on every turn, long before anything is stored: setup can be a new
    // account's first request, and a medication reminder made in it is
    // scheduled in this zone (routines.ts timeZoneFor), not UTC.
    zone && db.prepare("UPDATE settings SET time_zone = ? WHERE user_id = ?").bind(zone, userId).run(),
  ]);
  const fresh = () => freshState(accountName, Date.now());
  const begun = loaded.state ?? fresh();

  // Before the check below: the goodbye of the turn that finished setup is replayed too.
  const replay = replayIfSame(begun, input.turnId);
  if (replay !== null) {
    sayAgain(replay, onSentence);
    say("setup", { rid: requestId, action: input.action, turn: begun.turns, replayed: "yes" });
    const view = viewOf(begun, loaded.apps, started, !!loaded.onboardedAt);
    return { reply: replay, view, meta: { ms: Date.now() - started, turn: begun.turns, parsed: false, replayed: true } };
  }
  // Done already (and not gone through again from Settings, which clears onboarded_at): nothing to ask.
  if (loaded.onboardedAt) {
    return { reply: "", view: viewOf(begun, loaded.apps, started, true), meta: { ms: Date.now() - started, turn: begun.turns, parsed: false } };
  }

  const answered = input.action === "answer" || input.action === "skip";
  const { state: shown, skipped } = input.action === "skip" ? declineAsked(begun, started) : { state: begun, skipped: [] };
  const event = input.action === "answer" ? null : eventLine(input.action, { mode: shown.mode, skipped });
  const block = stateBlock(shown, {
    assistantName: settings?.assistant_name || "OVOA",
    now: started,
    timeZone: zone ?? validTimeZone(settings?.time_zone),
    typed: !!input.typed,
    accountName,
    googleAccounts: accounts.map((a) => a.email),
    apps: appsView(loaded.apps, started),
    answering: answered,
  });
  const words = event ? event.prompt : `They said: "${input.text}"`;
  const theirs: Line = { role: "user", text: event ? event.note : input.text!, at: started, turn: input.turnId };
  const history = transcriptTurns(begun);
  const withReply = (reply: string, now: number) => (current: SetupState) =>
    appendTurn(current, [theirs, { role: "ovoa", text: reply, at: now, turn: input.turnId }], answered, now);

  const attempts: EngineAttempt[] = [];
  // Kept here rather than left to the usage sink, so the meta can say what the
  // turn cost; recorded the same way, once the turn is over.
  const usages: LlmUsage[] = [];
  let firstSentenceMs: number | null = null;
  let appended = false;
  let early: Promise<void> = Promise.resolve();
  /** One try at the reply. `nudge`: the last try said nothing out loud. */
  const ask = async (nudge: boolean) => {
    const splitter = replySplitter(
      (sentence) => {
        firstSentenceMs ??= Date.now() - started;
        onSentence?.(sentence);
      },
      (spoken) => {
        if (!spoken) return;
        // The words go into the conversation as soon as they're all out, while
        // the update is still being written: an answer given over that tail is
        // a new turn, which has to see the question it is answering.
        early = updateSetup(db, userId, (current) => ({ state: withReply(spoken, Date.now())(current), out: null }), fresh).then(
          () => void (appended = true),
          (err) => console.error("ovoa.err setup: couldn't save the reply early", err),
        );
      },
    );
    let engine: string | undefined;
    try {
      const outcome = await chatWithTools(env, {
        model: env.CHAT_MODEL,
        system: SETUP_SYSTEM,
        turns: [...history, { role: "user", text: `${block}\n${words}${nudge ? `\n${NO_WORDS}` : ""}` }],
        tools: [],
        callTool: async () => ({ error: "There are no tools in setup." }),
        voice: true,
        usage: { userId, purpose: "onboarding" },
        prefer: { order: prefs.engine_order, voice: prefs.voice_engine },
        onAttempt: (a) => attempts.push(a),
        onUsage: (u) => usages.push(u),
        onText: (delta) => splitter.push(delta),
      });
      engine = outcome.engine;
    } catch (err) {
      // Cut off while writing its update: every word was already said, so the
      // turn stands, with its update lost (the next state asks for it again).
      if (!splitter.trailer() || !splitter.spoken()) throw err;
      console.error("ovoa.err setup: the reply was cut off in its update", err);
    }
    splitter.end();
    return { splitter, engine };
  };

  let got: Awaited<ReturnType<typeof ask>>;
  try {
    got = await ask(false);
    // An update with no words before it: asked once more, told why.
    if (!got.splitter.spoken()) got = await ask(true);
  } catch (err) {
    if (!isAiUnreachable(err)) throw err;
    // Said plainly, the way a Talk turn says it (llm.ts). Nothing was said
    // before it (the engines only give up before a word) and nothing is saved:
    // the app offers Try again and Later.
    onSentence?.(AI_UNREACHABLE);
    say("setup", { rid: requestId, action: input.action, turn: begun.turns, ms: Date.now() - started, unreachable: "yes" });
    return {
      reply: AI_UNREACHABLE,
      view: viewOf(begun, loaded.apps, started),
      meta: { ms: Date.now() - started, turn: begun.turns, parsed: false, unreachable: true, tried: attempts.map((a) => `${a.engine}:${a.outcome}`).join(",") },
    };
  } finally {
    ctx.waitUntil(noteEngines(env, attempts));
    ctx.waitUntil(recordUsage(env, usages.map((u) => llmRow(userId, u, glmPriceFrom(env)))));
  }
  const reply = got.splitter.spoken();
  if (!reply) throw new Error("The setup reply had no spoken words, twice");

  let update = parseUpdate(got.splitter.trailer());
  const parsed = !!update;
  // No readable block (left off, or cut short): a small second call reads the
  // exchange and writes it, while the reply is still being spoken, so what they
  // said is kept either way (2026-09-23: 17 of 64 probe turns carried none, and
  // one reply said "I've got her down as your SOS contact" with nothing saved).
  if (!update) {
    const before = usages.length;
    update = await generateText(env, {
      model: env.CHAT_MODEL,
      system: EXTRACT_SYSTEM,
      turns: [{ role: "user", text: `${block}\n${words}\nOVOA replied: "${reply}"` }],
      voice: true,
      usage: { userId, purpose: "onboarding" },
      prefer: { order: prefs.engine_order, voice: prefs.voice_engine },
      onAttempt: (a) => attempts.push(a),
      onUsage: (u) => usages.push(u),
    })
      .then(parseUpdate)
      .catch((err) => {
        console.error("ovoa.err setup: couldn't read the update from the exchange", err);
        return null;
      });
    ctx.waitUntil(recordUsage(env, usages.slice(before).map((u) => llmRow(userId, u, glmPriceFrom(env)))));
  }
  await early;
  const saved = await updateSetup(
    db,
    userId,
    (current) => {
      const now = Date.now();
      let s = skipped.length ? declineAsked(current, now, skipped).state : current;
      if (!appended) s = withReply(reply, now)(s);
      let effects: Effect[] = [];
      if (update) ({ state: s, effects } = mergeUpdate(s, update, now));
      // Not read: the words stand, nothing is stored, and the next state says so.
      // What this reply asked about is unknown too: the last one's `asking`
      // left in place would have Skip decline a question nobody is asking
      // (2026-09-23 review), and keep the phone's Contacts picker up.
      else s = { ...s, lostUpdate: true, problems: [], asking: [], updatedAt: now };
      const how = finishDecision(s, update);
      if (how) {
        const f = finishState(s, how, now);
        s = f.state;
        effects = [...effects, ...f.effects];
      }
      if (update) s = { ...s, transcript: withUpdate(s.transcript, input.turnId, update) };
      return { state: { ...s, lastTurn: { id: input.turnId, reply } }, out: { effects, how } };
    },
    fresh,
  );
  const { how } = saved.out;
  const state = await store(env, ctx, userId, saved.state, saved.out.effects, accountName);
  if (how) {
    await markOnboarded(db, userId, Date.now());
    ctx.waitUntil(retryApps(env, userId));
  }
  const view = viewOf(state, await currentApps(db, userId), Date.now());
  const meta: SetupMeta = {
    ms: Date.now() - started,
    turn: state.turns,
    engine: got.engine,
    firstSentenceMs,
    parsed,
    extracted: !parsed && !!update,
    fillIds: update ? Object.keys(update.fill) : [],
    usage: { microUsd: usages.reduce((n, u) => n + (llmRow(userId, u, glmPriceFrom(env)).microUsd ?? 0), 0) },
    tried: attempts.map((a) => `${a.engine}:${a.outcome}`).join(","),
  };
  // Ids and counts only: problem lines and values carry phone numbers and medication names.
  say("setup", {
    rid: requestId,
    action: input.action,
    turn: state.turns,
    ms: meta.ms,
    firstSentence: firstSentenceMs ?? undefined,
    engine: got.engine,
    parsed: parsed ? "yes" : update ? "extracted" : "no",
    fills: update ? Object.keys(update.fill).join(",") || "none" : undefined,
    asking: update?.asking.join(",") || undefined,
    problems: state.problems.length || undefined,
    finished: how ?? undefined,
  });
  return { reply, view, meta };
}

/**
 * The update written onto this turn's OVOA line, compact: the next turn's
 * transcript shows the model its own replies with their blocks (Line.update).
 */
function withUpdate(transcript: SetupState["transcript"], turnId: string, update: Update) {
  const compact = JSON.stringify({
    fill: update.fill,
    ...(update.unsure.length && { unsure: update.unsure }),
    ...(update.decline.length && { decline: update.decline }),
    asking: update.asking,
    end: update.end,
  }).slice(0, 600);
  let i = transcript.length - 1;
  while (i >= 0 && !(transcript[i].role === "ovoa" && transcript[i].turn === turnId)) i--;
  return i < 0 ? transcript : transcript.map((l, j) => (j === i ? { ...l, update: compact } : l));
}

/** The view, with no model call: GET /onboarding/state. */
export async function setupViewFor(env: Env, userId: string): Promise<SetupView> {
  const [loaded, accountName] = await Promise.all([loadSetup(env.DB, userId), accountNameOf(env.DB, userId)]);
  const now = Date.now();
  return viewOf(loaded.state ?? freshState(accountName, now), loaded.apps, now, !!loaded.onboardedAt);
}

/**
 * Setup over without a model call: Later on the setup screen (POST
 * /onboarding/finish {reason}). What was said so far is kept and stored as a
 * finishing turn would, and it can be picked up again from Settings.
 */
export async function finishSetup(env: Env, ctx: Ctx, userId: string, how: FinishHow = "later"): Promise<SetupView> {
  const db = env.DB;
  const accountName = await accountNameOf(db, userId);
  const now = Date.now();
  const saved = await updateSetup(
    db,
    userId,
    (current) => {
      if (current.finished) return { state: current, out: [] as Effect[] };
      const f = finishState(current, how, now);
      return { state: f.state, out: f.effects };
    },
    () => freshState(accountName, now),
  );
  const state = await store(env, ctx, userId, saved.state, saved.out, accountName);
  await markOnboarded(db, userId, now);
  ctx.waitUntil(retryApps(env, userId));
  return viewOf(state, await currentApps(db, userId), Date.now(), true);
}

/**
 * Settings → go through setup again. What's stored is filled in as "from
 * before", so the model asks what to change rather than everything again;
 * goals, focus and facts come from the last setup when it's still there
 * (they aren't stored anywhere they can be read back from). Nothing already
 * set up is removed. The rev moves, so a turn of the old setup still in
 * flight can't write over this one.
 */
export async function restartSetup(env: Env, userId: string): Promise<SetupView> {
  const db = env.DB;
  const now = Date.now();
  const [accountName, stored, loaded] = await Promise.all([accountNameOf(db, userId), storedValues(env, userId), loadSetup(db, userId)]);
  const s = freshState(accountName, now, "restart");
  if (s.slots.name.value) s.slots.name = { ...s.slots.name, status: "filled", fromBefore: true };
  for (const [id, value] of Object.entries(stored.values) as [keyof typeof OBJECTIVES, unknown][]) {
    const merged = OBJECTIVES[id].merge(undefined, value);
    if (merged.value !== undefined) s.slots[id] = { status: merged.status, value: merged.value, asked: 0, fromBefore: true };
  }
  const before = loaded.state;
  for (const id of ["goals", "focus", "about"] as const) {
    const slot = before?.slots[id];
    if (slot?.value !== undefined && (slot.status === "filled" || slot.status === "partial")) {
      s.slots[id] = { status: slot.status, value: slot.value, asked: 0, fromBefore: true };
    }
  }
  s.made = { ...stored.made, goals: before?.made.goals ?? [], memories: before?.made.memories ?? {} };
  await db
    .prepare("UPDATE profile SET setup_state = ?, setup_apps = NULL, setup_rev = setup_rev + 1, onboarded_at = NULL, updated_at = ? WHERE user_id = ?")
    .bind(JSON.stringify(s), now, userId)
    .run();
  return viewOf(s, {}, now, false);
}

// ---------- Goal apps ----------
//
// An app is designed for each goal as soon as the talk moves on from goals, so
// the wrap-up can say it's being made (the user's call). designApp is a model
// call on the typed engines (7 s on average on Z.ai, up to 21 s, 2026-09-23),
// too slow to wait for in a turn, so it runs in waitUntil and writes its result
// to profile.setup_apps, one goal's key per statement, never the whole column:
// a turn's save of the state can't overwrite a result, and two jobs can't
// overwrite each other. A job that fails, or dies with its waitUntil, gets one
// more try when setup finishes.

/** The first try, and one more at finish. */
const APP_TRIES = 2;
/** A job claimed this long ago with no result died with its request (waitUntil runs ~30 s past the response). */
const APP_DEAD_MS = 60_000;

/** Adds each goal as 'queued', unless a racing turn already has. */
async function queueApps(db: D1Database, userId: string, jobs: Extract<Effect, { kind: "app" }>[]) {
  const at = Date.now();
  await db.batch(
    jobs.map((j) => {
      const entry: SetupAppEntry = { goal: j.goal, detail: j.detail, status: "queued", at, tries: 0 };
      return db
        .prepare(`UPDATE profile SET setup_apps = json_insert(COALESCE(setup_apps, '{}'), '$."' || ? || '"', json(?)) WHERE user_id = ?`)
        .bind(j.key, JSON.stringify(entry), userId);
    }),
  );
}

/** Makes one goal's app, if it's still to make and nobody else has just claimed it. */
async function makeApp(env: Env, userId: string, key: string) {
  const db = env.DB;
  const row = await db
    .prepare(`SELECT json_extract(setup_apps, '$."' || ? || '"') AS entry FROM profile WHERE user_id = ?`)
    .bind(key, userId)
    .first<{ entry: string | null }>();
  const entry = row?.entry ? (JSON.parse(row.entry) as SetupAppEntry) : null;
  if (!entry || entry.status === "made" || entry.status === "full" || entry.tries >= APP_TRIES) return;
  // Claimed by moving `tries` on from what was read: a second job reading the same entry finds it moved and stops.
  const claim: SetupAppEntry = { ...entry, status: "queued", at: Date.now(), tries: entry.tries + 1 };
  const took = await db
    .prepare(
      `UPDATE profile SET setup_apps = json_set(setup_apps, '$."' || ? || '"', json(?))
        WHERE user_id = ? AND json_extract(setup_apps, '$."' || ? || '".tries') = ?`,
    )
    .bind(key, JSON.stringify(claim), userId, key, entry.tries)
    .run();
  if (!took.meta.changes) return;
  let result: SetupAppEntry;
  try {
    const draft = await designApp(env, userId, `An app to help me with this: ${entry.goal}.${entry.detail ? ` ${entry.detail}` : ""}`);
    const app = await saveApp(db, userId, draft);
    result = app ? { ...claim, status: "made", appId: app.id, name: app.name } : { ...claim, status: "full" };
  } catch (err) {
    // The day's spend used up halfway is a refusal, not a fault: shown as failed, tried again at finish.
    if (!isModelRefused(err)) console.error("ovoa.err setup: couldn't make an app for a goal", err);
    result = { ...claim, status: "failed" };
  }
  // A setup started again since (restart, or the 14-day sweep) has no entry to write into, and gets none.
  await db
    .prepare(`UPDATE profile SET setup_apps = json_set(setup_apps, '$."' || ? || '"', json(?)) WHERE user_id = ?`)
    .bind(key, JSON.stringify(result), userId)
    .run();
}

/** At finish: the goals whose app failed, or whose job died, get their one more try. */
async function retryApps(env: Env, userId: string) {
  const apps = await currentApps(env.DB, userId);
  const now = Date.now();
  const due = Object.entries(apps).filter(
    ([, e]) => e.tries < APP_TRIES && (e.status === "failed" || (e.status === "queued" && now - e.at > APP_DEAD_MS)),
  );
  await Promise.all(due.map(([key]) => makeApp(env, userId, key)));
}
