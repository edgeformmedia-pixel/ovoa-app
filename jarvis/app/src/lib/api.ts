import { fetch as streamingFetch } from "expo/fetch";
import { openAppId } from "./activeApp";
import { consentMissing, noteConsentNeeded, type AiConsent } from "./consent";
import { devlog } from "./devlog";

// The server (jarvis/api) on the ovoa.ai account since the v1 move. Builds from
// before it use jarvis-api.edgeformmedia.workers.dev, which forwards here until
// 2026-10-14 (jarvis/forwarder).
export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "https://api.ovoa.ai";

export type Settings = {
  assistantName: string;
  personality: string;
  memoryEnabled: boolean;
  stepGoal: number;
  autoApprove: boolean;
  /** The timeline of the day. Off until asked for. */
  contextEnabled: boolean;
  /** Whether OVOA does anything when nobody is talking to it. */
  agentEnabled: boolean;
  agentAutonomy: Autonomy;
  /** Minutes past local midnight. */
  quietStart: number;
  quietEnd: number;
  agentDailyRuns: number;
  /** Dev accounts only: the always-listening experiments. */
  captureEverything?: boolean;
};

/** Something that repeats: a medication, the dog, water. Medications come from Apple Reminders. */
export type Routine = {
  id: string;
  kind: "med" | "pet" | "habit" | "custom";
  title: string;
  /** Minutes past local midnight. */
  times: number[];
  /** 0 = Sunday. Empty means every day. */
  days: number[];
  when: string;
  buzzPattern: string;
  externalSource: string | null;
  externalId: string | null;
  nextDueAt: number | null;
  updatedAt: number;
  streak: number;
  today: { id: string; due_at: number; status: "pending" | "done" | "missed" | "snoozed" | "skipped" }[];
};

export type RoutineSync = {
  routines: Routine[];
  /** Added by voice or onboarding: the phone creates these in Reminders. */
  toCreate: { id: string; title: string; times: number[]; days: number[] }[];
  /** Confirmed in OVOA: the phone ticks these off in Reminders. */
  toWriteBack: { eventId: string; externalId: string; dueAt: number }[];
};

type Occurrence = { dueAt?: number; eventId?: string };

export type Place = {
  id: string;
  name: string | null;
  kind: "home" | "work" | "gym" | "other";
  lat: number;
  lng: number;
  radius: number;
  address: string | null;
  visit_count: number;
};

export type LineSource = "mic" | "assistant" | "recording" | "background";
export type TranscriptLine = { id: string; ts: number; text: string; source: LineSource };
export type TranscriptBlock = { start: number; at: string; title: string | null; summary: string | null; lines: number; sources: LineSource[] };
export type TranscriptHour = { hour: string; start: number; label: string; title: string | null; summary: string | null; blocks: TranscriptBlock[] };
export type TranscriptDay = { date: string; title: string | null; summary: string | null; hours: TranscriptHour[] };

/** One card on the home screen's feed (api/src/feed.ts). */
export type FeedCard =
  | { kind: "summary"; title: string; body: string; minutesSaved: number; counts: Record<string, number> }
  | { kind: "todos"; title: string; date: string; items: { id: string; text: string; done: boolean }[] }
  | { kind: "routines"; title: string; items: { id: string; title: string; at: string; dueAt: number; status: string; streak: number }[] }
  | { kind: "streak"; title: string; body: string; routineId: string }
  | { kind: "missed"; title: string; body: string; routineId: string }
  | { kind: "agent"; title: string; items: { at: string; text: string }[] }
  | { kind: "week"; title: string; body: string; minutesSaved: number }
  | { kind: "workout"; title: string; body: string; workoutId: string }
  | { kind: "memory"; title: string; body: string; day: string }
  | { kind: "favor"; title: string; body: string; commitmentId: string; unsure: boolean }
  | { kind: "activity"; title: string; items: { at: string; text: string; source: string }[] };

/** One line on a day's list. */
export type Todo = {
  id: string;
  date: string;
  text: string;
  source: "commitment" | "note" | "routine" | "carried" | "user";
  done: number;
  synced_to: string | null;
};

/** Something the background agent asked the phone to do, in words. */
export type QueuedCommand = { id: string; text: string; source: "agent" | "system"; reason: string | null; created_at: number };

/** What the server knows this user has; every feature picks its path from this. */
export type Capabilities = {
  band: boolean;
  google: boolean;
  health: boolean;
  watchHr: boolean;
  locationAlways: boolean;
  ambient: boolean;
  push: boolean;
};

export type DeviceState = {
  bandLinked: boolean;
  notifications?: "granted" | "denied" | "undetermined";
  health?: boolean;
  watchHr?: boolean;
  location?: "none" | "when_in_use" | "always";
  buzzOption?: number;
  build?: string;
  sleepHours?: number;
};

/** suggest: it looks and tells you. act: it may also make reversible changes. */
export type Autonomy = "off" | "suggest" | "act";

/**
 * The morning brief, as `buildMorningBrief` assembles it (api/src/rhythm.ts):
 * `text` is what gets spoken, `facts` is what it was written from. The app
 * renders both and composes neither.
 */
export type MorningBrief = {
  text: string;
  facts: {
    name: string | null;
    weather: { summary: string; highF: number; lowF: number } | null;
    /** Already formatted "09:15 Dentist". */
    events: string[];
    medsToday: string[];
    topOfList: string[];
    askedOfYou: string[];
    /** Only present when money is actually tight; otherwise the brief stays off it. */
    money: string | null;
    readiness: { summary?: string } | null;
    importantEmail: { subject?: string; from?: string }[];
  };
};

/** Something the agent decided was worth saying. */
export type AgentNote = {
  id: string;
  kind: "brief" | "nudge" | "finding" | "done" | "question";
  title: string;
  body: string;
  urgency: "low" | "normal" | "high";
  /** A pending action this note is about, if it proposed something. */
  action_id: string | null;
  created_at: number;
  read_at: number | null;
  /** The job that produced it, if any. */
  job: string | null;
};

export type AgentJob = {
  id: string;
  title: string;
  instruction: string;
  kind: "once" | "daily" | "weekly" | "interval";
  at_minutes: number | null;
  weekday: number | null;
  every_minutes: number | null;
  next_run_at: number;
  last_run_at: number | null;
  run_count: number;
  fail_count: number;
  status: "active" | "paused";
  notify: "always" | "ifuseful" | "never";
  source: "user" | "agent" | "system";
  /** Read back from the schedule: "every day at 7:30 AM". */
  when: string;
};

export type AgentGoal = { id: string; text: string; reason: string | null; created_at: number };

/** One autonomous run, including the ones that decided to stay quiet. */
export type AgentRun = {
  id: string;
  trigger: "job" | "commitment" | "manual" | "event";
  started_at: number;
  ms: number | null;
  engine: string | null;
  tools_used: string[];
  outcome: "spoke" | "quiet" | "acted" | "error" | "skipped";
  detail: string | null;
  job: string | null;
};

/** One moment of the day, as the timeline keeps it. The words are not here. */
export type ContextBlock = {
  at: string;
  source: "voice" | "chat" | "calendar" | "location" | "health";
  title: string;
  summary: string;
};

export type ContextDay =
  // The absent fields are spelled out so a component can read `day.summary`
  // without narrowing first, the same way ContextWeek works. `summary` was the
  // one that got left out.
  | { date: string; nothing: string; title?: undefined; summary?: undefined; blocks?: undefined }
  | { date: string; title?: string; summary?: string; blocks: ContextBlock[]; nothing?: undefined };

export type ContextWeek =
  // The absent fields are spelled out so a component can read `week.title`
  // without narrowing first, the same way ContextDay works.
  | { week: string; nothing: string; days?: undefined; from?: undefined; to?: undefined; title?: undefined; summary?: undefined }
  | {
      week: string;
      from: string;
      to: string;
      title?: string;
      summary?: string;
      /** `summary`: the day's kept summary, for a day past the 14 days (api/src/daysummary.ts). */
      days: { date: string; weekday: string; happened: string[]; summary?: string }[];
      nothing?: undefined;
    };

/** A note as GET /notes returns it. `ts` is when it was written, in ms. */
export type Note = { id: string; ts: number; text: string; tags: string[]; remind_at: number | null; done: number };

