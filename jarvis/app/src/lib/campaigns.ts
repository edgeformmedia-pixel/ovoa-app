import type { IconName, Tone } from "../components/ui";
import type { CampaignDetail, CampaignItemStatus, CampaignMode, CampaignStatus } from "./api";
import { colors } from "./theme";

// Campaigns (api/src/campaigns.ts): how the list (app/campaigns.tsx) and one
// campaign (app/campaign/[id].tsx) name and colour modes and states. The
// server decides everything; this is only the words.

export const MODES: Record<CampaignMode, { label: string; icon: IconName; tone: Tone; verb: string }> = {
  email: { label: "Email", icon: "mail-outline", tone: "blue", verb: "sent" },
  research: { label: "Lookups", icon: "search-outline", tone: "violet", verb: "looked up" },
  friends: { label: "Friends' OVOAs", icon: "people-outline", tone: "green", verb: "sent" },
};

export const STATUS: Record<CampaignStatus, { label: string; ink: string; wash: string }> = {
  waiting_for_approval: { label: "Waiting for your OK", ink: colors.late, wash: colors.lateWash },
  running: { label: "Running", ink: colors.now, wash: colors.nowWash },
  done: { label: "Done", ink: colors.done, wash: colors.doneWash },
  stopped: { label: "Stopped", ink: colors.inkDim, wash: colors.wash },
};

/** One item's state, for its line in the results. */
export const ITEM_STATUS: Record<CampaignItemStatus, { label: string; ink: string }> = {
  pending: { label: "To do", ink: colors.inkMute },
  working: { label: "On it", ink: colors.now },
  done: { label: "Done", ink: colors.done },
  skipped: { label: "Skipped", ink: colors.late },
  failed: { label: "Didn't work", ink: colors.stop },
};

/** Items finished one way or another: done, skipped, or didn't work. */
export const finished = (counts: CampaignDetail["counts"]) => (counts.done ?? 0) + (counts.skipped ?? 0) + (counts.failed ?? 0);

/** What to call one item in the results: its name, address or username, or whatever it has first. */
export function itemName(data: Record<string, unknown>, idx: number) {
  for (const key of ["name", "title", "email", "username", "place", "company", "venue"]) {
    const v = data[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  const first = Object.values(data).find((v) => typeof v === "string" && v.trim());
  return typeof first === "string" ? first.trim() : `Item ${idx + 1}`;
}
