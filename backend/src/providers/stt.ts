import { config } from "../config.js";
import type { SttResult, TranscriptSegment } from "../types.js";
import { pcmToWav } from "./audio.js";

export interface SttProvider {
  readonly name: string;
  transcribe(pcm: Buffer): Promise<SttResult>;
}

/**
 * Lets the whole pipeline run before any API keys exist, and keeps the ingest
 * and enrichment paths testable without spending money on every run.
 *
 * Returns a realistic sample conversation rather than a placeholder string:
 * enrichment and chat are the parts worth testing without hardware, and neither
 * does anything interesting given "captured 9s of audio".
 */
const SAMPLE_TRANSCRIPT: TranscriptSegment[] = [
  { speaker: 0, start: 0.0, end: 5.2, text: "Okay so before we lose the thread — where did we land on the supplier thing?" },
  { speaker: 1, start: 5.4, end: 13.1, text: "Still waiting. I emailed them Tuesday asking for the BLE docs and the demo APK, no reply yet. I'll chase them again Friday if it's still quiet." },
  { speaker: 0, start: 13.3, end: 18.9, text: "Don't block on it. Can we just sniff the protocol off their app in the meantime?" },
  { speaker: 1, start: 19.2, end: 27.6, text: "Yeah, that's the plan. I need an Android phone though, the snoop log doesn't exist on iOS. I'll pick up a cheap Pixel this week." },
  { speaker: 0, start: 27.8, end: 31.4, text: "Put it on the company card. What about the consent piece?" },
  { speaker: 1, start: 31.7, end: 41.2, text: "That worries me more than the hardware honestly. Always-on recording is two-party consent in a bunch of states. We need a recording indicator in the UI and probably a lawyer to look at the disclosure copy." },
  { speaker: 0, start: 41.5, end: 46.0, text: "Agreed. I'll ask Dana for a referral. Anything else before I drop?" },
  { speaker: 1, start: 46.2, end: 52.8, text: "Just the transcription bill — if we're recording eight hours a day per user that adds up fast. I want to run the numbers before we commit to a provider." },
];

const mockStt: SttProvider = {
  name: "mock",
  async transcribe() {
    return {
      text: SAMPLE_TRANSCRIPT.map(
        (seg) => `Speaker ${seg.speaker}: ${seg.text}`,
      ).join("\n"),
      segments: SAMPLE_TRANSCRIPT,
      provider: "mock",
    };
  },
};

const deepgram: SttProvider = {
  name: "deepgram",
  async transcribe(pcm) {
    const url = new URL("https://api.deepgram.com/v1/listen");
    url.searchParams.set("model", "nova-3");
    url.searchParams.set("smart_format", "true");
    url.searchParams.set("punctuate", "true");
    // A pendant picks up whoever is in the room, so speaker labels matter more
    // here than they would for a push-to-talk mic.
    url.searchParams.set("diarize", "true");

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Token ${config.deepgramApiKey}`,
        "Content-Type": "audio/wav",
      },
      body: new Uint8Array(pcmToWav(pcm)),
    });

    if (!res.ok) {
      throw new Error(`Deepgram ${res.status}: ${await res.text()}`);
    }

    const body = (await res.json()) as DeepgramResponse;
    const alt = body.results?.channels?.[0]?.alternatives?.[0];
    if (!alt) throw new Error("Deepgram returned no alternatives");

    const segments: TranscriptSegment[] = groupWords(alt.words ?? []);
    return { text: alt.transcript ?? "", segments, provider: "deepgram" };
  },
};

interface DeepgramWord {
  word: string;
  punctuated_word?: string;
  start: number;
  end: number;
  speaker?: number;
}

interface DeepgramResponse {
  results?: {
    channels?: { alternatives?: { transcript?: string; words?: DeepgramWord[] }[] }[];
  };
}

/** Collapse per-word timings into contiguous same-speaker runs. */
function groupWords(words: DeepgramWord[]): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  for (const w of words) {
    const speaker = w.speaker ?? null;
    const last = segments.at(-1);
    const token = w.punctuated_word ?? w.word;
    if (last && last.speaker === speaker) {
      last.text += ` ${token}`;
      last.end = w.end;
    } else {
      segments.push({ speaker, start: w.start, end: w.end, text: token });
    }
  }
  return segments;
}

export function getSttProvider(): SttProvider {
  return config.deepgramApiKey ? deepgram : mockStt;
}