export type Commitment = { said: string; text: string; theirWords: string | null; who: string | null; when: string | null };

/**
 * onboarded: false until the setup conversation is finished or put off.
 * devTools: a development account, so Dev tools shows the switches only those may use.
 */
export type User = {
  id: string;
  email: string;
  name: string;
  created_at: number;
  settings: Settings;
  onboarded?: boolean;
  devTools?: boolean;
  /** Which engine voices replies for this person (api/src/voice.ts). "device" means the phone does. */
  ttsEngine?: string;
  /**
   * The address has been proven with the emailed code (or on ovoa.ai). False:
   * the app asks for a code (app/verify-email.tsx). Missing from older servers.
   */
  emailVerified?: boolean;
  /** And nothing else works until it is: an account made by the app's sign-up since v1 (api/src/verify.ts). */
  mustVerify?: boolean;
  /** Whether they've agreed to AI (lib/consent.ts). Missing from older servers, which never ask. */
  aiConsent?: AiConsent;
  /**
   * Whether they've agreed to the Terms of Service, and to which wording
   * (api/src/terms.ts). The app shows the Terms first until `accepted`
   * (app/terms.tsx). Missing from older servers, which never ask.
   */
  terms?: TermsState;
};

export type TermsState = { accepted: boolean; version: number | null; at: number | null; current: number };

/** One reply engine as the server sees it right now (api/src/llm.ts engineStatus). */
export type EngineInfo = {
  engine: string;
  name: string;
  key: "set" | "missing";
  model: string | null;
  coolingForS: number;
  lastError: string | null;
};

/** What the server's own settings say: the order every call tries, who answers spoken turns first, which voice. */
export type ServerSettings = { engine_order?: string; voice_engine?: string; tts_engine?: string };

export type EngineStatus = {
  engines: EngineInfo[];
  /** What a typed and a spoken turn would try right now, for this person. */
  typedOrder: string[];
  voiceOrder: string[];
  everyone: ServerSettings;
  mine?: ServerSettings;
};

// ---------- Setup (api/src/setup/, 2026-09-23) ----------
//
// Setup is a conversation the model leads: it covers a list of things in its
// own words and in its own order, and the server keeps what it learned. The
// phone gets where it is (SetupView) and nothing to count down with.

/** What setup finds out, in the server's order (api/src/setup/objectives.ts OBJECTIVE_IDS). */
export type SetupObjectiveId =
  | "name"
  | "day"
  | "goals"
  | "emergency_contact"
  | "daily"
  | "work"
  | "workouts"
  | "nicknames"
  | "leaving"
  | "focus"
  | "about";
/** How it ended: covered, they said stop, Later, or the most answers a setup takes. */
export type SetupHow = "complete" | "stopped" | "later" | "budget";

/** Where setup is (api/src/setup/state.ts viewOf): GET /onboarding/state, and every setup turn. */
export type SetupView = {
  /** Over (finished, put off, or done before): the app moves on. */
  done: boolean;
  /** Nothing said yet: pick a voice, then start. Otherwise pick up where it was. */
  fresh: boolean;
  /** 'restart': gone through again from Settings, with what's stored filled in as fromBefore. */
  mode: "first" | "restart";
  /** Their answers so far (a Skip counts). */
  turns: number;
  /** What OVOA's last reply asked about. */
  asking: SetupObjectiveId[];
  /** Every one, in order. `shown`: its value in a few words; 'low' is one the model is still checking. */
  objectives: {
    id: SetupObjectiveId;
    label: string;
    priority: "required" | "ask" | "optional";
    status: "open" | "partial" | "low" | "filled" | "declined";
    resolved: boolean;
    shown?: string;
    fromBefore?: boolean;
  }[];
  /** Add-ons it turned on, for the phone's menu: "calorie" for an eating goal. */
  addons: string[];
  /** An app made for each goal, in the background: 'making' until it's there. */
  apps: { goal: string; status: "making" | "made" | "failed" | "full"; name?: string; id?: string }[];
  /** `open`: the required ones still open when it ended. */
  finished?: { at: number; how: SetupHow; open: SetupObjectiveId[] };
};

/** One setup turn, as its stream's done line gives it (api/src/index.ts POST /onboarding/turn). */
export type SetupTurnResult = {
  /** What OVOA said, already streamed a sentence at a time. */
  reply: string;
  setup: SetupView;
  meta: {
    ms: number;
    turn: number;
    engine?: string;
    firstSentenceMs?: number | null;
    /** The reply's update was read; false means the next turn asks the model for it again. */
    parsed: boolean;
    /** The objectives that update filled in. */
    fillIds?: string[];
    usage?: { microUsd: number };
    tried?: string;
    /** The same turnId came twice: the reply the server already gave, with no second model call. */
    replayed?: boolean;
    /** No AI engine answered: the reply says so, and nothing was kept. */
    unreachable?: boolean;
  };
};

export type Message = { id: string; role: "user" | "assistant"; content: string; created_at: number };
export type Memory = { id: string; content: string; created_at: number };

export type StepDay = { day: string; steps: number };

// ---------- Health (api/src/healthdays.ts) ----------
//
// Heart rate lives in hr_samples (POST /hr), steps in step_days (PUT /steps);
// everything else Apple Health knows about a day goes up as a HealthDayIn, one
// per local day, overwritten by the phone. Times are ms since the epoch.

/** A night, as health.ts sleepNight works it out. */
export type SleepNight = {
  /** Minutes asleep: every source's asleep time, overlaps counted once. */
  asleepMin: number;
  /** Minutes in bed, kept apart: an iPhone's Sleep schedule records only this, and it isn't sleep. */
  inBedMin?: number;
  /** Bedtime and wake time: the first start and last end of the asleep time (of in bed when there's none). */
  start: number;
  end: number;
  /** Stage minutes, from the one source that records stages. */
  stages?: { core?: number; deep?: number; rem?: number; awake?: number };
  /** "Apple Watch", "iPhone", an app's name. Never a device's own name, which is its owner's. */
  source: string;
};

/** A day's Apple Health numbers, as the phone sends them (PUT /health/days). Heart rate and steps travel separately. */
export type HealthDayIn = {
  day: string;
  activeKcal?: number;
  exerciseMin?: number;
  standHours?: number;
  /** Apple's own resting heart rate (a watch works it out). */
  restingHr?: number;
  hrvMs?: number;
  spo2Pct?: number;
  respRate?: number;
  weightKg?: number;
  sleep?: SleepNight;
  /** What wrote the day's numbers, as sourceLabel says them. */
  sources?: { heart?: string[]; sleep?: string[]; steps?: string[] };
};

/**
 * A workout from Apple Health; the server keeps it in workouts as
 * 'hk:<userId>:<uuid>', source 'health' (two accounts on one phone read the same Health).
 */
export type HealthWorkoutIn = {
  uuid: string;
  /** HealthKit's name for it: "running", "traditionalStrengthTraining". */
  type: string;
  start: number;
  end: number;
  kcal?: number;
  distanceM?: number;
  source: string;
};

/** Where resting heart rate came from: Apple's own figure, the Band overnight, or the Band's lowest readings. */
export type RestingFrom = "apple" | "band_night" | "band_low";

/** GET /health/days: a day as the server has it, the phone's numbers and the heart rate it keeps merged. */
export type HealthDay = {
  day: string;
  steps: number | null;
  restingBpm: number | null;
  restingFrom: RestingFrom | null;
  heartLow: number | null;
  heartAvg: number | null;
  heartHigh: number | null;
  activeKcal: number | null;
  exerciseMin: number | null;
  standHours: number | null;
  hrvMs: number | null;
  spo2Pct: number | null;
  respRate: number | null;
  weightKg: number | null;
  sleep: SleepNight | null;
  workouts: { type: string; start: number; minutes: number; avgBpm?: number; from: string }[];
  updatedAt: number | null;
};

