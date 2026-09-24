import { Redirect, type Href } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { usePlan } from "../../lib/plan";
import { colors } from "../../lib/theme";

// Where the app opens. With a plan that is Talk: OVOA is something you talk to,
// and everything else is an app you added (lib/addons.ts). Activity, which used
// to be here, is one of those now, at /activity.
//
// The free plan has no Talk in its menu, only Apps and Settings (2026-09-24),
// so it lands on Apps. Day is still where a plan that hasn't answered in time
// goes: it works on every plan.

/** How long the first open waits on the plan before going to Day, which works on every plan. */
const PLAN_WAIT_MS = 3000;

export default function Home() {
  const { free, ready } = usePlan();
  // A moment's wait for the plan (the phone's copy, or the server's first
  // answer), so a free phone isn't sent to the locked Talk first. Not longer:
  // a stalled connection would otherwise hold a blank screen until the request
  // gave up, a minute later. Day then, and the menu follows once the plan is in.
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(() => setWaited(true), PLAN_WAIT_MS);
    return () => clearTimeout(timer);
  }, [ready]);
  if (!ready && !waited) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.paper, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={colors.now} />
      </View>
    );
  }
  // Free: Apps, which with Settings is all its menu has (components/Drawer.tsx).
  return <Redirect href={(ready && !free ? "/chat" : ready ? "/apps" : "/day") as Href} />;
}
