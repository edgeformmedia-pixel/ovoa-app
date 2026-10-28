// The Pebble Index 01's webhook (ring.ts): its key, its form, and the same
// recording delivered twice. INDEX_WEBHOOK_API.md, version 1.

import { noteKey, ringKeyOf, ringNoteOf } from "../src/ring";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const g = typeof got === "object" ? JSON.stringify(got) : got;
  const w = typeof want === "object" ? JSON.stringify(want) : want;
  const ok = g === w;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${g}${ok ? "" : `  (wanted ${w})`}`);
}

const key = "a".repeat(64);
eq("a bearer key", ringKeyOf(new Headers({ authorization: `Bearer ${key}` })), key);
eq("in capitals too", ringKeyOf(new Headers({ authorization: `bearer ${key.toUpperCase()}` })), key);
eq("the app's older header", ringKeyOf(new Headers({ "x-widget-token": key })), key);
eq("no header", ringKeyOf(new Headers()), null);
eq("not a key of ours", ringKeyOf(new Headers({ authorization: "Bearer hunter2" })), null);

{
  const form = new FormData();
  form.set("transcription", "  Remind me to call Sam after practice\r\n");
  form.set("recordedAt", "1761650000123");
  form.set("client", "ring");
  form.set("audio", new Blob([new Uint8Array(10)], { type: "audio/mp4" }), "abc.m4a");
  const note = ringNoteOf(form, new Headers({ "x-index-trigger": "single-click-hold" }));
  eq("its words", note.words, "Remind me to call Sam after practice");
  eq("when", note.recordedAt, 1761650000123);
  eq("the audio came", note.audio?.size, 10);
  eq("not a test", note.test, false);
  eq("which gesture", note.trigger, "single-click-hold");
}

{
  const form = new FormData();
  form.set("transcription", "This is a test");
  form.set("test", "true");
  eq("a test event, by its field", ringNoteOf(form, new Headers()).test, true);
  eq("or its header", ringNoteOf(new FormData(), new Headers({ "x-index-test": "true" })).test, true);
}

{
  const form = new FormData();
  form.set("recordedAt", "soon");
  const note = ringNoteOf(form, new Headers());
  eq("recording only, no words", note.words, null);
  eq("a bad time is none", note.recordedAt, null);
}

const a = await noteKey("u1", { recordedAt: 1, words: "hi" });
eq("the same recording twice is one", a, await noteKey("u1", { recordedAt: 1, words: "hi" }));
eq("another is another", a === (await noteKey("u1", { recordedAt: 2, words: "hi" })), false);
eq("and someone else's is theirs", a === (await noteKey("u2", { recordedAt: 1, words: "hi" })), false);

if (fails) {
  console.log(`\n${fails} failed`);
  process.exit(1);
}
