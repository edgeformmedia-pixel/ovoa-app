// Runs everything in test/ as *.test.ts.
//
//     npm test
//
// esbuild is already here for wrangler, so this needs no new dependency and no
// test framework: a test file is a script that prints its checks and exits
// non-zero if any failed. That is enough for the things worth testing here,
// which are pure functions with fiddly edge cases — local time across a DST
// change, mostly, which is exactly the kind of bug that ships unnoticed and
// then fires an alarm an hour late twice a year.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const testDir = join(root, "test");

const only = process.argv[2];
const files = readdirSync(testDir).filter((f) => f.endsWith(".test.ts") && (!only || f.includes(only)));
if (!files.length) {
  console.error(only ? `No test files matching "${only}"` : "No test files in test/");
  process.exit(1);
}

const out = mkdtempSync(join(tmpdir(), "ovoa-test-"));
let failed = 0;

try {
  for (const file of files) {
    const bundle = join(out, `${file.replace(/\.ts$/, "")}.mjs`);
    await esbuild.build({
      entryPoints: [join(testDir, file)],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: bundle,
      logLevel: "error",
    });
    console.log(`\n── ${file} ${"─".repeat(Math.max(0, 60 - file.length))}`);
    try {
      // Its own process, so one test file crashing doesn't take the rest down.
      execFileSync(process.execPath, [bundle], { stdio: "inherit" });
    } catch {
      failed++;
    }
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} test file(s) failed` : `\n${files.length} test file(s) passed`);
process.exit(failed ? 1 : 0);
