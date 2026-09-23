// Who a text goes to when nobody taps Send (app/src/lib/recipientGuard.ts).
//
// With "Send texts automatically" on, a recipient marked exact gets the text
// through the Shortcuts app with no tap; anyone else gets the Messages sheet.
// "Hey, Ooa, Sth Thai Ecker boss text message…" went out to a half match with
// nobody looking (messages, 2026-09-23 22:00), so this is the line that decides
// whether a text can go to the wrong person, and it is checked here.

import { literalRecipient, looksLikeValue, namedExactly, noteSearch, pickRecipient, type Candidate } from "../../app/src/lib/recipientGuard";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(got)}${ok ? "" : `  (wanted ${JSON.stringify(want)})`}`);
}

const contact = (fullName: string, value: string | null, soundsLike = false): Candidate => {
  const [givenName, ...rest] = fullName.split(" ");
  return { fullName, givenName, familyName: rest.join(" ") || null, soundsLike, value };
};

// ---------- Word for word, and only one ----------

const donya = pickRecipient("Donya", [contact("Donya Karimi", "+61 412 000 111")], "phone");
eq("the first name of the only contact with it is exact", donya.exact, true);
eq("and the label is just who and where", donya.label, "Donya Karimi (+61 412 000 111)");

eq("the whole name is exact", pickRecipient("donya karimi", [contact("Donya Karimi", "0412000111")], "phone").exact, true);
eq("case, accents and punctuation don't count", namedExactly("zoe o'neil", contact("Zoë O’Neil", null)), true);
eq("but the letters do", namedExactly("Zoe Oneal", contact("Zoë O’Neil", null)), false);

// ---------- Anything less opens the Messages sheet ----------

const bySound = pickRecipient("Ty Ecker", [contact("Tigh Eckart", "+61 400 111 222", true)], "phone");
eq("a contact found by sound is not exact", bySound.exact, false);
eq("and the card says why", bySound.label, 'Tigh Eckart (+61 400 111 222), the closest match to "Ty Ecker"');

const prefix = pickRecipient("Sam", [contact("Samantha Lee", "0400 000 001")], "phone");
eq("a longer name that starts the same is not exact", prefix.exact, false);

const twoSams = pickRecipient("Sam", [contact("Sam Smith", "0400 000 001"), contact("Sam Jones", "0400 000 002")], "phone");
eq("one of two contacts with the name is not exact", twoSams.exact, false);
eq("and the card says there are two", twoSams.label.endsWith('one of 2 contacts named "Sam"'), true);

const sameSam = pickRecipient("Sam Smith", [contact("Sam Smith", "+61 400 000 001"), contact("Sam Smith", "0400 000 001")], "phone");
eq("two cards for one person with one number are still one person", sameSam.exact, true);

// "Sam" the email-only card is who "Sam" means as much as Sam Smith is.
const noNumberSam = pickRecipient("Sam", [{ ...contact("Sam", null), familyName: null }, contact("Sam Smith", "0400 000 001")], "phone");
eq("a word-for-word match with no number still makes it one of two", noNumberSam.exact, false);
eq("and the card says there are two", noNumberSam.label, 'Sam Smith (0400 000 001), one of 2 contacts named "Sam"');

const onlyOther = pickRecipient("Sam", [contact("Sam", null), contact("Samuel Park", "0400 000 003")], "phone");
eq("when the word-for-word match has no number, the closest one isn't exact", onlyOther.exact, false);
eq("but it is still offered", onlyOther.value, "0400 000 003");

const nobody = pickRecipient("Nobody", [], "phone");
eq("no match: no value", nobody.value, null);
eq("and not exact", nobody.exact, false);

const fullFirst = pickRecipient("Sam", [contact("Sam Smith", "0400 000 001"), { ...contact("Sam", "0400 000 009"), givenName: "Sam", familyName: null }], "phone");
eq("the contact named just 'Sam' is the one picked for 'Sam'", fullFirst.value, "0400 000 009");

// ---------- A number is taken as meant, unless a search doubted it ----------

eq("a number looks like a number", looksLikeValue("0412 000 111", "phone"), true);
eq("a name doesn't", looksLikeValue("Donya", "phone"), false);
eq("an address looks like an address", looksLikeValue("sam@example.com", "email"), true);

const t0 = 1_790_000_000_000;
eq("a number nobody searched for is exact", literalRecipient("+61 499 999 999", t0).exact, true);

// The model searched "Ty Ecker", got a contact that only sounded like it, and passed its number on.
noteSearch("Ty Ecker", [{ ...contact("Tigh Eckart", null, true), values: ["+61 400 111 222"] }], t0);
eq("that number, however it's written, is not exact", literalRecipient("0400 111 222", t0 + 60_000).exact, false);
eq("and the card says so", literalRecipient("0400 111 222", t0 + 60_000).label.includes("wasn't sure"), true);

// Or passed the contact's real spelling, as phone.ts tells it to when a sound-alike fits.
const realName = pickRecipient("Tigh Eckart", [contact("Tigh Eckart", "+61 400 111 222")], "phone", t0 + 60_000);
eq("the real spelling of a sound-alike is not exact either", realName.exact, false);
eq("and the card says why", realName.label, "Tigh Eckart (+61 400 111 222), a contact search wasn't sure this is who you meant");

// Or looked them up again by that spelling, a search now sure of them. Its query
// is the model's, not what the user said, so the doubt stands.
noteSearch("Tigh Eckart", [{ ...contact("Tigh Eckart", null), values: ["+61 400 111 222"] }], t0 + 2 * 60_000);
eq("a sure search by the spelling it learned doesn't clear the number", literalRecipient("+61 400 111 222", t0 + 3 * 60_000).exact, false);
eq("nor the name", pickRecipient("Tigh Eckart", [contact("Tigh Eckart", "+61 400 111 222")], "phone", t0 + 3 * 60_000).exact, false);

eq("fifteen minutes later it's a number like any other", literalRecipient("0400 111 222", t0 + 16 * 60_000).exact, true);
eq("and the name is exact again", pickRecipient("Tigh Eckart", [contact("Tigh Eckart", "+61 400 111 222")], "phone", t0 + 16 * 60_000).exact, true);

// Two with the name: whichever number the model passes on, it chose, not the user.
const t1 = t0 + 60 * 60_000;
noteSearch("Sam", [
  { ...contact("Sam Smith", null), values: ["0400 000 001"] },
  { ...contact("Sam Jones", null), values: ["0400 000 002", "sam.jones@example.com"] },
], t1);
eq("a number from a search that found two is not exact", literalRecipient("0400 000 002", t1 + 1000).exact, false);
eq("nor an address", literalRecipient("SAM.JONES@example.com", t1 + 1000).exact, false);
eq("nor the full name the model picked", pickRecipient("Sam Smith", [contact("Sam Smith", "0400 000 001")], "phone", t1 + 1000).exact, false);
eq("a number the search never showed is still exact", literalRecipient("0400 000 003", t1 + 1000).exact, true);

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
