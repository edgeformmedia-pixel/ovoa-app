import { Redirect } from "expo-router";
import { FreeToday } from "../../components/FreeToday";
import { usePlan } from "../../lib/plan";

// Where the app opens. With a plan that is Talk: OVOA is something you talk to,
// and everything else is an app you added (lib/addons.ts). Activity, which used
// to be here, is one of those now, at /activity.
//
// The free plan has no assistant to talk to, so its first screen is still the
// day itself: the spine of today's notes, with health under it
// (components/FreeToday.tsx).

export default function Home() {
  const { free } = usePlan();
  return free ? <FreeToday /> : <Redirect href="/chat" />;
}
