/**
 * iOS only imports shortcut files Apple has signed, and signing needs a Mac
 * signed into iCloud. SHORTCUT_SIGNING_URL points at a server that does it:
 * github.com/scaxyz/shortcut-signing-server on a Mac, or RoutineHub's HubSign
 * (needs a RoutineHub developer membership). Both take the same request as
 * the Cherri compiler sends: JSON { shortcutName, shortcut: <XML plist> }.
 */

export type SigningEnv = { SHORTCUT_SIGNING_URL?: string; SHORTCUT_SIGNING_TOKEN?: string };

export class SigningUnavailable extends Error {}

export const signingConfigured = (env: SigningEnv) => !!env.SHORTCUT_SIGNING_URL;

export async function signShortcut(env: SigningEnv, name: string, xml: string): Promise<ArrayBuffer> {
  if (!env.SHORTCUT_SIGNING_URL) throw new SigningUnavailable("No shortcut signing service is set up.");
  const res = await fetch(env.SHORTCUT_SIGNING_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(env.SHORTCUT_SIGNING_TOKEN && { authorization: `Bearer ${env.SHORTCUT_SIGNING_TOKEN}` }),
    },
    body: JSON.stringify({ shortcutName: name, shortcut: xml }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    console.error("shortcut signing failed", res.status, (await res.text()).slice(0, 300));
    throw new SigningUnavailable(`The signing service returned ${res.status}.`);
  }
  const body = await res.arrayBuffer();
  // Signed shortcuts are Apple Encrypted Archives, which start with "AEA1".
  const magic = new TextDecoder().decode(body.slice(0, 4));
  if (magic !== "AEA1") throw new SigningUnavailable("The signing service didn't return a signed shortcut.");
  return body;
}
