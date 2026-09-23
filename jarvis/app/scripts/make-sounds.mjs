// Renders OVOA's "Glass" sound set to assets/sounds/*.wav.
//
// The same tones as the Orb Studio page where the set was picked (2026-09-23):
// a sine at the note, a quieter one at 2.76x and a faint one at 5.4x (the
// uneven overtones are what make it sound like glass, not a beep), each with a
// quick strike and a half-second ring-out. Run with `node scripts/make-sounds.mjs`
// after changing a cue; the files are committed, so the app never builds them.
import { writeFileSync } from "node:fs";

const RATE = 44100;
const ROOT = 1046.5; // C6
const semi = (n) => ROOT * Math.pow(2, n / 12);

// [semitones from the root, start (s), loudness]
const CUES = {
  wake: [[0, 0], [7, 0.09]],
  sent: [[7, 0, 0.8], [0, 0.08, 0.7]],
  reply: [[4, 0, 0.7]],
  done: [[0, 0], [4, 0.07], [7, 0.14]],
  error: [[-2, 0, 0.9], [-8, 0.14, 0.9]],
  remind: [[12, 0], [7, 0.16], [12, 0.32]],
  created: [[0, 0], [4, 0.06], [7, 0.12], [12, 0.18], [16, 0.26, 0.6]],
  approve: [[0, 0], [9, 0.12]],
};

/** One partial: exponential strike to `peak`, then an exponential ring-out, like the studio's Web Audio envelope. */
function partial(buf, f, start, attack, decay, peak) {
  const from = Math.floor(start * RATE);
  const n = Math.floor((attack + decay) * RATE);
  const floor = 0.0001;
  for (let i = 0; i < n && from + i < buf.length; i++) {
    const t = i / RATE;
    const g = t < attack ? floor * Math.pow(peak / floor, t / attack) : peak * Math.pow(floor / peak, (t - attack) / decay);
    buf[from + i] += Math.sin(2 * Math.PI * f * (t + start)) * g;
  }
}

function glass(buf, f, t, v = 1) {
  partial(buf, f, t, 0.005, 0.55, 0.22 * v);
  partial(buf, f * 2.76, t, 0.003, 0.18, 0.05 * v);
  partial(buf, f * 5.4, t, 0.002, 0.07, 0.02 * v);
}

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(s * 32767))), i * 2));
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

for (const [name, notes] of Object.entries(CUES)) {
  const end = Math.max(...notes.map(([, at]) => at)) + 0.6;
  const buf = new Float32Array(Math.ceil(end * RATE));
  for (const [n, at, v] of notes) glass(buf, semi(n), at, v ?? 1);
  // The same loudness for every cue, well under full scale: these are cues, not alerts.
  const peak = buf.reduce((m, s) => Math.max(m, Math.abs(s)), 0);
  const out = buf.map((s) => (s / peak) * 0.5);
  // A 5 ms fade at the very end so nothing clicks.
  const fade = Math.floor(0.005 * RATE);
  for (let i = 0; i < fade; i++) out[out.length - 1 - i] *= i / fade;
  writeFileSync(new URL(`../assets/sounds/glass-${name}.wav`, import.meta.url), wav(out));
  console.log(`glass-${name}.wav  ${(end).toFixed(2)} s`);
}