/** GET /hr/day: one day of heart rate from the Band and Apple Health. */
export type HeartDay = {
  day: string;
  latest: { ts: number; bpm: number; source: "band" | "health"; agoMin: number } | null;
  restingBpm: number | null;
  restingFrom: RestingFrom | null;
  low: number | null;
  avg: number | null;
  high: number | null;
  count: number;
  /** Minutes at resting + 25 or more. */
  raisedMin: number;
  /** 5-minute medians, oldest first; in each five minutes, the source with more readings there (the watch's on a tie). */
  points: { ts: number; bpm: number }[];
  /** Readings from each source that day. */
  sources: { band: number; health: number };
};

export type Contact = { id: string; name: string; phone: string };
export type SafetyEvent = {
  id: string;
  /** Only SOS is sent now; "fall" is older history, gone after the 14-day purge. */
  kind: "fall" | "sos";
  status: "ok" | "alerted";
  latitude: number | null;
  longitude: number | null;
  created_at: number;
};

export type PendingAction = {
  id: string;
  summary: string;
  created_at: number;
  /** Present when the app carries out the action on the phone itself. */
  phone?: { tool: string; args: Record<string, any> };
  /** "Approve for me" is on: run it without a card unless it needs a choice. */
  auto?: boolean;
};
export type PhoneResult = { ok: boolean; detail: string };
export type PhoneCaps = {
  lookups: boolean;
  capabilities: string[];
  autoSendTexts?: boolean;
  /** This build auto-sends a text only to a recipient it is sure of; anyone else gets the Messages sheet (phoneActions.ts). */
  recipientGuard?: boolean;
};
/** Something the assistant wants looked up on the phone before it can answer. */
export type PhoneCall = { id: string; name: string; args: Record<string, any> };
/** A chat turn either finishes, or pauses until the app sends lookup results to `resume`. */
/** The parts a made app's screen is built from (server: myapps.ts Block; drawn by components/AppBlocks.tsx). */
export type BlockKind = "buttons" | "list" | "counter" | "log" | "note" | "timer";
export type AppButton = { label: string; prompt: string };
export type AppBlock = {
  id: string;
  kind: BlockKind;
  title: string;
  buttons?: AppButton[];
  placeholder?: string;
  unit?: string;
  goal?: number | null;
  step?: number;
  daily?: boolean;
  text?: string;
  minutes?: number;
};
export type ListItem = { id: string; text: string; done: boolean };
export type LogEntry = { id: string; text: string; at: number };
export type BlockState = { items?: ListItem[]; entries?: LogEntry[]; value?: number; day?: string };
export type AppContents = Record<string, BlockState>;
/** One change to what's on a made app's screen (server: myapps.ts applyOp). */
export type AppOp = {
  block: string;
  op: "add" | "toggle" | "remove" | "clear_done" | "count" | "set";
  text?: string;
  item?: string;
  done?: boolean;
  amount?: number;
  value?: number;
};

/** An app someone described, before it's saved: what the model made of it, and whatever they changed. */
export type AppDraft = {
  name: string;
  about: string;
  /** An Ionicons name from the server's list (myapps.ts APP_ICONS; lib/appKit.ts). */
  icon: string;
  tone: "teal" | "violet" | "green" | "amber" | "coral" | "blue" | "pink";
  /** What the assistant does while it's open. */
  instructions: string;
  /** The first thing it says when opened. */
  opener: string;
  /** Its screen, top to bottom. */
  blocks: AppBlock[];
  /** Whether it reads its answers aloud. */
  speak: boolean;
};
export type MyApp = AppDraft & { id: string; createdAt: number; updatedAt: number; state: AppContents };

export type ChatResponse = (
  | { messages: Message[]; pendingActions: PendingAction[]; paused?: undefined; ignored?: boolean }
  | { paused: { turnId: string; calls: PhoneCall[] }; pendingActions: PendingAction[]; messages?: undefined; ignored?: undefined }
) & {
  /** Which model answered, how long each part of the server's work took, and how big the prompt was. */
  meta?: {
    engine: string;
    ms: number;
    /** Reading the user's settings, history and memories before the model runs. */
    contextMs?: number;
    firstTokenMs?: number | null;
    firstSentenceMs?: number | null;
    promptChars?: number;
    toolCount?: number;
    /** Tools the model ran server-side this turn, and what each cost. */
    tools?: { name: string; ms: number }[];
  };
};
/** A connected Google account. `label` is the tag the user (or the assistant) gave it. */
export type GoogleAccount = {
  id: string;
  email: string;
  name: string | null;
  label: string | null;
  isDefault: boolean;
  scopes: string[];
  connectedAt: number;
};
/** The top-level fields describe the default account; `accounts` has all of them. */
export type GoogleStatus =
  | { connected: false; accounts: GoogleAccount[] }
  | { connected: true; email: string; name: string | null; scopes: string[]; connectedAt: number; accounts: GoogleAccount[] };

/**
 * What one day (or the month so far) cost to serve, as the server counted it
 * (api/src/usage.ts). `estUsd` is at list price; `by` splits it by what it was
 * spent on ("mic", "voice (deepgram-aura-2)", "ai (glm)").
 */
export type UsageTotals = {
  day: string;
  turns: number;
  llmCalls: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  ttsChars: number;
  streamSeconds: number;
  clipSeconds: number;
  searches: number;
  microUsd: number;
  estUsd: string;
  by: Record<string, string>;
};
export type UsageSummary = { today: UsageTotals; month: UsageTotals };

export const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * What Google or Apple proving an address comes back as (api/src/index.ts
 * afterProven, afterApple): signed in to the account with that address
 * (`created`: Apple just made it), or a ticket for the name + password step
 * that makes one. `existing`: there is an account, made with the address by
 * someone who never proved it; the step gives it a new password.
 */
export type ProvenSignIn =
  | { token: string; user: User; created?: boolean }
  | { ticket: string; email: string; name: string | null; existing?: boolean };

export class ApiError extends Error {
  /** Per-field messages, when the server said which box is wrong. Signup does. */
  constructor(
    message: string,
    readonly status: number,
    readonly fields: Record<string, string> = {},
    /** Set when the server answered needs_plan: which plan the call is part of. */
    readonly needs: PlanNeeded | null = null,
    /** The server's own name for what went wrong, when it gave one: needs_consent, needs_verification, allowance... */
    readonly code: string | null = null,
    /** Seconds to wait before trying again, when the server said (a 429). */
    readonly retryAfter: number | null = null,
  ) {
    super(message);
  }
}

/** A code the server keys a reply off (api/src/verify.ts, consent.ts, plans.ts), or null. */
const errorCode = (body: unknown) => {
  const e = (body as { error?: unknown } | null)?.error;
  return typeof e === "string" && /^[a-z][a-z_]*$/.test(e) ? e : null;
};

/** A request this person hasn't agreed to AI for: stopped here, or refused by the server. */
export const isNeedsConsent = (err: unknown): err is ApiError => err instanceof ApiError && err.code === "needs_consent";

/**
 * Who to tell when a call comes back needs_verification: a new account whose
 * address isn't proven yet (auth.tsx reads GET /me again, and the code screen
 * comes up). One listener, like whenSessionDies.
 */
let codeNeeded: (() => void) | null = null;
export function whenCodeNeeded(handler: (() => void) | null) {
  codeNeeded = handler;
}

/** needs_consent and needs_verification, off any failed reply: each has someone to tell. Returns the code. */
export function noteCoded(body: unknown) {
  const code = errorCode(body);
  try {
    if (code === "needs_consent") noteConsentNeeded();
    if (code === "needs_verification") codeNeeded?.();
  } catch {}
  return code;
}

// ---------- Plans ----------

export type Tier = "free" | "base" | "pro";
export type PlanNeeded = "base" | "pro";

/** What GET /me says this person is on (api/src/plans.ts planView). */
export type Plan = {
  tier: Tier;
  status: "trialing" | "active" | "past_due" | "canceled" | "comp" | "none";
  trialEndsAt: string | null;
  renewsAt: string | null;
  /** repliesLeftToday is null for a development account, which has no daily limit. */
  limits: { repliesLeftToday: number | null; resetsAt: string };
  features: { chat: boolean; voice: boolean; wake: boolean; agent: boolean };
};

/** A call the person's plan doesn't include. Keyed off the server's `error`, never the status alone. */
export const isNeedsPlan = (err: unknown): err is ApiError => err instanceof ApiError && err.needs !== null;

