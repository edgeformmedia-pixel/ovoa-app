import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { config, MODEL } from "../config.js";
import { assistantTools, webSearchTool } from "../tools/index.js";

let client: Anthropic | null = null;
export function claude(): Anthropic {
  if (!client) {
    if (!config.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    client = new Anthropic({ apiKey: config.anthropicApiKey });
  }
  return client;
}

/**
 * Safety classifiers can decline a request (HTTP 200, stop_reason "refusal").
 * Rather than pinning a substitute model we let the server route by refusal
 * category, so there is no fallback list to maintain as models change.
 */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

const EnrichmentSchema = z.object({
  title: z.string().describe("Six words or fewer, no trailing punctuation"),
  summary: z.string().describe("Two to four sentences, plain past tense"),
  action_items: z
    .array(z.string())
    .describe("Concrete commitments someone made. Empty array if none."),
});

export interface Enrichment {
  title: string;
  summary: string;
  actionItems: string[];
}

const ENRICH_SYSTEM = `You process transcripts from an always-on wearable microphone.

The audio is ambient and unstructured: half-finished sentences, background
speech, and long stretches of nothing. Speaker labels come from automatic
diarization and are frequently wrong.

Summarize only what was actually said. Do not infer intent, invent names, or
fill gaps with plausible detail. If the transcript is too fragmentary to
summarize, say so in the summary rather than guessing.

An action item is something a speaker committed to doing. A topic that merely
came up is not an action item.`;

export async function enrichTranscript(transcript: string): Promise<Enrichment> {
  const response = await claude().messages.parse({
    model: MODEL,
    max_tokens: 4096,
    system: [{ type: "text", text: ENRICH_SYSTEM, cache_control: { type: "ephemeral" } }],
    // Enrichment is a bounded extraction task; low effort is both cheaper and
    // faster here, and this runs on every capture.
    output_config: { effort: "low", format: zodOutputFormat(EnrichmentSchema) },
    messages: [{ role: "user", content: `<transcript>\n${transcript}\n</transcript>` }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error(
      `Enrichment refused: ${response.stop_details?.explanation ?? "no explanation"}`,
    );
  }

  const parsed = response.parsed_output;
  if (!parsed) throw new Error("Enrichment returned unparseable output");

  return {
    title: parsed.title,
    summary: parsed.summary,
    actionItems: parsed.action_items,
  };
}

const CHAT_SYSTEM = `You are OVOA, the assistant behind a wearable microphone the
user carries through their day.

## What you can and cannot know

The pendant is a microphone. It has no GPS, no camera, and no network of its
own. You know things because somebody said them out loud near the wearer.

You do not observe the world directly. You cannot see where anyone is, what
they are doing now, or anything that was not spoken near the pendant.

## Using your tools

Search before you answer. Almost every question about the wearer's life is
answerable from their recordings, and you have no memory of them otherwise.

Transcripts are automatic and imperfect — misheard words, dropped audio, wrong
speaker labels. If the obvious phrasing finds nothing, search again with the
words people would actually have spoken. Two or three attempts before concluding
something was not recorded.

Use get_current_context before answering anything relative to now — "today",
"this week", "where am I" — rather than assuming the date.

## Answering about other people

When asked where someone is, or what they are doing, search the transcripts
first. People announce their plans constantly, and "she said at breakfast she'd
be at Maya's until six" is usually what the person actually wanted.

Be precise about what that is. It is what someone said they intended, not where
they are. Say so, and give the time it was said, so the wearer can judge how
stale it is. Never present a recalled plan as a current location.

If there is no live location sharing, say that plainly rather than implying you
could find out.

## Grounding

Ground every claim in a tool result. When the recordings do not cover something,
say what is missing instead of reconstructing it — a confident wrong answer
about the user's own life is worse than an admission that the audio did not
catch it. Quote the transcript when exact wording matters.

Answers are read on a phone, often one-handed. Keep them short.`;

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * Answers a question using the wearer's recordings, their phone's reported
 * state, and web search.
 *
 * Transcripts are reached through a search tool rather than pasted into the
 * prompt: a day of wear is roughly 40k tokens, so context-stuffing stops fitting
 * within a week and can never reach older recordings at any size.
 *
 * Returns the tool runner so the route can stream text deltas and tool activity
 * to the phone as they happen.
 */
export function streamChat(opts: { turns: ChatTurn[] }) {
  return claude().beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 8192,
    betas: [FALLBACK_BETA],
    // Route around category-specific refusals without pinning a model.
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    system: [{ type: "text", text: CHAT_SYSTEM, cache_control: { type: "ephemeral" } }],
    tools: [...assistantTools, webSearchTool],
    messages: opts.turns.map((t) => ({ role: t.role, content: t.content })),
    stream: true,
  });
}
