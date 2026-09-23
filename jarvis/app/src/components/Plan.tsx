import Ionicons from "@expo/vector-icons/Ionicons";
import { RefreshControl, StyleSheet, Text, View } from "react-native";
import type { PlanNeeded } from "../lib/api";
import { PLAN_NAMES, planDate, usePlan } from "../lib/plan";
import { colors, radius, space, type } from "../lib/theme";
import { Btn, Row, Screen, TopBar, text } from "./ui";

// What the app shows where a plan decides (docs/paywall/SPEC.md).
//
// While the app is on TestFlight there is nothing to buy in it: no prices, no
// buy buttons, no links out to checkout (SPEC §4, Apple 3.1.1). Plans are
// managed on the site, and the app only says so, in one plain line. The words
// are plain too: "part of a plan", never "tier", "entitlement" or "paywall".

/** The one line that says where plans live. Text, not a link. */
export const MANAGED_AT = "Plans are managed at ovoa.ai.";

/**
 * The free home's one card about the assistant. Said once, in one place, and
 * never repeated as a nag across the app.
 */
export function AssistantPlanCard() {
  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Ionicons name="sparkles-outline" size={18} color={colors.agent} />
        <Text style={styles.cardTitle}>OVOA's assistant is part of a plan</Text>
      </View>
      <Text style={text.sub}>
        With a plan you can talk to OVOA, hear a morning brief, and have your Band's button ask it anything. Your health
        and your notes stay free.
      </Text>
      <Text style={text.meta}>{MANAGED_AT} Already a member? Pull down to refresh.</Text>
    </View>
  );
}

/**
 * A whole screen whose feature isn't part of this person's plan: what it would
 * do, and which plan it comes with. Calm, never an error, and pulling down asks
 * again, for someone who has just joined.
 */
export function PartOfPlan({
  title,
  needs,
  what,
  bar = true,
}: {
  title: string;
  needs: PlanNeeded;
  what: string;
  /** False on a screen pushed over another, which has a back arrow instead of the menu. */
  bar?: boolean;
}) {
  const { refresh, refreshing } = usePlan();
  return (
    <View style={styles.page}>
      {bar && <TopBar title={title} />}
      <Screen
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => void refresh({ fromSite: true })} tintColor={colors.now} />
        }
      >
        <View style={styles.part}>
          <Ionicons name={needs === "pro" ? "sparkles-outline" : "lock-closed-outline"} size={28} color={colors.inkMute} />
          <Text style={styles.partTitle}>{needs === "pro" ? "Part of Pro" : "Part of a plan"}</Text>
          <Text style={styles.partBody}>{what}</Text>
          <Text style={styles.partMeta}>
            {needs === "pro" ? "It comes with the Pro plan." : "It comes with the Base and Pro plans."} {MANAGED_AT}
          </Text>
          <Text style={styles.partMeta}>Already a member? Pull down to refresh.</Text>
        </View>
      </Screen>
    </View>
  );
}

/** One line in Settings where a switch would be: the feature, and that it's part of Pro. */
export function PartOfProLine({ label, what }: { label: string; what: string }) {
  return (
    <View style={styles.proRow}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.proLabel}>{label}</Text>
        <Text style={text.meta}>{what}</Text>
      </View>
      <Text style={styles.proTag}>Part of Pro</Text>
    </View>
  );
}

const STATUS: Record<string, string | undefined> = {
  trialing: "Trial",
  past_due: "Payment due",
  canceled: "Ends soon",
  comp: "Given to you",
};

/**
 * Settings → Your plan: which plan, until when, and a way to check again.
 * The App Store version adds buying here; TestFlight must not (SPEC §4).
 */
export function YourPlan() {
  const { plan, refresh, refreshing } = usePlan();
  const name = plan ? PLAN_NAMES[plan.tier] : "Checking…";
  const trialEnds = planDate(plan?.trialEndsAt ?? null);
  const renews = planDate(plan?.renewsAt ?? null);
  const status = plan && plan.tier !== "free" ? STATUS[plan.status] : undefined;
  const left = plan?.limits.repliesLeftToday;

  return (
    <View style={{ gap: space.s1 }}>
      <Row icon="ribbon-outline" tone="violet" title="Plan" value={status ? `${name} · ${status}` : name} first />
      {!!trialEnds && <Row icon="hourglass-outline" tone="amber" title="Trial ends" value={trialEnds} />}
      {!trialEnds && !!renews && (
        <Row icon="refresh-outline" tone="blue" title={plan?.status === "canceled" ? "Ends" : "Renews"} value={renews} />
      )}
      {plan && plan.tier !== "free" && typeof left === "number" && (
        <Row icon="chatbubble-outline" tone="teal" title="Replies left today" value={String(left)} />
      )}
      <Text style={[text.meta, { paddingTop: space.s2 }]}>
        {plan?.tier === "free"
          ? "Health and notes are free. The assistant comes with the Base and Pro plans."
          : plan?.tier === "base"
            ? "The hands-free wake word and background work come with Pro."
            : ""}
        {plan?.tier === "pro" ? "" : " "}
        {MANAGED_AT}
      </Text>
      <StoreActions />
      <Btn
        label={refreshing ? "Checking…" : "Refresh"}
        onPress={() => void refresh({ fromSite: true })}
        disabled={refreshing}
        style={{ alignSelf: "flex-start", marginTop: space.s2 }}
      />
      <Text style={text.meta}>Already a member? Refresh after joining and the app catches up.</Text>
    </View>
  );
}

/**
 * The seam for buying in the app, and the only place it will go.
 *
 * // IAP goes here
 *
 * The App Store build adds StoreKit here (Apple 3.1.1: in-app purchase for the
 * AI plans; memberships bought on ovoa.ai are honoured under 3.1.3(b)). After a
 * purchase, call usePlan().refresh({ fromSite: true }) and every gate follows.
 * During TestFlight it must render nothing: no prices, no buy buttons, no
 * links to checkout (docs/paywall/SPEC.md §4).
 */
function StoreActions() {
  // IAP goes here
  return null;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.paper },

  card: { backgroundColor: colors.wash, borderRadius: radius.tile, padding: space.s4, gap: space.s2, marginTop: space.s2 },
  cardHead: { flexDirection: "row", alignItems: "center", gap: space.s2 },
  cardTitle: { ...type.head, color: colors.ink, flex: 1 },

  part: { alignItems: "center", gap: space.s3, paddingTop: space.s10, paddingHorizontal: space.s4 },
  partTitle: { ...type.title, color: colors.ink, textAlign: "center" },
  partBody: { ...type.sub, color: colors.inkDim, textAlign: "center", maxWidth: 340 },
  partMeta: { ...type.meta, color: colors.inkMute, textAlign: "center", maxWidth: 340 },

  proRow: { flexDirection: "row", alignItems: "center", gap: space.s3 },
  proLabel: { ...type.body, color: colors.ink },
  proTag: { ...type.meta, fontWeight: "600", color: colors.agent },
});
