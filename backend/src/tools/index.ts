import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { captures, deviceState } from "../db.js";

/**
 * Tools the assistant can call while answering.
 *
 * The guiding rule is that everything here is answerable from the wearer's own
 * audio or their own phone. Anything requiring another person's data needs
 * consent infrastructure that does not exist yet - see docs/capabilities.md.
 */

const searchTranscripts = betaZodTool({
  name: "search_transcripts",
  description:
    "Search everything the wearer's microphone has recorded. Use this for any " +
    "question about what was said, what happened, what someone mentioned, or " +
    "what the wearer agreed to. Returns short snippets with capture IDs - call " +
    "get_capture to read the full conversation around a promising hit. " +
    "Search generously: transcripts are imperfect, so if the obvious phrasing " +
    "returns nothing, try the words people would actually have spoken.",
  inputSchema: z.object({
    query: z
      .string()
      .describe("Words likely to appear in the conversation, not a question"),
    from: z
      .string()
      .optional()
      .describe("ISO 8601 lower bound on capture start time"),
    to: z.string().optional().describe("ISO 8601 upper bound on capture start time"),
    limit: z.number().int().min(1).max(25).optional(),
  }),
  run: async ({ query, from, to, limit }) => {
    const hits = captures.search({ query, from, to, limit });
    if (hits.length === 0) {
      return "No matching audio. The conversation may not have been recorded, or may have been transcribed differently.";
    }
    return JSON.stringify(
      hits.map((h) => ({
        capture_id: h.id,
        recorded_at: h.started_at,
        title: h.title,
        excerpt: h.snippet,
      })),
    );
  },
});

const getCapture = betaZodTool({
  name: "get_capture",
  description:
    "Read the full transcript, summary, and action items of one capture, by ID.",
  inputSchema: z.object({
    capture_id: z.string().describe("ID from search_transcripts or list_captures"),
  }),
  run: async ({ capture_id }) => {
    const capture = captures.get(capture_id);
    if (!capture) return "No capture with that ID.";
    return JSON.stringify({
      recorded_at: capture.startedAt,
      duration_sec: capture.durationSec,
      title: capture.title,
      summary: capture.summary,
      action_items: capture.actionItems,
      transcript: capture.transcript,
    });
  },
});

const listCaptures = betaZodTool({
  name: "list_captures",
  description:
    "List recent captures with their titles and summaries, newest first. Use " +
    "this for questions about a period of time rather than a specific topic - " +
    "'what happened today', 'what did I miss this week'.",
  inputSchema: z.object({
    limit: z.number().int().min(1).max(50).optional(),
  }),
  run: async ({ limit }) => {
    const rows = captures.list(limit ?? 15);
    if (rows.length === 0) return "No captures recorded yet.";
    return JSON.stringify(
      rows.map((c) => ({
        capture_id: c.id,
        recorded_at: c.startedAt,
        duration_sec: c.durationSec,
        title: c.title,
        summary: c.summary,
        action_items: c.actionItems,
        status: c.status,
      })),
    );
  },
});

const getCurrentContext = betaZodTool({
  name: "get_current_context",
  description:
    "The wearer's current situation: server time, and whatever the phone last " +
    "reported about location and pendant battery. Call this before answering " +
    "anything relative to now ('today', 'this week') or about where the wearer is.",
  inputSchema: z.object({}),
  run: async () => {
    const now = new Date();
    const state = deviceState.get();

    if (!state) {
      return JSON.stringify({
        server_time: now.toISOString(),
        note: "The phone has not reported location or battery yet.",
      });
    }

    // Stale location is worse than no location if the model treats it as
    // current, so the age is returned alongside it rather than left implicit.
    const ageMin = Math.round((now.getTime() - new Date(state.reportedAt).getTime()) / 60_000);

    return JSON.stringify({
      server_time: now.toISOString(),
      timezone: state.timezone,
      location: state.latitude != null
        ? { latitude: state.latitude, longitude: state.longitude, label: state.placeLabel }
        : null,
      location_age_minutes: ageMin,
      pendant_battery_pct: state.batteryPct,
    });
  },
});

/**
 * Locating another person is deliberately a stub that explains itself.
 *
 * The honest answer to "where's my kid" is usually in the transcripts - someone
 * said where they were going. Live location is a different product: it needs
 * per-user accounts, a revocable grant from the person being located, and an
 * audit trail they can see. Returning a helpful-sounding guess here, or wiring
 * it up without those, is how this category of feature becomes stalkerware.
 */
const locateFamilyMember = betaZodTool({
  name: "locate_family_member",
  description:
    "Report whether live location sharing is available for a family member. " +
    "Call this only after search_transcripts, since what someone said about " +
    "their plans is usually the better answer.",
  inputSchema: z.object({
    name: z.string().describe("The family member as the wearer referred to them"),
  }),
  run: async ({ name }) => {
    return JSON.stringify({
      available: false,
      reason:
        `Live location sharing is not set up. OVOA cannot locate ${name} — the ` +
        `pendant is a microphone with no GPS, and locating another person ` +
        `requires them to share their location from their own device first.`,
      suggestion:
        "Search the transcripts for what they said about their plans, and offer " +
        "that instead. Be clear it is what they said, not where they are.",
    });
  },
});

export const assistantTools = [
  searchTranscripts,
  getCapture,
  listCaptures,
  getCurrentContext,
  locateFamilyMember,
];

/**
 * Anthropic-hosted, so there is nothing to implement and no result to return:
 * the search runs server-side and its results arrive in the same response.
 */
export const webSearchTool = {
  type: "web_search_20260209" as const,
  name: "web_search" as const,
  max_uses: 5,
};
