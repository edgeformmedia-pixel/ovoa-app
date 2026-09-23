import Ionicons from "@expo/vector-icons/Ionicons";
import { useRouter, type Href } from "expo-router";
import { Linking, RefreshControl, StyleSheet, Text, View } from "react-native";
import { logFail } from "../lib/devlog";
import { spotRef } from "../lib/drawer";
import { PLAN_NAMES, planDate, usePlan } from "../lib/plan";
import { colors, radius, space, type } from "../lib/theme";
import { Btn, Row, Screen, TopBar, text } from "./ui";

// What the app shows where a plan decides (docs/paywall/SPEC.md).
//
// Every AI feature is Base's, and Pro is only more of it (2026-09-23), so there
// is one locked state: "That's for Base users", what the thing would do, and a
// See options button that opens the plans on ovoa.ai. That link is the user's
// call for TestFlight, and temporary (SPEC §4): it opens the plans page, never
// checkout, and it lives only in StoreActions, where in-app purchase replaces
// it for the App Store. No prices and no buy buttons in the app. The words are
// plain: "for Base users", never "tier", "entitlement" or "paywall".
//
// Someone on Base who hasn't agreed to AI yet (lib/consent.ts, usePlan's
// needsConsent) sees the same places locked another way: "Agree to use AI",
// and a button to the consent screen (app/consent.tsx). Nothing to buy.

/** The one line that says where plans live. */
export const MANAGED_AT = "Plans are on ovoa.ai.";

/** Where See options goes: the plans on the site (decision 12). TestFlight only; see StoreActions. */
export const PLANS_URL = "https://ovoa.ai/early-access#plans";

/** The locked state's headline, wherever it shows. */
export const FOR_BASE = "That's for Base users";

/** The headline, and the tag, where they have the plan but haven't agreed to AI. */
export const AGREE_FIRST = "Agree to use AI";

/** What a locked AI feature is tagged with in a list: why it's locked, in three or four words. */
export function lockTag(needsConsent: boolean) {
  return needsConsent ? AGREE_FIRST : "For Base users";
}

/**
 * The free home's one card about the assistant. Said once, in one place, and
 * never repeated as a nag across the app.
 */
export function AssistantPlanCard() {
  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Ionicons name="lock-closed-outline" size={18} color={colors.agent} />
        <Text style={styles.cardTitle}>Talking to OVOA is for Base users</Text>
      </View>
      <Text style={text.sub}>
        With Base you can talk to OVOA, hear a morning brief, make your own apps, and have your Band's button ask it
        anything. Your health, your notes and the apps that don't use AI stay free.
      </Text>
      <StoreActions />
      <Text style={text.meta}>Already a member? Pull down to refresh.</Text>
    </View>
  );
}

/**
 * A whole screen whose feature isn't part of this person's plan: that it's for
 * Base users, what it would do, and See options. Calm, never an error, and
 * pulling down asks again, for someone who has just joined.
 */
export function PartOfPlan({
  title,
  what,
  bar = true,
  spot,
}: {
  title: string;
  what: string;
  /** False on a screen pushed over another, which has a back arrow instead of the menu. */
  bar?: boolean;
  /** Names See options for the tour's spotlight (StoreActions). Talk's alone passes it. */
  spot?: string;
}) {
  const { refresh, refreshing, needsConsent } = usePlan();
  if (needsConsent) return <AgreeFirst title={title} what={what} bar={bar} spot={spot} />;
  return (
    <View style={styles.page}>
      {bar && <TopBar title={title} />}
      <Screen
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => void refresh({ fromSite: true })} tintColor={colors.now} />
        }
      >
        <View style={styles.part}>
          <Ionicons name="lock-closed-outline" size={28} color={colors.inkMute} />
          <Text style={styles.partTitle}>{FOR_BASE}</Text>
          <Text style={styles.partBody}>{what}</Text>
          <StoreActions spot={spot} />
          <Text style={styles.partMeta}>Already a member? Pull down to refresh.</Text>
        </View>
      </Screen>
    </View>
  );
}

/**
 * PartOfPlan for someone whose plan has it but who hasn't agreed to AI: what
 * it would do, that OVOA needs their OK before anything goes to an AI company,
 * and the way to the consent screen. Never "for Base users": they are.
 */
function AgreeFirst({ title, what, bar, spot }: { title: string; what: string; bar: boolean; spot?: string }) {
  const router = useRouter();
  return (
    <View style={styles.page}>
      {bar && <TopBar title={title} />}
      <Screen>
        <View style={styles.part}>
          <Ionicons name="lock-closed-outline" size={28} color={colors.inkMute} />
          <Text style={styles.partTitle}>{AGREE_FIRST}</Text>
          <Text style={styles.partBody}>{what}</Text>
          <Text style={styles.partMeta}>OVOA needs your OK before anything you say goes to an AI company.</Text>
          <View ref={spot ? spotRef(spot) : undefined} collapsable={false} style={styles.options}>
            <Btn label="Review and agree" kind="go" onPress={() => router.push("/consent" as Href)} />
          </View>
        </View>
      </Screen>
    </View>
  );
}

/** One line in Settings where a switch would be: the feature, and why it's locked. */
export function LockedLine({ label, what }: { label: string; what: string }) {
  const { needsConsent } = usePlan();
  return (
    <View style={styles.proRow}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.proLabel}>{label}</Text>
        <Text style={text.meta}>{what}</Text>
      </View>
      <Text style={styles.proTag}>{lockTag(needsConsent)}</Text>
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
 * See options (StoreActions) is where the App Store version adds buying.
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
          ? "Health, notes and the apps that don't use AI are free. Talking to OVOA, and everything else that uses AI, is for Base users."
          : plan?.tier === "base"
            ? "Base has everything. Pro is the same with three times the daily usage."
            : ""}
        {plan?.tier === "pro" ? "" : " "}
        {MANAGED_AT}
      </Text>
      <StoreActions align="flex-start" />
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
 * The seam for buying in the app, and the only place it will go. Every locked
 * state and Settings → Your plan show it.
 *
 * // IAP goes here
 *
 * The App Store build adds StoreKit here, in place of the link (Apple 3.1.1:
 * in-app purchase for the AI plans; memberships bought on ovoa.ai are honoured
 * under 3.1.3(b)). After a purchase, call usePlan().refresh({ fromSite: true })
 * and every gate follows.
 *
 * During TestFlight it is one button, See options, that opens the plans on
 * ovoa.ai (PLANS_URL): the user's call, and temporary (docs/paywall/SPEC.md
 * §4). The plans page, never checkout; no prices and no buy button in the app.
 * Nothing here changes the plan: coming back to the app asks again (plan.tsx).
 * Pro has nothing more to see, so it shows nothing. `spot` names it for the
 * tour's spotlight; only one mounted copy may have it, so only the locked Talk
 * screen passes one.
 */
export function StoreActions({ spot, align = "center" }: { spot?: string; align?: "center" | "flex-start" }) {
  // IAP goes here
  const { plan } = usePlan();
  if (plan?.tier === "pro") return null;
  return (
    <View ref={spot ? spotRef(spot) : undefined} collapsable={false} style={[styles.options, { alignSelf: align }]}>
      <Btn label="See options" kind="go" onPress={() => void Linking.openURL(PLANS_URL).catch(logFail("plan: opening the plans"))} />
    </View>
  );
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

  options: { paddingVertical: space.s1 },

  proRow: { flexDirection: "row", alignItems: "center", gap: space.s3 },
  proLabel: { ...type.body, color: colors.ink },
  proTag: { ...type.meta, fontWeight: "600", color: colors.agent },
});
