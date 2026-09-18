import fs from "node:fs/promises";
import { audioPath, captures } from "./db.js";
import { enrichTranscript } from "./providers/claude.js";
import { getSttProvider } from "./providers/stt.js";

/**
 * Runs after a capture closes: transcribe, then enrich. Deliberately not
 * awaited by the request that triggers it — the phone should be able to hang up
 * as soon as its bytes are safely on disk.
 */
export async function processCapture(id: string): Promise<void> {
  try {
    const pcm = await fs.readFile(audioPath(id));
    if (pcm.length === 0) {
      captures.setStatus(id, "failed", "No audio received");
      return;
    }

    const stt = getSttProvider();
    const result = await stt.transcribe(pcm);
    captures.saveTranscript(id, result.text, result.segments);

    if (!result.text.trim()) {
      // Silence is a normal outcome for an always-on mic, not an error.
      captures.saveEnrichment(id, {
        title: "Silent capture",
        summary: "No speech was detected in this recording.",
        actionItems: [],
      });
      return;
    }

    const enrichment = await enrichTranscript(result.text);
    captures.saveEnrichment(id, enrichment);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    captures.setStatus(id, "failed", message);
  }
}
