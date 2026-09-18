import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { synthesize } from "../providers/tts.js";

const TtsBody = z.object({ text: z.string().min(1).max(5000) });

export async function ttsRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/tts", async (req, reply) => {
    const parsed = TtsBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    try {
      const audio = await synthesize(parsed.data.text);
      return reply.type("audio/mpeg").send(audio);
    } catch (err) {
      req.log.error(err);
      return reply.code(503).send({ error: "tts unavailable" });
    }
  });
}
