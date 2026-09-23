import { Contact, ContactField, requestPermissionsAsync } from "expo-contacts";
import { Platform } from "react-native";
import { literalRecipient, looksLikeValue, noteSearch, pickRecipient, sameEmail, samePhone, type Resolved } from "./recipientGuard";
import { nameScore, SOUNDS_LIKE_THRESHOLD } from "./soundsLike";

/** The iPhone's Contacts app: search, add, edit, and turning names into numbers or emails. */

export type CreateArgs = {
  firstName: string;
  lastName?: string;
  company?: string;
  jobTitle?: string;
  phones: string[];
  emails: string[];
};
export type UpdateArgs = Omit<CreateArgs, "firstName" | "phones" | "emails"> & {
  contactName: string;
  firstName?: string;
  addPhones: string[];
  removePhones: string[];
  addEmails: string[];
  removeEmails: string[];
};

export type ContactMatch = { id: string; name: string; detail: string };

const FIELDS = [ContactField.FULL_NAME, ContactField.COMPANY, ContactField.PHONES, ContactField.EMAILS] as const;
const SEARCH_FIELDS = [...FIELDS, ContactField.JOB_TITLE, ContactField.BIRTHDAY] as const;

const NAME_PARTS = [
  ContactField.GIVEN_NAME,
  ContactField.FAMILY_NAME,
  ContactField.PHONETIC_GIVEN_NAME,
  ContactField.PHONETIC_FAMILY_NAME,
] as const;

type Named = {
  id: string;
  fullName?: string | null;
  givenName?: string | null;
  familyName?: string | null;
  phoneticGivenName?: string | null;
  phoneticFamilyName?: string | null;
};

const scoreOf = (query: string, c: Named) =>
  nameScore(query, [c.fullName, c.givenName, c.familyName, c.phoneticGivenName, c.phoneticFamilyName]);

/**
 * Contacts matching a name, even when it's spelled the way it sounds. Voice
 * transcription writes "Tigh Eckart" as "Ty Eckard", which the phone's own
 * search can't find, so if nothing close comes back we compare every contact
 * by sound. `soundsLike` marks contacts found that way.
 */
type Details<T extends readonly ContactField[]> = Awaited<ReturnType<typeof Contact.getAllDetails<T>>>[number];
type Match<T extends readonly ContactField[]> = Details<T> & { id: string; soundsLike: boolean };

async function matchContacts<T extends readonly ContactField[]>(
  query: string,
  fields: T,
  limit: number,
): Promise<Match<T>[]> {
  // Name parts ride along for scoring; callers only read the fields they asked for.
  const all = [...fields, ...NAME_PARTS] as unknown as T;
  const named = (c: Details<T>) => c as unknown as Named;
  const tag = (c: Details<T>, soundsLike: boolean) => ({ ...c, id: named(c).id, soundsLike });

  const exact = await Contact.getAllDetails(all, { name: query, limit });
  if (exact.some((c) => scoreOf(query, named(c)) >= 0.9)) return exact.map((c) => tag(c, false));

  const everyone = await Contact.getAllDetails(all);
  const close = everyone
    .map((c) => ({ c, score: scoreOf(query, named(c)) }))
    .filter((x) => x.score >= SOUNDS_LIKE_THRESHOLD && !exact.some((e) => named(e).id === named(x.c).id))
    .sort((a, b) => b.score - a.score)
    .map((x) => tag(x.c, true));
  return [...exact.map((c) => tag(c, false)), ...close].slice(0, limit);
}

async function ensureAccess() {
  if (Platform.OS === "web") throw new Error("Contacts only work in the iPhone app.");
  const { granted } = await requestPermissionsAsync();
  if (!granted) throw new Error("OVOA doesn't have access to Contacts. Allow it in iPhone Settings → OVOA.");
}

/** Contacts on the phone matching the name the assistant was given. */
export async function findContacts(name: string): Promise<ContactMatch[]> {
  await ensureAccess();
  const found = await matchContacts(name, FIELDS, 20);
  return found.map((c) => ({
    id: c.id,
    name: c.fullName || "(no name)",
    detail: [c.company, c.phones?.[0]?.number, c.emails?.[0]?.address].filter(Boolean).join(" · "),
  }));
}

