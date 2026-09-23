// The phone's ear (app/modules/name-ear), its Swift side and its TypeScript
// side checked against each other from the source.
//
// Nothing on the Windows machine compiles Swift: the first build that does is
// a Codemagic TestFlight build, and a mismatch found there costs a release
// cycle. So this reads NameEarModule.swift and index.ts and checks that they
// promise each other the same things: the functions JavaScript calls, every
// state, cause and "after" the native side emits, the fields describe()
// returns, the options start() reads, and the iOS error codes its messages
// name. It also checks that the echo-cancelled input calls (iOS 18.2) only run
// behind an availability check, that the brackets balance, that a '!pri'
// refusal reads to lib/liveListen.ts as neither "off screen" nor a refusal for
// good (either would stop the app trying again), that start() on a halted ear
// restarts it rather than rebuilding it, and that the audio session is only
// ever turned off where JavaScript has said nothing is playing.
//
// Run by `npm test` from jarvis/api, so the app is found from the working
// directory (scripts/test.mjs bundles this file elsewhere first).

import { readFileSync } from "node:fs";
import { join } from "node:path";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${g}${ok ? "" : `  (wanted ${w})`}`);
}

const APP = join(process.cwd(), "..", "app");
const read = (...parts: string[]) => readFileSync(join(APP, ...parts), "utf8").replace(/\r\n/g, "\n");
const swift = read("modules", "name-ear", "ios", "src", "NameEarModule.swift");
const ts = read("modules", "name-ear", "index.ts");
const liveListen = read("src", "lib", "liveListen.ts");

const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();
const all = (re: RegExp, text: string) => [...text.matchAll(re)].map((m) => m[1]);

/** The text of `type Name = ... };` in index.ts, to the line that closes it. */
function typeBlock(name: string) {
  const start = ts.search(new RegExp(`\\btype ${name} =`));
  const end = ts.indexOf("\n};", start);
  return start < 0 || end < 0 ? "" : ts.slice(start, end);
}

/** The string literals of `name?: "a" | "b";` in a type block. */
function union(block: string, name: string) {
  const line = block.match(new RegExp(`\\n\\s+${name}\\??:\\s*([^;]+);`));
  return line ? sorted(all(/"([^"]+)"/g, line[1])) : [];
}

/** The Swift with its comments and string literals taken out. */
const swiftCode = swift
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*$/gm, "")
  .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');

// ---------- What JavaScript may call ----------

const nativeFns = sorted(all(/\b(?:Async)?Function\("(\w+)"\)/g, swift));
const declaredFns = sorted(all(/^ {2}(\w+)\??[(:<]/gm, typeBlock("NameEarNativeModule")));
// addListener comes with every Expo module; everything else must be defined natively.
eq(
  "every function index.ts declares is defined in Swift",
  declaredFns.filter((n) => n !== "addListener" && !nativeFns.includes(n)),
  [],
);
eq("restartEngine is defined natively", nativeFns.includes("restartEngine"), true);
eq("and index.ts exports it, undefined where the native side lacks it", /export const restartEngine =[\s\S]*?: undefined;/.test(ts), true);

// ---------- What the native side says ----------

const stateBlock = typeBlock("NameEarState");
eq(
  "the states Swift emits are the states index.ts types, no more and no fewer",
  sorted(all(/"state"\]?\s*[:=]\s*"(\w+)"/g, swift)),
  union(stateBlock, "state"),
);
eq("the causes of a stop on its own match", sorted(all(/\bhalt\("(\w+)"/g, swift)), union(stateBlock, "cause"));
eq("the \"after\" of a return to listening match", sorted(all(/emitListening\(after: "(\w+)"\)/g, swift)), union(stateBlock, "after"));

const describe = swift.slice(swift.indexOf("func describe()"), swift.indexOf("return out", swift.indexOf("func describe()")));
eq(
  "describe()'s fields are NameEarDescription's",
  sorted([...all(/^\s+"(\w+)":/gm, describe), ...all(/out\["(\w+)"\] =/g, describe)]),
  sorted(all(/^ {2}(\w+)\??:/gm, typeBlock("NameEarDescription"))),
);
// Only set when iOS threw, so it has to be optional on the JavaScript side.
eq("echoCancelError is optional in index.ts", /\n {2}echoCancelError\?: string;/.test(typeBlock("NameEarDescription")), true);

const startOptions = ts.match(/start\(options: \{([^}]+)\}\): Promise/)?.[1] ?? "";
eq("the options start() reads natively are the ones index.ts sends", sorted(all(/options\["(\w+)"\]/g, swift)), sorted(all(/(\w+)\??:/g, startOptions)));

// ---------- iOS's codes, and how the app reads the messages ----------

const fourCC = (code: string) => [...code].reduce((n, c) => n * 256 + c.charCodeAt(0), 0);
const constant = (name: string) => Number(swift.match(new RegExp(`static let ${name} = ([\\d_]+)`))?.[1].replace(/_/g, ""));
eq("insufficientPriority is '!pri'", constant("insufficientPriority"), fourCC("!pri"));
eq("cannotInterruptOthers is '!int'", constant("cannotInterruptOthers"), fourCC("!int"));
eq("'!pri' is the 561017449 the logs show", fourCC("!pri"), 561017449);
eq("activation is tried again at 200, 400 and 800 ms", swift.match(/for waitMs in \[([^\]]+)\]/)?.[1], "200, 400, 800");

/** The sentence explain() returns for `constantName`, with the code filled in the way iOS would. */
function message(constantName: string, code: number) {
  const text = swift.match(new RegExp(`ns\\.code == ${constantName} \\{\\s*return "([^"]+)"`))?.[1] ?? "";
  return text.replace("\\(ns.code)", String(code));
}
const pri = message("insufficientPriority", fourCC("!pri"));
const offScreen = message("cannotInterruptOthers", fourCC("!int"));
eq("the '!pri' message names it and its number", pri.includes("'!pri'") && pri.includes("561017449"), true);
eq("the '!int' message names its number (lib/foreground.ts matches on it)", offScreen.includes("560557684"), true);
// holdEar (lib/liveListen.ts) waits for the app on /off screen/i and gives up for the session on EAR_REFUSED.
eq("'!int' still reads as off screen", /off screen/i.test(offScreen), true);
eq("'!pri' doesn't read as off screen", /off screen/i.test(pri), false);
const refused = liveListen.match(/const EAR_REFUSED = \/(.+)\/(\w*);/);
if (refused) {
  eq("'!pri' doesn't read as refused for good", new RegExp(refused[1], refused[2]).test(pri), false);
} else {
  console.log("note: liveListen.ts has no EAR_REFUSED any more; the refused-for-good check is skipped");
}

