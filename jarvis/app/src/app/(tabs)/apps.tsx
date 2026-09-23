import Ionicons from "@expo/vector-icons/Ionicons";
import { useRouter, type Href } from "expo-router";
import { useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { expandFrom } from "../../components/Expand";
import { PressScale, Rise } from "../../components/motion";
import { Empty, GroupLabel, IconTile, Screen, TopBar, toneWash, type IconName, type Tone } from "../../components/ui";
import {
  ADDONS,
  installedAddons,
  searchAddons,
  USAGE_LABEL,
  useInstalledAddons,
  type Addon,
  type AddonUsage,
} from "../../lib/addons";
import type { MyApp } from "../../lib/api";
import { useSession } from "../../lib/auth";
import { useDevMode } from "../../lib/devMode";
import { CALORIE_ID, calorieToggled } from "../../lib/food";
import { spotRef, usePointedAt, type SpotRect } from "../../lib/drawer";
import { myApps, useMyApps } from "../../lib/myApps";
import { MANAGED_AT } from "../../components/Plan";
import { usePlan } from "../../lib/plan";
import { colors, radius, space, type } from "../../lib/theme";

// Apps: what's added onto this OVOA, and what could be (lib/addons.ts).
//
// One search over both lists. Yours come first and open on a tap; the rest
// install on a tap, and open from then on. Press and hold one of yours to take
// it off.
//
// Create is at the top: say or type what you want and OVOA makes it
// (app/create.tsx). The apps you made sit with yours, by you, and open in Talk
// with their instructions on (lib/activeApp.ts).

/** What every row shows, whoever made the app. */
type Card = {
  name: string;
  by: string;
  about: string;
  icon: IconName;
  tone: Tone;
  usage: AddonUsage;
  usageWhy?: string;
};

/** One of theirs, as a row. It runs on the assistant, so each thing asked is a reply. */
const madeCard = (a: MyApp, by: string): Card => ({
  name: a.name,
  by,
  about: a.about,
  icon: a.icon as IconName,
  tone: a.tone,
  usage: "some",
  usageWhy: "Each thing you ask it counts as a reply.",
});

export default function Apps() {
  const router = useRouter();
  const devMode = useDevMode();
  const installed = useInstalledAddons();
  const { can } = usePlan();
  const { token, user } = useSession();
  const made = useMyApps(token);
  const pointed = usePointedAt();
  const [query, setQuery] = useState("");
  const me = user?.name?.trim() || "you";

  const listed = ADDONS.filter((a) => devMode || !a.dev);
  const found = searchAddons(listed, query);
  // Yours in the order you added them; the rest in catalog order.
  const yours = installed.map((id) => found.find((a) => a.id === id)).filter((a): a is Addon => !!a);
  const more = found.filter((a) => !installed.includes(a.id));
  const q = query.trim().toLowerCase();
  const mine = made.filter((a) => !q || `${a.name} ${a.about} ${me}`.toLowerCase().includes(q));
  const showCreate = !q || "create make new build my own app".includes(q);

  const create = () => {
    if (!can.chat) {
      Alert.alert("Making apps is part of a plan", `It comes with the Base and Pro plans. ${MANAGED_AT}`);
      return;
    }
    router.push("/create" as Href);
  };

  // A made app opens on its own screen (app/made/[id].tsx).
  const openMine = (a: MyApp) => router.push({ pathname: "/made/[id]", params: { id: a.id } } as unknown as Href);

  const deleteMine = (a: MyApp) =>
    Alert.alert(`Delete ${a.name}?`, "You made it, so deleting it can't be undone. You can always make another.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () =>
          myApps.remove(token, a.id).catch((err) => Alert.alert("Couldn't delete it", (err as Error).message)),
      },
    ]);

  const planTag = (a: Addon) =>
    a.needs === "agent" && !can.agent ? "Part of Pro" : a.needs === "assistant" && !can.chat ? "Part of a plan" : undefined;

  // Calorie is the one whose state lives on the server too: installing it is
  // what makes OVOA count and ask (lib/food.ts).
  const install = (a: Addon) => {
    void installedAddons.install(a.id);
    if (a.id === CALORIE_ID) void calorieToggled(token, true);
  };

  const remove = (a: Addon) =>
    Alert.alert(
      `Remove ${a.name}?`,
      a.id === CALORIE_ID
        ? "It comes off your apps, and OVOA goes back to noting food quietly, with no numbers. Add it back any time and it asks the way you chose."
        : "It comes off your apps. Anything it switched on stays on until you turn it off, and you can add it back any time.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            void installedAddons.remove(a.id);
            if (a.id === CALORIE_ID) void calorieToggled(token, false);
          },
        },
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

        {showCreate && (
          <View ref={spotRef("Create")} collapsable={false}>
          <PressScale
            onPress={create}
            accessibilityRole="button"
            accessibilityLabel="Create an app"
            accessibilityHint="Say or type what you want, and OVOA makes it"
            style={[styles.create, pointed === "Create" && styles.createPointed]}
          >
            <View style={styles.createIcon}>
              <Ionicons name="add" size={28} color={colors.paper} />
            </View>
            <View style={styles.body}>
              <Text style={styles.name}>Create</Text>
              <Text style={styles.about}>Say or type what you want, and OVOA makes it into an app.</Text>
              {!can.chat && <Text style={[styles.by, styles.tag]}>Part of a plan</Text>}
            </View>
            <Ionicons name="mic-outline" size={22} color={colors.now} />
          </PressScale>
          </View>
        )}

        {(yours.length > 0 || mine.length > 0) && (
          <>
            <GroupLabel>Your apps</GroupLabel>
            {yours.map((a, i) => (
              <AddonRow
                key={a.id}
                index={i}
                addon={a}
                tag={planTag(a)}
                action="Open"
                onPress={(from) => expandFrom(from, toneWash(a.tone), () => router.navigate(a.href))}
                onLongPress={() => remove(a)}
              />
            ))}
            {mine.map((a, i) => (
              <AddonRow
                key={a.id}
                index={yours.length + i}
                addon={madeCard(a, me)}
                action="Open"
                onPress={(from) => expandFrom(from, toneWash(a.tone), () => openMine(a))}
                onLongPress={() => deleteMine(a)}
              />
            ))}
          </>
        )}

        {more.length > 0 && (
          <>
            <GroupLabel>Add-ons</GroupLabel>
            {more.map((a, i) => (
              <AddonRow
                key={a.id}
                index={yours.length + mine.length + i}
                addon={a}
                tag={planTag(a)}
                action="Install"
                onPress={() => install(a)}
              />
            ))}
          </>
        )}

        {found.length === 0 && mine.length === 0 ? (
          <Empty icon="search" title="No apps found" body={`Nothing matches "${query.trim()}".`} />
        ) : (
          <>
            <Text style={styles.hint}>
              Daily usage is what your plan allows each day: your replies, and the work behind them. It resets every
              day. Apps that use more leave less for talking.
            </Text>
            {(yours.length > 0 || mine.length > 0) && (
              <Text style={styles.hint}>Press and hold one of your apps to remove it.</Text>
            )}
          </>
        )}
      </Screen>
    </View>
  );
}

