import { say } from "./obs";

// The switch for moving house (v1 release, Phase 1: the new Cloudflare account).
//
// The data is copied from the old account's jarvis-db into the new one while
// this Worker is already deployed there. For those minutes the new Worker must
// neither take writes (a new row could collide with a copied one, or be left
// out of the count that proves the copy) nor run its crons (reminders and agent
// jobs would fire from half-copied tables, and fire again once the copy lands).
//
// MAINTENANCE=on does both: every request, whatever the route or method, is
// answered 503 with a sentence people can read, and scheduled() returns without
// doing anything. It sits in front of Hono, so not even the request log
// (obs.ts observe) touches the database. The order at cutover: deploy with it
// on, replace the old Worker with the forwarder (which freezes the old
// database), copy the data (scripts/move-db.mjs), deploy again with it off.
//
//     npx wrangler deploy --var MAINTENANCE:on     # on, for this deploy only
//     npx wrangler deploy                          # off: wrangler.jsonc says "off"

export const MAINTENANCE_MESSAGE = "OVOA is moving to a new home. Back in a few minutes.";

/** Long enough that nothing retries in a tight loop, short enough to be back soon after. */
const RETRY_AFTER_S = 120;

/** True when the MAINTENANCE var says on. Anything else, or nothing, is off. */
export function inMaintenance(env: { MAINTENANCE?: string }) {
  return ["on", "1", "true", "yes"].includes((env.MAINTENANCE ?? "").trim().toLowerCase());
}

/** The one answer every request gets while the switch is on. */
export function maintenanceResponse() {
  return new Response(JSON.stringify({ error: "maintenance", message: MAINTENANCE_MESSAGE }), {
    status: 503,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "retry-after": String(RETRY_AFTER_S),
      "cache-control": "no-store",
      // What cors() in index.ts would have added, so a browser (the site's
      // sign-in) can read the sentence instead of a network error.
      "access-control-allow-origin": "*",
    },
  });
}

/** Wraps the Worker's handlers so the switch is checked before anything else runs. */
export function withMaintenance<E extends { MAINTENANCE?: string }>(handler: ExportedHandler<E>): ExportedHandler<E> {
  const { fetch: onFetch, scheduled: onScheduled } = handler;
  return {
    ...handler,
    fetch: onFetch && ((request, env, ctx) => (inMaintenance(env) ? maintenanceResponse() : onFetch(request, env, ctx))),
    scheduled:
      onScheduled &&
      ((controller, env, ctx) => {
        if (inMaintenance(env)) {
          say("cron", { cron: controller.cron, skipped: "maintenance" });
          return;
        }
        return onScheduled(controller, env, ctx);
      }),
  };
}
