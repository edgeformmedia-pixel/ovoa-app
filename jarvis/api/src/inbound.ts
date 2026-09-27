// Opt-in inbound for creators: "text JAKE to OVOA".
//
// A creator (any OVOA user) makes a code and up to five short questions. Anyone
// who texts that code, alone, to OVOA's line is opting in: OVOA answers with
// the intro and the first question, then asks the rest one at a time and keeps
// the answers. The owner asks their own OVOA "who answered?" (inbound_results)
// and gets everyone back, to rank or follow up with themselves.
//
// This is the opt-in version of outreach on purpose. OVOA never texts anyone
// who didn't text the code first, never shows a respondent's number or answers
// to anyone but the code's owner, stops when they text STOP (keywords.ts, which
// runs first), and caps new respondents per code per day. Asking the questions
// needs no model at all, so a thousand fans cost nothing; the owner's own OVOA
// reads the answers on their plan when they ask.
//
// Only for numbers with no OVOA account linked (texting.ts guest path), and off
// unless INBOUND_CODES is "1".

import type { CallTool, ToolSpec } from "./llm";
import type { Env } from "./types";

export const inboundOn = (env: Env) => env.INBOUND_CODES === "1";

export const MAX_QUESTIONS = 5;
export const MAX_CODES = 5;
const ANSWER_MAX = 500;
const DAY_MS = 86_400_000;
/** An unfinished screener is dropped after this, so an old one doesn't catch an ordinary text. */
const STALE_MS = 2 * DAY_MS;

/** Letters only, 3 to 15: never mistaken for an account link code (texting.ts, which has digits). */
const CODE = /^[A-Z]{3,15}$/;
const RESERVED = new Set(["STOP", "START", "HELP", "INFO", "CARD", "CONTACT", "UNSUBSCRIBE", "STOPALL", "UNSTOP", "YES", "NO", "UNLINK", "OVOA"]);

export function codeProblem(code: string): string | null {
  if (!CODE.test(code)) return "A code is 3 to 15 letters, like JAKE.";
  if (RESERVED.has(code)) return `${code} is a word OVOA already uses. Pick another.`;
  return null;
}

type CodeRow = { code: string; user_id: string; intro: string; questions: string; active: number; daily_cap: number };
type Respondent = { code: string; phone: string; step: number; answers: string; started_at: number; updated_at: number; done_at: number | null };

const questionsOf = (row: Pick<CodeRow, "questions">): string[] => {
  try {
    const q = JSON.parse(row.questions) as unknown;
    return Array.isArray(q) ? q.map(String) : [];
  } catch {
    return [];
  }
};

export const DONE_TEXT = "That's everything, thanks! They'll see your answers. Text STOP anytime and you won't hear from OVOA.";
export const FULL_TEXT = "Lots of people texted this today, so it's full. Try again tomorrow!";

/**
 * Handles a text from a number with no account, if it's a code or an answer to
 * a screener in progress. Returns what happened, or null to let the free trial
 * (guest.ts) have it.
 */
