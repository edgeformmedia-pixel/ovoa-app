import Ionicons from "@expo/vector-icons/Ionicons";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Empty, GroupLabel, IconTile, Screen, TopBar } from "../../components/ui";
import { ADDONS, installedAddons, searchAddons, USAGE_LABEL, useInstalledAddons, type Addon } from "../../lib/addons";
import { useDevMode } from "../../lib/devMode";
import { usePlan } from "../../lib/plan";
import { colors, radius, space, type } from "../../lib/theme";

// Apps: what's added onto this OVOA, and what could be (lib/addons.ts).
//
// One search over both lists. Yours come first and open on a tap; the rest
// install on a tap, and open from then on. Press and hold one of yours to take
// it off.

export default function Apps() {
  const router = useRouter();
  const devMode = useDevMode();
  const installed = useInstalledAddons();
  const { can } = usePlan();
  const [query, setQuery] = useState("");

  const listed = ADDONS.filter((a) => devMode || !a.dev);
  const found = searchAddons(listed, query);
  // Yours in the order you added them; the rest in catalog order.
  const yours = installed.map((id) => found.find((a) => a.id === id)).filter((a): a is Addon => !!a);
  const more = found.filter((a) => !installed.includes(a.id));

  const planTag = (a: Addon) =>
    a.needs === "agent" && !can.agent ? "Part of Pro" : a.needs === "assistant" && !can.chat ? "Part of a plan" : undefined;

  const remove = (a: Addon) =>
    Alert.alert(
      `Remove ${a.name}?`,
      "It comes off your apps. Anything it switched on stays on until you turn it off, and you can add it back any time.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Remove", style: "destructive", onPress: () => void installedAddons.remove(a.id) },
      ],
    );

  return (
    <View style={styles.page}>
      <TopBar title="Apps" />
      <Screen keyboardShouldPersistTaps="handled">
        <View style={styles.search}>
          <Ionicons name="search" size={18} color={colors.inkMute} />
          <TextInput
            style={styles.searchInput}
            value={query}
            onChangeText={setQuery}
            placeholder="Search apps"
            placeholderTextColor={colors.inkMute}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            clearButtonMode="while-editing"
            accessibilityLabel="Search apps"
          />
        </View>

        {yours.length > 0 && (
          <>
            <GroupLabel>Your apps</GroupLabel>
            {yours.map((a) => (
              <AddonRow
                key={a.id}
                addon={a}
                tag={planTag(a)}
                action="Open"
                onPress={() => router.navigate(a.href)}
                onLongPress={() => remove(a)}
              />
            ))}
          </>
        )}

        {more.length > 0 && (
          <>
            <GroupLabel>Add-ons</GroupLabel>
            {more.map((a) => (
              <AddonRow
                key={a.id}
                addon={a}
                tag={planTag(a)}
                action="Install"
                onPress={() => void installedAddons.install(a.id)}
              />
            ))}
          </>
        )}

        {found.length === 0 ? (
          <Empty icon="search" title="No apps found" body={`Nothing matches "${query.trim()}".`} />
        ) : (
          <>
            <Text style={styles.hint}>
              Daily usage is what your plan allows each day: your replies, and the work behind them. It resets every
              day. Apps that use more leave less for talking.
            </Text>
            {yours.length > 0 && <Text style={styles.hint}>Press and hold one of your apps to remove it.</Text>}
          </>
        )}
      </Screen>
    </View>
  );
}

function AddonRow({
  addon,
  tag,
  action,
  onPress,
  onLongPress,
}: {
  addon: Addon;
  /** Which plan it comes with, when this person's doesn't include it. */
  tag?: string;
  action: "Open" | "Install";
  onPress: () => void;
  onLongPress?: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={`${action} ${addon.name}, by ${addon.by}`}
      accessibilityHint={addon.about}
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.7 }]}
    >
      <IconTile name={addon.icon} tone={addon.tone} size={46} />
      <View style={styles.body}>
        <Text style={styles.name} numberOfLines={1}>
          {addon.name}
        </Text>
        <Text style={styles.by} numberOfLines={1}>
          by {addon.by}
          {!!tag && <Text style={styles.tag}> · {tag}</Text>}
        </Text>
        <Text style={styles.about}>{addon.about}</Text>
        <View style={styles.usage}>
          <Ionicons
            name={addon.usage === "none" ? "leaf-outline" : "flash-outline"}
            size={13}
            color={addon.usage === "more" ? colors.late : colors.inkMute}
          />
          <Text style={[styles.usageText, addon.usage === "more" && styles.usageMore]}>
            {USAGE_LABEL[addon.usage]}
            {!!addon.usageWhy && <Text style={styles.usageWhy}> · {addon.usageWhy}</Text>}
          </Text>
        </View>
      </View>
      {/* A label, not a button: the whole card is the button, and a button
          inside a button is two things to tap for one action. */}
      <View style={styles.action}>
        <Text style={styles.actionText}>{action}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.paper },

  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.s2,
    backgroundColor: colors.wash,
    borderRadius: 14,
    paddingHorizontal: space.s3,
  },
  searchInput: { flex: 1, ...type.body, color: colors.ink, paddingVertical: space.s3 },

  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.s3,
    backgroundColor: colors.wash,
    borderRadius: radius.tile,
    padding: space.s3,
  },
  body: { flex: 1, gap: 1 },
  name: { ...type.head, color: colors.ink },
  by: { ...type.meta, color: colors.inkMute },
  tag: { color: colors.agent, fontWeight: "600" },
  about: { ...type.sub, color: colors.inkDim, marginTop: 2 },
  action: { minHeight: 34, paddingHorizontal: 14, borderRadius: 17, justifyContent: "center", backgroundColor: colors.paper },
  actionText: { ...type.sub, fontWeight: "600", color: colors.ink },

  usage: { flexDirection: "row", alignItems: "flex-start", gap: 5, marginTop: space.s1 },
  usageText: { ...type.meta, color: colors.inkMute, flex: 1 },
  usageMore: { color: colors.late, fontWeight: "600" },
  usageWhy: { fontWeight: "400", color: colors.inkMute },

  hint: { ...type.meta, color: colors.inkMute, textAlign: "center", paddingTop: space.s4 },
});
