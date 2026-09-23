import { Directory, File, Paths } from "expo-file-system";
import { devlog } from "./devlog";
import { currentTtsEngine, isDeviceUtterance, onTtsEngineChange, renderSpeech, usesDeviceVoice, voicePref, type Spoken, type VoiceId } from "./voice";

// What OVOA says the moment you stop talking, while the answer is worked out:
// "One moment." Voiced once per voice and kept on the phone, so it plays
// instantly with no network round trip, and picked at random so it doesn't
// sound like a machine. The lines are in fillerLines.ts: short ones at send,
// and a "still on it" one for an answer that is slow to come.
//
// Everything here is deliberately synchronous where a File is handed straight to
// a player. In SDK 57 copy() and move() return promises, and the un-awaited
// versions gave the player a file that had not been written yet: 11 of 19
// addressed turns then sat in silence for the whole eight-second playback
// watchdog — the one thing a filler exists to prevent (device_logs, 2026-09-21).

import { FILLERS, SHORT_FILLERS, STILL_ON_IT } from "./fillerLines";

export { SHORT_FILLERS };

/** Which lines: said at send, or once when the answer is slow to come (fillerLines.ts). */
export type FillerKind = "short" | "still";

/** A filler to play, and what it says: the turn gate strips its echo by the words (turnGate.ts hearFiller). */
export type Filler = { piece: Spoken; text: string };

// Built on demand, not at import: expo-file-system throws when the module is
// merely loaded on a platform it does not support, which took the whole app
// down before the first screen rendered. recordings.ts is lazy for the same reason.
const dir = () => new Directory(Paths.document, "fillers");
let ready: { file: File; text: string }[] = [];
/** Which voice, on which engine, the ready files are in. */
let voice: string | null = null;
let preparing: Promise<void> | null = null;
/** So two picks in the same millisecond can't collide on one cache filename. */
let pickCount = 0;

/** "One moment." → "one-moment". */
const slug = (line: string) => line.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * Named by engine, voice and the line's own words: the same voice on another
 * engine sounds different, so it is voiced again. By the words, not the line's
 * place in the list: files were named 0-9 until the lines changed, and a
 * numbered file would have gone on saying the old line under the new line's
 * text, so the gate would have listened for the wrong echo.
 */
const fileFor = (engine: string, v: VoiceId, line: string) => new File(dir(), `${engine}-${v}-${slug(line)}.mp3`);

/**
 * Deletes the files of lines no longer said (the old numbered ones included),
 * in every voice. Tidying only: a folder it can't read costs nothing but space.
 */
function dropRetiredLines(folder: Directory) {
  const current = FILLERS.map((line) => `-${slug(line)}.mp3`);
  try {
    for (const entry of folder.list()) {
      if (entry instanceof File && !current.some((end) => entry.name.endsWith(end))) entry.delete();
    }
  } catch (err) {
    devlog("file", "couldn't tidy away old fillers", err instanceof Error ? err.message : String(err));
  }
}

/** Voices every filler in the chosen voice, once; later calls only pick up what's on disk. */
export function prepareFillers(token: string) {
  preparing ??= (async () => {
    try {
      // The phone's own voice needs nothing prepared: pickFillerLine speaks the words.
      if (usesDeviceVoice()) {
        voice = `device:${await voicePref.get()}`;
        ready = [];
        return;
      }
      const v = await voicePref.get();
      const engine = currentTtsEngine();
      const folder = dir();
      if (!folder.exists) folder.create({ intermediates: true });
      dropRetiredLines(folder);
      const files: { file: File; text: string }[] = [];
      let voiced = 0;
      for (let i = 0; i < FILLERS.length; i++) {
        const target = fileFor(engine, v, FILLERS[i]);
        // A slot that exists but is empty poisons itself for good: `exists` skips
        // re-voicing it, and pickFillerLine then throws that pick away every time it
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
          // The server switched to the phone's voice mid-way: nothing more to keep.
          if (isDeviceUtterance(made)) break;
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
        files.push({ file: target, text: FILLERS[i] });
      }
      voice = `${engine}:${v}`;
      ready = files;
      devlog("file", `${files.length} fillers ready in ${v} on ${engine} (${voiced} newly voiced)`, folder.uri);
    } catch (err) {
      devlog("err", "couldn't prepare the fillers", String(err));
    } finally {
      preparing = null;
    }
  })();
  return preparing;
}

/**
 * A random filler of one kind, as a copy (playing a clip deletes it), with its
 * words. Null when none are ready yet, or they're in a different voice than the
 * one now chosen. Picked only when it will be played: every pick copies a file
 * into the cache, and a copy nobody plays is left there (voice.ts asks
 * reply.queued() first, and clip() throws away one it turns down).
 */
export function pickFillerLine(kind: FillerKind = "short"): Filler | null {
  const lines = kind === "short" ? SHORT_FILLERS : STILL_ON_IT;
  // The phone's own voice: the words are enough, and there is nothing to copy.
  if (usesDeviceVoice()) {
    const text = lines[Math.floor(Math.random() * lines.length)];
    return { piece: { device: true, text }, text };
  }
  const choices = ready.filter((r) => lines.includes(r.text));
  if (!choices.length) return null;
  const { file: source, text } = choices[Math.floor(Math.random() * choices.length)];
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
    return { piece: copy, text };
  } catch (err) {
    devlog("err", "couldn't copy a filler to play", err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** A short filler to play at once, for callers that only need the sound (the band's turns). */
export const pickFiller = (): Spoken | null => pickFillerLine("short")?.piece ?? null;

/** When the voice or the engine changes the old fillers are wrong: drop them and voice the new ones. */
export function watchVoiceForFillers(token: string) {
  const again = () => {
    ready = [];
    void prepareFillers(token);
  };
  const offVoice = voicePref.onChange((v) => {
    if (`${currentTtsEngine()}:${v}` !== voice) again();
  });
  const offEngine = onTtsEngineChange(again);
  return () => {
    offVoice();
    offEngine();
  };
}