/** Full details for the assistant's phone_contacts_search lookup. */
export async function searchContacts({ query }: { query: string }) {
  await ensureAccess();
  const found = await matchContacts(query, SEARCH_FIELDS, 10);
  // The model passes on a number from here, or the contact's real spelling, and
  // either looks certain on its own; so the numbers and addresses of the matches
  // this wasn't sure of are remembered as unsure (recipientGuard.ts).
  noteSearch(
    query,
    found.map((c) => ({
      ...(c as unknown as Named),
      soundsLike: c.soundsLike,
      values: [...(c.phones ?? []).map((p) => p.number), ...(c.emails ?? []).map((e) => e.address)],
    })),
  );
  return found.map((c) => ({
    name: c.fullName,
    // Found by sound, not spelling: the user probably means this person.
    ...(c.soundsLike && { note: `spelled differently from "${query}"; sounds alike` }),
    company: c.company || undefined,
    jobTitle: c.jobTitle || undefined,
    phones: c.phones?.map((p) => `${p.label ? `${p.label}: ` : ""}${p.number}`),
    emails: c.emails?.map((e) => `${e.label ? `${e.label}: ` : ""}${e.address}`),
    birthday: c.birthday
      ? [c.birthday.year, c.birthday.month, c.birthday.day].filter((x) => x != null).join("-")
      : undefined,
  }));
}

/** `exact`: certainly who was meant, so a text to them may go out with no tap (recipientGuard.ts). */
export type Recipient = Resolved & { input: string };

/**
 * Turns what the assistant passed ("Sarah", "555-1234", "sam@x.com") into a
 * number or email. Names use the first matching contact that has one, a
 * word-for-word match first.
 */
export async function resolveRecipient(input: string, kind: "phone" | "email"): Promise<Recipient> {
  if (looksLikeValue(input, kind)) return { input, ...literalRecipient(input) };

  await ensureAccess();
  // More than a search shows: "only one contact has this name" means nothing if
  // the second one was past the limit.
  const found = await matchContacts(input, FIELDS, 50);
  const candidates = found.map((c) => {
    const phones = c.phones ?? [];
    const value =
      kind === "phone"
        ? (phones.find((p) => p.label === "mobile" || p.label === "iPhone") ?? phones[0])?.number
        : c.emails?.[0]?.address;
    return { ...(c as unknown as Named), soundsLike: c.soundsLike, value };
  });
  return { input, ...pickRecipient(input, candidates, kind) };
}

export async function createContact(a: CreateArgs) {
  await ensureAccess();
  await Contact.create({
    givenName: a.firstName,
    familyName: a.lastName,
    company: a.company,
    jobTitle: a.jobTitle,
    phones: a.phones.map((number) => ({ label: "mobile", number })),
    emails: a.emails.map((address) => ({ label: "home", address })),
  });
  return `added ${[a.firstName, a.lastName].filter(Boolean).join(" ")} to your contacts`;
}

export async function updateContact(a: UpdateArgs, contactId: string | undefined) {
  if (!contactId) throw new Error("Pick which contact to edit.");
  await ensureAccess();
  const contact = new Contact(contactId);

  await contact.patch({
    givenName: a.firstName,
    familyName: a.lastName,
    company: a.company,
    jobTitle: a.jobTitle,
  });

  const phones = await contact.getPhones();
  for (const p of phones) {
    if (a.removePhones.some((r) => samePhone(r, p.number ?? ""))) await contact.deletePhone(p);
  }
  for (const number of a.addPhones) {
    if (!phones.some((p) => samePhone(number, p.number ?? ""))) await contact.addPhone({ label: "mobile", number });
  }

  const emails = await contact.getEmails();
  for (const e of emails) {
    if (a.removeEmails.some((r) => sameEmail(r, e.address ?? ""))) await contact.deleteEmail(e);
  }
  for (const address of a.addEmails) {
    if (!emails.some((e) => sameEmail(address, e.address ?? ""))) await contact.addEmail({ label: "home", address });
  }

  return `updated ${(await contact.getFullName()) || a.contactName}`;
}
