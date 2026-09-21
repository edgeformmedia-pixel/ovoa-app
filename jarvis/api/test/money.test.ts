// When the next payday and the next bill fall, and whether a purchase fits.
//
// Both halves ship bugs quietly. A monthly bill anchored on the 31st that
// clamps its way down to the 28th and stays there gets rent wrong for the rest
// of the year; a verdict that rounds "tight" up to "no" turns an assistant that
// helps into one that nags, which is the same thing as one that's been deleted.

import { addMonths, assess, headline, money, nextOccurrence, occurrencesBetween, toCents, type Picture } from "../src/money";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${got}${ok ? "" : `  (wanted ${want})`}`);
}

// ---------- Dates ----------

eq("the 31st clamps in February", addMonths("2026-01-31", 1), "2026-02-28");
eq("and comes back in March", addMonths("2026-01-31", 2), "2026-03-31");
eq("a leap February takes the 29th", addMonths("2028-01-31", 1), "2028-02-29");

eq("a monthly bill on the same day is today's", nextOccurrence("2026-09-03", "monthly", "2026-09-03"), "2026-09-03");
eq("and next month's once it's passed", nextOccurrence("2026-09-03", "monthly", "2026-09-04"), "2026-10-03");
eq("clamping isn't permanent", nextOccurrence("2026-01-31", "monthly", "2026-03-01"), "2026-03-31");
eq("months ahead still land on the day", nextOccurrence("2026-01-31", "monthly", "2026-12-01"), "2026-12-31");
eq("a year out", nextOccurrence("2026-03-15", "yearly", "2026-03-16"), "2027-03-15");

eq("a fortnightly payday", nextOccurrence("2026-09-04", "biweekly", "2026-09-05"), "2026-09-18");
eq("payday today is today", nextOccurrence("2026-09-04", "biweekly", "2026-09-04"), "2026-09-04");
eq("an anchor in the future is the next one", nextOccurrence("2026-09-18", "biweekly", "2026-09-01"), "2026-09-18");
eq("fortnightly across a clock change stays on the weekday", nextOccurrence("2026-10-23", "biweekly", "2026-11-01"), "2026-11-06");
eq("a weekly bill", nextOccurrence("2026-09-01", "weekly", "2026-09-20"), "2026-09-22");
eq("twice a month", nextOccurrence("2026-09-01", "semimonthly", "2026-09-02"), "2026-09-16");
eq("and round to the next month", nextOccurrence("2026-09-16", "semimonthly", "2026-09-17"), "2026-10-01");
eq("a one-off that's been is gone", nextOccurrence("2026-09-01", "once", "2026-09-02"), null);

eq("a weekly bill can land twice before payday", occurrencesBetween("2026-09-01", "weekly", "2026-09-20", "2026-10-02").length, 2);
eq("a monthly one lands once", occurrencesBetween("2026-09-25", "monthly", "2026-09-20", "2026-10-02").join(), "2026-09-25");
eq("nothing due inside the window is nothing", occurrencesBetween("2026-11-01", "monthly", "2026-09-20", "2026-10-02").length, 0);

// ---------- Money in and out ----------

eq("dollars to cents", toCents("$40.50"), 4050);
eq("spoken dollars", toCents("40 dollars"), 4000);
eq("a number is dollars", toCents(18), 1800);
eq("whole dollars lose the cents", money(32000), "$320");
eq("and keep them when there are some", money(1850), "$18.50");

// ---------- The verdict ----------

/** Thomas at the till: $320 in the account, paid Friday, electric due Thursday, a date on Saturday. */
const base: Picture = {
  currency: "USD",
  balanceCents: 32_000,
  savingsCents: 0,
  balanceAgeDays: 0,
  bufferCents: 5_000,
  today: "2026-09-21",
  nextPayDate: "2026-09-25",
  nextPayCents: 90_000,
  daysToPay: 4,
  payDelta: -0.1,
  lastPayCents: 81_000,
  usualPayCents: 90_000,
  billsDue: [{ id: "b1", name: "Electric", amountCents: 14_000, date: "2026-09-24", autopay: false }],
  unknownBills: [],
  plans: [{ id: "p1", text: "the date on Saturday", amountCents: 8_000, date: "2026-09-24" }],
  plansAfterPay: [],
  dailySpendCents: 1_000,
  spendKnown: true,
};

// 320 - 140 electric - 80 date - 40 four days of living - 50 cushion = 10 spare.
const cheap = assess(base, 1_000);
eq("a ten dollar thing fits", cheap.verdict, "yes");
eq("and leaves nothing much", cheap.afterCents, 0);
eq("nothing has to give", cheap.dropOneOf.length, 0);

const shoes = assess(base, 6_000);
eq("sixty dollar shoes are tight, not impossible", shoes.verdict, "tight");
eq("by fifty dollars", shoes.gapCents, 5_000);
eq("and the date is what would have to give", shoes.dropOneOf[0].text, "the date on Saturday");
eq("dropping it covers the gap", shoes.cantCover, false);

const boots = assess(base, 30_000);
eq("three hundred dollars is a no", boots.verdict, "no");
eq("and skipping the date wouldn't save it", boots.cantCover, true);

// The same shoes with the date already off the table: the eighty dollars is
// theirs again, so the answer changes from "tight" to "fine".
const nothingPlanned = assess({ ...base, plans: [] }, 6_000);
eq("with the date dropped the shoes just fit", nothingPlanned.verdict, "yes");
eq("and there's no trade to offer", nothingPlanned.dropOneOf.length, 0);
const noTrade = assess({ ...base, plans: [] }, 12_000);
eq("something dearer is still tight", noTrade.verdict, "tight");
eq("with nothing to suggest giving up", noTrade.dropOneOf.length, 0);

const say = headline(base, shoes);
eq("the sentence names the light paycheck", say.includes("10% under your usual"), true);
eq("names the bill", say.includes("Electric"), true);
eq("names the trade", say.includes("skipping the date on Saturday"), true);
eq("and hands the decision back", say.includes("your call"), true);
eq("a yes doesn't offer a trade", headline(base, cheap).includes("skipping"), false);
// A clause bolted onto a noun phrase reads as broken English out loud, which is
// the only place this sentence is ever heard.
eq("a yes still mentions the pinch, in its own sentence", headline(base, cheap).includes("Worth knowing: this cheque"), true);
const no = headline(base, boots);
eq("a no doesn't say 'and' twice", no.includes("short, and"), false);
eq("and still names why", no.includes("This cheque was 10% under your usual"), true);

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