export async function inboundText(
  env: Env,
  phone: string,
  content: string,
  send: (text: string) => Promise<boolean>,
  now = Date.now(),
): Promise<string | null> {
  const db = env.DB;
  const word = content.trim().toUpperCase().replace(/[.!]+$/, "");

  // Someone partway through a screener is answering it, even with a word that's also a code
  // ("what's your name?" "Jake"). Checked first.
  const open = await db
    .prepare(
      "SELECT r.*, c.questions, c.active FROM inbound_respondents r JOIN inbound_codes c ON c.code = r.code WHERE r.phone = ? AND r.done_at IS NULL AND r.updated_at > ? ORDER BY r.updated_at DESC LIMIT 1",
    )
    .bind(phone, now - STALE_MS)
    .first<Respondent & { questions: string; active: number }>();
  if (open && open.active) return answerOpen(db, open, phone, content, send, now);

  // A code, alone: opting in.
  if (CODE.test(word)) {
    const code = await db.prepare("SELECT * FROM inbound_codes WHERE code = ? AND active = 1").bind(word).first<CodeRow>();
    if (code) {
      const already = await db.prepare("SELECT done_at FROM inbound_respondents WHERE code = ? AND phone = ?").bind(word, phone).first<{ done_at: number | null }>();
      if (already?.done_at) {
        await send("You already answered this one, thanks!");
        return "inbound: already answered";
      }
      if (!already) {
        const today = await db
          .prepare("SELECT COUNT(*) AS n FROM inbound_respondents WHERE code = ? AND started_at > ?")
          .bind(word, now - DAY_MS)
          .first<{ n: number }>();
        if ((today?.n ?? 0) >= code.daily_cap) {
          await send(FULL_TEXT);
          return "inbound: full";
        }
        await db
          .prepare("INSERT INTO inbound_respondents (code, phone, step, answers, started_at, updated_at) VALUES (?, ?, 0, '[]', ?, ?)")
          .bind(word, phone, now, now)
          .run();
      } else {
        // An old screener they never finished (open ones are answered above): start it over.
        await db.prepare("UPDATE inbound_respondents SET step = 0, answers = '[]', updated_at = ? WHERE code = ? AND phone = ?").bind(now, word, phone).run();
      }
      const questions = questionsOf(code);
      await send(`${code.intro}\n\n${questions[0] ?? ""}`.trim());
      return "inbound: opted in";
    }
  }

  return null;
}

async function answerOpen(
  db: D1Database,
  open: Respondent & { questions: string; active: number },
  phone: string,
  content: string,
  send: (text: string) => Promise<boolean>,
  now: number,
): Promise<string> {
  // An answer to the question they were last asked.
  const questions = questionsOf(open);
  let answers: string[] = [];
  try {
    answers = JSON.parse(open.answers) as string[];
  } catch {
    answers = [];
  }
  answers[open.step] = content.trim().slice(0, ANSWER_MAX);
  const next = open.step + 1;
  const finished = next >= questions.length;
  await db
    .prepare("UPDATE inbound_respondents SET step = ?, answers = ?, updated_at = ?, done_at = ? WHERE code = ? AND phone = ?")
    .bind(next, JSON.stringify(answers), now, finished ? now : null, open.code, phone)
    .run();
  await send(finished ? DONE_TEXT : questions[next]!);
  return finished ? "inbound: finished" : "inbound: answered";
}

/** Someone who texted STOP isn't asked anything more. */
export async function endInboundFor(db: D1Database, phone: string, now = Date.now()) {
  await db.prepare("UPDATE inbound_respondents SET done_at = ?, updated_at = ? WHERE phone = ? AND done_at IS NULL").bind(now, now, phone).run();
}

// ---------- The owner's tools ----------

const TOOLS: ToolSpec[] = [
  {
    name: "inbound_create",
    description:
      "Makes a public text-in code for them (e.g. JAKE): anyone who texts that code to OVOA's number opts in and gets their short intro and up to 5 questions, one at a time. For creators collecting fans, leads or applicants. Letters only, 3 to 15.",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string" },
        intro: { type: "string", description: "The first thing a person gets, e.g. 'Hey! It's Jake's AI. 3 quick questions.'" },
        questions: { type: "array", items: { type: "string" }, description: "1 to 5 short questions, asked in order." },
      },
      required: ["code", "intro", "questions"],
    },
  },
  {
    name: "inbound_results",
    description:
      "Who texted one of their codes and what they answered (in parts: pass offset=nextOffset). With no code, lists their codes with counts.",
    parameters: { type: "object", properties: { code: { type: "string" }, offset: { type: "number" } } },
  },
  {
    name: "inbound_close",
    description: "Closes one of their codes: new texts of it are ignored. Answers so far stay.",
    parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
  },
];

const NAMES = new Set(TOOLS.map((t) => t.name));
export const isInboundTool = (name: string) => NAMES.has(name);

