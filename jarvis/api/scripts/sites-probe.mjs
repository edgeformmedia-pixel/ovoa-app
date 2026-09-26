// Builds a website by text against production, end to end, and checks it: the
// text turn calls site_build, the cron's sites lane writes the page (a minute
// or two), the page is served with its policy, a change by text lands, and
// texting first can be turned off and on by text (src/sites.ts, src/reach.ts).
// Runs through POST /texting/try, so no real text is sent.
//
//     cd jarvis/api
//     XDG_CONFIG_HOME=C:/Users/thoma/.wrangler-ovoa node scripts/sites-probe.mjs > sites-probe.txt
//
// Like texting-probe.mjs, it signs up a throwaway account, marks its address
// proven and links a made-up number with wrangler (texting first off, so
// nothing is ever sent to it), agrees to AI, and deletes the account, and the
// website with it, at the end. It waits up to eight minutes for each build.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API = process.argv.includes("--api") ? process.argv[process.argv.indexOf("--api") + 1] : "https://api.ovoa.ai";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function text(token, message) {
  const t0 = Date.now();
  const r = await json("/texting/try", token, { method: "POST", body: JSON.stringify({ message }) });
  const texts = r.texts ?? [];
  console.log(`  > ${message}\n  < ${texts.map((t) => JSON.stringify(t)).join("\n  < ") || "(nothing)"}  [${Date.now() - t0} ms, ${r.outcome}]`);
  return texts.join("\n");
}

/** Polls GET /sites until `done` says so, or eight minutes pass. */
async function waitFor(token, what, done) {
  const t0 = Date.now();
  for (;;) {
    const { sites } = await json("/sites", token);
    if (done(sites)) {
      console.log(`  (${what} after ${Math.round((Date.now() - t0) / 1000)} s)`);
      return sites;
    }
    if (Date.now() - t0 > 8 * 60_000) {
      console.log(`  (gave up waiting for ${what}: ${JSON.stringify(sites)})`);
      return sites;
    }
    await sleep(15_000);
  }
}

const email = `probe-${Date.now().toString(36)}@example.com`;
const password = `p${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
const phone = `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
const { token, user } = await json("/auth/signup", null, { method: "POST", body: JSON.stringify({ email, password, name: "Probe Person" }) });
const id = user.id.replace(/[^0-9a-f-]/gi, "");
console.error(`account ${id} created`);
try {
  d1Execute([
    `UPDATE users SET email_verified_at = ${Date.now()} WHERE id = '${id}'`,
    `UPDATE settings SET time_zone = 'America/New_York' WHERE user_id = '${id}'`,
    `INSERT INTO text_links (user_id, phone, linked_at, proactive) VALUES ('${id}', '${phone}', ${Date.now()}, 0)`,
  ]);
  const me = await json("/me", token);
  await json("/me/consent", token, { method: "POST", body: JSON.stringify({ version: me.user.aiConsent.current }) });

  // 1. Texting first, on and off by text (left off: the number is made up).
  await text(token, "text me first with reminders and stuff from now on");
  check("texting first is turned on by text", (await json("/texting", token)).linked?.textingFirst === true);
  await text(token, "actually stop texting me first, notifications are fine");
  check("and off again", (await json("/texting", token)).linked?.textingFirst === false);

  // 2. A client's website, asked for by text.
  const asked = await text(
    token,
    "Build a website for my client Tony Russo's shop, Tony's Pizza: New York style pizza in Hialeah FL since his dad opened it. Slices, whole pies, garlic knots, calzones, wings. Open 11am to 11pm every day, till 1am Friday and Saturday. Phone (305) 555-0142, 1234 W 49th St, Hialeah FL 33012. Delivery within 5 miles and pickup. Red and cream, warm and old-school but modern.",
  );
  const listed = (await json("/sites", token)).sites ?? [];
  check("site_build was called: the site is written down", listed.length === 1, JSON.stringify(listed));
  const site = listed[0];
  check("for the client", /tony/i.test(site?.client ?? site?.name ?? ""), `${site?.name} / ${site?.client}`);
  check("the reply says it's on its way, not that it's live", /build|on its way|minute/i.test(asked) && !/\bis live\b/i.test(asked), asked.split("\n")[0]);
  // The link now, or only once it's live, but never a wrong one.
  const given = asked.match(/https?:\/\/\S+/g) ?? [];
  check("any link it gives is the one that opens", given.every((u) => u.replace(/[).,!]+$/, "") === site?.link), given.join(" ") || "(held until it's live)");
  if (site?.link.includes("/s/")) {
    const bare = new URL(site.address).hostname;
    check("and not the address that doesn't open yet", !new RegExp(`(^|[^/])${bare.replace(/\./g, "\\.")}`).test(asked), bare);
  }

  // 3. The cron builds it.
  const built = await waitFor(token, "the first build", (s) => s[0]?.status !== "building");
  check("it went live", built[0]?.status === "live", built[0]?.status);
  const res = await fetch(built[0].link);
  const html = await res.text();
  check("the page is served", res.status === 200, `${res.status} ${built[0].link}`);
  check("it's their page", /Tony/i.test(html) && /555-0142/.test(html));
  check("with the facts they gave and no script", !/<script(?![^>]*ld\+json)/i.test(html) && !/\son[a-z]+=/i.test(html));
  const policy = res.headers.get("content-security-policy") ?? "";
  check("under the policy with no script source", policy.includes("default-src 'none'") && !/script-src/.test(policy), policy.slice(0, 80));
  check("made with OVOA, with a way to report it", html.includes("Made with") && html.includes("Report this site"));
  check("its contact form posts back to the site (the preview's does nothing)", /<form[^>]*action="(\/contact|#)"/.test(html));
  if (built[0].link.includes("/s/")) check("a preview is never indexed", (res.headers.get("x-robots-tag") ?? "").includes("noindex"));

  // 4. A change, by text; asked about while it's being made, it isn't claimed.
  const before = built[0].version;
  await text(token, "On Tony's site, add a line that they cater parties of 20 or more, and make the call button bigger.");
  const meanwhile = await text(token, "what websites do I have?");
  check("it knows its websites", /tony/i.test(meanwhile));
  const hosts = [...meanwhile.matchAll(/\b([a-z0-9-]+)\.ovoa\.ai\b/gi)].map((m) => m[1].toLowerCase()).filter((h) => h !== "api");
  const links = (meanwhile.match(/https?:\/\/\S+/g) ?? []).map((u) => u.replace(/[).,!]+$/, ""));
  check(
    "every address it gives is the site's real one",
    links.every((u) => u === site.link) && hosts.every((h) => site.link.includes(`//${h}.`)),
    [...links, ...hosts].join(" ") || "(none given)",
  );
  const stillChanging = (await json("/sites", token)).sites?.[0]?.changing;
  if (stillChanging) check("and doesn't claim a change that isn't there yet", !/(already|now) (on|has|have|there)|catering (line|section) (is|has been) (added|on)/i.test(meanwhile), meanwhile.split("\n")[0]);
  const changed = await waitFor(token, "the change", (s) => s[0]?.version > before && !s[0]?.changing);
  const again = await (await fetch(changed[0].link)).text();
  check("the change landed", changed[0].version > before && /cater/i.test(again), `version ${before} -> ${changed[0].version}`);
} finally {
  await json("/me", token, { method: "DELETE" }).catch((err) => console.error(`couldn't delete ${id}: ${err.message}`));
  console.error(`account ${id} deleted`);
}
console.log(fails ? `\n${fails} check(s) failed` : "\nall website probe checks passed");
process.exit(fails ? 1 : 0);
