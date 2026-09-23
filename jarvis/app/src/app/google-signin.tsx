import { Redirect } from "expo-router";

// "Continue with Google" sends the browser back to ovoa://google-signin with a
// one-time code (lib/signInWith.ts). The auth session catches that first; if
// the app is opened by the link instead, the code is no use without the key
// the sign-in screen holds, so just go home.
export default function GoogleSignin() {
  return <Redirect href="/" />;
}
