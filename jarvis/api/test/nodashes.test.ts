// No dashes in what OVOA says (the owner's rule): an em dash or en dash in a
// string or template literal of any file the overnight branch added or changed
// fails this test. Comments are fine. The model is told the same in its prompt
// and noDashes() cleans what it writes; this catches what's written by hand.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(got)}${ok ? "" : `  (wanted ${JSON.stringify(want)})`}`);
}

/** The string and template literals in TypeScript source, with their line numbers. Comments skipped. Pure. */
export function literals(src: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === "\n") {
      line++;
      i++;
    } else if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") line++;
        i++;
      }
      i += 2;
    } else if (c === '"' || c === "'" || c === "`") {
      const start = line;
      let text = "";
      i++;
      while (i < n && src[i] !== c) {
        if (src[i] === "\\") {
          text += src[i]! + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        if (src[i] === "\n") line++;
        text += src[i];
        i++;
      }
      i++;
      out.push({ line: start, text });
    } else {
      i++;
    }
  }
  return out;
}

const DASH = /[–—]/;

eq("finds a dash in a string", literals('const a = "one — two"; // fine — here').filter((l) => DASH.test(l.text)).length, 1);
eq("not in a comment", literals("/* a — b */ const x = 'ok';").filter((l) => DASH.test(l.text)).length, 0);
eq("templates too", literals("const t = `a – ${b}`;").filter((l) => DASH.test(l.text)).length, 1);

/** The lines this branch added, per file (paths as seen from jarvis/api), from git. */
function addedLines(): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  let diff = "";
  try {
    diff = execFileSync("git", ["diff", "-U0", "16c2deb", "--", "src", "../app/src"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return out;
  }
  let file = "";
  for (const line of diff.split("\n")) {
    const f = /^\+\+\+ b\/(.+)$/.exec(line);
    if (f) {
      file = f[1]!.replace(/^jarvis\/api\//, "").replace(/^jarvis\/app\//, "../app/");
      if (/\.(ts|tsx)$/.test(file)) out.set(file, new Set());
      else file = "";
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h && file) {
      const from = Number(h[1]);
      const count = h[2] === undefined ? 1 : Number(h[2]);
      for (let i = 0; i < count; i++) out.get(file)!.add(from + i);
    }
  }
  return out;
}

// Main's own copy (the app has "—" as an empty value in places) is the owner's to change: only what this branch wrote.
const added = addedLines();
// Without the history (a shallow clone), there's nothing to compare against: skipped, not failed.
if (!added.size) console.log("skip no git history to compare with 16c2deb");
else eq("the branch's changes were found", added.size > 10, true);
const found: string[] = [];
for (const [file, lines] of added) {
  if (!existsSync(file)) continue;
  for (const l of literals(readFileSync(file, "utf8"))) {
    if (lines.has(l.line) && DASH.test(l.text)) found.push(`${file}:${l.line} ${l.text.slice(0, 80)}`);
  }
}
eq("no dashes in the strings it added", found, []);

console.log(fails ? `\n${fails} failed` : "\nall passed");
if (fails) process.exit(1);
