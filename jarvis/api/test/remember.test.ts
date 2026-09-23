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
  // A statement next to a request still counts.
  "Set an alarm for six. I have a flight to Denver tomorrow",
  "I'm vegan, find me somewhere to eat",
  "Hey OVOA, can you remember that my sister is Sarah?",
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

// Requests say "me" and "my" and tell OVOA nothing about the person: no memory pass (2026-09-23).
for (const said of [
  "Text Ty that I'm running late",
  "Remind me to call my mum at five",
  "Hey, Ovo, text my girlfriend Donya that I'm on the 7th floor",
  "Hey OVOA, what's on my calendar tomorrow?",
  "OVOA call my mom",
  "can you set an alarm for me at 6",
  "I need you to text my boss that I'm late",
  "Okay so wake me up at seven",
]) {
  eq(`a request: "${said}"`, mightBeAboutThem(said), false);
}
eq("their name for OVOA opens a request too", mightBeAboutThem("Max remind me to take my pills", "Max"), false);

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
  "I want you to remember that I'm vegan",
  "I need you to remember my sister is Sarah",
  "make sure you remember I'm vegan",
  "I'd like you to remember I'm vegan",
]) {
  eq(`asked to remember: "${said}"`, askedToRemember(said), true);
}
// Their name for OVOA leads in too, with or without the comma a transcript leaves out.
for (const said of ["Max remember that I'm vegan", "Hey Max remember I'm vegan", "Max, don't forget I work nights"]) {
  eq(`asked, by name: "${said}"`, askedToRemember(said, "Max"), true);
}
eq("but not without knowing the name", askedToRemember("Max remember that I'm vegan"), false);
eq("a name with a dot in it is only itself", askedToRemember("Dr Max remember I'm vegan", "Dr. Max"), false);

for (const said of [
  "I'm vegan",
  "do you remember what I said about the job?",
  "I can't remember where I put my keys",
  "I remember when we went to Rome",
  "remember what my sister's name is?",
  "what's the weather",
  "my sister is Sarah",
  "do you want me to remember the gate code?",
  "I need you to remember what I said about the job",
]) {
  eq(`not asked: "${said}"`, askedToRemember(said), false);
}

if (fails) {
  console.log(`\n${fails} failed`);
  process.exit(1);
}
console.log("\nall passed");
