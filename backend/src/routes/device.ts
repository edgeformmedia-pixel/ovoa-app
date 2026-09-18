import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { deviceState } from "../db.js";

/**
 * The pendant has no clock, GPS, or network, so anything situational has to
 * come from the handset. The app posts this on a coarse cadence — location
 * precise enough to answer "where am I" does not need to be minute-by-minute,
 * and a tighter cadence would cost battery on both devices.
 */
const StateBody = z.object({
  latitude: z.number().min(-90).max(90).nullable().default(null),
  longitude: z.number().min(-180).max(180).nullable().default(null),
  placeLabel: z.string().max(200).nullable().default(null),
  batteryPct: z.number().int().min(0).max(100).nullable().default(null),
  timezone: z.string().max(64).nullable().default(null),
});

export async function deviceRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/device/state", async (req, reply) => {
    const parsed = StateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    deviceState.set(parsed.data);
    return { ok: true };
  });

  app.get("/v1/device/state", async () => deviceState.get() ?? { reported: false });
}
