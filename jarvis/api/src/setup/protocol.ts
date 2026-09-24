import { z } from "zod";
import { sentenceStream } from "../sentences";
import { isObjectiveId, type ObjectiveId } from "./objectives";

// One setup reply, one streamed model call: first the words OVOA says, then a
// small update block the server reads (the AI-led setup, 2026-09-23):
//
//   Seven and eleven, got it. What would you most like a hand with?
//   <update>{"fill":{"day":{"wake":"07:00","bed":"23:00"}},"unsure":[],"decline":[],"asking":["goals"],"end":null}</update>
//
// A text trailer rather than a tool call: it reads the same on Workers AI, Z.ai
// and Gemini, and it guarantees the words come first, so the first sentence is
// being voiced while the model is still writing the JSON. replySplitter keeps
// the JSON out of the voice; parseUpdate reads it, forgivingly.

/** Spoken characters with no update in sight: the reply has run away, and the model is stopped. */
export const SPOKEN_CAP = 700;

/** Where the spoken part ends: the update tag, a code fence, or a bare JSON object. */
const MARKER = /<update|```|\{\s*"/;
/** A tail that may still become a marker once the next piece arrives: "<", "<upd", "`", "{". */
const PARTIAL = /(?:<(?:u(?:p(?:d(?:a(?:t)?)?)?)?)?|`{1,2}|\{\s*)$/;

/**
 * Splits a streamed reply into speech and its update. Speech goes through
 * sentenceStream (sentences.ts) with the first clause sent early, as a spoken
 * Talk turn's does. At the marker the last sentence is flushed at once, so
 * "…what time do you get up?<update>" is voiced before the JSON is written
 * (a sentence only ends at whitespace after "?", and none comes), then
 * `onMarker` is called once with everything spoken. push() keeps returning true
 * after the marker so the JSON is never cut off; before it, false means stop
 * (a runaway or looping reply, SPOKEN_CAP).
 */
export function replySplitter(onSpeech: (sentence: string) => void, onMarker: (spoken: string) => void) {
  const speech = sentenceStream(onSpeech, SPOKEN_CAP, { firstClause: true });
  let raw = "";
  /** raw before this has been spoken, skipped, or held as the trailer. */
  let pos = 0;
  let phase: "lead" | "think" | "speech" | "trailer" = "lead";
  let trailerAt = -1;
  let going = true;

  const toTrailer = (at: number) => {
    if (at > pos) going = speech.push(raw.slice(pos, at));
    speech.end();
    phase = "trailer";
    trailerAt = at;
    pos = raw.length;
    onMarker(speech.text());
  };

  const step = () => {
    for (;;) {
      if (phase === "lead") {
        const rest = raw.slice(pos);
        const body = rest.trimStart();
        const at = pos + rest.length - body.length;
        if (!body) return;
        // Some hosts put the model's reasoning in the content: never spoken.
        if (body.startsWith("<think>")) {
          phase = "think";
          pos = at + "<think>".length;
          continue;
        }
        // An update with no words before it: nothing to say (turn.ts asks once more).
        if (/^(<update|```|\{)/.test(body)) return toTrailer(at);
        if (["<think>", "<update", "```"].some((tag) => tag.startsWith(body))) return;
        phase = "speech";
        pos = at;
        continue;
      }
      if (phase === "think") {
        const end = raw.indexOf("</think>", pos);
        if (end < 0) return;
        pos = end + "</think>".length;
        phase = "lead";
        continue;
      }
      if (phase === "speech") {
        const rest = raw.slice(pos);
        const m = MARKER.exec(rest);
        if (m) return toTrailer(pos + m.index);
        const held = PARTIAL.exec(rest);
        const upTo = pos + (held ? held.index : rest.length);
        if (upTo > pos) {
          going = speech.push(raw.slice(pos, upTo));
          pos = upTo;
        }
      }
      return;
    }
  };

  return {
    /** A piece of the reply. False: stop the model (only ever before the update). */
    push(delta: string) {
      raw += delta;
      if (phase !== "trailer") step();
      return phase === "trailer" || going;
    },
    /** The model finished. A tail held back as a possible marker was speech after all. */
    end() {
      if (phase === "speech" && pos < raw.length) speech.push(raw.slice(pos));
      if (phase !== "trailer") speech.end();
      pos = raw.length;
    },
    /** Everything spoken, repeats left out. */
    spoken: () => speech.text(),
    /** The update block as written, or "" when there was none. */
    trailer: () => (trailerAt < 0 ? "" : raw.slice(trailerAt)),
  };
}

// ---------- The update ----------

export type Update = {
  /** Objective id → the value their latest message gave (objectives.ts reads each). */
  fill: Partial<Record<ObjectiveId, unknown>>;
  /** Filled but not sure it was heard right: kept as 'low', and nothing risky stored until it's confirmed. */
  unsure: ObjectiveId[];
  decline: ObjectiveId[];
  /** What the reply asks about: Skip declines these, and the asked counts grow. */
  asking: ObjectiveId[];
  end: "complete" | "stop" | null;
};

/** Most objectives one update may fill. More is a model listing everything it knows, not what it just heard. */
const MAX_FILLS = 8;

/** A list of objective ids; a lone id counts as a list of one. */
const ids = z
  .preprocess((v) => (typeof v === "string" ? [v] : v), z.array(z.unknown()))
  .catch([])
  .transform((list) => [...new Set(list.filter(isObjectiveId))]);

const updateSchema = z.object({
  fill: z
    .union([
      z.record(z.string(), z.unknown()),
      // The longer shape a model may fall back on: [{"id", "value", "confidence"}].
      z.array(z.object({ id: z.string(), value: z.unknown(), confidence: z.string().optional() })),
    ])
    .optional()
    .catch(undefined),
  unsure: ids.optional(),
  decline: ids.optional(),
  asking: ids.optional(),
  end: z.unknown().optional(),
});

/**
 * Reads an update block: tags and code fences stripped, the outermost {…}
 * taken, trailing commas mended, then checked. Unknown objective ids are
 * dropped here; a value of the wrong shape is objectives.ts's to report. Null
 * when there's nothing readable: the spoken reply still stands (turn.ts marks
 * the update lost, and the next turn's state says so).
 */
export function parseUpdate(trailer: string): Update | null {
  const body = trailer.replace(/<\/?update[^>]*>/gi, "").replace(/```(?:json)?/gi, "");
  const from = body.indexOf("{");
  const to = body.lastIndexOf("}");
  if (from < 0 || to <= from) return null;
  let json: unknown;
  try {
    json = JSON.parse(body.slice(from, to + 1).replace(/,\s*([}\]])/g, "$1"));
  } catch {
    return null;
  }
  const p = updateSchema.safeParse(json);
  if (!p.success) return null;
  const u = p.data;
  const fill: Update["fill"] = {};
  const unsure = [...(u.unsure ?? [])];
  const entries = Array.isArray(u.fill)
    ? u.fill.map((f) => {
        if (f.confidence === "low" && isObjectiveId(f.id) && !unsure.includes(f.id)) unsure.push(f.id);
        return [f.id, f.value] as const;
      })
    : Object.entries(u.fill ?? {});
  for (const [id, value] of entries) {
    if (isObjectiveId(id) && value !== undefined && value !== null && Object.keys(fill).length < MAX_FILLS) fill[id] = value;
  }
  return {
    fill,
    unsure,
    decline: u.decline ?? [],
    asking: (u.asking ?? []).slice(0, 3),
    end: /^(complete|completed|done)$/i.test(String(u.end)) ? "complete" : /^stop/i.test(String(u.end)) ? "stop" : null,
  };
}
