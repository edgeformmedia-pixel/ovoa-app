import { isRunningInExpoGo, requireOptionalNativeModule } from "expo";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { Platform } from "react-native";
import { api, type ProvenSignIn } from "./api";
import { devlog } from "./devlog";

// "Continue with Google" and "Sign in with Apple" on the sign-in screen
// (api/src/signin.ts). Either proves an address: the account behind it is
// signed in, or there's none yet and the screen asks for a name and password.
// null means the person cancelled, and the screen says nothing about it.

type AppleModule = typeof import("expo-apple-authentication");

/**
 * Sign in with Apple, where it can work. Loaded lazily and only when the
 * native side is in the build, so web, Android and a build from before it was
 * added never import it. Not in Expo Go: Apple would sign its tokens for Expo
 * Go's bundle id, and the server only takes com.ovoa.app's.
 */
const Apple: AppleModule | null =
  Platform.OS === "ios" && !isRunningInExpoGo() && requireOptionalNativeModule("ExpoAppleAuthentication")
    ? (require("expo-apple-authentication") as AppleModule)
    : null;

/** The module, for the screen's AppleAuthenticationButton: Apple's own button is required. */
export const appleAuth = Apple;

/** Whether to show the Apple button at all (iOS 13+, the native side present). */
export async function appleSignInAvailable() {
  if (!Apple) return false;
  try {
    return await Apple.isAvailableAsync();
  } catch {
    return false;
  }
}

/** What ?error= on the way back from Google means, in the person's words (api/src/signin.ts SigninError). */
const GOOGLE_ERRORS: Record<string, string> = {
  expired: "That took too long. Try Continue with Google again.",
  unconfirmed: "Google didn't confirm your email address. Try again, or use your email and a password.",
  google: "Google sign-in didn't work just now. Try again.",
};

/**
 * Google's page in an auth session, the same way lib/google.ts connects an
 * account, then the one-time code it sends back redeemed with the key only
 * this phone has.
 */
export async function signInWithGoogle(): Promise<ProvenSignIn | null> {
  const returnUrl = Linking.createURL("google-signin");
  const { url, key } = await api.googleSignInStart(returnUrl);
  const result = await WebBrowser.openAuthSessionAsync(url, returnUrl);
  if (result.type !== "success") return null;
  const params = Linking.parse(result.url).queryParams ?? {};
  if (params.error === "cancelled") return null;
  if (params.error || typeof params.code !== "string") {
    devlog("warn", `sign-in: Google came back with ${String(params.error ?? "no code")}`);
    throw new Error(GOOGLE_ERRORS[String(params.error)] ?? GOOGLE_ERRORS.google);
  }
  return api.googleSignInRedeem(params.code, key);
}

/** Apple's own sheet, with a nonce from the server that the token has to carry back. */
export async function signInWithApple(): Promise<ProvenSignIn | null> {
  if (!Apple) throw new Error("Sign in with Apple isn't available on this phone.");
  const { nonce } = await api.appleSignInStart();
  let credential: Awaited<ReturnType<AppleModule["signInAsync"]>>;
  try {
    credential = await Apple.signInAsync({
      requestedScopes: [Apple.AppleAuthenticationScope.FULL_NAME, Apple.AppleAuthenticationScope.EMAIL],
      nonce,
    });
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === "ERR_REQUEST_CANCELED") return null;
    devlog("err", `sign-in: Apple said ${String(code ?? "no")}`, err instanceof Error ? err.message : String(err));
    throw new Error("Sign in with Apple didn't work just now. Try again.");
  }
  // Apple sends the name only the first time someone signs in to the app.
  const name = credential.fullName;
  return api.appleSignIn(
    credential.identityToken!,
    nonce,
    name?.givenName || name?.familyName ? { givenName: name.givenName, familyName: name.familyName } : null,
  );
}
