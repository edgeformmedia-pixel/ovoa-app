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

/**
 * Google connections from before the v1 move didn't come across: they were
 * made with the old Google client, and their tokens were locked with the old
 * server's key (api/scripts/move-db-lib.mjs). An account from before then with
 * nothing connected is told to reconnect, rather than just seeing "Connect".
 * Generous on purpose: an account made a little after the move only sees one
 * extra line.
 */
const GOOGLE_MOVED_BY = Date.parse("2026-10-15T00:00:00Z");

export const mayHaveHadGoogle = (createdAt: number | undefined) =>
  typeof createdAt === "number" && createdAt < GOOGLE_MOVED_BY;
