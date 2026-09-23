import { View, StyleSheet, Text } from "react-native";
import { HealthCards } from "../../components/HealthCards";
import { Steps } from "../../components/Steps";
import { Screen, TopBar } from "../../components/ui";
import { colors, space, type } from "../../lib/theme";

// Health, and only health. What OVOA did, what's due and what slipped used to
// pile up on top of this screen as a stack of cards; all of that is on the
// spine on Day now, in the order it happened.
//
// An app you install from Apps (lib/addons.ts); it used to be the home screen.

export default function Activity() {
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
