import Fastify from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireDeviceToken } from "./auth.js";
import { config } from "./config.js";
import { getSttProvider } from "./providers/stt.js";
import { captureRoutes } from "./routes/captures.js";
import { chatRoutes } from "./routes/chat.js";
import { deviceRoutes } from "./routes/device.js";
import { ttsRoutes } from "./routes/tts.js";

const app = Fastify({
  logger: true,
  // A few minutes of 16 kHz PCM is ~2 MB/min; 32 MB gives the phone room to
  // batch chunks when it has been offline.
  bodyLimit: 32 * 1024 * 1024,
});

// Audio chunks arrive as raw bytes. Fastify rejects unknown content types
// unless a parser is registered for them.
app.addContentTypeParser(
  "application/octet-stream",
  { parseAs: "buffer" },
  (_req, body, done) => done(null, body),
);

// The web UI is a single file with no build step, so it is read once at boot
// and served from memory rather than pulling in a static-file plugin.
const here = path.dirname(fileURLToPath(import.meta.url));
const indexHtml = fs.readFileSync(path.join(here, "..", "public", "index.html"), "utf8");

app.get("/", async (_req, reply) => reply.type("text/html; charset=utf-8").send(indexHtml));

// Demo surface: OVOA driven through an iMessage-style thread. Read per request
// so edits show up without a restart.
app.get("/imessage", async (_req, reply) =>
  reply
    .type("text/html; charset=utf-8")
    .send(fs.readFileSync(path.join(here, "..", "public", "imessage.html"), "utf8")),
);

// Voice-over clips for that page, built by `npm run voice`.
app.get("/voice-clips.js", async (_req, reply) => {
  const file = path.join(here, "..", "public", "voice-clips.js");
  if (!fs.existsSync(file)) return reply.code(404).send("run npm run voice to build it");
  return reply.type("text/javascript; charset=utf-8").send(fs.readFileSync(file, "utf8"));
});

app.get("/health", async () => ({
  ok: true,
  stt: getSttProvider().name,
  claude: config.anthropicApiKey ? "configured" : "missing ANTHROPIC_API_KEY",
  tts: config.elevenLabsApiKey ? "configured" : "disabled",
}));

app.register(async (protectedRoutes) => {
  protectedRoutes.addHook("preHandler", requireDeviceToken);
  await protectedRoutes.register(captureRoutes);
  await protectedRoutes.register(chatRoutes);
  await protectedRoutes.register(deviceRoutes);
  await protectedRoutes.register(ttsRoutes);
});

const start = async (): Promise<void> => {
  try {
    // 0.0.0.0 so a phone on the same Wi-Fi can reach the dev server.
    await app.listen({ port: config.port, host: "0.0.0.0" });

    // Finding the machine's LAN address is the fiddliest part of opening this
    // on a phone, so print it rather than making anyone hunt for it.
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (a.family === "IPv4" && !a.internal) {
          app.log.info(`Open on your phone: http://${a.address}:${config.port}`);
        }
      }
    }
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

void start();
