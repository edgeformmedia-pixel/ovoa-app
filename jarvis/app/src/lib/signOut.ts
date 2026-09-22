import { devlog } from "./devlog";

// What belongs to the person signed in, not to the phone.
//
// Signing out used to forget the session token and the push registration and
// nothing else. The next person to sign in on the same phone inherited the last
// one's location tracking (still running, now uploading as them), alarms that
// kept ringing with the last person's name and no way to stop them, medication
// reminders, queued heart-rate readings sent under the new account, and consent
// switches like "send texts automatically" that they never turned on.
//
// Each module that keeps something per person registers how to let go of it
// here, at load. auth.tsx runs them all when a session ends — signed out, or
// found dead on the server. Registered rather than imported by auth.tsx, so
// this file depends on nothing and no module has to import the session.

type Reset = () => void | Promise<void>;

const resets = new Map<string, Reset>();

/** Registers what to do when the signed-in person changes. `name` is for the log. */
export function onSignOut(name: string, reset: Reset) {
  resets.set(name, reset);
}

/** Runs every registered reset. One failing doesn't stop the rest. */
export async function resetForSignOut() {
  for (const [name, reset] of resets) {
    try {
      await reset();
    } catch (err) {
      devlog("err", `sign-out: couldn't reset ${name}`, err instanceof Error ? err.message : String(err));
    }
  }
}
