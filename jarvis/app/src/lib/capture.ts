import { useEffect } from "react";
import { api } from "./api";
import { useAuth } from "./auth";
import { devlog } from "./devlog";
import { getRecordings, markLost, updateRecording, useRecordings, wavFile, type Recording } from "./recordings";
import { transcribe } from "./voice";

// How a recording becomes a moment in the timeline.
//
// This is the only path into the timeline, and it starts with someone pressing
// a button. The clip's own button, the Record tab, a typed note — all explicit.
// There is no branch here that captures anything the user did not choose to
// record, and there is not meant to be one.
//
// What crosses the network is the audio, once, to be turned into words; the
// words go up to be summarised and are thrown away there. What comes back and
// is kept is a title and two sentences. The recording itself never leaves this
// phone, and stays exactly where the user put it.

/** The server refuses anything larger, and a 10 MB WAV is already ~15 minutes. */
const MAX_BYTES = 10 * 1024 * 1024;

/** In flight right now, so two passes can't send the same recording twice. */
const working = new Set<string>();

/** A pass is walking the list. Module scope, so a remount can't start a second one. */
let passRunning = false;

/**
 * Transcribes one saved recording and files it in the timeline. The outcome is
 * written back onto the recording, so a failure is visible in the Record tab
 * rather than silent, and so a retry doesn't start from nothing.
 */
export async function captureRecording(token: string, recording: Recording) {
  if (recording.blockId || recording.lost || working.has(recording.id)) return;
  // Joined onto Documents as it is right now. The old code carried an absolute uri
  // saved when the recording was made, and iOS moves the container on every app
  // update, so every one of them pointed at a folder that no longer existed.
  const audio = wavFile(recording);
  if (!audio) return;
  working.add(recording.id);
  updateRecording(recording.id, { capturing: true, captureError: undefined });

  try {
    if (!audio.exists) {
      // A dead end, not a retry: nothing on this phone will bring the file back.
      markLost(recording.id, "The audio for this one is no longer on the phone, so it can't be added to your timeline.");
      return;
    }
    // v57: File.size is 0 for a file that isn't there, so the check above has to
    // come first — otherwise a missing file looks like a 0-byte one and only
    // blows up later, inside transcribe (device_logs 2026-09-20 23:18).
    const bytes = audio.size;
    devlog("file", `timeline: reading ${audio.name}, ${Math.round(bytes / 1024)} KB`, audio.uri);
    if (bytes > MAX_BYTES) {
      throw new Error(`Too long to transcribe (${Math.round(bytes / 1024 / 1024)} MB). The limit is 10 MB.`);
    }
    if (bytes === 0) {
      markLost(recording.id, "This recording came out empty, so there's nothing to add to your timeline.");
      return;
    }

    const text = await transcribe(token, audio.uri, "audio/wav", { keep: true });
    if (!text.trim()) {
      // Silence or noise. Marked so it isn't retried on every launch.
      updateRecording(recording.id, { capturing: false, captureError: "Nothing was said in this one." });
      return;
    }

    const started = recording.createdAt;
    const { block } = await api.addContextBlock(token, {
      startedAt: started,
      endedAt: started + Math.round((recording.seconds ?? 0) * 1000),
      source: "voice",
      transcript: text,
    });
    updateRecording(recording.id, { capturing: false, blockId: block.id, blockTitle: block.title });
    devlog("log", `timeline: filed "${block.title}"`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The uri goes in the detail: without it the log said which file was missing
    // but never which folder was tried, which is the whole of this bug.
    devlog("err", "timeline: couldn't file a recording", `${recording.id} · ${audio.uri}\n${message}`);
    updateRecording(recording.id, { capturing: false, captureError: message });
  } finally {
    working.delete(recording.id);
  }
}

/** Clears the error so the next pass tries again. A lost recording has nothing to try. */
export function retryCapture(token: string, recording: Recording) {
  if (recording.lost) {
    devlog("log", `timeline: retry ignored, ${recording.id} has no audio`, recording.lost);
    return Promise.resolve();
  }
  updateRecording(recording.id, { captureError: undefined });
  return captureRecording(token, { ...recording, captureError: undefined });
}

/**
 * Files anything recorded but not yet filed, while the timeline is on. One at a
 * time: each one is a transcription and a model call, and doing four at once
 * only makes all four slower.
 */
export function useAutoCapture() {
  const { token, user } = useAuth();
  const recordings = useRecordings();
  const on = !!token && !!user?.settings.contextEnabled;

  useEffect(() => {
    if (!on || passRunning) return;
    let stopped = false;
    // One pass at a time. Every capture writes the list, which re-runs this
    // effect, which used to start a second pass that skipped straight past the
    // one still working (it is in `working`) and began the next recording — so
    // "one at a time" quietly became all of them at once, which is exactly what
    // the fourteen recovered recordings would have done on first launch.
    passRunning = true;
    (async () => {
      let tried = 0;
      // Attempted in this pass, whatever came of it. Without this the sweep below
      // could spin on a recording the band path is already holding in `working`,
      // which returns without marking it either way.
      const seen = new Set<string>();
      try {
        // Keep sweeping until one finds nothing new. The pass therefore also picks
        // up whatever arrived while it was working, which the effect can no longer
        // do for it now that a second pass is refused.
        for (let swept = 1; swept && !stopped; ) {
          swept = 0;
          // Read fresh each time: a capture rewrites the list as it goes.
          for (const recording of getRecordings()) {
            if (stopped) return;
            const current = getRecordings().find((r) => r.id === recording.id);
            if (!current?.wavName || current.blockId || current.captureError || current.lost) continue;
            if (seen.has(current.id)) continue;
            seen.add(current.id);
            swept++;
            tried++;
            await captureRecording(token!, current);
          }
        }
      } finally {
        passRunning = false;
        if (tried) devlog("log", `timeline: pass over ${tried} unfiled recording${tried === 1 ? "" : "s"} finished`);
      }
    })();
    return () => {
      stopped = true;
    };
    // `recordings` is the trigger: a new one arriving starts another pass.
  }, [on, token, recordings]);
}
