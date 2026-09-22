import { Directory, File, Paths } from "expo-file-system";
import { useSyncExternalStore } from "react";
import { devlog } from "./devlog";

// The recordings saved on this phone. The audio files live in Documents/recordings
// (the ES100 module writes them there); this keeps the list, in index.json beside them.
//
// Only the file NAME is stored, never the full uri. iOS hands the app a new data
// container UUID on every install and update, so a saved
// file:///var/mobile/Containers/Data/Application/<UUID>/Documents/recordings/x.wav
// stops resolving the moment the app updates. Every row held one, so all fourteen
// recordings died in the same minute — "couldn't be opened because there is no such
// file", device_logs 2026-09-20 23:18. The audio itself moved with the container and
// was never lost; only the remembered path was wrong. A name joined onto
// Paths.document at read time is right for whatever container we are in today.
//
// Documents and not cache, deliberately: the v57 docs call Paths.cache "a place to
// store files that can be deleted by the system when the device runs low on storage"
// and Paths.document "a place to store files that are safe from being deleted by the
// system" (docs.expo.dev/versions/v57.0.0/sdk/filesystem). A recording the user can
// replay has to survive, so it stays in Documents, where UteBleModule.swift already
// writes it. Only audio we are about to play and throw away goes in cache.

export type Recording = {
  id: string;
  title: string;
  createdAt: number;
  /** Where it came from. Only the clip for now. */
  source: "clip";
  /** The clip's own id for it, which is also its start time in unix seconds. */
  sessionId?: number;
  seconds?: number;
  /** Playable audio, as a file name inside Documents/recordings. Missing if decoding failed. */
  wavName?: string;
  /** The raw file as the clip stored it, a name in the same folder. */
  rawName?: string;
  /** Absolute uris written by builds up to 44. Read once by migrate(), then dropped. */
  wavUri?: string;
  rawUri?: string;
  bytes?: number;
  decodeError?: string;
  /** The timeline block written from this one, once it has been filed. */
  blockId?: string;
  blockTitle?: string;
  /** Why filing it didn't work. Set means "don't keep retrying on every launch". */
  captureError?: string;
  /** The audio is gone from disk. A dead end: nothing retries a lost recording. */
  lost?: string;
  /** Being transcribed and filed right now. Not worth persisting. */
  capturing?: boolean;
};

const INDEX_NAME = "index.json";
const dir = () => new Directory(Paths.document, "recordings");
const indexFile = () => new File(dir(), INDEX_NAME);

/** What the user is told when the audio is simply not there any more. */
const GONE = "The audio for this one is no longer on the phone.";

let list: Recording[] = [];
let loaded = false;
/**
 * The index was there but could not be read. Nothing may be written over it:
 * one bad parse followed by any save() would replace a real list with an empty
 * one, which is the whole library gone for a transient read error.
 */
let unreadable = false;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