/**
 * Who to tell when a call comes back needs_plan (plan.tsx refreshes the plan,
 * and the screens show their locked state). One listener, like whenSessionDies.
 */
let planNeeded: ((needs: PlanNeeded) => void) | null = null;
export function whenPlanNeeded(handler: ((needs: PlanNeeded) => void) | null) {
  planNeeded = handler;
}

/** Reads the server's 402 body off a failed reply and passes it on. Null when it isn't one. */
export function notePlanNeeded(body: unknown): PlanNeeded | null {
  const b = body as { error?: unknown; needs?: unknown } | null;
  if (b?.error !== "needs_plan") return null;
  const needs: PlanNeeded = b.needs === "pro" ? "pro" : "base";
  try {
    planNeeded?.(needs);
  } catch {}
  return needs;
}

/**
 * What a failed reply says, for a person. A coded error (needs_plan,
 * allowance, needs_consent, maintenance) comes with a `message` written to be
 * shown, and that is what the ApiError carries; the code was showing up on
 * screen as "needs_plan". Anything else is the server's error as it was.
 */
export function errorText(body: unknown, status: number) {
  const b = body as { error?: unknown; message?: unknown } | null;
  const code = typeof b?.error === "string" ? b.error : "";
  if (/^[a-z][a-z_]*$/.test(code) && typeof b?.message === "string" && b.message) return b.message;
  return code || `Request failed (${status})`;
}

// ---------- AI requests are stopped on the phone ----------
//
// The server decides every plan (api/src/plans.ts), but a phone that already
// knows it's on the free plan never sends an AI request only to be told no:
// it stops it here, before it's sent, with the same needs_plan the server would
// give, and the screen shows its locked state (plan.tsx, components/Plan.tsx).
// The same for someone who hasn't agreed to AI yet (lib/consent.ts): stopped
// with needs_consent, so nothing reaches an AI company before they agree.
// While the plan isn't known, everything is sent and the server decides.

/**
 * The requests that reach a model or OVOA's paid voice: the Base rules of
 * api/src/plans.ts ROUTE_TIERS, for the routes this app calls. Everything else,
 * and every DELETE, is free there too.
 */
const AI_REQUESTS: [method: string, path: RegExp][] = [
  ["POST", /^\/(chat|chat\/resume|siri)$/],
  ["GET", /^\/brief$/],
  ["POST", /^\/voice\/speak$/],
  ["POST", /^\/context\/blocks$/],
  ["GET", /^\/context\/(days|weeks)\/[^/]+$/],
  ["*", /^\/onboarding(\/[a-z]+)?$/],
  ["POST", /^\/apps\/(design|revise)$/],
  ["POST", /^\/agent\/(jobs|goals)$/],
  ["POST", /^\/agent\/jobs\/[^/]+\/run$/],
  ["POST", /^\/transcripts\/heard$/],
];

/** The plan a request is part of when it's an AI request (always Base since v1), or null. Pure. */
export function aiRequestNeeds(method: string, path: string): PlanNeeded | null {
  const m = method.toUpperCase();
  if (m === "DELETE") return null;
  const bare = path.split("?")[0];
  return AI_REQUESTS.some(([rm, re]) => (rm === "*" || rm === m) && re.test(bare)) ? "base" : null;
}

/** What plan.tsx knows of the plan right now: its tier, or null while it doesn't know. */
let knownTier: (() => Tier | null) | null = null;
export function whenPlanKnown(read: (() => Tier | null) | null) {
  knownTier = read;
}

/** The sentence a request stopped on the phone carries. The server's needs_plan says it at more length. */
export const LOCKED_MESSAGE = "That's for Base users.";

/** The sentence a request stopped for want of consent carries (lib/consent.ts). */
export const CONSENT_LOCKED_MESSAGE = "Agree to how OVOA uses AI first. It's in Settings.";

/**
 * The error to throw instead of sending, when this phone knows the request
 * isn't theirs to make: their plan doesn't include it, or they haven't agreed
 * to AI yet, so nothing is sent to a model (or to Deepgram) before they do.
 */
export function lockedOnPhone(method: string, path: string): ApiError | null {
  const needs = aiRequestNeeds(method, path);
  if (!needs) return null;
  if (knownTier?.() === "free") {
    devlog("log", `${method} ${path.split("?")[0]} not sent: that's for Base users`);
    return new ApiError(LOCKED_MESSAGE, 402, {}, needs, "needs_plan");
  }
  if (consentMissing()) {
    devlog("log", `${method} ${path.split("?")[0]} not sent: they haven't agreed to AI yet`);
    return new ApiError(CONSENT_LOCKED_MESSAGE, 403, {}, null, "needs_consent");
  }
  return null;
}

const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Who to tell when the server says a session is dead (auth.tsx signs out).
 * Without it an expired or revoked session left every screen failing with 401
 * for good, and nothing ever sent the person back to sign in.
 */
let deadSession: ((token: string) => void) | null = null;
export function whenSessionDies(handler: ((token: string) => void) | null) {
  deadSession = handler;
}

/**
 * The server's own words for a session it doesn't recognise (api/src/index.ts).
 * Matched exactly: a wrong current password on the change-password form is a
 * 401 too, and must not sign anyone out.
 */
export function noteDeadSession(status: number, token: string | null, error: unknown) {
  if (status === 401 && token && error === "Not signed in") deadSession?.(token);
}

// ---------- The server out of reach ----------
//
// While the server was down for its move (every request answered 503
// "maintenance"), each five-minute PUT /device/state wrote two error rows, and a
// phone with no signal does the same for every request it tries (device_logs,
// 2026-09-23 15:50-16:05). Neither is the phone doing anything wrong, and the
// rows bury the ones that are. So an outage is said once, as a warning; the
// requests that fail inside it stay on the phone, and the first answer after it
// says how long it lasted.

type Outage = { why: "maintenance" | "offline"; since: number; missed: number };
let outage: Outage | null = null;

/** Why the server can't be reached right now (already logged), or null once something has been answered. */
export const serverOut = () => outage?.why ?? null;

function noteOut(why: Outage["why"], what: string, detail: string) {
  if (outage?.why === why) {
    outage.missed++;
    devlog("req", `${what} not answered (${why})`, detail, { level: "debug" });
    return;
  }
  outage = { why, since: Date.now(), missed: 1 };
  devlog(
    "warn",
    why === "maintenance"
      ? "the server is down for maintenance; staying quiet until it answers again"
      : "can't reach the server; staying quiet until it answers again",
    `${what}: ${detail}`,
  );
}

function noteAnswered() {
  if (!outage) return;
  const { why, since, missed } = outage;
  outage = null;
  const s = Math.round((Date.now() - since) / 1000);
  devlog("log", `the server answers again after ${s} s (${missed} requests not answered, ${why})`);
}

/**
 * A request body for the log with what the person said taken out. The log
 * line is kept on the phone and rides up with errors as a breadcrumb, and the
 * words in a chat or ambient body can be the room's: only their length goes.
 */
function redacted(body: string | undefined) {
  if (!body) return body;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    let changed = false;
    for (const key of ["message", "text", "note"]) {
      if (typeof parsed[key] === "string") {
        parsed[key] = `[${(parsed[key] as string).length} chars]`;
        changed = true;
      }
    }
    return changed ? JSON.stringify(parsed) : body;
  } catch {
    return body;
  }
}

