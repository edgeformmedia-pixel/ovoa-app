import type { FastifyReply, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

/**
 * A single shared token is enough to keep the dev server from being an open
 * relay, and no more than that. Before this is reachable from the internet it
 * needs per-user accounts — see README, "Before you ship".
 */
export async function requireDeviceToken(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const header = req.headers.authorization ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";

  const a = Buffer.from(presented);
  const b = Buffer.from(config.deviceToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    await reply.code(401).send({ error: "unauthorized" });
  }
}
