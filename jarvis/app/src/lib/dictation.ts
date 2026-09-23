import { useEffect, useRef } from "react";
import { useAssistant } from "./assistant";
import { useConversation } from "./voice";

// Say something instead of typing it: one utterance, turned into text, handed
// to `onText`, and the microphone closes. Used by a made app's screen, its
// editor, and Create.
//
// Talk's own listening is held off the whole time (useAssistant().hold), so
// Always listen doesn't answer what was meant for this box. The phone's ear is
// one microphone for the whole app (liveListen.ts holdEar): this borrows it,
// in open mode, and hands it back. No wake word (every word counts) and no
// fillers (nothing is being answered here). The words are recognised on the
// phone; only the text reaches `onText`.

export function useDictation(token: string, onText: (text: string) => void) {
  const a = useAssistant();
  const handler = useRef(onText);
  handler.current = onText;
  const release = useRef<(() => void) | null>(null);

  const convo = useConversation(
    token,
    async (said) => {
      stop();
      handler.current(said);
      return null;
    },
    { wake: false, fillers: false },
  );

  function stop() {
    convo.end();
    release.current?.();
    release.current = null;
  }

  const start = async () => {
    if (release.current) return;
    void a.hold(() => new Promise<void>((r) => (release.current = r)));
    // Always listen's conversation has the ear until the hold has closed it.
    if (a.alwaysListen) await new Promise((r) => setTimeout(r, 250));
    const ok = await convo.start();
    if (!ok) stop();
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => stop(), []);

  const listening = !!release.current && convo.phase !== "off";
  return { listening, words: convo.words, error: convo.error, start, stop };
}
