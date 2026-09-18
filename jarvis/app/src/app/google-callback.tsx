import { Redirect } from "expo-router";

// Google sends the browser back to ovoa://google-callback. The auth session usually
// catches that first; if the app is opened by the link instead, just go home.
export default function GoogleCallback() {
  return <Redirect href="/" />;
}
