import { useContext, useEffect, type Context } from "react";
import { devlog } from "./devlog";

// Reading a context whose provider isn't above you used to throw, and a throw
// from a hook costs the whole screen: /agent did exactly that on every open,
// because AgentProvider was mounted in (tabs)/_layout while /agent is a sibling
// of (tabs) in the root stack, not a child of it ("useAgent must be used inside
// AgentProvider", device_logs 2026-09-21). The providers live at the root now,
// so that particular hole is closed; this is here so the next mistake of the
// same shape costs a screen that does nothing rather than a screen that dies on
// a phone nobody can attach a debugger to.

/** Hooks that have already complained, so a re-render doesn't fill the log. */
const complained = new Set<string>();

/**
 * The context's value, or `fallback` — a deliberately inert version of it — when
 * there is no provider above. Missing is always a bug, so the first time each
 * hook hits it the log gets an `err` with a stack, which names the screen.
 */
export function useOptionalContext<T>(context: Context<T | null>, hook: string, fallback: T): T {
  const value = useContext(context);
  if (!value && !complained.has(hook)) {
    complained.add(hook);
    devlog("err", `${hook}() with no provider above it — using an inert one`, new Error(`${hook} outside its provider`).stack);
  }
  return value ?? fallback;
}

/** One line up, one line down, so the log says which contexts were mounted and when. */
export function useProviderLog(name: string) {
  useEffect(() => {
    devlog("log", `${name}: provider up`);
    return () => devlog("log", `${name}: provider down`);
  }, [name]);
}
