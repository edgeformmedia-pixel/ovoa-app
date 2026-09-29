// The browser agent's rules (browsermoves.ts): what it will open, how it reads
// the model's answer, and which clicks always wait for a YES.

import { isRisky, parseMove, safeUrl, RISKY } from "../src/browsermoves";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${g}${ok ? "" : `  (wanted ${w})`}`);
}

// Addresses: public web pages only.
eq("adds https", safeUrl("example.com/a"), "https://example.com/a");
eq("keeps http", safeUrl("http://example.com/"), "http://example.com/");
eq("no file", safeUrl("file:///etc/passwd"), null);
eq("no javascript", safeUrl("javascript:alert(1)"), null);
eq("no localhost", safeUrl("http://localhost:8787/"), null);
eq("no bare host", safeUrl("http://intranet/"), null);
eq("no ip", safeUrl("http://169.254.169.254/latest"), null);
eq("no ipv6", safeUrl("http://[::1]/"), null);
eq("no .internal", safeUrl("https://db.internal/"), null);

// The model's answer.
eq("click", parseMove('Sure {"action":"click","id":4} ok'), { action: "click", id: 4 });
eq("type", parseMove('{"action":"type","id":2,"text":"hi","enter":true}'), { action: "type", id: 2, text: "hi", enter: true });
eq("done", parseMove('{"action":"done","result":"It opens at 9."}'), { action: "done", result: "It opens at 9." });
eq("needs a number", parseMove('{"action":"click"}'), null);
eq("not json", parseMove("I would click the button"), null);
eq("unknown action", parseMove('{"action":"run","cmd":"rm -rf /"}'), null);
eq("bad json", parseMove('{"action":"click","id":}'), null);

// Money, sending and deleting always wait.
const marks = [
  { id: 1, tag: "a", type: "", label: "Menu" },
  { id: 2, tag: "button", type: "", label: "Place your order" },
  { id: 3, tag: "button", type: "submit", label: "Delete account" },
  { id: 4, tag: "button", type: "", label: "Add to cart" },
  { id: 5, tag: "input", type: "text", label: "Search" },
];
eq("menu is free", isRisky({ action: "click", id: 1 }, marks), false);
eq("order waits", isRisky({ action: "click", id: 2 }, marks), true);
eq("delete waits", isRisky({ action: "click", id: 3 }, marks), true);
eq("add to cart is free", isRisky({ action: "click", id: 4 }, marks), false);
eq("search Enter is free", isRisky({ action: "type", id: 5, text: "x", enter: true }, marks), false);
eq("scrolling is free", isRisky({ action: "scroll", dir: "down" }, marks), false);
eq("words", ["Buy now", "Book now", "Send message", "Confirm booking", "Pay $20"].map((w) => RISKY.test(w)), [true, true, true, true, true]);

if (fails) {
  console.error(`${fails} failed`);
  process.exit(1);
}
