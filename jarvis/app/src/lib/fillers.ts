import { Directory, File, Paths } from "expo-file-system";
import { devlog } from "./devlog";
import { renderSpeech, voicePref, type VoiceId } from "./voice";

// What OVOA says the moment you stop talking, while the answer is worked out:
// "One second while I get that." Voiced once per voice and kept on the phone,
// so it plays instantly with no network round trip, and picked at random so it
// doesn't sound like a machine.

export const FILLERS = [
  "One second while I get that.",
  "Give me a second.",
  "Let me check on that.",
  "Hang on, getting that for you.",
  "One moment.",
  "Sure, one sec.",
  "Let me look into that.",
  "Okay, give me a second.",
  "Right, one moment.",
  "Let me see.",
];

const dir = new Directory(Paths.document, "fillers");
let ready: File[] = [];
let voice: VoiceId | null = null;
let preparing: Promise<void> | null = null;

const fileFor = (v: VoiceId, i: number) => new File(dir, `${v}-${i}.mp3`);

/** Voices every filler in the chosen voice, once; later calls only pick up what's on disk. */
export function prepareFillers(token: string) {
  preparing ??= (async () => {
    try {
      const v = await voicePref.get();
      if (!dir.exists) dir.create({ intermediates: true });
      const files: File[] = [];
      for (let i = 0; i < FILLERS.length; i++) {
        const target = fileFor(v, i);
        if (!target.exists) {
          const made = await renderSpeech(token, FILLERS[i]).catch(() => null);
          if (!made) continue;
          made.move(target);
        }
        files.push(target);
      }
      voice = v;
      ready = files;
      devlog("voice", `${files.length} fillers ready in ${v}`);
    } catch (err) {
      devlog("err", "couldn't prepare the fillers", String(err));
    } finally {
      preparing = null;
    }
  })();
  return preparing;
}

/**
 * A random filler, as a copy (playing a clip deletes it). Null when none are
 * ready yet, or they're in a different voice than the one now chosen.
 */
export function pickFiller(): File | null {
  if (!ready.length) return null;
  const source = ready[Math.floor(Math.random() * ready.length)];
  try {
    const copy = new File(Paths.cache, `ovoa-filler-${Date.now()}.mp3`);
    source.copy(copy);
    return copy;
  } catch {
    return null;
  }
}

/** When the voice changes the old fillers are wrong: drop them and voice the new ones. */
export function watchVoiceForFillers(token: string) {
  return voicePref.onChange((v) => {
    if (v === voice) return;
    ready = [];
    void prepareFillers(token);
  });
}