/** The last segment of a path or file:// uri, undoing whatever iOS percent-encoded. */
export function fileNameOf(path: string) {
  const last = path.split("?")[0].split("#")[0].replace(/\/+$/, "").split("/").pop() ?? "";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** The playable file, resolved against Documents as it is right now. */
export function wavFile(recording: Recording | null | undefined) {
  return recording?.wavName ? new File(dir(), recording.wavName) : null;
}

/** The raw file the clip sent, resolved the same way. */
export function rawFile(recording: Recording | null | undefined) {
  return recording?.rawName ? new File(dir(), recording.rawName) : null;
}

/**
 * Builds up to 44 stored the whole file:// uri, which carries the app container's
 * UUID and dies on every update. Keep the name and throw the uri away; the file it
 * named is still sitting in Documents/recordings under the new container.
 */
function migrate(saved: Recording[]) {
  let changed = 0;
  const next = saved.map((entry) => {
    // `capturing` is about this run of the app. If the app was killed mid-way it
    // would otherwise come back reading "Adding to your timeline…" forever, for
    // something nothing is working on any more.
    const { wavUri, rawUri, capturing: _capturing, ...rest } = entry;
    const row: Recording = { ...rest };
    if (!row.wavName && wavUri) row.wavName = fileNameOf(wavUri);
    if (!row.rawName && rawUri) row.rawName = fileNameOf(rawUri);
    if (wavUri || rawUri) {
      changed++;
      // The old error was the raw Foundation string; it means nothing now.
      if (row.captureError?.includes("no such file")) row.captureError = undefined;
    }
    return row;
  });
  return { list: next, changed };
}

/**
 * Once per launch: which entries still have their audio, and what is actually in
 * the folder. This is the line that would have named the stale-path bug from the
 * phone instead of from a guess, so it is worth the one directory read it costs.
 */
function audit(rows: Recording[]) {
  const folder = dir();
  let onDisk: string[] = [];
  try {
    // list() throws when the folder isn't there, which is true on a fresh install.
    onDisk = folder.exists ? folder.list().map((e) => e.name).filter((n) => n !== INDEX_NAME) : [];
  } catch (err) {
    devlog("err", "couldn't list the recordings folder", `${folder.uri}\n${String(err)}`);
    return { list: rows, missing: 0 };
  }
  const gone = new Set(rows.filter((r) => r.wavName && !onDisk.includes(r.wavName)).map((r) => r.id));
  const claimed = new Set(rows.flatMap((r) => [r.wavName, r.rawName]).filter(Boolean) as string[]);
  const orphans = onDisk.filter((n) => !claimed.has(n));
  devlog(
    "file",
    `recordings: ${onDisk.length} audio files on disk, ${gone.size} of ${rows.length} entries have none`,
    `dir ${folder.uri}\non disk: ${onDisk.join(", ") || "(none)"}\nno audio: ${[...gone].join(", ") || "(none)"}\nunclaimed: ${orphans.join(", ") || "(none)"}`,
  );
  if (!gone.size) return { list: rows, missing: 0 };
  return {
    list: rows.map((r) => (gone.has(r.id) ? { ...r, lost: GONE, captureError: GONE } : r)),
    missing: gone.size,
  };
}

function load() {
  if (loaded) return;
  loaded = true;
  const file = indexFile();
  try {
    if (!file.exists) {
      devlog("file", "recordings: no index yet", file.uri);
      return;
    }
    const raw = file.textSync();
    const saved = JSON.parse(raw) as Recording[];
    if (!Array.isArray(saved)) throw new Error(`index.json holds a ${typeof saved}, not a list`);
    const moved = migrate(saved);
    const checked = audit(moved.list);
    list = checked.list;
    devlog(
      "file",
      `recordings: ${list.length} loaded, ${moved.changed} repathed, ${checked.missing} lost`,
      `${file.uri}\n${raw.length} bytes of index`,
    );
    // One write covers both the migration and anything the audit marked lost.
    if (moved.changed || checked.missing) save();
  } catch (err) {
    unreadable = true;
    devlog("err", "couldn't read the recordings list; it will not be written over", `${file.uri}\n${String(err)}`);
  }
}

function save() {
  if (unreadable) return emit();
  const file = indexFile();
  try {
    const folder = dir();
    if (!folder.exists) folder.create({ intermediates: true, idempotent: true });
    // Neither `capturing` nor an absolute uri ever goes back to disk.
    const body = JSON.stringify(list.map(({ capturing: _c, wavUri: _w, rawUri: _r, ...keep }) => keep));
    file.write(body);
  } catch (err) {
    devlog("err", "couldn't save the recordings list", `${file.uri}\n${String(err)}`);
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

/**
 * Used to decide whether a clip session still needs downloading. A row whose
 * audio is gone does not count as having it — otherwise "Import from clip"
 * answers "up to date" about a recording the phone cannot play.
 */
export function hasClipSession(sessionId: number) {
  return getRecordings().some((r) => r.sessionId === sessionId && !r.lost);
}

/** Adds a recording, replacing an earlier copy of the same clip session. */
export function addRecording(recording: Omit<Recording, "id" | "title"> & { title?: string }) {
  load();
  const when = new Date(recording.createdAt);
  // A caller that still hands over a uri gets it turned into a name here, so there
  // is exactly one place in the app where an absolute path can reach the index.
  const { wavUri, rawUri, ...rest } = recording;
  const entry: Recording = {
    id: recording.sessionId ? `clip-${recording.sessionId}` : `rec-${recording.createdAt}`,
    title:
      recording.title ??
      `Recording ${when.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`,
    ...rest,
    ...(rest.wavName || wavUri ? { wavName: rest.wavName ?? fileNameOf(wavUri!) } : {}),
    ...(rest.rawName || rawUri ? { rawName: rest.rawName ?? fileNameOf(rawUri!) } : {}),
  };
  devlog(
    "file",
    `recordings: added ${entry.id} (${entry.wavName ?? "no wav"}, ${Math.round((entry.bytes ?? 0) / 1024)} KB)`,
    entry.decodeError ? `decode failed: ${entry.decodeError}` : undefined,
  );
  list = [entry, ...list.filter((r) => r.id !== entry.id)].sort((a, b) => b.createdAt - a.createdAt);
  save();
  return entry;
}

export function updateRecording(id: string, patch: Partial<Omit<Recording, "id">>) {
  load();
  list = list.map((r) => (r.id === id ? { ...r, ...patch } : r));
  save();
}

/**
 * The audio is gone and no retry brings it back, so say why once and stop. It goes
 * into captureError too, because that is what the Record tab shows and what the
 * auto-capture pass skips on (capture.ts) — which is what ends the retry loop.
 */
export function markLost(id: string, reason: string) {
  devlog("err", `recording ${id} is lost`, reason);
  updateRecording(id, { lost: reason, captureError: reason, capturing: false });
}

export function renameRecording(id: string, title: string) {
  updateRecording(id, { title: title.trim() || "Untitled" });
}

export function deleteRecording(id: string) {
  load();
  const recording = list.find((r) => r.id === id);
  for (const file of [wavFile(recording), rawFile(recording)]) {
    if (!file) continue;
    try {
      // delete() throws on a file that isn't there, which after an update used to
      // be every one of them; check first so the list entry still goes away.
      if (file.exists) file.delete();
      else devlog("file", `nothing to delete at ${file.name}`, file.uri);
    } catch (err) {
      devlog("err", "couldn't delete a recording's audio", `${file.uri}\n${String(err)}`);
    }
  }
  list = list.filter((r) => r.id !== id);
  devlog("file", `recordings: deleted ${id}, ${list.length} left`);
  save();
}
