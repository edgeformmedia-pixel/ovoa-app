// Instagram (instagram.ts): Meta's signed_request for the deauthorize and
// data-deletion callbacks only counts with the app secret's signature, and a
// DM is only offered inside Instagram's 24-hour window.

import { inReplyWindow, parseSignedRequest, REPLY_WINDOW_MS } from "../src/instagram";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${g}${ok ? "" : `  (wanted ${w})`}`);
}

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function sign(secret: string, data: object) {
  const payload = b64url(new TextEncoder().encode(JSON.stringify(data)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  return `${b64url(sig)}.${payload}`;
}

const secret = "test-secret-not-real";
const good = await sign(secret, { algorithm: "HMAC-SHA256", user_id: "17841400000000001", issued_at: 1 });
eq("signed with the app secret", (await parseSignedRequest(secret, good))?.user_id, "17841400000000001");
eq("signed with another secret", await parseSignedRequest("other", good), null);
eq("payload swapped", await parseSignedRequest(secret, `${good.split(".")[0]}.${b64url(new TextEncoder().encode('{"user_id":"2"}'))}`), null);
eq("another algorithm", await parseSignedRequest(secret, await sign(secret, { algorithm: "none", user_id: "1" })), null);
eq("garbage", await parseSignedRequest(secret, "nope"), null);
eq("empty", await parseSignedRequest(secret, ""), null);

const now = 1_800_000_000_000;
eq("wrote an hour ago", inReplyWindow(now - 3_600_000, now), true);
eq("wrote 23h59m ago", inReplyWindow(now - REPLY_WINDOW_MS + 60_000, now), true);
eq("wrote 25 hours ago", inReplyWindow(now - 25 * 3_600_000, now), false);
eq("never wrote", inReplyWindow(null, now), false);

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
