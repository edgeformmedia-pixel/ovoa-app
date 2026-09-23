// The phone's logger, checked from here.
//
// It lives in the app (jarvis/app/src/lib/devlog.ts), which has no test runner
// of its own; esbuild bundles it happily from here and nothing in it needs a
// device. It is tested because of what it is protecting against: one 3-second
// retry loop wrote 7,150 identical rows into device_logs in a day and the phone
// sent 90,103 rows in 24 hours. If the collapsing quietly stops working, the
// next flood looks exactly like the last one and nothing says otherwise.

import { breadcrumbs, clearDevLog, devlog, devlogRepeat, devlogSettled, onDevLog, sweepLog, type LogEntry } from "../../app/src/lib/devlog";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${got}${ok ? "" : `  (wanted ${want})`}`);
}

/** Everything that reached the uploader while `work` ran. */
function collect(work: () => void) {
  const rows: LogEntry[] = [];
  clearDevLog();
  const off = onDevLog((e) => rows.push(e));
  try {
    work();
  } finally {
    off();
  }
  return rows;
}

const total = (rows: LogEntry[]) => rows.reduce((n, r) => n + r.count, 0);

// ---------- A loop costs a handful of rows, not thousands ----------

const loop = collect(() => {
  for (let i = 0; i < 500; i++) devlog("err", "mic restart failed", "Error: Session activation failed");
  // Nothing has written for a while: close the group and bank the rest.
  sweepLog(Date.now() + 60_000);
});
eq("500 identical lines are a handful of rows", loop.length <= 5, true);
eq("and every one of them is still counted", total(loop), 500);
eq("the first one goes out in full", loop[0].text, "mic restart failed");
eq("the last one says how many there were", loop[loop.length - 1].text.startsWith("× "), true);

// ---------- The numbers inside a line don't stop it collapsing ----------

const changing = collect(() => {
  for (let i = 0; i < 40; i++) devlog("voice", `no audio from the mic for ${3000 + i} ms; restarting it`);
  sweepLog(Date.now() + 60_000);
});
eq("a changing millisecond count is still one loop", changing.length <= 3, true);
eq("and the count is right", total(changing), 40);

// ---------- Two different failures stay two failures ----------

const apart = collect(() => {
  for (let i = 0; i < 5; i++) {
    devlog("err", "mic restart failed", "Error: Session activation failed");
    devlog("err", "mic restart failed", "Error: The operation couldn't be completed. (OSStatus error 560557684.)");
  }
  sweepLog(Date.now() + 60_000);
});
eq("a different cause is a different row", apart.filter((r) => r.count === 1).length >= 2, true);
eq("both are counted in full", total(apart), 10);

// ---------- A line that must never be folded away ----------

const uncollapsed = collect(() => {
  for (let i = 0; i < 4; i++) devlog("err", "FATAL uncaught JS error: boom", "stack", { level: "fatal", collapse: false });
});
eq("collapse: false means every one goes", uncollapsed.length, 4);
eq("and a fatal is a fatal", uncollapsed[0].level, "fatal");

// ---------- Every turn's timing is its own row ----------
//
// "× 5 more in 2 min — phone turn 10.2 s after you stopped speaking" kept one
// breakdown out of six (device_logs, 2026-09-23). A turn line is never folded.

const turns = collect(() => {
  for (let i = 0; i < 6; i++) devlog("perf", `phone turn ${10 + i}.2 s after you stopped speaking`, "stopped talking 0 ms · model answers 9.2 s");
  for (let i = 0; i < 6; i++) devlog("res", `first sentence after ${4000 + i} ms`, "40 chars", { collapse: false });
  sweepLog(Date.now() + 60_000);
});
eq("six perf lines are six rows", turns.filter((r) => r.kind === "perf").length, 6);
eq("each with its own number", turns.filter((r) => r.kind === "perf")[5].text, "phone turn 15.2 s after you stopped speaking");
eq("and no '× more' row after them", turns.some((r) => r.text.startsWith("× ")), false);
eq("a res line marked collapse: false is its own row too", turns.filter((r) => r.kind === "res").length, 6);

// ---------- devlogRepeat / devlogSettled ----------

const keyed = collect(() => {
  for (let i = 0; i < 20; i++) devlogRepeat("mic restart", "err", `mic restart failed (attempt ${i})`, "why");
  // It came right: the count goes out now rather than waiting for a sweep.
  devlogSettled("mic restart");
});
eq("a keyed repeat collapses even when the words change", keyed.length <= 3, true);
eq("settling banks the rest at once", total(keyed), 20);

// ---------- Nothing that could sign anyone in ----------

const secrets = collect(() => {
  devlog("req", "POST /auth/login", '{"email":"bob@example.com","password":"hunter2hunter2"}');
  devlog("err", "401 GET /me", "authorization: Bearer abc123def456ghi789");
});
eq("the password is gone", secrets[0].detail?.includes("hunter2hunter2"), false);
eq("the address is shortened", secrets[0].detail?.includes("b***@example.com"), true);
eq("the token is gone", secrets[1].detail?.includes("abc123def456ghi789"), false);

// ---------- An error arrives with what led to it ----------

const crumbs = collect(() => {
  devlog("voice", "listening live");
  devlog("req", "POST /chat");
  devlog("err", "couldn't get a reply", "No answer from the server after 60 s");
});
eq("the error carries the events before it", crumbs[2].detail?.includes("events before this"), true);
eq("including the request", crumbs[2].detail?.includes("POST /chat"), true);
eq("and the breadcrumb ring has them all", breadcrumbs().length >= 3, true);

// ---------- The ceiling announces itself ----------

const flood = collect(() => {
  // 400 lines that can't collapse into each other, in well under a minute.
  for (let i = 0; i < 400; i++) devlog("log", `a different line every time ${i}`, undefined, { collapse: false });
  // A minute later the uploader sweeps, and the tally goes out — even though
  // nothing has been logged since. A flood that stops must still own up to
  // what it dropped, or the truncation is silent after all. (Well past a
  // minute: the sweeps above already pushed the window's start into the future.)
  sweepLog(Date.now() + 10 * 60_000);
});
const tally = flood.find((r) => r.text.includes("lines dropped"));
eq("the flood is cut off", flood.length < 400, true);
eq("and nothing is dropped in silence", !!tally, true);
eq("the tally is exactly what didn't go", tally?.count, 400 - (flood.length - 1));

// ---------- Sequence numbers ----------

const seqs = collect(() => {
  devlog("log", "one");
  devlog("log", "two");
  devlog("log", "three");
});
eq("every row is numbered in order", seqs[2].seq - seqs[0].seq, 2);

clearDevLog();
console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
