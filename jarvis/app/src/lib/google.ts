import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { api } from "./api";

export type ConnectResult = { ok: true } | { ok: false; cancelled?: boolean; message: string };

/**
 * Opens Google's consent screen and waits for the server to send the user back to the app.
 * Without `accountId` this adds an account; with one it reconnects that account.
 */
export async function connectGoogle(token: string, accountId?: string): Promise<ConnectResult> {
  const returnUrl = Linking.createURL("google-callback");
  const { url } = await api.googleConnectUrl(token, returnUrl, accountId);
  const result = await WebBrowser.openAuthSessionAsync(url, returnUrl);

  if (result.type !== "success") return { ok: false, cancelled: true, message: "Cancelled" };
  const params = Linking.parse(result.url).queryParams ?? {};
  if (params.google === "connected") return { ok: true };
  return { ok: false, message: String(params.message ?? "Couldn't connect to Google") };
}

export const GOOGLE_APPS = ["Gmail", "Calendar", "Drive", "Sheets", "Docs", "Tasks", "Contacts"];
