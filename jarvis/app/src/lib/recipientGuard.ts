// Who a text is for, and whether the phone is sure of it.
//
// With "Send texts automatically" on, a text goes out through the Shortcuts app
// with no tap (phoneActions.ts). That is only safe when the phone is certain who
// it's for: "Hey, Ooa, Sth Thai Ecker boss text message saying that I'm on the
// 7th floor" went through a contact search that only half matched, and the text
// was sent with nobody looking ("Sent — told Ty's boss", messages 2026-09-23
// 22:00). So every recipient carries `exact`, and only exact ones go out alone.
//
// No app imports, so api/test/recipientGuard.test.ts can check it; phoneContacts.ts
// does the reading of Contacts and hands the matches here.

const digits = (s: string) => s.replace(/\D/g, "");
/**
 * A number without its country code or trunk prefix: the last 9 digits. The
 * last 10 kept one apart from itself when it was written both ways, as
 * Australian mobiles are: "+61 400 111 222" ends 1400111222 and "0400 111 222"
 * ends 0400111222.
 */
const phoneKey = (s: string) => digits(s).slice(-9);
export const samePhone = (a: string, b: string) => {
  const [x, y] = [phoneKey(a), phoneKey(b)];
  return !!x && !!y && x === y;
};
export const sameEmail = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A name as it's compared word for word: case, accents and punctuation don't count. */
const plain = (s: string | null | undefined) =>
  (s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export type Candidate = {
  fullName?: string | null;
  givenName?: string | null;
  familyName?: string | null;
  /** Found by how the name sounds, not how it's spelled (phoneContacts.ts matchContacts). */
  soundsLike: boolean;
  /** Its number or address of the kind wanted, if it has one. */
  value?: string | null;
};

export type Resolved = {
  value: string | null;
  label: string;
  /**
   * Certainly who was meant: a number or address given as one, or the one
   * contact whose name is word for word what was said; either way, not one a
   * recent contact search was unsure of. Anything else opens in Messages before
   * it goes.
   */
  exact: boolean;
};

/** What was said is this contact's name word for word: the whole of it, or the first name. */
export function namedExactly(said: string, c: Candidate) {
  const s = plain(said);
  const names = [c.fullName, c.givenName, [c.givenName, c.familyName].filter(Boolean).join(" ")];
  return !!s && names.some((n) => plain(n) === s);
}

/** "555-1234" or "sam@x.com" rather than a name. */
export const looksLikeValue = (input: string, kind: "phone" | "email") =>
  kind === "phone" ? digits(input).length >= 3 && !/[a-z]/i.test(input) : input.includes("@");

// --- What a search wasn't sure of --------------------------------------------
//
// The model reads phone_contacts_search's results and hands
// phone_message_compose either the number or the contact's real spelling, as
// phone.ts tells it to when a sound-alike fits. Both look certain on their own:
// a bare number is taken as meant, and the real spelling is that contact's name
// word for word. So without this a contact that only sounded like what was said
// came back looking exact and went out as if the user had named them. What the
// search wasn't sure of is kept by number and address, for as long as a turn and
// its follow-up could take.
//
// Only time clears a doubt. A later search the model is sure of doesn't: its
// query is the model's, written with the spelling the first search taught it,
// and says nothing about whose name the user said.

const unsure = new Map<string, number>();
const UNSURE_MS = 15 * 60_000;
const valueKey = (value: string) => (value.includes("@") ? value.trim().toLowerCase() : phoneKey(value));

/**
 * Notes a contact search's matches. Only the one word-for-word match of a
 * search that found exactly one is sure; the rest (found by sound, or one of
 * several with the name) are remembered as unsure.
 */
export function noteSearch(query: string, found: (Candidate & { values: (string | null | undefined)[] })[], now = Date.now()) {
  for (const [key, at] of unsure) if (now - at >= UNSURE_MS) unsure.delete(key);
  const exact = found.filter((c) => !c.soundsLike && namedExactly(query, c));
  for (const c of found) {
    if (exact.length === 1 && exact[0] === c) continue;
    for (const v of c.values) {
      const key = v ? valueKey(v) : "";
      if (key) unsure.set(key, now);
    }
  }
}

/** A recent contact search wasn't sure this number or address was who the user meant. */
function doubted(value: string, now: number) {
  const key = valueKey(value);
  const at = key ? unsure.get(key) : undefined;
  return at !== undefined && now - at < UNSURE_MS;
}
const DOUBTED = "a contact search wasn't sure this is who you meant";

/**
 * The contact a name means, from the matches for it: a word-for-word match
 * first, then the closest. Exact only when every other word-for-word match has
 * the same number — two cards for one person (iCloud and Gmail, say) with the
 * same number are still one person — and a recent search didn't doubt it.
 */
export function pickRecipient(input: string, found: Candidate[], kind: "phone" | "email", now = Date.now()): Resolved {
  const same = (a: string, b: string) => (kind === "phone" ? samePhone(a, b) : sameEmail(a, b));
  const said = plain(input);
  const exact = found
    .filter((c) => !c.soundsLike && namedExactly(input, c))
    // "Sam" the contact before "Sam Smith", when "Sam" was said.
    .sort((a, b) => Number(plain(b.fullName) === said) - Number(plain(a.fullName) === said));
  for (const c of [...exact, ...found]) {
    const value = c.value;
    if (!value) continue;
    const named = exact.includes(c);
    // A match with no number counts too: "Sam" the email-only contact is as much
    // who "Sam" means as "Sam Smith" is, and is picked over him when it has one.
    const rivals = exact.filter((e) => e !== c && !(e.value && same(e.value, value)));
    const why = !named
      ? `the closest match to "${input}"`
      : rivals.length
        ? `one of ${rivals.length + 1} contacts named "${input}"`
        : doubted(value, now)
          ? DOUBTED
          : "";
    return { value, label: `${c.fullName} (${value})${why && `, ${why}`}`, exact: !why };
  }
  return { value: null, label: `${input}: no ${kind === "phone" ? "number" : "email"} found in Contacts`, exact: false };
}

/** A number or address the assistant passed as it is: exact, unless a recent search wasn't sure of it. */
export function literalRecipient(input: string, now = Date.now()): Resolved {
  const unsureOf = doubted(input, now);
  return { value: input, label: unsureOf ? `${input} (${DOUBTED})` : input, exact: !unsureOf };
}
