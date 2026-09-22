import { Directory, File, Paths } from "expo-file-system";
import { devlog } from "./devlog";
import { renderSpeech, voicePref, type VoiceId } from "./voice";

// What OVOA says the moment you stop talking, while the answer is worked out:
// "One second while I get that." Voiced once per voice and kept on the phone,
// so it plays instantly with no network round trip, and picked at random so it
// doesn't sound like a machine.
//
// Everything here is deliberately synchronous where a File is handed straight to
// a player. In SDK 57 copy() and move() return promises, and the un-awaited
// versions gave the player a file that had not been written yet: 11 of 19
// addressed turns then sat in silence for the whole eight-second playback
// watchdog — the one thing a filler exists to prevent (device_logs, 2026-09-21).

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

// Built on demand, not at import: expo-file-system throws when the module is
// merely loaded on a platform it does not support, which took the whole app
// down before the first screen rendered. recordings.ts is lazy for the same reason.
const dir = () => new Directory(Paths.document, "fillers");
let ready: File[] = [];
let voice: VoiceId | null = null;
let preparing: Promise<void> | null = null;
/** So two picks in the same millisecond can't collide on one cache filename. */
let pickCount = 0;

const fileFor = (v: VoiceId, i: number) => new File(dir(), `${v}-${i}.mp3`);

/** Voices every filler in the chosen voice, once; later calls only pick up what's on disk. */
export function prepareFillers(token: string) {
  preparing ??= (async () => {
    try {
      const v = await voicePref.get();
      const folder = dir();
      if (!folder.exists) folder.create({ intermediates: true });
      const files: File[] = [];
      let voiced = 0;
      for (let i = 0; i < FILLERS.length; i++) {
        const target = fileFor(v, i);
        // A slot that exists but is empty poisons itself for good: `exists` skips
        // re-voicing it, and pickFiller then throws that pick away every time it
        // comes up. One failed TTS response should cost one attempt, not the slot.
        if (target.exists && !target.size) {
          devlog("file", `filler ${i} was saved empty; voicing it again`, target.uri);
          try {
            target.delete();
          } catch {}
        }
        if (!target.exists) {
          const made = await renderSpeech(token, FILLERS[i]).catch((err) => {
            devlog("err", `couldn't voice filler ${i}`, err instanceof Error ? err.message : String(err));
            return null;
          });
          if (!made) continue;
          // Awaited: move() returns a promise in SDK 57, so the old un-awaited call
          // could list a filler as ready before it had reached its final path.
          try {
            await made.move(target);
          } catch (err) {
            devlog("err", `couldn't save filler ${i}`, err instanceof Error ? err.message : String(err));
            continue;
          }
          voiced++;
        }
        files.push(target);
      }
      voice = v;
      ready = files;
      devlog("file", `${files.length} fillers ready in ${v} (${voiced} newly voiced)`, folder.uri);
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
    if (!source.exists) {
      // Documents survives an update, but the list is built once per launch. The
      // list is left alone: clearing it here would turn one missing file into no
      // fillers at all until the voice changed, and nothing would re-voice them.
      devlog("err", "a filler is missing from Documents/fillers; skipping it", source.uri);
      return null;
    }
    const copy = new File(Paths.cache, `ovoa-filler-${Date.now()}-${pickCount++}.mp3`);
    // copySync, not copy: copy() is async in SDK 57, and nothing awaited it, so
    // the player was handed a file that hadn't been written yet.
    source.copySync(copy, { overwrite: true });
    if (!copy.size) {
      devlog("err", "a filler copied as an empty file; skipping it", source.uri);
      return null;
    }
    return copy;
  } catch (err) {
    devlog("err", "couldn't copy a filler to play", err instanceof Error ? err.message : String(err));
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