function AddonRow({
  addon,
  index,
  tag,
  action,
  onPress,
  onLongPress,
}: {
  addon: Card;
  /** Its place in the list, so the list cascades in. */
  index: number;
  /** Which plan it comes with, when this person's doesn't include it. */
  tag?: string;
  action: "Open" | "Install";
  /** Given where the card is on screen, so opening can grow out of it. */
  onPress: (from: SpotRect | null) => void;
  onLongPress?: () => void;
}) {
  const box = useRef<View>(null);
  const press = () => {
    const node = box.current;
    if (!node) return onPress(null);
    node.measureInWindow((x, y, width, height) => onPress(width > 0 ? { x, y, width, height } : null));
  };
  return (
    <Rise index={index}>
    <View ref={box} collapsable={false}>
    <PressScale
      onPress={press}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={`${action} ${addon.name}, by ${addon.by}`}
      accessibilityHint={addon.about}
      style={styles.card}
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
    </PressScale>
    </View>
    </Rise>
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

  create: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.s3,
    backgroundColor: colors.nowWash,
    borderRadius: radius.tile,
    padding: space.s3,
    borderWidth: 2,
    borderColor: "transparent",
  },
  // Pointed at by the spoken tour.
  createPointed: { borderColor: colors.now },
  createIcon: {
    width: 46,
    height: 46,
    borderRadius: 14,
    backgroundColor: colors.now,
    alignItems: "center",
    justifyContent: "center",
  },

  hint: { ...type.meta, color: colors.inkMute, textAlign: "center", paddingTop: space.s4 },
});
