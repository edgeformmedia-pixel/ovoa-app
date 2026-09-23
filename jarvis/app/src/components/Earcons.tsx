import { useEffect, useRef } from "react";
import { useAssistant } from "../lib/assistant";
import { cue } from "../lib/cues";

// Marks the conversation's moments with the Glass cues (lib/cues.ts). Renders
// nothing; it only watches the assistant.
//
//   off -> listening        "I'm listening"  (the orb was tapped; hearing its
//                           name plays the same cue, from voice.ts, since the
//                           phase is "listening" already)
//   listening -> thinking   "Got it"         (what you said was sent)
//   thinking -> speaking    a tap only: a chime right before OVOA's voice
//                           would talk over its first word
//   a new approval card     "Needs you"
//   a new error             "Couldn't"
//
// Coming back to listening after a reply makes no sound: a chime on every turn
// of a conversation would be noise.
export function Earcons() {
  const a = useAssistant();
  const phase = useRef(a.phase);
  const cards = useRef(a.approvals.length);
  const error = useRef(a.error);

  useEffect(() => {
    const was = phase.current;
    phase.current = a.phase;
    if (was === a.phase) return;
    if (a.phase === "listening" && (was === "off" || was === "waiting")) cue("wake");
    else if (a.phase === "thinking" && was === "listening") cue("sent");
    else if (a.phase === "speaking" && was === "thinking") cue("reply", { sound: false });
  }, [a.phase]);

  useEffect(() => {
    if (a.approvals.length > cards.current) cue("approve");
    cards.current = a.approvals.length;
  }, [a.approvals.length]);

  useEffect(() => {
    if (a.error && a.error !== error.current) cue("error");
    error.current = a.error;
  }, [a.error]);

  return null;
}
