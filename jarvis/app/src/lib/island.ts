import * as LiveActivity from "expo-live-activity";
import { Platform } from "react-native";
import { devlog } from "./devlog";

// Whether OVOA is listening, in the Dynamic Island and on the Lock Screen: a Live Activity while
// the twist standby or a conversation is on. The widget draws "sf:<symbol>#<colour>" as an SF
// Symbol (patches/expo-live-activity+0.4.2.patch) and puts the title next to it.

export type IslandStatus = "off" | "listening" | "thinking" | "speaking";

const LOOK: Record<IslandStatus, LiveActivity.LiveActivityState> = {
  off: { title: "Off", subtitle: "Twist your wrist to talk", dynamicIslandImageName: "sf:mic.slash.fill#8E8E93" },
  listening: { title: "Listening", subtitle: "Go ahead, I'm listening", dynamicIslandImageName: "sf:mic.fill#34C759" },
  thinking: { title: "Thinking", subtitle: "Working on it", dynamicIslandImageName: "sf:ellipsis#FFD60A" },
  speaking: { title: "Speaking", subtitle: "Answering out loud", dynamicIslandImageName: "sf:speaker.wave.2.fill#0A84FF" },
};

const CONFIG: LiveActivity.LiveActivityConfig = {
  backgroundColor: "111111",
  titleColor: "FFFFFF",
  subtitleColor: "EBEBF5",
  deepLinkUrl: "/",
};

let activityId: string | null = null;
let shown: IslandStatus | null = null;
let lastError = "";

LiveActivity.addActivityUpdatesListener?.(({ activityID, activityState }) => {
  // Swiped away, or ended by iOS (they last 8 hours): start a new one next time.
  if (activityID === activityId && (activityState === "dismissed" || activityState === "ended")) {
    activityId = null;
    shown = null;
  }
});

/** Shows `status` in the Dynamic Island, or takes it away (null). Never throws. */
export function showIsland(status: IslandStatus | null) {
  if (Platform.OS !== "ios" || status === shown) return;
  try {
    if (!status) {
      if (activityId) LiveActivity.stopActivity(activityId, LOOK.off);
      activityId = null;
    } else if (activityId) {
      LiveActivity.updateActivity(activityId, LOOK[status]);
    } else {
      // Only works with the app open; from the background it's tried again when the app opens.
      activityId = LiveActivity.startActivity(LOOK[status], CONFIG) || null;
      if (!activityId) return;
      devlog("voice", "dynamic island: on");
    }
    shown = status;
  } catch (err) {
    // The activity is gone (or couldn't start): start a new one on the next change.
    activityId = null;
    shown = null;
    const why = err instanceof Error ? err.message : String(err);
    if (why !== lastError) devlog("err", "dynamic island failed", why);
    lastError = why;
  }
}
