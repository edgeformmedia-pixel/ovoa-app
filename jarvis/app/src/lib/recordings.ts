import { Directory, File, Paths } from "expo-file-system";
import { useSyncExternalStore } from "react";
import { devlog } from "./devlog";

// The recordings saved on this phone. The audio files live in Documents/recordings
// (the ES100 module writes them there); this keeps the list, in index.json beside them.

export type Recording = {
  id: string;
  title: string;
  createdAt: number;
  /** Where it came from. Only the clip for now. */
  source: "clip";
  /** The clip's own id for it, which is also its start time in unix seconds. */
  sessionId?: number;
  seconds?: number;
  /** Playable audio. Missing if decoding failed; `rawUri` is still kept. */
  wavUri?: string;
  rawUri?: string;
  bytes?: number;
  decodeError?: string;
  /** The timeline block written from this one, once it has been filed. */
  blockId?: string;
  blockTitle?: string;
  /** Why filing it didn't work. Set means "don't keep retrying on every launch". */
  captureError?: string;
  /** Being transcribed and filed right now. Not worth persisting. */
  capturing?: boolean;
};

const dir = () => new Directory(Paths.document, "recordings");
const indexFile = () => new File(dir(), "index.json");

let list: Recording[] = [];
let loaded = false;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const file = indexFile();
    if (file.exists) {
      // `capturing` is about this run of the app. If the app was killed mid-way
      // it would otherwise come back reading "Adding to your timeline…" forever,
      // for something nothing is working on any more.
      list = (JSON.parse(file.textSync()) as Recording[]).map(({ capturing: _, ...r }) => r);
    }
  } catch (err) {
    devlog("err", "couldn't read the recordings list", String(err));
  }
}

function save() {
  try {
    const d = dir();
    if (!d.exists) d.create({ intermediates: true, idempotent: true });
    indexFile().write(JSON.stringify(list));
  } catch (err) {
    devlog("err", "couldn't save the recordings list", String(err));
  }
  emit();
}

export function getRecordings() {
  load();
  return list;
}

export function useRecordings() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getRecordings,
  );
}

export function hasClipSession(sessionId: number) {
  return getRecordings().some((r) => r.sessionId === sessionId);
}

/** Adds a recording, replacing an earlier copy of the same clip session. */
export function addRecording(recording: Omit<Recording, "id" | "title"> & { title?: string }) {
  load();
  const when = new Date(recording.createdAt);
  const entry: Recording = {
    id: recording.sessionId ? `clip-${recording.sessionId}` : `rec-${recording.createdAt}`,
    title:
      recording.title ??
      `Recording ${when.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`,
    ...recording,
  };
  list = [entry, ...list.filter((r) => r.id !== entry.id)].sort((a, b) => b.createdAt - a.createdAt);
  save();
  return entry;
}

export function updateRecording(id: string, patch: Partial<Omit<Recording, "id">>) {
  load();
  list = list.map((r) => (r.id === id ? { ...r, ...patch } : r));
  save();
}

export function renameRecording(id: string, title: string) {
  updateRecording(id, { title: title.trim() || "Untitled" });
}

export function deleteRecording(id: string) {
  load();
  const recording = list.find((r) => r.id === id);
  for (const uri of [recording?.wavUri, recording?.rawUri]) {
    if (!uri) continue;
    try {
      const file = new File(uri);
      if (file.exists) file.delete();
    } catch {}
  }
  list = list.filter((r) => r.id !== id);
  save();
}
