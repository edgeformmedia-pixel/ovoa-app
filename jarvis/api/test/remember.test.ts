// Which exchanges earn a memory pass. A false "no" loses a fact until it comes
// up again; a false "yes" costs one model call. So the check leans towards yes,
// and these make sure the things people actually say about themselves get through.

import { mightBeAboutThem } from "../src/remember";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${got}${ok ? "" : `  (wanted ${want})`}`);
}

for (const said of [
  "I'm vegan",
  "I’m allergic to peanuts",
  "My sister is Sarah",
  "we moved to Denver last month",
  "Call me Tom",
  "remember that the gate code is 4412",
  "forget what I said about the job",
  "Text Ty that I'm running late",
]) {
  eq(`about them: "${said}"`, mightBeAboutThem(said), true);
}

for (const said of [
  "set an alarm for seven",
  "what's the weather",
  "stop",
  "who won the game last night",
  "how long to boil an egg",
]) {
  eq(`not about them: "${said}"`, mightBeAboutThem(said), false);
}

if (fails) {
  console.log(`\n${fails} failed`);
  process.exit(1);
}
console.log("\nall passed");
