// The old address, handed on (v1 release, Phase 1: the new Cloudflare account).
//
// Until the move, the server was `jarvis-api` on the old edgeformmedia account,
// at https://jarvis-api.edgeformmedia.workers.dev. Every build made before the
// move has that address baked in (jarvis/app/src/lib/api.ts), and so do Siri
// shortcuts made before it. The server now lives at https://api.ovoa.ai on the
// new account (jarvis/api). This Worker takes the old one's place, under the
// same name on the old account, and hands every request on as it came: method,
// headers, body, path and query (forward.ts). The body is streamed, not read,
// so uploads go through as they arrive. What comes back is returned as is,
// also streamed, so the NDJSON /chat stream and the audio from /voice/speak
// reach the phone piece by piece. Redirects come back unfollowed
// (redirect: "manual"), so the /google/callback 302 to ovoa:// reaches the
// phone's browser as a 302. The one change: a 403 needs_consent or
// needs_verification, which an old build could only show as that code, comes
// back with a sentence telling them to update (forward.ts forOldBuild).
//
// Two kinds of request header are left out, because Cloudflare writes its own
// on the hop to api.ovoa.ai: host (from the URL) and the cf-* ones. So the
// caller's address doesn't pass: every old build reaches the server from
// Cloudflare's address, and they share the per-address limits (src/limits.ts:
// sign-ins 10/min, log uploads 60/min) while this runs. That was decided on
// 2026-09-23, and there's no signed header carrying the real address.
//
// It has no bindings. The old D1 stays untouched as the backup, and nothing
// here can write to it. It has no crons either (wrangler.jsonc), so reminders
// fire once, from the new Worker.
//
// Deploy it from jarvis/api, with the OLD account's profile:
//
//     XDG_CONFIG_HOME=C:/Users/thoma/.wrangler-edgeformmedia npx wrangler deploy -c ../forwarder/wrangler.jsonc
//
// Delete it, and the old D1, after 2026-10-14. Builds and shortcuts that still
// use the old address stop working then.

import { forward } from "./forward";

export default {
  fetch: (request) => forward(request),
} satisfies ExportedHandler;
