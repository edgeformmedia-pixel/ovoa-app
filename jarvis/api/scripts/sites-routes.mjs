// Keeps the ovoa.ai subdomains that have Workers of their own off the websites
// route (src/sites.ts, docs/sites.md), and says whether the wildcard DNS record
// the websites need is there yet.
//
//     XDG_CONFIG_HOME=C:/Users/thoma/.wrangler-ovoa node scripts/sites-routes.mjs [--dry-run]
//
// Why: the websites are served by the route *.ovoa.ai/* (wrangler.jsonc), and a
// route beats a Custom Domain on the same host. api, admin, help and www are
// Custom Domains of their own Workers; without a more specific route with no
// Worker on it ("admin.ovoa.ai/*" and nothing else), the websites route would
// answer for them. This lists every Custom Domain on the zone and adds the
// missing no-Worker routes. Run it before the first deploy with the wildcard
// route, and again after adding any Custom Domain on the zone.
//
// It uses CLOUDFLARE_API_TOKEN when set, else the wrangler login's own token
// (refreshed first by `wrangler whoami`). Nothing is changed with --dry-run.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dryRun = process.argv.includes("--dry-run");
const here = new URL("..", import.meta.url);
const config = readFileSync(new URL("wrangler.jsonc", here), "utf8");
const account = /"account_id"\s*:\s*"([0-9a-f]{32})"/.exec(config)?.[1];
const domain = /"SITES_DOMAIN"\s*:\s*"([^"]+)"/.exec(config)?.[1] ?? "ovoa.ai";
const worker = /"name"\s*:\s*"([^"]+)"/.exec(config)?.[1];
if (!account || !worker) throw new Error("wrangler.jsonc has no account_id or name");

function token() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  // An OAuth token lasts an hour: whoami refreshes it before it's read.
  spawnSync("npx wrangler whoami", { cwd: here, shell: true, stdio: "ignore" });
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  const file = join(base, ".wrangler", "config", "default.toml");
  if (!existsSync(file)) throw new Error(`No wrangler login at ${file}. Set XDG_CONFIG_HOME to the ovoa.ai profile.`);
  const found = /oauth_token\s*=\s*"([^"]+)"/.exec(readFileSync(file, "utf8"))?.[1];
  if (!found) throw new Error("The wrangler login has no OAuth token. Run `wrangler login` with the ovoa.ai profile.");
  return found;
}

const auth = { authorization: `Bearer ${token()}`, "content-type": "application/json" };
async function api(path, init = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, { ...init, headers: auth });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${JSON.stringify(body.errors ?? body).slice(0, 300)}`);
  return body.result;
}

const zones = await api(`/zones?name=${domain}`);
const zone = zones?.[0];
if (!zone) throw new Error(`No zone called ${domain} on this login`);
console.log(`Zone ${domain} (${zone.id}), Worker ${worker}${dryRun ? ", dry run" : ""}`);

const domains = (await api(`/accounts/${account}/workers/domains`)).filter((d) => d.zone_id === zone.id);
const routes = await api(`/zones/${zone.id}/workers/routes`);
const byPattern = new Map(routes.map((r) => [r.pattern, r]));

// Every subdomain with a Custom Domain, this Worker's own (api) included: its
// traffic stays on the Custom Domain rather than going through the route.
const hosts = [...new Set(domains.map((d) => d.hostname.toLowerCase()))].filter((h) => h.endsWith(`.${domain}`) && !h.slice(0, -(domain.length + 1)).includes("."));
let added = 0;
for (const host of hosts.sort()) {
  const pattern = `${host}/*`;
  const route = byPattern.get(pattern);
  const owner = domains.find((d) => d.hostname.toLowerCase() === host)?.service;
  if (route) {
    console.log(`  ${pattern.padEnd(28)} ${route.script ? `route to ${route.script} (left alone)` : "kept off the websites route"}  [Custom Domain: ${owner}]`);
    continue;
  }
  if (dryRun) {
    console.log(`  ${pattern.padEnd(28)} would add a route with no Worker  [Custom Domain: ${owner}]`);
    continue;
  }
  await api(`/zones/${zone.id}/workers/routes`, { method: "POST", body: JSON.stringify({ pattern }) });
  added++;
  console.log(`  ${pattern.padEnd(28)} added a route with no Worker  [Custom Domain: ${owner}]`);
}
const wildcard = routes.find((r) => r.pattern === `*.${domain}/*`);
console.log(`  ${`*.${domain}/*`.padEnd(28)} ${wildcard ? `route to ${wildcard.script ?? "no Worker"}` : `not there yet: \`npm run deploy\` adds it (wrangler.jsonc)`}`);
console.log(added ? `Added ${added}.` : "Nothing to add.");

// The DNS record the route needs, which only the dashboard can add.
const dns = await fetch(`https://cloudflare-dns.com/dns-query?name=wildcard-check.${domain}&type=A`, { headers: { accept: "application/dns-json" } })
  .then((r) => r.json())
  .catch(() => ({}));
if (dns.Status === 0 && dns.Answer?.length) {
  console.log(`Wildcard DNS: in place (wildcard-check.${domain} answers). Website links use <name>.${domain}.`);
} else {
  console.log(
    [
      `Wildcard DNS: missing. Until it's added, website links go to the preview (https://api.${domain}/s/<name>).`,
      `  Add it once in the Cloudflare dashboard: ${domain} → DNS → Records → Add record:`,
      "  Type AAAA, Name *, IPv6 address 100::, Proxy status Proxied (orange cloud), then Save.",
    ].join("\n"),
  );
}
