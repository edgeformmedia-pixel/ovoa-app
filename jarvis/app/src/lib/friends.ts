import type { IconName, Tone } from "../components/ui";
import type { AccessLevel, ConnectionPerms } from "./api";

// Friends (api/src/network.ts ACCESS_LEVELS, docs/ovoa-network.md): the levels
// the Friends tab offers and the switches under Advanced. The server decides
// what each switch does; this is only how they're named and explained.

export type Switch = keyof Omit<ConnectionPerms, "level" | "shareNote">;

export const LEVELS: { key: AccessLevel; label: string; icon: IconName; tone: Tone; blurb: string; allows: string[]; danger?: boolean }[] = [
  {
    key: "basic",
    label: "Basic",
    icon: "person-outline",
    tone: "blue",
    blurb: "Their OVOA can find a time with you and pass on reminders. Everything else comes to you first.",
    allows: ["When you're free or busy", "Reminders and things they share"],
  },
  {
    key: "best_friend",
    label: "Best friend",
    icon: "heart-outline",
    tone: "pink",
    blurb: "Books you at free times and answers their questions from your note, without asking.",
    allows: ["Everything in Basic", "Book you at a free time", "Answer questions from your note"],
  },
  {
    key: "partner",
    label: "Partner",
    icon: "home-outline",
    tone: "violet",
    blurb: "Also sees what's on your calendar and roughly where you are, to answer them.",
    allows: ["Everything in Best friend", "What's on your calendar", "Roughly where you are"],
  },
  {
    key: "full",
    label: "Full access",
    icon: "warning-outline",
    tone: "coral",
    blurb: "Their OVOA gets answers from everything yours remembers about you, without asking. Only for someone you'd hand your phone to.",
    allows: ["Everything in Partner", "What OVOA remembers about you"],
    danger: true,
  },
];

export const levelLabel = (level: AccessLevel | "custom" | undefined) => LEVELS.find((l) => l.key === level)?.label ?? "Custom";

/** Advanced: one row per switch, in the order they matter. */
export const SWITCHES: { key: Switch; label: string; about: string; danger?: boolean }[] = [
  { key: "shareFreeBusy", label: "When I'm free or busy", about: "Only the times, never what's in your calendar." },
  { key: "takeReminders", label: "Reminders and shares", about: "Off: you're asked before one of theirs reaches you." },
  { key: "autoAcceptMeetings", label: "Book me at a free time", about: "Taken without asking, and you're told." },
  { key: "autoAnswerQuestions", label: "Answer their questions", about: "From your note and whatever is on below. Anything else comes to you." },
  { key: "calendarDetails", label: "What's on my calendar", about: "Titles, places and times, for answering them." },
  { key: "shareLocation", label: "Roughly where I am", about: "Your phone's last place, for answering them." },
  { key: "answerFromMemory", label: "What OVOA remembers about me", about: "Everything it's learned about you. Only for someone you fully trust.", danger: true },
];

export const FULL_WARNING =
  "Their OVOA will get answers from everything yours remembers about you, your calendar and where you are, without asking you first. Only give this to someone you'd trust with your phone.";
