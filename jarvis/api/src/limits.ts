import type { Context, MiddlewareHandler } from "hono";
import { say } from "./obs";
import type { Env, Vars } from "./types";

// How fast one person, or one address, may use the expensive routes.
//
// Every model, transcription and voice call comes out of accounts the whole app
// shares. With one user that never mattered; with many, one script (or one
// phone stuck in a loop) could spend the day's allowance for everyone, and the
// engine cooldowns in llm.ts would then push every other person onto the slow
// fallbacks too. Login had no limit at all, so a password could be guessed at
// the speed of the network.
//
// Cloudflare's rate-limit bindings (wrangler.jsonc "ratelimits"): counted per
// Cloudflare location, cost no database writes, and are deliberately generous
// rather than exact. Limits here are set well above what a person talking to
// their wrist can reach, so only a runaway ever meets one. If a binding is
// missing, requests go through: a limit is a guard, not a gate.

type Limiter = keyof Pick<Env, "RL_AUTH" | "RL_TURN" | "RL_SPEAK" | "RL_LOGS">;

/** Which limiter a signed-in route counts against. Unlisted routes aren't limited. */
const ROUTE_LIMITS: [RegExp, Limiter, string][] = [
  // A turn, however it arrives. 20 a minute is a question every three seconds.
  [/^\/(chat|chat\/resume|siri)$/, "RL_TURN", "turn"],
  [/^\/voice\/token$/, "RL_TURN", "listen"],
  [/^\/claude$/, "RL_TURN", "claude"],
  // One per sentence from builds that voice replies themselves.
  [/^\/voice\/speak$/, "RL_SPEAK", "speak"],
  // Talking over a reply without live transcription uploads a 1.8 s piece at a
  // time (app voice.ts speakInterruptible): over 30 a minute, legitimately.
  [/^\/voice\/transcribe$/, "RL_SPEAK", "transcribe"],
];

/** The caller's address, for routes where nobody is signed in yet. */
export function clientIp(c: Context) {
  return c.req.header("cf-connecting-ip") ?? "unknown";
}

/** True when this key may go ahead. Never throws, and a missing binding always allows. */
export async function allowed(env: Env, limiter: Limiter, key: string) {
  const binding = env[limiter];
  if (!binding) return true;
  try {
    return (await binding.limit({ key })).success;
  } catch (err) {
    console.error(`limits: ${limiter} couldn't be checked; letting it through`, err);
    return true;
  }
}

export function tooMany(c: Context, what: string) {
  c.header("retry-after", "60");
  return c.json({ error: `Too many ${what} in a short time. Give it a minute and try again.` }, 429);
}

/** For signed-in routes: counts each expensive request against the person making it. */
export function limitByUser(): MiddlewareHandler<{ Bindings: Env; Variables: Vars }> {
  return async (c, next) => {
    const match = ROUTE_LIMITS.find(([path]) => path.test(c.req.path));
    if (match && c.req.method === "POST") {
      const [, limiter, group] = match;
      if (!(await allowed(c.env, limiter, `${group}:${c.var.userId}`))) {
        say("limit", { limiter, group, user: c.var.userId, path: c.req.path });
        return tooMany(c, "requests");
      }
    }
    await next();
  };
}
