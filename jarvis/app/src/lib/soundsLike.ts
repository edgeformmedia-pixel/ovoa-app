// Matching names that sound alike, for names that come through voice
// transcription spelled the way they sound ("Ty Eckard" for "Tigh Eckart").

/** A rough English sound key: spellings that sound the same get the same key. */
export function soundKey(word: string) {
  let w = word.toLowerCase().normalize("NFD").replace(/[^a-z]/g, "");
  if (!w) return "";
  w = w
    .replace(/^kn|^gn|^pn|^wr/, (m) => m[1]) // silent first letters: knight, wright
    .replace(/igh/g, "i") // tigh, high
    .replace(/gh(?![aeiou])/g, "") // silent gh: vaughn, leigh
    .replace(/ph/g, "f")
    .replace(/ck|q/g, "k")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/c/g, "k")
    .replace(/x/g, "ks")
    .replace(/z/g, "s")
    .replace(/dt$|d$/, "t") // eckard / eckart
    .replace(/(?<=[aeiouy])[hw](?![aeiouy])/g, "") // sarah, shaw
    .replace(/y/g, "i")
    .replace(/[aeiou]+/g, (v, i) => (i === 0 ? "a" : "")) // keep that it starts with a vowel, drop the rest
    .replace(/(.)\1+/g, "$1"); // double letters
  return w;
}

function editDistance(a: string, b: string) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

function similarity(a: string, b: string) {
  if (!a || !b) return 0;
  return 1 - editDistance(a, b) / Math.max(a.length, b.length);
}

/** How alike two single names are, 0 to 1, by spelling or by sound. */
function wordScore(a: string, b: string) {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  if (x === y) return 1;
  // "Tom" for "Thomas": a prefix of 3+ letters counts as a strong match.
  if (x.length >= 3 && y.startsWith(x)) return 0.9;
  const sound = soundKey(x) === soundKey(y) ? 0.95 : similarity(soundKey(x), soundKey(y)) * 0.9;
  return Math.max(similarity(x, y), sound);
}

const wordsOf = (s: string) => s.split(/[\s,.'-]+/).filter(Boolean);

/**
 * How well a spoken name matches a contact, 0 to 1. Every word the user said
 * has to match some part of the contact's name (or its phonetic name).
 */
export function nameScore(query: string, names: (string | null | undefined)[]) {
  const said = wordsOf(query);
  const parts = names.flatMap((n) => (n ? wordsOf(n) : []));
  if (!said.length || !parts.length) return 0;
  const scores = said.map((w) => Math.max(...parts.map((p) => wordScore(w, p))));
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

/** Good enough to offer as "did you mean". */
export const SOUNDS_LIKE_THRESHOLD = 0.75;
