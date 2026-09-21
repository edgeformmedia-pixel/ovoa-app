// Which Google account a request belongs to when the user didn't say. A wrong
// confident pick puts a dentist appointment on the work calendar; a timid one
// asks about everything. Close calls must fall back to the default.

import type { GoogleAccount } from "../src/google/oauth";
import { scoreAccounts, type AccountProfile } from "../src/google/routing";
import { atLocalTime } from "../src/time";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${got}${ok ? "" : `  (wanted ${want})`}`);
}

const NY = "America/New_York";
const account = (id: string, email: string, label: string | null, isDefault = false): GoogleAccount => ({
  id,
  email,
  name: null,
  label,
  isDefault,
  scopes: ["gmail", "calendar"],
  connectedAt: 0,
});
const personal = account("p", "tom@gmail.com", "Personal", true);
const work = account("w", "tom@acme.com", "Work");
const accounts = [personal, work];
const profiles: AccountProfile[] = [
  { account_id: "p", email_domain: "gmail.com", contact_domains: "[]", topics: '["gym","dinner","family"]', work_start: null, work_end: null, learned_at: 1 },
  { account_id: "w", email_domain: "acme.com", contact_domains: '["client.io"]', topics: '["standup","sprint","client"]', work_start: 9 * 60, work_end: 17 * 60, learned_at: 1 },
];
const pick = (args: Record<string, unknown>) => scoreAccounts(accounts, profiles, args, NY);

const tenAm = new Date(atLocalTime("2026-09-22", 10 * 60, NY)).toISOString();

eq("a colleague's address is work", pick({ title: "Sync", to: "jane@acme.com" }).account.id, "w");
eq("a client's address is work", pick({ title: "Kickoff", attendees: ["bob@client.io"], start: tenAm }).account.id, "w");
eq("and it's confident", pick({ title: "Kickoff", attendees: ["bob@client.io"] }).confident, true);
eq("sprint planning is work", pick({ title: "Sprint planning with the client", start: tenAm }).account.id, "w");
eq("dinner with family is personal", pick({ title: "Family dinner" }).account.id, "p");
eq("the dentist on a work-tagged account scores down", pick({ title: "Dentist", start: tenAm }).account.id, "p");
eq("nothing to go on: the default", pick({ title: "Thing" }).account.id, "p");
eq("and it says it isn't sure", pick({ title: "Thing" }).confident, false);
eq("a gmail.com address says nothing about work", pick({ title: "Hello", to: "friend@gmail.com" }).confident, false);

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