export async function request<T>(path: string, token: string | null, init: RequestInit = {}): Promise<T> {
  const method = init.method ?? "GET";
  const stopped = lockedOnPhone(method, path);
  if (stopped) throw stopped;
  // Auth request bodies hold passwords, and a successful reply holds a token:
  // both stay out. A *failed* reply holds neither, and is the only thing in
  // device_logs that can tell a typo from a person who never had an account —
  // which is why 123 401s across 38 devices told us nothing (2026-09-21).
  const secret = path.startsWith("/auth/") || path.startsWith("/me/password");
  devlog("req", `${method} ${path}`, secret ? undefined : redacted(init.body as string | undefined));
  const started = Date.now();
  // Never wait forever: a request frozen while iOS suspended the app would
  // otherwise hang the voice loop until the connection drops (seen: 15 min).
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      signal: timeout.signal,
      ...init,
      headers: {
        "content-type": "application/json",
        ...(token && { authorization: `Bearer ${token}` }),
        ...init.headers,
      },
    });
  } catch (err) {
    clearTimeout(timer);
    if (timeout.signal.aborted) {
      devlog("err", `${method} ${path} failed after ${Date.now() - started} ms`, String(err));
      throw new Error(`No answer from the server after ${REQUEST_TIMEOUT_MS / 1000} s`);
    }
    // fetch only rejects like this when there is no connection to the server at all.
    noteOut("offline", `${method} ${path}`, `${String(err)} after ${Date.now() - started} ms`);
    throw err;
  }
  clearTimeout(timer);
  const body = await res.json().catch(() => ({}));
  if (res.status === 503 && body?.error === "maintenance") {
    noteOut("maintenance", `${method} ${path}`, `503 after ${Date.now() - started} ms`);
    throw new ApiError(errorText(body, res.status), res.status, {}, null, noteCoded(body));
  }
  noteAnswered();
  // Not part of their plan, not agreed to AI yet, or the code not typed yet:
  // ordinary answers, not faults, and logged as such, so a free phone's log
  // isn't a wall of errors.
  const locked = !res.ok && ["needs_plan", "needs_consent", "needs_verification"].includes(body?.error);
  devlog(
    res.ok ? "res" : locked ? "log" : "err",
    `${res.status} ${method} ${path} · ${Date.now() - started} ms`,
    secret && res.ok ? undefined : locked ? `${body.error}${body.needs ? ` (${body.needs})` : ""}` : body,
  );
  if (!res.ok) {
    noteDeadSession(res.status, token, body.error);
    const needs = notePlanNeeded(body);
    const retryAfter = typeof body.retryAfter === "number" ? body.retryAfter : null;
    throw new ApiError(errorText(body, res.status), res.status, body.fields ?? {}, needs, noteCoded(body), retryAfter);
  }
  return body as T;
}

type StreamLine<R> =
  | { type: "sentence"; text: string }
  | { type: "voice"; on: boolean; engine?: string }
  | { type: "audio"; seq: number; text: string; mp3?: string; error?: string }
  | ({ type: "done" } & R)
  | { type: "error"; error: string };

/**
 * Asks the server to voice the reply itself and send the audio down the same
 * stream (api/src/voice.ts speechStream), instead of this phone asking
 * /voice/speak for each sentence once it has it. That second round trip was
 * between the words existing and the first one being heard.
 */
export type ServerSpeech = {
  voice: string;
  /** Arrives before any sentence: whether the audio is coming, and from which engine. False: voice the sentences here. */
  onVoicing: (on: boolean, engine?: string) => void;
  /** A piece of the reply, in order: mp3 as base64, or null when the server couldn't voice it. */
  onVoiced: (text: string, mp3: string | null) => void;
};

/**
 * Why the voice loop let go of a streamed reply, by the signal it aborted. The
 * abort can't carry it: React Native's AbortController (the abort-controller
 * polyfill) drops abort(reason). Every dropped stream used to be logged as
 * "talked over", the ones a restarted or ended conversation dropped included,
 * which led a read of the 2026-09-23 logs to blame a filler's echo for cutting
 * a reply off, though the gate could then only interrupt a reply that was
 * already speaking (turnGate.ts). With no reason given, the line claims none.
 *
 * "talked over" and "told to stop" are the turn gate's (the second can come
 * while the answer is still being worked out); "cut short" is a tap or a click;
 * "conversation ended" is listening stopped or restarted (voice.ts).
 */
const dropReasons = new WeakMap<AbortSignal, DropReason>();
export type DropReason = "talked over" | "told to stop" | "cut short" | "conversation ended";

/** Stops a streamed turn, saying why for the log (DropReason). */
export function dropReply(abort: AbortController, why: DropReason) {
  dropReasons.set(abort.signal, why);
  abort.abort();
}

/**
 * A chat turn with the reply streamed: `onSentence` gets each sentence as soon as
 * the server has it (so it can be spoken while the rest is written), then this
 * resolves with the same response a plain request would. `R` is that response:
 * a chat turn's, or a setup turn's (SetupTurnResult), which come down the same
 * stream (api/src/index.ts streamTurn).
 */
async function streamedTurn<R extends { meta?: unknown } = ChatResponse>(
  path: string,
  token: string,
  body: Record<string, unknown>,
  onSentence: (sentence: string) => void,
  signal?: AbortSignal,
  speech?: ServerSpeech,
): Promise<R> {
  const locked = lockedOnPhone("POST", path);
  if (locked) throw locked;
  if (speech) body = { ...body, speak: { voice: speech.voice } };
  devlog("req", `POST ${path} (streamed)`, redacted(JSON.stringify(body)));
  const started = Date.now();
  // No progress for this long means the connection is dead (the whole reply can take longer).
  const timeout = new AbortController();
  let timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
  // The caller gave up (the user talked over the reply, told it to stop or cut it short, or the conversation ended): stop reading.
  let dropped = false;
  const drop = () => {
    dropped = true;
    timeout.abort();
  };
  if (signal?.aborted) drop();
  signal?.addEventListener("abort", drop);
  const alive = () => {
    clearTimeout(timer);
    timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
  };
  try {
    const res = await streamingFetch(`${API_URL}${path}`, {
      method: "POST",
      signal: timeout.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...body, stream: true }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      const locked = ["needs_plan", "needs_consent", "needs_verification"].includes(err.error ?? "");
      devlog(locked ? "log" : "err", `${res.status} POST ${path} · ${Date.now() - started} ms`, err);
      noteDeadSession(res.status, token, err.error);
      throw new ApiError(errorText(err, res.status), res.status, {}, notePlanNeeded(err), noteCoded(err));
    }
    noteAnswered();
    // A server without streaming answers plain JSON. The timing lines of a turn
    // are never folded into a repeat (devlog.ts NEVER_COLLAPSED says why).
    if (!res.headers.get("content-type")?.includes("ndjson") || !res.body) {
      const json = (await res.json()) as R;
      devlog("res", `${res.status} POST ${path} · ${Date.now() - started} ms (not streamed)`, json.meta ?? json, { collapse: false });
      return json;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sentences = 0;
    let voiced = 0;
    let final: R | null = null;
    const handle = (line: string) => {
      if (!line.trim()) return;
      const msg = JSON.parse(line) as StreamLine<R>;
      if (msg.type === "sentence") {
        // The timing is the point of this line; the sentence is the reply itself,
        // and it used to ride up to device_logs with it whenever trace was on.
        if (!sentences++) devlog("res", `first sentence after ${Date.now() - started} ms`, `${msg.text.length} chars`, { collapse: false });
        onSentence(msg.text);
      } else if (msg.type === "voice") {
        speech?.onVoicing(msg.on, msg.engine);
      } else if (msg.type === "audio") {
        if (!voiced++) {
          devlog("res", `first voiced piece after ${Date.now() - started} ms`, msg.error ?? `${msg.mp3?.length ?? 0} b64 chars`, { collapse: false });
        }
        speech?.onVoiced(msg.text, msg.mp3 ?? null);
      } else if (msg.type === "error") {
        throw new ApiError(msg.error, 500);
      } else {
        const { type: _, ...rest } = msg;
        final = rest as unknown as R;
      }
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      alive();
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        handle(line);
      }
    }
    handle(buffer);
    if (!final) throw new Error("The reply was cut off");
    const done = final as R;
    // The meta, not the reply, here and above: a setup turn's view holds what they told it (a contact's number).
    devlog("res", `200 POST ${path} · ${Date.now() - started} ms, ${sentences} sentences streamed`, done.meta ?? done, { collapse: false });
    return done;
  } catch (err) {
    if (dropped) {
      const why = signal && dropReasons.get(signal);
      devlog("voice", `dropped the reply after ${Date.now() - started} ms${why ? ` (${why})` : ""}`);
      throw new Error("Cancelled");
    }
    if (timeout.signal.aborted) {
      devlog("err", `POST ${path} stalled after ${Date.now() - started} ms`);
      throw new Error(`No answer from the server after ${REQUEST_TIMEOUT_MS / 1000} s`);
    }
    if (!(err instanceof ApiError)) devlog("err", `POST ${path} failed after ${Date.now() - started} ms`, String(err));
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", drop);
  }
}

