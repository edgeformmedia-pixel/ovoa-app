import { z } from "zod";
import { generateText } from "./llm";
import type { Env } from "./types";

// Always-listening sends everything the phone overhears. Before treating it as
// a message, decide whether it was actually said to the assistant, the way a
// person in the room would: their name, a request plainly aimed at them, or a
// reply to what they just said. Anything else (talk with other people, TV,
// phone calls, thinking out loud) gets silence.

/** Right after the assistant speaks, an unnamed reply is probably for it. */
const FOLLOW_UP_MS = 45_000;
const CONTEXT_MESSAGES = 6;

const verdictSchema = {
  type: "object",
  properties: { addressed: { type: "boolean" } },
  required: ["addressed"],
};

function editDistance(a: string, b: string) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = row[j];
      row[j] = next;
    }
  }
  return row[b.length];
}

/**
 * Whether the assistant's name is said, allowing for how transcription spells
 * it: "OVOA" comes back as "Ovoa", "Ovo", "Ova", "O.V.O.A." and so on. Any word,
 * or two words run together, within one edit of the name counts.
 */
export function saysName(text: string, name: string) {
  const clean = (s: string) => s.toLowerCase().normalize("NFD").replace(/[^a-z0-9 ]/g, "").trim();
  const target = clean(name).replace(/ /g, "");
  if (target.length < 3) return false;
  // "O.V.O.A." and "o v o a" become "ovoa".
  const joined = text.toLowerCase().replace(/\b([a-z])[. ]+(?=[a-z]\b)/g, "$1");
  const words = clean(joined.replace(/[^a-z0-9]+/gi, " ")).split(/\s+/).filter(Boolean);
  const candidates = [...words, ...words.slice(1).map((w, i) => words[i] + w)];
  const allowed = target.length >= 4 ? 1 : 0;
  return candidates.some((w) => Math.abs(w.length - target.length) <= allowed && editDistance(w, target) <= allowed);
}

/**
 * Words a sentence aimed at an assistant tends to open with: a question, or an
 * instruction. Deliberately generous — a real request wrongly dropped here is
 * silence the user notices, while a stray line of television getting as far as
 * the model only costs what it always cost.
 */
const REQUEST_START =
  /^(what|whats|when|where|who|whose|why|how|which|is|are|was|were|can|could|would|will|do|does|did|should|shall|am|any|tell|remind|text|message|call|email|mail|send|set|add|put|schedule|book|play|pause|stop|start|cancel|delete|remove|open|show|find|look|check|search|read|write|draft|make|create|turn|give|help|log|note|remember|forget|snooze|wake|save)\b/i;

/** The discourse markers people start a sentence with before getting to the point. */
const PREAMBLE = /^(hey|hi|ok|okay|so|um|uh|well|yeah|alright|right|and|but|oh|now|please)[,\s]+/i;

function looksLikeARequest(text: string) {
  const trimmed = text.trim();
  if (trimmed.includes("?")) return true;
  if (REQUEST_START.test(trimmed)) return true;
  const stripped = trimmed.replace(PREAMBLE, "");
  return stripped !== trimmed && REQUEST_START.test(stripped);
}

export async function isMeantForAssistant(env: Env, userId: string | null, text: string, assistantName: string) {
  if (saysName(text, assistantName)) {
    console.log("ambient: says name", text);
    return true;
  }

  // Filler and fragments never need the model.
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) {
    console.log("ambient: too short", text);
    return false;
  }

  const recent = userId
    ? await env.DB
        .prepare("SELECT role, content, created_at FROM messages WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
        .bind(userId, CONTEXT_MESSAGES)
        .all<{ role: "user" | "assistant"; content: string; created_at: number }>()
    : { results: [] as { role: "user" | "assistant"; content: string; created_at: number }[] };
  const now = Date.now();
  const lastReply = recent.results.find((m) => m.role === "assistant");
  const secondsSinceReply = lastReply ? Math.round((now - lastReply.created_at) / 1000) : null;

  // A room the assistant isn't part of: unless it has just spoken, the only thing
  // that earns a model call is something shaped like a request. A television
  // produced dozens of these a minute on 2026-09-21, and each one spent the same
  // quota the user's real questions needed -- which is how a spoken turn ended up
  // waiting on the slowest engine available.
  const inConversation = secondsSinceReply !== null && secondsSinceReply * 1000 < FOLLOW_UP_MS;
  if (!inConversation && !looksLikeARequest(text)) {
    console.log("ambient: room talk (no model call)", text);
    return false;
  }

  try {
    const raw = await generateText(env, {
      model: env.CHAT_MODEL,
      json: { schema: verdictSchema },
      fast: true,
      system: [
        `You are the gatekeeper for ${assistantName}, a voice assistant whose microphone is always on.`,
        "You get one sentence the microphone just overheard. Decide whether the user said it TO the assistant.",
        "addressed = true when:",
        `- it names the assistant (${assistantName}), even misspelled by transcription;`,
        "- it's a clear command or question for an assistant (\"what's the weather\", \"remind me to call mom\", \"text Sam I'm late\") and nothing suggests another person is being spoken to;",
        "- the assistant spoke in the last ~45 seconds and this answers or follows up on what it said.",
        "addressed = false when it's conversation with someone else, one side of a phone call, TV/music/video audio,",
        "thinking out loud, a fragment, filler (\"yeah\", \"okay\", \"hmm\"), or anything about the assistant in the third person.",
        "When unsure, answer false: speaking up uninvited is worse than staying quiet.",
      ].join("\n"),
      turns: [
        {
          role: "user",
          text: JSON.stringify({
            overheard: text,
            secondsSinceAssistantLastSpoke: secondsSinceReply,
            recentConversation: recent.results
              .reverse()
              .map((m) => ({ from: m.role === "assistant" ? assistantName : "user", said: m.content.slice(0, 400) })),
          }),
        },
      ],
    });
    const addressed = z.object({ addressed: z.boolean() }).parse(JSON.parse(raw)).addressed;
    console.log(`ambient: ${addressed ? "addressed" : "ignored"}`, text);
    return addressed;
  } catch (err) {
    console.error("ambient check failed", err);
    // Can't tell: only a very recent follow-up gets through.
    return secondsSinceReply !== null && secondsSinceReply * 1000 < FOLLOW_UP_MS;
  }
}
