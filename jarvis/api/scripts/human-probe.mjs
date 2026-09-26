// Checks texting that sounds like a person against production (texting.ts):
// a plain "thanks" gets a tapback and no reply, a reply stays short, and a
// photo sent by text is read. Runs through POST /texting/try, so no real text
// is sent. A throwaway account (Base, a made-up +1555 number with texting
// first off) is created with wrangler and deleted at the end.
//
//     cd jarvis/api
//     XDG_CONFIG_HOME=C:/Users/thoma/.wrangler-ovoa node scripts/human-probe.mjs > human-probe.txt

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API = "https://api.ovoa.ai";
/** A public photo with words and numbers in it, to read back. */
const PHOTO = process.env.PROBE_PHOTO ?? "https://httpbin.org/image/jpeg";

async function json(path, token, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }), ...init.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${body.error ?? ""}`);
  return body;
}

function d1Execute(statements) {
  const dir = mkdtempSync(join(tmpdir(), "ovoa-probe-"));
  const file = join(dir, "probe.sql");
  writeFileSync(file, `${statements.join(";\n")};\n`);
  try {
    const r = spawnSync("npx", ["wrangler", "d1", "execute", "jarvis-db", "--remote", "-y", "--file", file], { shell: true, encoding: "utf8", env: process.env });
    if (r.status !== 0) throw new Error(`wrangler d1 execute failed: ${(r.stderr || r.stdout).slice(-400)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let fails = 0;
function check(label, ok, detail) {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

async function text(token, message, media) {
  const t0 = Date.now();
  const r = await json("/texting/try", token, { method: "POST", body: JSON.stringify({ message, ...(media && { media }) }) });
  console.log(`  > ${message}${media ? ` [+ ${media}]` : ""}\n  < ${(r.texts ?? []).map((t) => JSON.stringify(t)).join("\n  < ") || "(no words)"}${r.reactions?.length ? `  [tapback: ${r.reactions.join(", ")}]` : ""}  [${Date.now() - t0} ms]`);
  return r;
}

const email = `probe-${Date.now().toString(36)}@example.com`;
const password = `p${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
const phone = `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
const { token, user } = await json("/auth/signup", null, { method: "POST", body: JSON.stringify({ email, password, name: "Probe Person" }) });
const id = user.id.replace(/[^0-9a-f-]/gi, "");
console.error(`account ${id} created`);
try {
  d1Execute([
    `UPDATE users SET email_verified_at = ${Date.now()}, plan_override = 'base' WHERE id = '${id}'`,
    `UPDATE settings SET time_zone = 'America/New_York' WHERE user_id = '${id}'`,
    `INSERT INTO text_links (user_id, phone, linked_at, proactive) VALUES ('${id}', '${phone}', ${Date.now()}, 0)`,
  ]);
  const me = await json("/me", token);
  await json("/me/consent", token, { method: "POST", body: JSON.stringify({ version: me.user.aiConsent.current }) });

  const set = await text(token, "remind me to call the dentist tomorrow at 10am");
  const reply = (set.texts ?? []).join(" ");
  check("a reply stays short", reply.length > 0 && reply.length <= 140, `${reply.length} characters`);
  check("with no help-desk filler", !/^(sure|certainly|of course|absolutely)\b|let me know if|anything else\?/i.test(reply), reply);

  const thanks = await text(token, "thanks!");
  check("'thanks!' gets a tapback", (thanks.reactions ?? []).length === 1, JSON.stringify(thanks.reactions));
  check("and no words", (thanks.texts ?? []).length === 0, JSON.stringify(thanks.texts));

  const photo = await text(token, "what's in this photo?", PHOTO);
  const said = (photo.texts ?? []).join(" ");
  check("a photo by text is read", said.length > 0 && !/couldn't open|can't open|unable to (view|see|open)/i.test(said), said);
} finally {
  await json("/me", token, { method: "DELETE" }).catch((err) => console.error(`couldn't delete ${id}: ${err.message}`));
  console.error(`account ${id} deleted`);
}
console.log(fails ? `\n${fails} check(s) failed` : "\nall human-texting probe checks passed");
process.exit(fails ? 1 : 0);
