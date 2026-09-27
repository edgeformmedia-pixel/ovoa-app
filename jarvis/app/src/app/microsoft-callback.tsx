import { Redirect } from "expo-router";

// Microsoft sends the browser back to ovoa://microsoft-callback. The auth session usually
// catches that first; if the app is opened by the link instead, just go home.
export default function MicrosoftCallback() {
  return <Redirect href="/" />;
}
