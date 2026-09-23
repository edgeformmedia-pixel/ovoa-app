// Transcribes the same clips with Deepgram and with Whisper on Workers AI, in
// production, and prints what each heard and how long it took.
//
//     cd jarvis/api
//     XDG_CONFIG_HOME=C:/Users/thoma/.wrangler-ovoa node scripts/clip-bench.mjs a.wav b.m4a ...
//
// Like engine-bench.mjs: a throwaway account, its own row in server_settings
// (written with wrangler, no debug key needed), a wait for the settings cache,
// then each clip through both transcribers, then the account and its rows are
// deleted. The clips are sent with the content type the phone would use: WAV
// for the band's recordings, audio/mp4 for the phone's own.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

const API = process.env.API ?? "https://api.ovoa.ai";
const files = process.argv.slice(2);
if (!files.length) {
  console.error("give me some clips");
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TYPES = { ".wav": "audio/wav", ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".opus": "audio/ogg" };

function settingsRows(userId, engine, remove = false) {
  const statements = remove
    ? [`DELETE FROM server_settings WHERE key LIKE '%:${userId}'`]
    : [
        `INSERT INTO server_settings (key, value, updated_at) VALUES ('stt_clip_engine:${userId}', '${engine}', ${Date.now()}) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ];
  const dir = mkdtempSync(join(tmpdir(), "ovoa-clip-"));
  const file = join(dir, "settings.sql");
  writeFileSync(file, `${statements.join(";\n")};\n`);
  try {
    const r = spawnSync("npx", ["wrangler", "d1", "execute", "jarvis-db", "--remote", "-y", "--file", file], { shell: true, encoding: "utf8", env: process.env });
    if (r.status !== 0) throw new Error(`wrangler d1 execute failed: ${(r.stderr || r.stdout).slice(-300)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function json(path, token, init = {}) {
  const res = await fetch(`${API}${path}`, { ...init, headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${body.error ?? ""}`);
  return body;
}

async function transcribe(token, file) {
  const t0 = Date.now();
  const res = await fetch(`${API}/voice/transcribe`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": TYPES[extname(file).toLowerCase()] ?? "audio/mp4" },
    body: readFileSync(file),
  });
  const body = await res.json().catch(() => ({}));
  return { ms: Date.now() - t0, status: res.status, text: body.text ?? null, usedEngine: body.engine ?? null, error: body.error ?? null };
}

const email = `clips-${Date.now().toString(36)}@example.com`;
const password = `c${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
const { token, user } = await json("/auth/signup", null, { method: "POST", body: JSON.stringify({ email, password, name: "Clips" }) });
console.error(`account ${user.id} created`);
const rows = [];
try {
  for (const engine of ["deepgram", "workers-whisper"]) {
    settingsRows(user.id, engine);
    console.error(`${engine}: waiting 65 s for the settings cache`);
    await sleep(65_000);
    for (const file of files) {
      const r = await transcribe(token, file);
      rows.push({ engine, file, ...r });
      console.error(`${engine.padEnd(15)} ${file.split(/[\\/]/).pop().padEnd(14)} ${String(r.ms).padStart(6)} ms  ${r.status}  ${r.usedEngine ?? ""}  ${(r.text ?? r.error ?? "").slice(0, 110)}`);
      await sleep(1000);
    }
  }
} finally {
  await json("/me", token, { method: "DELETE" }).catch((err) => console.error("could not delete the account:", err.message));
  try {
    settingsRows(user.id, "", true);
  } catch (err) {
    console.error("could not remove the settings rows:", err.message);
  }
}
console.log("| clip | asked for | answered by | ms | what it heard |");
console.log("|---|---|---|---|---|");
for (const r of rows) {
  const name = r.file.split(/[\\/]/).pop();
  console.log(`| ${name} | ${r.engine} | ${r.status === 200 ? (r.usedEngine ?? "?") : `failed (${r.status})`} | ${r.ms} | ${(r.text ?? r.error ?? "").replace(/\|/g, "/")} |`);
}
