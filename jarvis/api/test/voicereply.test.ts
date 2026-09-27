// Voice-note replies (voicereply.ts): off unless TEXT_VOICE_REPLIES is "1";
// when someone texts a voice memo the reply goes as text and then as audio;
// the audio is served by a random token for an hour; no consent, no audio;
// a failure never touches the text reply.

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { capture, receive, type Deps } from "../src/texting";
import type { Env } from "../src/types";
import { sendVoiceReply, SPOKEN_MAX, spokenPart, voiceClipRoutes } from "../src/voicereply";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(got)}${ok ? "" : `  (wanted ${JSON.stringify(want)})`}`);
}

function d1(sqlite: DatabaseSync): D1Database {
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => (sqlite.prepare(sql).get(...(args as never[])) as unknown) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...(args as never[])) }),
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...(args as never[])).changes) } }),
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (list: ReturnType<typeof statement>[]) => {
      const out = [];
      for (const s of list) out.push(await s.run());
      return out;
    },
  } as unknown as D1Database;
}

const sqlite = new DatabaseSync(":memory:");
for (const file of readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort()) {
  sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
}
const addUser = (id: string, consent: boolean) =>
  sqlite
    .prepare("INSERT INTO users (id, email, password_hash, password_salt, name, created_at, ai_consent_at, ai_consent_version) VALUES (?, ?, '', '', ?, 0, ?, ?)")
    .run(id, `${id}@example.com`, id, consent ? 1 : null, consent ? 99 : null);
addUser("sam", true);
addUser("nia", false);

const LINE = "+15125550000";
const SAM_PHONE = "+15865550300";
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 1, 2, 3]);
let spoke: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("deepgram.com") && url.includes("/speak")) {
    spoke.push(JSON.parse(String(init?.body ?? "{}")).text);
    return new Response(MP3, { headers: { "content-type": "audio/mpeg" } });
  }
  if (url === "https://cdn.test/memo.m4a") return new Response(new Uint8Array([0, 0, 0, 32, 1, 2]), { headers: { "content-type": "audio/mp4" } });
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const base = {
  DB: d1(sqlite),
  PUBLIC_URL: "https://api.test",
  DEEPGRAM_API_KEY: "dg",
  SENDBLUE_API_KEY_ID: "k",
  SENDBLUE_API_SECRET: "s",
  SENDBLUE_NUMBER: LINE,
  SENDBLUE_WEBHOOK_SECRET: "w",
  AI: { run: async () => ({ text: "what's on my calendar tomorrow" }) },
};
const off = base as unknown as Env;
const on = { ...base, TEXT_VOICE_REPLIES: "1" } as unknown as Env;
const waits: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) };

async function main() {
  // What's spoken.
  eq("a short reply is spoken whole", spokenPart("You're free after 3. Want me to hold it?"), "You're free after 3. Want me to hold it?");
  const long = spokenPart(`${"This is a sentence that goes on. ".repeat(40)}`);
  eq("a long one stops at a sentence", [long.length <= SPOKEN_MAX, long.endsWith(".")], [true, true]);

  // Off: nothing, and Deepgram isn't asked.
  const sent: { to: string; content: string; media?: string }[] = [];
  const send = async (to: string, content: string, media?: string) => (sent.push({ to, content, media }), true);
  eq("off: no audio", await sendVoiceReply(off, ctx, "sam", SAM_PHONE, "Hi there.", send), false);
  eq("and nothing spoken", spoke.length, 0);

  // On.
  eq("on: the audio goes", await sendVoiceReply(on, ctx, "sam", SAM_PHONE, "You're free after 3.", send), true);
  eq("spoken by Deepgram", spoke, ["You're free after 3."]);
  const media = sent.at(-1)?.media ?? "";
  eq("as a link to its audio", /^https:\/\/api\.test\/texting\/voice\/[A-Za-z0-9_-]{32}\.mp3$/.test(media), true);
  eq("to them, with no words of its own", [sent.at(-1)?.to, sent.at(-1)?.content], [SAM_PHONE, ""]);
  eq("no consent: no audio", await sendVoiceReply(on, ctx, "nia", "+1", "Hi.", send), false);

  // The route Sendblue fetches.
  const app = new Hono<{ Bindings: Env }>();
  app.route("/", voiceClipRoutes);
  const path = new URL(media).pathname;
  const res = await app.request(path, {}, on);
  eq("served", [res.status, res.headers.get("content-type"), new Uint8Array(await res.arrayBuffer()).length], [200, "audio/mpeg", MP3.length]);
  eq("a made-up token isn't", (await app.request("/texting/voice/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.mp3", {}, on)).status, 404);
  sqlite.prepare("UPDATE voice_clips SET expires_at = 0").run();
  eq("gone after the hour", (await app.request(path, {}, on)).status, 404);

  // Over the texting path: a voice memo in, the text reply and then the audio out.
  sqlite.prepare("INSERT INTO text_links (user_id, phone, linked_at) VALUES ('sam', ?, 0)").run(SAM_PHONE);
  const out = capture();
  const deps: Deps = { turn: async () => ({ reply: "You've got the dentist at 10.", pendingActions: [] }), sender: () => out.sender, deadline: Date.now() + 60_000, debounceMs: 0 };
  let n = 0;
  const text = async (env: Env, media: string) => {
    const w: Promise<unknown>[] = [];
    const got = await receive(
      env,
      { waitUntil: (p: Promise<unknown>) => void w.push(p) },
      {
        content: "",
        is_outbound: false,
        status: "RECEIVED",
        message_handle: `vm-${++n}`,
        from_number: SAM_PHONE,
        number: SAM_PHONE,
        to_number: LINE,
        media_url: media,
        message_type: "message",
        group_id: "",
        participants: [SAM_PHONE, LINE],
        opted_out: false,
        sendblue_number: LINE,
        service: "iMessage",
      },
      deps,
    );
    if (got.work) await got.work;
    await Promise.allSettled(w);
  };
  await text(on, "https://cdn.test/memo.m4a");
  eq("the text reply, then the audio", out.sent.map((s) => [s.content, !!s.media]), [
    ["You've got the dentist at 10.", false],
    ["", true],
  ]);
  out.sent.length = 0;
  await text(off, "https://cdn.test/memo.m4a");
  eq("switched off: just the text, as before", out.sent.map((s) => [s.content, !!s.media]), [["You've got the dentist at 10.", false]]);

  await Promise.allSettled(waits);
  console.log(fails ? `\n${fails} failed` : "\nall passed");
  if (fails) process.exit(1);
}

main();
