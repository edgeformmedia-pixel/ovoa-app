export type CaptureStatus = "recording" | "processing" | "ready" | "failed";

export interface Capture {
  id: string;
  status: CaptureStatus;
  startedAt: string;
  closedAt: string | null;
  durationSec: number | null;
  bytes: number;
  transcript: string | null;
  title: string | null;
  summary: string | null;
  actionItems: string[];
  error: string | null;
}

export interface TranscriptSegment {
  speaker: number | null;
  start: number;
  end: number;
  text: string;
}

export interface SttResult {
  text: string;
  segments: TranscriptSegment[];
  provider: string;
}
