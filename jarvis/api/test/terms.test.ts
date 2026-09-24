// Whether the Terms of Service have been agreed to (terms.ts): the current
// wording counts, an older one or none doesn't, and the app is shown the Terms
// until it does.

import { TERMS_VERSION, termsAccepted, termsView } from "../src/terms";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${g}${ok ? "" : `  (wanted ${w})`}`);
}

eq("never agreed", termsAccepted({ terms_accepted_at: null, terms_version: null }), false);
eq("no row", termsAccepted(null), false);
eq("the current wording", termsAccepted({ terms_accepted_at: 5, terms_version: TERMS_VERSION }), true);
eq("an older wording asks again", termsAccepted({ terms_accepted_at: 5, terms_version: TERMS_VERSION - 1 }), false);
eq("what GET /me says", termsView({ terms_accepted_at: 5, terms_version: TERMS_VERSION }), {
  accepted: true,
  version: TERMS_VERSION,
  at: 5,
  current: TERMS_VERSION,
});

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
