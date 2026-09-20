import { File } from "expo-file-system";
import { useEffect } from "react";
import { api } from "./api";
import { useAuth } from "./auth";
import { devlog } from "./devlog";
import { getRecordings, updateRecording, useRecordings, type Recording } from "./recordings";
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

function sizeOf(uri: string) {
  try {
    return new File(uri).size ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Transcribes one saved recording and files it in the timeline. The outcome is
 * written back onto the recording, so a failure is visible in the Record tab
 * rather than silent, and so a retry doesn't start from nothing.
 */
export async function captureRecording(token: string, recording: Recording) {
  if (!recording.wavUri || recording.blockId || working.has(recording.id)) return;
  working.add(recording.id);
  updateRecording(recording.id, { capturing: true, captureError: undefined });

  try {
    const bytes = sizeOf(recording.wavUri);
    if (bytes > MAX_BYTES) {
      throw new Error(`Too long to transcribe (${Math.round(bytes / 1024 / 1024)} MB). The limit is 10 MB.`);
    }

    const text = await transcribe(token, recording.wavUri, "audio/wav", { keep: true });
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
    devlog("err", "timeline: couldn't file a recording", message);
    updateRecording(recording.id, { capturing: false, captureError: message });
  } finally {
    working.delete(recording.id);
  }
}

/** Clears the error so the next pass tries again. */
export function retryCapture(token: string, recording: Recording) {
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
    if (!on) return;
    let stopped = false;
    (async () => {
      // Read fresh each time: a capture rewrites the list as it goes.
      for (const recording of getRecordings()) {
        if (stopped) return;
        const current = getRecordings().find((r) => r.id === recording.id);
        if (!current?.wavUri || current.blockId || current.captureError) continue;
        await captureRecording(token!, current);
      }
    })();
    return () => {
      stopped = true;
    };
    // `recordings` is the trigger: a new one arriving starts another pass.
  }, [on, token, recordings]);
}
