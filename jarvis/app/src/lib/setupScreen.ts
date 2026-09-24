import type { SetupTurnResult, SetupView } from "./api";

// What the setup screen (app/onboarding.tsx) and Settings show of setup,
// worked out from the server's SetupView (api/src/setup/state.ts viewOf). The
// conversation itself is the model's (api/src/setup/): nothing here says a word
// to the person, and nothing counts down what's left (the user's complaint
// about the old nine questions, 2026-09-23). Kept apart from the screen so it
// can be checked without a phone (api/test/setupScreen.test.ts).

/**
 * One request's id (api/src/setup/turn.ts setupTurnSchema: 8-64 characters).
 * Try again sends the same one, so a turn the server finished but the phone
 * never heard the end of is replayed rather than asked twice. The app has no
 * uuid source; the time alone is 8 characters.
 */
export const newTurnId = (now = Date.now(), random = Math.random) => now.toString(36) + random().toString(36).slice(2, 10);

/** A line of the conversation on screen. `turn`: the request it came from, so a reply's sentences land in one bubble. */
export type Line = { from: "ovoa" | "you"; text: string; turn?: string };

/** A sentence of OVOA's reply onto its turn's bubble, or a new bubble for a new turn. */
export function withSentence(lines: Line[], turn: string, sentence: string): Line[] {
  const last = lines[lines.length - 1];
  if (last?.from === "ovoa" && last.turn === turn) return [...lines.slice(0, -1), { ...last, text: `${last.text} ${sentence}` }];
  return [...lines, { from: "ovoa", text: sentence, turn }];
}

/** Before Try again: what a failed turn got as far as saying, so the retry's reply isn't added to it twice. */
export const withoutReply = (lines: Line[], turn: string) => lines.filter((l) => !(l.from === "ovoa" && l.turn === turn));

/** OVOA's latest words: the big line on screen. */
export function latestLine(lines: Line[]) {
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].from === "ovoa") return lines[i].text;
  return "";
}

/**
 * The "So far" list: what's covered and has a value to show, so a misheard one
 * can be seen and put right. That takes in a value still marked unsure where
 * unsure counts as covered (the day, work, workouts: api/src/setup/objectives.ts
 * lowResolves), marked `checking`: those are stored as they are when setup ends
 * (applyLow) and it may end without asking again, so they're the ones most
 * worth seeing (2026-09-23 review). Not the name while it's unsure: that's the
 * account's own first name before it has come up, or one still being checked,
 * and neither is stored (a name is never applyLow). Not what they declined, and
 * nothing still open.
 */
export const soFar = (view: SetupView | null) =>
  (view?.objectives ?? [])
    .filter((o) => o.resolved && o.status !== "declined" && !!o.shown && !(o.id === "name" && o.status === "low" && !o.fromBefore))
    .map((o) => ({ id: o.id, label: o.label, shown: o.shown!, checking: o.status === "low" }));

/** Choose from Contacts is offered while OVOA is asking who to call in an emergency. */
export const wantsContact = (view: SetupView | null) => !!view?.asking.includes("emergency_contact");

/**
 * A contact picked from the iPhone's Contacts, as the answer they'd have typed:
 * the name and one number, a mobile if there is one. A number read out loud is
 * the easiest thing in setup to mishear. Null when it has no number.
 */
export function contactAnswer(
  name: string | null | undefined,
  phones: { label?: string | null; number?: string | null }[] | null | undefined,
): string | null {
  const numbers = (phones ?? []).filter((p) => !!p.number?.trim());
  const pick = numbers.find((p) => /mobile|iphone|cell/i.test(p.label ?? "")) ?? numbers[0];
  if (!pick) return null;
  const number = pick.number!.trim();
  const who = name?.trim();
  return who ? `${who}, ${number}` : number;
}

/** Apps made for goals so far: when this goes up, the phone reads its list of apps again. */
export const appsMade = (view: SetupView | null) => (view?.apps ?? []).filter((a) => a.status === "made").length;

/** Still being made when setup ends: the app list is read again a little later. */
export const appsMaking = (view: SetupView | null) => (view?.apps ?? []).some((a) => a.status === "making");

/**
 * The device_logs line for a turn: which engine, how soon the first sentence
 * came, what it asked about next. Ids and numbers only, never what was said.
 */
export function turnLog(res: SetupTurnResult) {
  const { meta, setup } = res;
  const timing = meta.replayed ? "replayed" : meta.unreachable ? "no AI reachable" : `first sentence ${meta.firstSentenceMs ?? "-"} ms`;
  const lost = meta.parsed || meta.replayed || meta.unreachable ? "" : " · its update didn't come through";
  return `setup: turn ${setup.turns} · ${timing} · ${meta.engine ?? "no engine"} · asking ${setup.asking.join(", ") || "nothing"}${lost}`;
}

/** "a", "a and b", "a, b and c". */
const listed = (items: string[]) => (items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

/**
 * Settings → Your day: setup again, or finishing one they stopped. Both start
 * a restart (api/src/setup/turn.ts restartSetup), which begins from what's
 * stored and asks about the rest; only the words differ.
 */
export function setupAgain(view: SetupView | null): { label: string; about: string } {
  const finished = view?.finished;
  if (finished?.how === "stopped" || finished?.how === "later") {
    const open = finished.open.map((id) => view!.objectives.find((o) => o.id === id)?.label.toLowerCase()).filter((l): l is string => !!l);
    return {
      label: "Finish setting up",
      about: `Setup stopped before the end${open.length ? `, with ${listed(open)} still to talk about` : ""}. Finishing it starts from what OVOA already knows and asks about the rest.`,
    };
  }
  return {
    label: "Talk through setup again",
    about:
      "A conversation about your day, your goals, who to call in an emergency and what to be reminded of. Going through it again starts from what OVOA already knows and asks what's changed; nothing is removed unless you say so.",
  };
}
