// AES-GCM for tokens at rest. Output: base64(iv || ciphertext).

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

let cached: { raw: string; key: CryptoKey } | undefined;

async function key(raw: string) {
  if (cached?.raw !== raw) {
    cached = { raw, key: await crypto.subtle.importKey("raw", unb64(raw), "AES-GCM", false, ["encrypt", "decrypt"]) };
  }
  return cached.key;
}

export async function encrypt(rawKey: string, plaintext: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(rawKey), new TextEncoder().encode(plaintext)),
  );
  const out = new Uint8Array(iv.length + data.length);
  out.set(iv);
  out.set(data, iv.length);
  return b64(out);
}

export async function decrypt(rawKey: string, encoded: string) {
  const bytes = unb64(encoded);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(0, 12) },
    await key(rawKey),
    bytes.slice(12),
  );
  return new TextDecoder().decode(plain);
}

export function base64url(bytes: Uint8Array) {
  return b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
