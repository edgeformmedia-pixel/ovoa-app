// Google's Gemini API at its lowest level: one plain call (generate) and one
// answer grounded in Google Search (grounded). Only llm.ts calls these, and only
// after asking the gate there; test/gate.test.ts fails if anything else does.

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export type Turn = { role: "user" | "model"; text: string };

/**
 * The least thinking a Gemini model takes, for spoken turns and quick calls.
 * Flash-Lite goes down to "minimal", which is also its default; the 3.x Flash
 * models refuse "minimal" with a 400 ("Thinking level MINIMAL is not supported
 * for this model", 2026-09-21) and stop at "low". Checked against
 * ai.google.dev/gemini-api/docs/thinking on 2026-09-23.
 */
export function quickThinking(model: string): "minimal" | "low" {
  return /flash-lite/i.test(model) ? "minimal" : "low";
}

type GenerateOptions = {
  apiKey: string;
  model: string;
  system: string;
  turns: Turn[];
  json?: { schema: Record<string, unknown> };
  /** Skip most of the model's thinking, for quick yes/no calls. */
  fast?: boolean;
  /** Stops the request: llm.ts passes the caller's, so a call called off (the overheard-line check's "no") costs no more. */
  signal?: AbortSignal;
};

/**
 * One plain call. Returns the text and, beside it, Gemini's own token counts
 * (usageMetadata) so the caller can write down what the call cost.
 */
export async function generate({ apiKey, model, system, turns, json, fast, signal }: GenerateOptions): Promise<{ text: string; usage: unknown }> {
  const res = await fetch(`${BASE}/${model}:generateContent`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
      generationConfig: {
        ...(json && { responseMimeType: "application/json", responseSchema: json.schema }),
        ...(fast && { thinkingConfig: { thinkingLevel: quickThinking(model) } }),
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Gemini ${model} ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }

  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
    usageMetadata?: unknown;
  };
  const text = (data.candidates?.[0]?.content?.parts ?? [])
    .filter((p) => !p.thought && p.text)
    .map((p) => p.text)
    .join("");
  if (!text) throw new Error(`Gemini ${model} returned no text`);
  return { text, usage: data.usageMetadata };
}

/** At most this many pages come back with a search answer. */
const MAX_SOURCES = 5;
const SEARCH_TIMEOUT_MS = 12_000;

type GroundedOptions = { apiKey: string; model: string; query: string; today: string };

/**
 * Gemini answers with Google Search turned on, and says where it got it. Only
 * llm.ts searchGrounded calls this, after the gate (web.ts decides when to
 * search and what to do when this fails).
 */
export async function grounded({ apiKey, model, query, today }: GroundedOptions): Promise<{ answer: string; sources: { title: string; url: string }[] }> {
  const res = await fetch(`${BASE}/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      systemInstruction: {
        parts: [
          {
            text: [
              `Today is ${today}. Search the web and answer the question directly.`,
              "Three sentences at most. Lead with the answer, not with how you found it.",
              "Give numbers, times and dates exactly as the source gives them.",
              "If the sources disagree or none of them actually answer it, say so instead of picking one.",
            ].join(" "),
          },
        ],
      },
      contents: [{ role: "user", parts: [{ text: query }] }],
      tools: [{ google_search: {} }],
    }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Gemini search ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const data = (await res.json()) as {
    candidates?: {
      content?: { parts?: { text?: string; thought?: boolean }[] };
      groundingMetadata?: { groundingChunks?: { web?: { uri?: string; title?: string } }[] };
    }[];
  };
  const candidate = data.candidates?.[0];
  const answer = (candidate?.content?.parts ?? [])
    .filter((p) => p.text && !p.thought)
    .map((p) => p.text)
    .join("")
    .trim();
  if (!answer) throw new Error("Gemini search returned no text");

  const seen = new Set<string>();
  const sources: { title: string; url: string }[] = [];
  for (const chunk of candidate?.groundingMetadata?.groundingChunks ?? []) {
    const url = chunk.web?.uri;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    sources.push({ title: chunk.web?.title ?? url, url });
    if (sources.length >= MAX_SOURCES) break;
  }
  return { answer, sources };
}
