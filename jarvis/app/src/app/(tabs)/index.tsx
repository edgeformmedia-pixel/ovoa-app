import { Redirect, type Href } from "expo-router";
import { usePlan } from "../../lib/plan";

// Where the app opens. With a plan that is Talk: OVOA is something you talk to,
// and everything else is an app you added (lib/addons.ts). Activity, which used
// to be here, is one of those now, at /activity.
//
// The free plan lands on its first free screen instead of the locked Talk: its
// day, the spine of today's notes with health under it (the Day app, which is
// components/FreeToday.tsx on the free plan). The menu is the same for everyone
// (components/Drawer.tsx); Talk is there with a lock.

export default function Home() {
  const { free, ready } = usePlan();
  // A moment's wait for the plan (the phone's copy, or the server's first
  // answer), so a free phone isn't sent to the locked Talk first.
  if (!ready) return null;
  return <Redirect href={(free ? "/day" : "/chat") as Href} />;
}