// ---------- A halted ear, and the audio session ----------

// liveListen.ts holdEar calls start() whenever isRunning() is false, so a
// start() on an ear halted by a call has to restart its engine, not rebuild it:
// a rebuild asks for the model again, and loses the interruption watcher that
// brings the ear back when the call ends (review, 2026-09-23).
const startFn = swift.slice(swift.indexOf('AsyncFunction("start")'), swift.indexOf("}.runOnQueue(.main)", swift.indexOf('AsyncFunction("start")')));
eq("start() on a halted ear that had started restarts its engine", /guard current\.ready else[\s\S]*current\.restart \{/.test(startFn), true);
eq(
  "and keeps it when iOS refuses the session, rather than build a new one",
  /current\.restart \{[\s\S]*if NameEar\.refusedByIOS\(error\)[\s\S]*promise\.reject[\s\S]*return[\s\S]*startNew/.test(startFn),
  true,
);
const refusedFn = swift.slice(swift.indexOf("static func refusedByIOS"), swift.indexOf("\n  }\n", swift.indexOf("static func refusedByIOS")));
eq("refused by iOS means '!pri' or '!int'", ["insufficientPriority", "cannotInterruptOthers"].every((c) => refusedFn.includes(c)), true);

// Turning the session off stops every player in the app (a reply, the alarm's
// keep-awake loop), so it happens in one place only, when JavaScript allows it,
// once per launch.
eq("the session is turned off in one place only", (swiftCode.match(/setActive\(false/g) ?? []).length, 1);
const reactivateFn = swift.slice(swift.indexOf("private func reactivateForEchoCancel"), swift.indexOf("\n  }\n", swift.indexOf("private func reactivateForEchoCancel")));
eq("and that place is reactivateForEchoCancel", reactivateFn.includes("setActive(false)"), true);
eq("which does nothing unless JavaScript says nothing is playing", /\{\s*guard mayReactivate,/.test(reactivateFn), true);
eq("and does it once per launch", /echoReactivatedThisLaunch = true/.test(reactivateFn), true);
eq("only for a new ear: a restart doesn't turn the session off", /func restartEngine\(\)[\s\S]*?\n  \}/.exec(swift)?.[0].includes("reactivateForEchoCancel"), false);

// ---------- What only a compiler would catch ----------

// setPrefersEchoCancelledInput and its three properties are iOS 18.2; the app
// runs on 15.1 and up. Each use sits on, or just under, an 18.2 check.
const lines = swift.split("\n");
const unguarded = lines
  .map((line, i) => ({ line, i }))
  .filter(({ line }) => /EchoCancelledInput/.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line))
  .filter(({ i }) => {
    const back = lines.slice(Math.max(0, i - 3), i + 1).reverse();
    const check = back.find((l) => l.includes("#available("));
    return !check?.includes("#available(iOS 18.2, *)");
  })
  .map(({ i }) => i + 1);
eq("every echo-cancelled input call is behind #available(iOS 18.2, *)", unguarded, []);
eq("there are such calls to check", lines.filter((l) => /setPrefersEchoCancelledInput\(/.test(l)).length > 0, true);

for (const [open, close] of [["{", "}"], ["(", ")"], ["[", "]"]]) {
  const count = (c: string) => swiftCode.split(c).length - 1;
  eq(`the Swift's ${open} ${close} balance`, count(open) - count(close), 0);
}

// ---------- Result ----------

if (fails) {
  console.log(`\n${fails} check(s) failed`);
  process.exit(1);
}
console.log("\nall ear contract checks passed");