export function inboundAssistant(env: Env, userId: string) {
  if (!inboundOn(env)) return { tools: [] as ToolSpec[], callTool: (async () => ({ error: "Text-in codes aren't on." })) as CallTool, prompt: "" };
  const db = env.DB;

  const callTool: CallTool = async (name, args) => {
    if (name === "inbound_create") {
      const code = String(args.code ?? "").trim().toUpperCase();
      const problem = codeProblem(code);
      if (problem) return { error: problem };
      const questions = (Array.isArray(args.questions) ? args.questions : []).map((q) => String(q).trim().slice(0, 300)).filter(Boolean);
      if (!questions.length || questions.length > MAX_QUESTIONS) return { error: `Give 1 to ${MAX_QUESTIONS} questions.` };
      const intro = String(args.intro ?? "").trim().slice(0, 300);
      if (!intro) return { error: "intro is required" };
      const mine = await db.prepare("SELECT COUNT(*) AS n FROM inbound_codes WHERE user_id = ? AND active = 1").bind(userId).first<{ n: number }>();
      if ((mine?.n ?? 0) >= MAX_CODES) return { error: `They already have ${MAX_CODES} open codes. Close one first.` };
      const taken = await db.prepare("SELECT user_id FROM inbound_codes WHERE code = ?").bind(code).first<{ user_id: string }>();
      if (taken && taken.user_id !== userId) return { error: `${code} is taken. Try another.` };
      await db
        .prepare(
          "INSERT INTO inbound_codes (code, user_id, intro, questions, active, created_at) VALUES (?, ?, ?, ?, 1, ?) ON CONFLICT(code) DO UPDATE SET intro = excluded.intro, questions = excluded.questions, active = 1",
        )
        .bind(code, userId, intro, JSON.stringify(questions), Date.now())
        .run();
      return { code, questions: questions.length, tellPeople: `Text ${code} to OVOA's number` };
    }
    if (name === "inbound_results") {
      const code = String(args.code ?? "").trim().toUpperCase();
      if (!code) {
        const { results } = await db
          .prepare(
            "SELECT c.code, c.active, (SELECT COUNT(*) FROM inbound_respondents r WHERE r.code = c.code) AS started, (SELECT COUNT(*) FROM inbound_respondents r WHERE r.code = c.code AND r.done_at IS NOT NULL) AS finished FROM inbound_codes c WHERE c.user_id = ? ORDER BY c.created_at",
          )
          .bind(userId)
          .all<{ code: string; active: number; started: number; finished: number }>();
        return { codes: results.map((r) => ({ code: r.code, open: !!r.active, started: r.started, finished: r.finished })) };
      }
      const owned = await db.prepare("SELECT * FROM inbound_codes WHERE code = ? AND user_id = ?").bind(code, userId).first<CodeRow>();
      if (!owned) return { error: `They have no code ${code}.` };
      const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
      const { results } = await db
        .prepare("SELECT phone, answers, done_at FROM inbound_respondents WHERE code = ? ORDER BY started_at LIMIT 25 OFFSET ?")
        .bind(code, offset)
        .all<{ phone: string; answers: string; done_at: number | null }>();
      const total = await db.prepare("SELECT COUNT(*) AS n FROM inbound_respondents WHERE code = ?").bind(code).first<{ n: number }>();
      const questions = questionsOf(owned);
      return {
        code,
        questions,
        total: total?.n ?? 0,
        offset,
        nextOffset: offset + results.length < (total?.n ?? 0) ? offset + results.length : null,
        people: results.map((r) => ({ phone: r.phone, finished: !!r.done_at, answers: (JSON.parse(r.answers) as string[]).map((a) => a?.slice(0, 200) ?? null) })),
      };
    }
    if (name === "inbound_close") {
      const code = String(args.code ?? "").trim().toUpperCase();
      const done = await db.prepare("UPDATE inbound_codes SET active = 0 WHERE code = ? AND user_id = ?").bind(code, userId).run();
      return done.meta.changes ? { closed: code } : { error: `They have no code ${code}.` };
    }
    return { error: `Unknown tool ${name}` };
  };

  return {
    tools: TOOLS,
    callTool,
    prompt:
      "Text-in codes: a creator can have people text a code (like JAKE) to OVOA's number to opt in and answer a few questions (inbound_create). When they ask who answered, read inbound_results and rank or summarize for them. Only people who texted the code are ever texted, and only by OVOA's line.",
  };
}
