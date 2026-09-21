import Anthropic from "@anthropic-ai/sdk";
import { Hono } from "hono";
import { z } from "zod";
import { logAction } from "./actionlog";
import type { ToolSpec } from "./llm";
import type { Env, Vars } from "./types";

// Asking Claude directly: "OVOA, ask Claude how compound interest works", or the
// Ask Claude screen. OVOA's own replies come from Gemini (llm.ts); this is for
// when the user wants Claude's answer specifically, passed through as it is.
//
// Needs the ANTHROPIC_API_KEY secret (npx wrangler secret put ANTHROPIC_API_KEY).
// Without it the tool and the route say so rather than failing.

const MODEL = "claude-opus-5";

/**
 * One question, one answer. Refusal fallbacks are on: if Claude Opus 5 declines
 * for a policy reason, the API retries on the model it routes to instead.
 */
export async function askClaude(env: Env, prompt: string, opts: { voice?: boolean } = {}) {
  if (!env.ANTHROPIC_API_KEY) {
    return { error: "Claude isn't set up yet: the server needs an Anthropic API key (ANTHROPIC_API_KEY)." };
  }
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: opts.voice ? "low" : "medium" },
      system: opts.voice
        ? "Your answer will be read aloud through a small speaker. Answer in a few plain spoken sentences: no lists, no markdown, no symbols."
        : "Answer clearly and directly. Plain text; short paragraphs.",
      messages: [{ role: "user", content: prompt }],
    });
    if (response.stop_reason === "refusal") {
      return { error: "Claude declined to answer that." };
    }
    const text = response.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
    return { answer: text || "(Claude had nothing to say.)", model: response.model };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return { error: "The Anthropic API key on the server was refused." };
    if (err instanceof Anthropic.RateLimitError) return { error: "Claude is rate-limited right now. Try again in a minute." };
    if (err instanceof Anthropic.APIError) return { error: `Claude couldn't answer (${err.status}).` };
    throw err;
  }
}

export const askClaudeTool: ToolSpec = {
  name: "ask_claude",
  description:
    "Sends a question to Claude (Anthropic's model) and returns its answer. Only when the user asks for Claude by name: 'ask Claude…', 'what does Claude think…', 'send this to Claude'. Pass their question as they said it; then give them Claude's answer, saying it's from Claude.",
  parameters: {
    type: "object",
    properties: { prompt: { type: "string", description: "The question or prompt, complete on its own." } },
    required: ["prompt"],
  },
};

export const claude = new Hono<{ Bindings: Env; Variables: Vars }>();

claude.post("/claude", async (c) => {
  const parsed = z.object({ prompt: z.string().trim().min(1).max(20_000) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "A prompt is required" }, 400);
  const result = await askClaude(c.env, parsed.data.prompt);
  if ("error" in result) return c.json(result, 503);
  await logAction(c.env.DB, c.var.userId, "claude", `Asked Claude: ${parsed.data.prompt.slice(0, 100)}`, "chat");
  return c.json(result);
});
