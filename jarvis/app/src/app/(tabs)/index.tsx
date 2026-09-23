import { View, StyleSheet, Text } from "react-native";
import { HealthCards } from "../../components/HealthCards";
import { FreeToday } from "../../components/FreeToday";
import { Steps } from "../../components/Steps";
import { Screen, TopBar } from "../../components/ui";
import { usePlan } from "../../lib/plan";
import { colors, space, type } from "../../lib/theme";

// Health, and only health. What OVOA did, what's due and what slipped used to
// pile up on top of this screen as a stack of cards; all of that is on the
// spine on Day now, in the order it happened.
//
// On the free plan this is the first screen, so it is the day itself: the
// spine of today's notes, with health under it (components/FreeToday.tsx).

export default function Home() {
  const { free } = usePlan();
  return free ? <FreeToday /> : <Activity />;
}

function Activity() {
  const when = new Date().toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  return (
    <View style={styles.page}>
      <TopBar title="Activity" when={when} />
      <Screen>
        <Steps />

        <HealthCards />

        <Text style={styles.footnote}>Distance is an estimate based on average stride.</Text>
      </Screen>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.paper },
  footnote: { ...type.meta, color: colors.inkMute, textAlign: "center", paddingTop: space.s4 },
});
