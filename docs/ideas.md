# Ideas / mental notes

A running checklist of things to build. Nothing here is implemented yet — moving an
item into the product means giving it a section in `docs/capabilities.md` and a real
design note like `docs/agent.md`.

## Leaving-the-house checklist

The bracelet is the thing that's always on the wrist, so it's the right place for
"did you forget something" nudges.

- [ ] **Car keys on the bracelet.** Nudge on the band when you head out without the
      keys — needs a way to know the keys are behind (a tag, or the car's own
      Bluetooth pairing dropping out) and a way to know you're leaving (geofence off
      home, or the phone's significant-location change).
- [ ] **Wallet.** Same mechanism as the keys; one checklist, one nudge, not two
      separate alerts firing back to back.
- [ ] **Medication reminder.** Time-based rather than place-based, so it can ride the
      existing cron/due path (`jarvis/api/migrations/0012_due.sql`) — the open part is
      whether the band buzzes, the phone speaks, or both, and what counts as
      "acknowledged" so it stops asking.
