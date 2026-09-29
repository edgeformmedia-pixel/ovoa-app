// Time zone from a phone number (phonezone.ts): what a texting guest is told the hour by.

import { zoneForPhone } from "../src/phonezone";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` (got ${String(got)}, wanted ${String(want)})`}`);
}

eq("New York", zoneForPhone("+12125550100"), "America/New_York");
eq("Los Angeles", zoneForPhone("+13105550100"), "America/Los_Angeles");
eq("Chicago", zoneForPhone("+17735550100"), "America/Chicago");
eq("Denver", zoneForPhone("+13035550100"), "America/Denver");
eq("Phoenix has no DST", zoneForPhone("+16025550100"), "America/Phoenix");
eq("Honolulu", zoneForPhone("+18085550100"), "Pacific/Honolulu");
eq("Toronto", zoneForPhone("+14165550100"), "America/New_York");
eq("a made-up 555 number can't be told", zoneForPhone("+15555550100"), null);
eq("Jakarta", zoneForPhone("+6281234567890"), "Asia/Jakarta");
eq("London", zoneForPhone("+447911123456"), "Europe/London");
eq("Nigeria beats the 2-digit 23x guess", zoneForPhone("+2348012345678"), "Africa/Lagos");
eq("Russia is +7", zoneForPhone("+79161234567"), "Europe/Moscow");
eq("nothing", zoneForPhone(null), null);
eq("junk", zoneForPhone("abc"), null);

console.log(fails ? `\n${fails} check(s) failed` : "\nall phone zone checks passed");
process.exit(fails ? 1 : 0);
