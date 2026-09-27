// OVOA's contact card (contactcard.ts): the name, the logo and the number the
// card carries, and that its lines are folded the way vCard asks.

import { contactCard } from "../src/contactcard";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${got}${ok ? "" : `  (wanted ${want})`}`);
}

const card = contactCard("+15551234567");
eq("starts as a vCard 3.0", card.startsWith("BEGIN:VCARD\r\nVERSION:3.0\r\n"), true);
eq("named OVOA", card.includes("\r\nFN:OVOA\r\n"), true);
eq("carries the number", card.includes("TEL;TYPE=CELL,VOICE,pref:+15551234567\r\n"), true);
eq("carries the logo", card.includes("PHOTO;ENCODING=b;TYPE=PNG:iVBOR"), true);
eq("ends as a vCard", card.endsWith("END:VCARD\r\n"), true);
eq("every line is 75 characters or fewer", card.split("\r\n").every((l) => l.length <= 75), true);
eq("without a number, no TEL line", contactCard(null).includes("TEL"), false);

if (fails) process.exit(1);
