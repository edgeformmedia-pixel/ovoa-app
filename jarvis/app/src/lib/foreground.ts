import { AppState } from "react-native";

// "Is the app really on screen?" — the one test for everything iOS only allows a
// foreground app to do: opening a microphone (AVAudioSession activation comes
// back as '!int', OSStatus 560557684 — AVAudioSessionErrorCodeCannotInterrupt-
// Others, "a nonmixable session made active while the app was in the
// background") and starting a Live Activity ("Target is not foreground").
//
// AppState on its own isn't enough, for two reasons, and each of them shipped:
//  - "inactive" means both "sliding into the background" and "a permission sheet
//    is up while we're still in front" (React Native's AppState docs). It counts
//    as off screen here: waiting a moment through the second costs far less than
//    a refused microphone through the first.
//  - currentState still reads "active" for a moment after iOS has taken the
//    foreground away, which is how "dynamic island failed … Target is not
//    foreground" happened ten times despite the check at island.ts:50
//    (device_logs, 2026-09-21). A refusal therefore marks the app away until it
//    genuinely comes forward, rather than being re-asked against a stale reading.

/**
 * How long a "you are not foreground" refusal is believed over AppState. Short
 * on purpose: the race it covers is sub-second, and this gates the microphone
 * for every caller, so a Live Activity being turned down must not leave the app
 * deaf for long.
 */
const REFUSAL_HOLD_MS = 3000;

let refusedAt = 0;
const waiting = new Set<() => void>();

AppState.addEventListener("change", (state) => {
  if (state !== "active") return;
  refusedAt = 0;
  for (const wake of [...waiting]) wake();
});

/**
 * The app is on screen, as far as everything iOS gates on foreground goes.
 * A state AppState doesn't recognise ("unknown", before iOS has said anything)
 * counts as on screen: the app is in front at launch, and refusing then would
 * leave it deaf until the first state change.
 */
export function onScreen() {
  const state = AppState.currentState;
  if (state === "background" || state === "inactive" || state === "extension") return false;
  return Date.now() - refusedAt >= REFUSAL_HOLD_MS;
}

/**
 * iOS turned something down for not being foreground while AppState still said
 * we were. Stop asking, here and everywhere else, until the app is really back.
 */
export function noteOffScreen() {
  refusedAt = Date.now();
}

/**
 * Waits for the app to come forward, giving up after `maxWaitMs` so a caller in
 * a loop checks again for itself: a refusal can land while the app is already
 * active, and then no "active" event follows to wake anyone.
 */
export function whenOnScreen(maxWaitMs = 5000) {
  if (onScreen()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      waiting.delete(done);
      resolve();
    };
    const timer = setTimeout(done, maxWaitMs);
    waiting.add(done);
  });
}

/** iOS errors worth naming in the log, so the next person doesn't have to look them up. */
const KNOWN = [
  {
    match: "560557684",
    means: "'!int' AVAudioSessionErrorCodeCannotInterruptOthers — iOS will not open a microphone for an app that is not on screen",
  },
  {
    // Not a foreground refusal, and not fixed by waiting for the app: it came with the app on
    // screen, when the audio mode was switched under the running ear (device_logs, 2026-09-23).
    match: "561017449",
    means:
      "'!pri' AVAudioSessionErrorCodeInsufficientPriority — another audio session outranks OVOA's right now " +
      "(a call, Siri, another app's audio, or OVOA's own audio mode switched under the running microphone); not about being off screen",
  },
  {
    match: "Session activation failed",
    means: "the audio session would not activate (off screen, or another app holds it)",
  },
  { match: "not foreground", means: "iOS only starts a Live Activity for an app that is on screen" },
];

/**
 * What to write next to an audio failure. One line saying which iOS error this
 * is by name and where the app was beats the 7,150 bare copies of "mic restart
 * failed" that filled device_logs on 2026-09-21 and explained nothing.
 */
export function audioWhy(err: unknown, extra?: Record<string, string | number | boolean>) {
  const why = err instanceof Error ? err.message : String(err);
  const parts = [`app ${AppState.currentState}`];
  if (refusedAt) parts.push(`refused foreground ${Math.round((Date.now() - refusedAt) / 1000)} s ago`);
  const named = KNOWN.find((k) => why.includes(k.match));
  if (named) parts.push(named.means);
  for (const [k, v] of Object.entries(extra ?? {})) parts.push(`${k} ${v}`);
  return `${parts.join(" · ")} — ${why}`;
}
