import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { audioPath, captures } from "../db.js";
import { processCapture } from "../pipeline.js";
import { pcmDurationSec } from "../providers/audio.js";

export async function captureRoutes(app: FastifyInstance): Promise<void> {
  /** Start a capture. The phone calls this when the wearable starts streaming. */
  app.post("/v1/captures", async () => {
    const id = randomUUID();
    await fs.writeFile(audioPath(id), "");
    return captures.create(id);
  });

  /**
   * Append a chunk of PCM16. Body is raw bytes, not JSON — base64 would inflate
   * every upload by a third over a connection that is often cellular.
   */
  app.post<{ Params: { id: string }; Body: Buffer }>(
    "/v1/captures/:id/chunk",
    async (req, reply) => {
      const capture = captures.get(req.params.id);
      if (!capture) return reply.code(404).send({ error: "no such capture" });
      if (capture.status !== "recording") {
        return reply.code(409).send({ error: `capture is ${capture.status}` });
      }

      const chunk = req.body;
      if (!Buffer.isBuffer(chunk) || chunk.length === 0) {
        return reply.code(400).send({ error: "empty chunk" });
      }

      await fs.appendFile(audioPath(req.params.id), chunk);
      captures.addBytes(req.params.id, chunk.length);
      return { ok: true, bytes: capture.bytes + chunk.length };
    },
  );

  /** Close a capture and kick off transcription + enrichment in the background. */
  app.post<{ Params: { id: string } }>("/v1/captures/:id/close", async (req, reply) => {
    const capture = captures.get(req.params.id);
    if (!capture) return reply.code(404).send({ error: "no such capture" });
    if (capture.status !== "recording") {
      return reply.code(409).send({ error: `capture is ${capture.status}` });
    }

    captures.close(req.params.id, pcmDurationSec(capture.bytes));

    // Fire-and-forget: processCapture records its own failures on the row.
    void processCapture(req.params.id);

    return captures.get(req.params.id);
  });

  app.get("/v1/captures", async () => ({ captures: captures.list() }));

  app.get<{ Params: { id: string } }>("/v1/captures/:id", async (req, reply) => {
    const capture = captures.get(req.params.id);
    if (!capture) return reply.code(404).send({ error: "no such capture" });
    return capture;
  });
}
