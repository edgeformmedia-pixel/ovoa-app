import Anthropic from "@anthropic-ai/sdk";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { streamChat, type ChatTurn } from "../providers/claude.js";

const ChatBody = z.object({
  turns: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1) }))
    .min(1),
});

/** A truncated tool input can still pass schema validation, so never run it. */
class TruncatedToolInput extends Error {}

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Server-sent events. Emits `tool` when the assistant starts using one (the
   * app shows "Searching recordings…"), `token` for answer text, then a
   * terminal `done` or `error`.
   */
  app.post("/v1/chat", async (req, reply) => {
    const parsed = ChatBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const send = (event: string, data: unknown): void => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // The client hanging up should stop the work, not leave it running.
    const abort = new AbortController();
    req.raw.on("close", () => abort.abort());

    try {
      const runner = streamChat({ turns: parsed.data.turns as ChatTurn[] });
      let usage: Anthropic.Beta.BetaUsage | undefined;
      let refused = false;

      // Outer loop: one iteration per assistant turn. The runner executes the
      // tools between iterations and feeds results back automatically.
      for await (const messageStream of runner) {
        if (abort.signal.aborted) break;

        for await (const event of messageStream) {
          if (
            event.type === "content_block_start" &&
            event.content_block.type === "tool_use"
          ) {
            send("tool", { name: event.content_block.name });
          } else if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            send("token", { text: event.delta.text });
          }
        }

        const message = await messageStream.finalMessage();
        usage = message.usage;

        // Stop-reason rules are the caller's responsibility, not the runner's.
        const hasToolUse = message.content.some((b) => b.type === "tool_use");
        if (message.stop_reason === "max_tokens" && hasToolUse) {
          throw new TruncatedToolInput("tool input was truncated by max_tokens");
        }
        if (message.stop_reason === "refusal") {
          refused = true;
          break;
        }
        if (message.stop_reason === "pause_turn") {
          // Raised by long-running server tools such as web_search. The runner
          // does not resume these; until that is handled, say so rather than
          // presenting a half-finished answer as complete.
          send("error", { message: "The search took too long to finish." });
          refused = true;
          break;
        }
      }

      if (refused) {
        send("error", { message: "The model declined to answer this request." });
      } else {
        send("done", { usage });
      }
    } catch (err) {
      req.log.error(err);
      const message =
        err instanceof TruncatedToolInput
          ? "The answer was cut short. Try a narrower question."
          : err instanceof Error
            ? err.message
            : "stream failed";
      send("error", { message });
    } finally {
      reply.raw.end();
    }
  });
}