export const api = {
  /** `codeSent`: the first code went to the address with the sign-up (api/src/verify.ts). Missing from older servers. */
  signup: (email: string, password: string, name: string) =>
    request<{ token: string; user: User; codeSent?: boolean }>("/auth/signup", null, {
      method: "POST",
      body: JSON.stringify({ email, password, name }),
    }),
  login: (email: string, password: string) =>
    request<{ token: string; user: User }>("/auth/login", null, {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  /** "Continue with Google" (api/src/signin.ts): Google's page to open, and the key that redeems what comes back. */
  googleSignInStart: (returnUrl: string) =>
    request<{ url: string; key: string }>("/auth/google/start", null, {
      method: "POST",
      body: JSON.stringify({ returnUrl }),
    }),
  googleSignInRedeem: (code: string, key: string) =>
    request<ProvenSignIn>("/auth/google/redeem", null, { method: "POST", body: JSON.stringify({ code, key }) }),
  /** A nonce for Sign in with Apple, good once: Apple signs it into the token. */
  appleSignInStart: () => request<{ nonce: string }>("/auth/apple/start", null, { method: "POST", body: "{}" }),
  appleSignIn: (
    identityToken: string,
    nonce: string,
    fullName: { givenName: string | null; familyName: string | null } | null,
  ) =>
    request<ProvenSignIn>("/auth/apple", null, {
      method: "POST",
      body: JSON.stringify({ identityToken, nonce, fullName }),
    }),
  /** The name + password step after Google proved an address with no account (or an unproven one) behind it. */
  ticketSignup: (ticket: string, name: string, password: string) =>
    // `passwordChanged` is there only when the account already existed.
    request<{ token: string; user: User; passwordChanged?: boolean }>("/auth/email/signup", null, {
      method: "POST",
      body: JSON.stringify({ ticket, name, password, session: "app" }),
    }),
  logout: (token: string) => request("/auth/logout", token, { method: "POST" }),
  /** `plan` is missing from servers from before the plans. */
  me: (token: string) => request<{ user: User; plan?: Plan }>("/me", token),
  /** Asks ovoa.ai again now instead of using the last ten minutes' answer ("Refresh" in Settings). */
  refreshPlan: (token: string) => request<{ plan: Plan }>("/me/plan/refresh", token, { method: "POST" }),
  /**
   * The zone rides along with every settings change: the server needs it to
   * schedule background work in the user's own day, and a chat turn used to be
   * the only thing that ever told it.
   */
  updateMe: (token: string, patch: Partial<Settings> & { name?: string }) =>
    request<{ user: User }>("/me", token, {
      method: "PATCH",
      body: JSON.stringify({ ...patch, timeZone: timeZone() }),
    }),
  changePassword: (token: string, currentPassword: string, newPassword: string) =>
    request("/me/password", token, { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) }),
  deleteAccount: (token: string) => request("/me", token, { method: "DELETE" }),
  /** A code to the account's own address, for the code step. 429 with `retryAfter` when one went out in the last minute. */
  sendCode: (token: string) =>
    request<{ ok: true; emailVerified?: true; resendInSeconds?: number }>("/me/email/code", token, { method: "POST" }),
  verifyCode: (token: string, code: string) =>
    request<{ ok: true; emailVerified: true }>("/me/email/verify", token, { method: "POST", body: JSON.stringify({ code }) }),
  /** They pressed Agree on app/consent.tsx; `version` is the wording it showed (lib/consent.ts CONSENT_VERSION). */
  agreeToAi: (token: string, version: number) =>
    request<{ aiConsent: AiConsent }>("/me/consent", token, { method: "POST", body: JSON.stringify({ version }) }),
  /** They took it back, in Settings. AI stops until they agree again. */
  withdrawAi: (token: string) => request<{ aiConsent: AiConsent }>("/me/consent", token, { method: "DELETE" }),
  /** They scrolled to the end of the Terms and pressed Agree; `version` is the wording shown (lib/terms.ts TERMS_VERSION). */
  agreeToTerms: (token: string, version: number) =>
    request<{ terms: TermsState }>("/me/terms", token, { method: "POST", body: JSON.stringify({ version }) }),

  messages: (token: string) => request<{ messages: Message[] }>("/chat/messages", token),
  /**
   * `voice`: the user spoke this and the reply will be read aloud.
   * `ambient`: overheard by always-listening; the server replies only if it was
   * meant for the assistant, and otherwise answers `ignored` and saves nothing.
   */
  send: (token: string, message: string, phone: PhoneCaps, voice = false, ambient = false, source?: "agent", app?: string) =>
    request<ChatResponse>("/chat", token, {
      method: "POST",
      // An agent command is never run as one of the person's apps. `app` is a
      // made app's own screen asking; otherwise whichever app is open in Talk.
      body: JSON.stringify({ message, timeZone: timeZone(), phone, voice, ambient, source, app: source ? undefined : (app ?? openAppId()) }),
    }),
  resume: (token: string, turnId: string, results: Record<string, unknown>) =>
    request<ChatResponse>("/chat/resume", token, { method: "POST", body: JSON.stringify({ turnId, results }) }),
  /** `send` for a spoken turn, with the reply's sentences delivered as they're written. */
  sendStreamed: (
    token: string,
    message: string,
    phone: PhoneCaps,
    ambient: boolean,
    onSentence: (sentence: string) => void,
    signal?: AbortSignal,
    speech?: ServerSpeech,
  ) =>
    streamedTurn("/chat", token, { message, timeZone: timeZone(), phone, voice: true, ambient, app: openAppId() }, onSentence, signal, speech),
  resumeStreamed: (
    token: string,
    turnId: string,
    results: Record<string, unknown>,
    onSentence: (sentence: string) => void,
    signal?: AbortSignal,
    speech?: ServerSpeech,
  ) => streamedTurn("/chat/resume", token, { turnId, results }, onSentence, signal, speech),
  clearMessages: (token: string) => request("/chat/messages", token, { method: "DELETE" }),

  memories: (token: string) => request<{ memories: Memory[] }>("/memories", token),
  deleteMemory: (token: string, id: string) => request(`/memories/${id}`, token, { method: "DELETE" }),
  clearMemories: (token: string) => request("/memories", token, { method: "DELETE" }),

  syncSteps: (token: string, days: StepDay[]) =>
    request("/steps", token, { method: "PUT", body: JSON.stringify({ days }) }),

  contacts: (token: string) => request<{ contacts: Contact[] }>("/contacts", token),
  addContact: (token: string, name: string, phone: string) =>
    request<{ contact: Contact }>("/contacts", token, { method: "POST", body: JSON.stringify({ name, phone }) }),
  deleteContact: (token: string, id: string) => request(`/contacts/${id}`, token, { method: "DELETE" }),

  logSafetyEvent: (
    token: string,
    event: { kind: "sos"; status: SafetyEvent["status"]; latitude?: number; longitude?: number },
  ) =>
    request<{ event: SafetyEvent }>("/safety-events", token, { method: "POST", body: JSON.stringify(event) }),
  safetyEvents: (token: string) => request<{ events: SafetyEvent[] }>("/safety-events", token),

  googleStatus: (token: string) => request<GoogleStatus>("/google/status", token),
  /** `accountId` reconnects that account instead of adding another one. */
  googleConnectUrl: (token: string, returnUrl: string, accountId?: string) =>
    request<{ url: string }>("/google/connect", token, {
      method: "POST",
      body: JSON.stringify({ returnUrl, accountId }),
    }),
  googleUpdateAccount: (token: string, id: string, patch: { label?: string; isDefault?: true }) =>
    request<{ accounts: GoogleAccount[] }>(`/google/accounts/${id}`, token, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  googleRemoveAccount: (token: string, id: string) =>
    request<{ accounts: GoogleAccount[] }>(`/google/accounts/${id}`, token, { method: "DELETE" }),

  pendingActions: (token: string) => request<{ actions: PendingAction[] }>("/actions", token),
  approveAction: (token: string, id: string, phoneResult?: PhoneResult) =>
    request<{ message: Message }>(`/actions/${id}/approve`, token, {
      method: "POST",
      body: JSON.stringify({ timeZone: timeZone(), phoneResult }),
    }),
  cancelAction: (token: string, id: string) => request(`/actions/${id}`, token, { method: "DELETE" }),


  // ---------- The phone ----------

  reportDevice: (token: string, state: DeviceState) =>
    request<{ capabilities: Capabilities }>("/device/state", token, { method: "PUT", body: JSON.stringify(state) }),
  capabilities: (token: string) => request<{ capabilities: Capabilities }>("/capabilities", token),
  /** A buzz sent the long way round: server, push, then the band (or a notification without one). */
  buzzTest: (token: string, pattern = "ack") =>
    request<{ via: "band" | "notification"; reached: boolean }>("/buzz/test", token, {
      method: "POST",
      body: JSON.stringify({ pattern }),
    }),

  feed: (token: string) => request<{ cards: FeedCard[] }>("/feed", token),

  /**
   * This morning's brief, built fresh. The same thing the server reads aloud —
   * the screen shows it, it does not compose its own.
   */
  brief: (token: string, fresh = false) => request<MorningBrief>(fresh ? "/brief?fresh=1" : "/brief", token),

  // ---------- Alarms, urgent reminders ----------

  alarms: (token: string) =>
    request<{
      alarms: { id: string; at: string; minutes: number; days: number[]; label: string | null; hard: boolean; nextAt: number | null; next: string | null; ringing: boolean; stopped: boolean }[];
    }>("/alarms", token),
  addAlarm: (token: string, a: { time: string; days?: number[]; label?: string; hard?: boolean }) =>
    request<{ id: string; nextAt: number | null }>("/alarms", token, { method: "POST", body: JSON.stringify(a) }),
  deleteAlarm: (token: string, id: string) => request(`/alarms/${id}`, token, { method: "DELETE" }),
  stopAlarm: (token: string, id: string, steps: number) =>
    request(`/alarms/${id}/stop`, token, { method: "POST", body: JSON.stringify({ steps }) }),
  nagDone: (token: string, key: string) => request("/nags/done", token, { method: "POST", body: JSON.stringify({ key }) }),
  confirmFavor: (token: string, id: string) => request(`/favors/${id}/confirm`, token, { method: "POST" }),
  setCommitment: (token: string, id: string, status: "open" | "done" | "dropped") =>
    request(`/context/commitments/${id}`, token, { method: "PATCH", body: JSON.stringify({ status }) }),

  // ---------- Location timeline ----------

  sendLocations: (token: string, points: { ts: number; lat: number; lng: number; accuracy: number | null; speed: number | null }[]) =>
    request<{ visits: number }>("/locations", token, { method: "POST", body: JSON.stringify({ points }) }),
  places: (token: string) => request<{ places: Place[] }>("/places", token),
  placeAddress: (token: string, id: string, address: string) =>
    request(`/places/${id}/address`, token, { method: "POST", body: JSON.stringify({ address }) }),
  placeEvent: (token: string, placeId: string, kind: "enter" | "exit") =>
    request("/places/event", token, { method: "POST", body: JSON.stringify({ placeId, kind, ts: Date.now() }) }),
  forgetLocations: (token: string) => request("/locations", token, { method: "DELETE" }),

  // ---------- Heart rate ----------

  sendHeartRate: (token: string, source: "health" | "band", samples: { ts: number; bpm: number }[]) =>
    request<{ stored: number }>("/hr", token, { method: "POST", body: JSON.stringify({ source, samples }) }),
  heartToday: (token: string) =>
    request<{ baseline: number; latest: { ts: number; bpm: number } | null; count: number }>("/hr/today", token),
  /** Today, or `day` (YYYY-MM-DD, in their time zone). */
  heartDay: (token: string, day?: string) => request<HeartDay>(`/hr/day${day ? `?day=${day}` : ""}`, token),
  /**
   * Apple Health's day numbers and workouts for `from`..`to`. Workouts from
   * Health that start in that range and aren't in `workouts` are gone from
   * Health, and the server drops them too. Without AI consent nothing is kept
   * (they only serve the assistant): the answer says so.
   */
  putHealthDays: (token: string, body: { from: string; to: string; days: HealthDayIn[]; workouts: HealthWorkoutIn[] }) =>
    request<{ stored: number; workouts?: number; skipped?: "no_ai_consent" }>("/health/days", token, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  /** The last `days` days, up to 14 (what the server keeps). */
  healthDays: (token: string, days = 7) => request<{ days: HealthDay[] }>(`/health/days?days=${days}`, token),

  // ---------- Transcripts ----------

  transcriptDay: (token: string, date: string) =>
    request<TranscriptDay>(`/transcripts/day/${date}?timeZone=${encodeURIComponent(timeZone())}`, token),
  transcriptLines: (token: string, from: number, to: number) =>
    request<{ lines: TranscriptLine[] }>(`/transcripts/lines?from=${from}&to=${to}`, token),
  searchTranscripts: (token: string, q: string) =>
    request<{ lines: TranscriptLine[] }>(`/transcripts/search?q=${encodeURIComponent(q)}`, token),
  forgetTranscript: (token: string, from: number, to: number) =>
    request<{ forgot: number }>(`/transcripts?from=${from}&to=${to}`, token, { method: "DELETE" }),

  // ---------- To-do list ----------

  todos: (token: string, date?: string) =>
    request<{ date: string; todos: Todo[] }>(`/todos${date ? `?date=${date}` : ""}`, token),
  todoDone: (token: string, id: string) => request(`/todos/${id}/done`, token, { method: "POST" }),
  todosSynced: (token: string, items: { id: string; externalId: string }[]) =>
    request("/todos/synced", token, { method: "POST", body: JSON.stringify({ items }) }),

  // ---------- Setup ----------

  /** Where setup is, with no model call. */
  setupState: (token: string) => request<{ setup: SetupView }>("/onboarding/state", token),
  /**
   * One turn of setup, streamed like a spoken Talk turn (the same sentence,
   * voice and audio lines): 'start' and 'resume' have OVOA speak first,
   * 'answer' carries their words, 'skip' is the Skip button. `turnId` (8-64
   * characters) is sent again by Try again: a turn the server already finished
   * comes back as it was, with no second model call. The zone goes with every
   * turn: setup can be a new account's first request, and a reminder made in it
   * is scheduled in this zone.
   */
  setupTurn: (
    token: string,
    body: { turnId: string; action: "start" | "resume" | "answer" | "skip"; text?: string; typed?: boolean },
    onSentence: (sentence: string) => void,
    signal?: AbortSignal,
    speech?: ServerSpeech,
  ) => streamedTurn<SetupTurnResult>("/onboarding/turn", token, { ...body, timeZone: timeZone() }, onSentence, signal, speech),
  /** Later: setup is put off, what was said so far is kept, and Settings offers to finish it. */
  onboardingFinish: (token: string, reason?: "later" | "stopped") =>
    request<{ done: true; setup?: SetupView }>("/onboarding/finish", token, {
      method: "POST",
      body: JSON.stringify(reason ? { reason } : {}),
    }),
  /** Settings → go through setup again: it starts from what's stored, and the app shows setup once /me says so. */
  onboardingRestart: (token: string) => request<{ setup?: SetupView }>("/onboarding/restart", token, { method: "POST" }),

  // Apps people make (Apps → Create; api/src/myapps.ts).
  myApps: (token: string) => request<{ apps: MyApp[] }>("/apps", token),
  designApp: (token: string, description: string) =>
    request<{ draft: AppDraft }>("/apps/design", token, { method: "POST", body: JSON.stringify({ description }) }),
  saveApp: (token: string, draft: AppDraft) =>
    request<{ app: MyApp }>("/apps", token, { method: "POST", body: JSON.stringify(draft) }),
  deleteApp: (token: string, id: string) => request<{ ok: true }>(`/apps/${encodeURIComponent(id)}`, token, { method: "DELETE" }),
  updateApp: (token: string, id: string, draft: AppDraft) =>
    request<{ app: MyApp }>(`/apps/${encodeURIComponent(id)}`, token, { method: "PUT", body: JSON.stringify(draft) }),
  /** Changes an app the way they said ("add a button for dessert ideas"); nothing is saved until they keep it. */
  reviseApp: (token: string, app: AppDraft, change: string) =>
    request<{ draft: AppDraft }>("/apps/revise", token, { method: "POST", body: JSON.stringify({ app, change }) }),
  /** A tap on a made app's screen: no model, so it doesn't count against the day. */
  appOp: (token: string, id: string, op: AppOp) =>
    request<{ app: MyApp }>(`/apps/${encodeURIComponent(id)}/state`, token, {
      method: "POST",
      body: JSON.stringify({ ...op, timeZone: timeZone() }),
    }),

  // ---------- Routines ----------

  routines: (token: string) => request<{ routines: Routine[] }>("/routines", token),
  syncRoutines: (token: string, items: { externalId: string; title: string; times: number[]; days: number[] }[]) =>
    request<RoutineSync>("/routines/sync", token, {
      method: "POST",
      body: JSON.stringify({ source: "apple_reminders", items }),
    }),
  routineExternal: (token: string, id: string, externalId: string) =>
    request(`/routines/${id}/external`, token, { method: "POST", body: JSON.stringify({ externalId }) }),
  routinesWrittenBack: (token: string, ids: string[]) =>
    request("/routines/written-back", token, { method: "POST", body: JSON.stringify({ ids }) }),
  routinesScheduled: (token: string) => request("/routines/scheduled", token, { method: "POST" }),
  confirmRoutine: (token: string, id: string, at: Occurrence & { via?: "notification" | "voice" | "app" }) =>
    request<{ title: string | null }>(`/routines/${id}/confirm`, token, { method: "POST", body: JSON.stringify(at) }),
  snoozeRoutine: (token: string, id: string, at: Occurrence & { minutes?: number }) =>
    request(`/routines/${id}/snooze`, token, { method: "POST", body: JSON.stringify(at) }),

  // ---------- Commands the agent queued for the phone ----------

  /** Claims what's waiting: the server marks these running, so a second drain won't get them too. */
  pendingCommands: (token: string) => request<{ commands: QueuedCommand[] }>("/commands/pending", token),
  commandDone: (token: string, id: string, ok: boolean, result?: string) =>
    request(`/commands/${id}/done`, token, { method: "POST", body: JSON.stringify({ ok, result: result?.slice(0, 2000) }) }),

  /** Overheard and not answered. Kept only for an account with capture-everything on. */
  keepHeard: (token: string, lines: { ts: number; text: string }[]) =>
    request<{ kept: number }>("/transcripts/heard", token, { method: "POST", body: JSON.stringify({ lines }) }),

  // ---------- The agent ----------

  /** Lets the agent reach this phone. Safe to call again; the server replaces the row. */
  registerPush: (token: string, pushToken: string, platform?: string) =>
    request("/push/token", token, { method: "POST", body: JSON.stringify({ token: pushToken, platform }) }),
  unregisterPush: (token: string, pushToken: string) =>
    // In the body, not the query string: a push token is a credential, and in the
    // path it went into device_logs (and Cloudflare's access logs) percent-encoded,
    // where nothing masking ExponentPushToken[…] could match it.
    request("/push/token", token, { method: "DELETE", body: JSON.stringify({ token: pushToken }) }),

  agentNotes: (token: string) => request<{ notes: AgentNote[]; unread: number }>("/agent/notes", token),
  /** No ids means "the screen was opened": everything showing is read. */
  markNotesRead: (token: string, ids?: string[]) =>
    request("/agent/notes/read", token, { method: "POST", body: JSON.stringify({ ids }) }),
  dismissNote: (token: string, id: string) => request(`/agent/notes/${id}`, token, { method: "DELETE" }),

  agentJobs: (token: string) => request<{ jobs: AgentJob[] }>("/agent/jobs", token),
  createJob: (
    token: string,
    job: {
      title: string;
      instruction: string;
      kind: AgentJob["kind"];
      atMinutes?: number | null;
      weekday?: number | null;
      everyMinutes?: number | null;
      inMinutes?: number | null;
      notify?: AgentJob["notify"];
    },
  ) => request<{ id: string }>("/agent/jobs", token, { method: "POST", body: JSON.stringify(job) }),
  updateJob: (token: string, id: string, patch: { status?: "active" | "paused"; notify?: AgentJob["notify"] }) =>
    request(`/agent/jobs/${id}`, token, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteJob: (token: string, id: string) => request(`/agent/jobs/${id}`, token, { method: "DELETE" }),
  /** Runs it now, so a new job can be watched working instead of waited on. */
  runJob: (token: string, id: string) =>
    request<{ outcome: AgentRun["outcome"]; detail: string; note: AgentNote | null }>(`/agent/jobs/${id}/run`, token, {
      method: "POST",
    }),

  agentGoals: (token: string) => request<{ goals: AgentGoal[] }>("/agent/goals", token),
  addGoal: (token: string, text: string, reason?: string) =>
    request<{ id: string }>("/agent/goals", token, { method: "POST", body: JSON.stringify({ text, reason }) }),
  closeGoal: (token: string, id: string, status: "met" | "dropped") =>
    request(`/agent/goals/${id}`, token, { method: "PATCH", body: JSON.stringify({ status }) }),

  agentRuns: (token: string) => request<{ runs: AgentRun[]; usedToday: number }>("/agent/runs", token),

  // ---------- The timeline ----------

  /**
   * Adds one moment to the timeline. The transcript is read on the server to
   * write the summary, and kept there as the recording's words until the user
   * deletes them (a recording made on purpose outlives the 14 days,
   * api/src/retention.ts).
   */
  addContextBlock: (
    token: string,
    block: { startedAt: number; endedAt: number; source: ContextBlock["source"]; transcript?: string; note?: string },
  ) =>
    request<{ block: { id: string; title: string; summary: string } }>("/context/blocks", token, {
      method: "POST",
      body: JSON.stringify({ ...block, timeZone: timeZone() }),
    }),
  /**
   * A note as text only. `on_device`: the words came from the phone's own
   * speech recognition (onDeviceTranscribe.ts), so no audio goes with it and
   * none is needed; the free plan's notes arrive this way.
   */
  addNote: (token: string, note: { text: string; source?: "on_device" | "typed"; tags?: string[]; remindAt?: string }) =>
    request<{ id: string }>("/notes", token, { method: "POST", body: JSON.stringify(note) }),
  /** Open notes, newest first (up to 100). Free. */
  notes: (token: string) => request<{ notes: Note[] }>("/notes", token),
  contextDay: (token: string, date: string) =>
    request<ContextDay>(`/context/days/${date}?timeZone=${encodeURIComponent(timeZone())}`, token),
  /** The week that `date` falls in. One call instead of seven. */
  contextWeek: (token: string, date: string) =>
    request<ContextWeek>(`/context/weeks/${date}?timeZone=${encodeURIComponent(timeZone())}`, token),
  commitments: (token: string) =>
    request<{ open?: number; commitments?: Commitment[]; note?: string }>("/context/commitments", token),
  /** "Forget that." Takes the block and everything pulled out of it. */
  forgetBlock: (token: string, id: string) => request(`/context/blocks/${id}`, token, { method: "DELETE" }),
  /** "Forget the last hour." */
  forgetSince: (token: string, since: number) =>
    request<{ forgot: number }>(`/context/blocks?since=${since}`, token, { method: "DELETE" }),

  createSiriKey: (token: string) => request<{ key: string; url: string }>("/siri/key", token, { method: "POST" }),
  deleteSiriKey: (token: string) => request("/siri/key", token, { method: "DELETE" }),

  // ---------- What it costs ----------

  /** This person's own usage today and this month, for Dev tools. */
  usage: (token: string) => request<UsageSummary>("/usage/me", token),

  // ---------- Which engine answers (development accounts only) ----------

  engines: (token: string) => request<EngineStatus>("/engines", token),
  /** Sets (or with "" clears) any of the settings, for this person or for everyone. */
  setEngines: (token: string, patch: ServerSettings, scope: "me" | "everyone") =>
    request<EngineStatus>("/engines", token, { method: "PUT", body: JSON.stringify({ ...patch, scope }) }),
};
