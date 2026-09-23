// Deepgram is OVOA's voice and nothing else (2026-09-23). Speech is recognised
// on the iPhone (app lib/liveListen.ts, lib/onDeviceTranscribe.ts), so no code,
// on the server or in the app, may ask Deepgram to listen: not its listen
// endpoint over HTTP (a clip) or a WebSocket (the old live stream), and not
// its token grant, which only existed so the phone could open that stream.
// Synthesis (the speak endpoint) stays, and this checks that it is still found,
// so a scan that quietly read nothing can't pass.
//
// Run from jarvis/api like every test here (npm test), so the paths are
// relative to it.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(got)}${ok ? "" : `  (wanted ${JSON.stringify(want)})`}`);
}

/** Every .ts/.tsx/.swift file under `dir`, skipping installed packages. */
function sources(dir: string): string[] {
  const out: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx|mjs|js|swift)$/.test(name)) out.push(path);
  }
  return out;
}

const roots = ["src", "scripts", "../app/src", "../app/modules"];
const files = roots.flatMap(sources);

/** Code lines only: a comment may say what used to happen. */
const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line);

// A request to Deepgram names it (the host, or voice.ts's DEEPGRAM base URL)
// within a few lines of the path it asks for.
const NEAR = 3;
const LISTENS = /\/(v1\/)?listen\b|\/auth\/grant\b/;
const DEEPGRAM = /deepgram/i;

const offenders: string[] = [];
let speaks = 0;
for (const file of files) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    if (isComment(line)) return;
    if (/wss:\/\/api\.deepgram\.com/i.test(line)) offenders.push(`${file}:${i + 1} opens a Deepgram socket`);
    if (LISTENS.test(line)) {
      const around = lines.slice(Math.max(0, i - NEAR), i + NEAR + 1).filter((l) => !isComment(l)).join("\n");
      if (DEEPGRAM.test(around)) offenders.push(`${file}:${i + 1} ${line.trim().slice(0, 100)}`);
    }
    if (/\$\{DEEPGRAM\}\/speak/.test(line)) speaks++;
  });
}

eq("files scanned (server and app)", files.length > 50, true);
eq("the server still voices replies through Deepgram's speak endpoint", speaks > 0, true);
eq("nothing asks Deepgram to listen, or for a token to listen with", offenders, []);

// The two routes that used to are 410 now, and say so where they're defined.
const voice = readFileSync("src/voice.ts", "utf8");
eq("/voice/transcribe answers 410", /voice\.post\("\/voice\/transcribe", \(c\) => c\.json\(GONE, 410\)\)/.test(voice), true);
eq("/voice/token answers 410", /voice\.post\("\/voice\/token", \(c\) => c\.json\(GONE, 410\)\)/.test(voice), true);
eq("with a sentence an old build can show", /error: "Update OVOA from TestFlight"/.test(voice), true);

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
