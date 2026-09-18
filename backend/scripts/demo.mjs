#!/usr/bin/env node
/**
 * End-to-end pipeline test with no wearable attached.
 *
 * Uploads synthetic audio, lets the mock transcriber stand in for the device,
 * then exercises both Claude calls: enrichment on close, and a streamed chat
 * question against the stored transcript.
 *
 *   node --env-file=.env scripts/demo.mjs
 */

const BASE = process.env.DEMO_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`;
const TOKEN = process.env.DEVICE_TOKEN;

if (!TOKEN) {
  console.error("DEVICE_TOKEN is not set. Run with: node --env-file=.env scripts/demo.mjs");
  process.exit(1);
}

const auth = { Authorization: `Bearer ${TOKEN}` };

async function json(res) {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

const step = (n, msg) => console.log(`\n[${n}] ${msg}`);

// --- 0. Is the server even up, and what is configured? ---------------------
step(0, "Checking server health");
let health;
try {
  health = await json(await fetch(`${BASE}/health`));
} catch {
  console.error(`Cannot reach ${BASE}. Start the server first: npm run dev`);
  process.exit(1);
}
console.log(`    stt=${health.stt}  claude=${health.claude}  tts=${health.tts}`);
if (health.claude !== "configured") {
  console.error("\n    ANTHROPIC_API_KEY is missing — enrichment and chat will fail.");
  console.error("    Add it to backend/.env and restart the server.");
  process.exit(1);
}

// --- 1. Push a capture through ---------------------------------------------
step(1, "Creating capture and uploading audio");
const capture = await json(
  await fetch(`${BASE}/v1/captures`, { method: "POST", headers: auth }),
);

// The mock transcriber ignores the bytes, but the ingest path is real: this
// still exercises chunking, the append-to-disk write, and the duration math.
const chunk = Buffer.alloc(16_000 * 2 * 5); // 5s of 16kHz PCM16 silence
await fetch(`${BASE}/v1/captures/${capture.id}/chunk`, {
  method: "POST",
  headers: { ...auth, "Content-Type": "application/octet-stream" },
  body: chunk,
});
const closed = await json(
  await fetch(`${BASE}/v1/captures/${capture.id}/close`, { method: "POST", headers: auth }),
);
console.log(`    ${capture.id}  ${closed.durationSec}s`);

// --- 2. Wait for transcription + enrichment --------------------------------
step(2, "Waiting for transcription and Claude enrichment");
let result;
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  result = await json(await fetch(`${BASE}/v1/captures/${capture.id}`, { headers: auth }));
  if (result.status === "ready" || result.status === "failed") break;
  process.stdout.write(".");
}
console.log();

if (result.status !== "ready") {
  console.error(`    FAILED: ${result.error ?? "timed out while processing"}`);
  process.exit(1);
}

console.log(`    Title:   ${result.title}`);
console.log(`    Summary: ${result.summary}`);
console.log(`    Actions:`);
for (const item of result.actionItems) console.log(`      - ${item}`);

// --- 3. Ask a question about it (streamed) ---------------------------------
const question =
  process.argv[2] ?? "What am I blocked on, and what did I say I'd do about it?";
step(3, `Asking: "${question}"`);
process.stdout.write("    ");

const chat = await fetch(`${BASE}/v1/chat`, {
  method: "POST",
  headers: { ...auth, "Content-Type": "application/json" },
  body: JSON.stringify({ turns: [{ role: "user", content: question }] }),
});

// Minimal SSE reader: split on blank lines, act on the event/data pair.
const reader = chat.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let failed = false;

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });

  const frames = buffer.split("\n\n");
  buffer = frames.pop() ?? "";

  for (const frame of frames) {
    const event = frame.match(/^event: (.+)$/m)?.[1];
    const data = frame.match(/^data: (.+)$/m)?.[1];
    if (!event || !data) continue;
    const payload = JSON.parse(data);

    if (event === "token") process.stdout.write(payload.text);
    else if (event === "tool") process.stdout.write(`
    [${payload.name}] `);
    else if (event === "error") {
      console.error(`\n    STREAM ERROR: ${payload.message}`);
      failed = true;
    } else if (event === "done") {
      const u = payload.usage;
      console.log(
        `\n\n    tokens: ${u.input_tokens} in / ${u.output_tokens} out` +
          (u.cache_read_input_tokens ? ` (${u.cache_read_input_tokens} cached)` : ""),
      );
    }
  }
}

console.log(failed ? "\nDemo finished with errors." : "\nPipeline works end to end.");
process.exit(failed ? 1 : 0);
