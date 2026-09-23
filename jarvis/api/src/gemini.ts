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
};

/**
 * One plain call. Returns the text and, beside it, Gemini's own token counts
 * (usageMetadata) so the caller can write down what the call cost.
 */
export async function generate({ apiKey, model, system, turns, json, fast }: GenerateOptions): Promise<{ text: string; usage: unknown }> {
  const res = await fetch(`${BASE}/${model}:generateContent`, {
    method: "POST",
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
