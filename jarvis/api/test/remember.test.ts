// Which exchanges earn a memory pass. A false "no" loses a fact until it comes
// up again; a false "yes" costs one model call. So the check leans towards yes,
// and these make sure the things people actually say about themselves get through.

import { askedToRemember, mightBeAboutThem } from "../src/remember";

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

// Which memories are kept past 14 days: only what they asked OVOA to remember.
for (const said of [
  "Remember that I'm vegan",
  "remember my sister is Sarah",
  "Please don't forget I'm allergic to nuts",
  "Hey OVOA, remember I work nights",
  "Can you remember that we moved to Denver?",
  "keep in mind my knee is bad",
  "OK so remember: I hate cilantro",
  "I moved last month. Remember that.",
]) {
  eq(`asked to remember: "${said}"`, askedToRemember(said), true);
}

for (const said of [
  "I'm vegan",
  "do you remember what I said about the job?",
  "I can't remember where I put my keys",
  "I remember when we went to Rome",
  "remember what my sister's name is?",
  "what's the weather",
  "my sister is Sarah",
]) {
  eq(`not asked: "${said}"`, askedToRemember(said), false);
}

if (fails) {
  console.log(`\n${fails} failed`);
  process.exit(1);
}
console.log("\nall passed");
