import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { View, StyleSheet, Text } from "react-native";
import { HealthCards } from "../../components/HealthCards";
import { Steps } from "../../components/Steps";
import { Screen, TopBar } from "../../components/ui";
import { api, type HealthDay } from "../../lib/api";
import { useSession } from "../../lib/auth";
import { logFail } from "../../lib/devlog";
import { healthStatus, onHealthStatus } from "../../lib/healthSync";
import { colors, space, type } from "../../lib/theme";

// Health, and only health. What OVOA did, what's due and what slipped used to
// pile up on top of this screen as a stack of cards; all of that is on the
// spine on Day now, in the order it happened.
//
// An app you install from Apps (lib/addons.ts); it used to be the home screen.
// It is the "heart rate app": steps, then HealthCards — the heart rate the Band
// and any watch measured (HeartCard, from the server), then sleep and the body
// from Apple Health. None of it calls a model, so it's free on every plan.

export default function Activity() {
  const { token } = useSession();
  const when = new Date().toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  // The week as the server has it, fetched once per visit for both cards: the
  // resting heart rate bars, the 7-day averages, and today's copy for when
  // Apple Health can't be read.
  const [week, setWeek] = useState<HealthDay[] | null>(null);
  // Said only once it's true: saving to Health can be turned off in the sheet.
  const [savedToHealth, setSavedToHealth] = useState(healthStatus().writeHeart === "on");
  useEffect(() => onHealthStatus(() => setSavedToHealth(healthStatus().writeHeart === "on")), []);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      api
        .healthDays(token, 7)
        .then((r) => alive && setWeek(r.days))
        .catch(logFail("activity: healthDays"));
      return () => {
        alive = false;
      };
    }, [token]),
  );

  return (
    <View style={styles.page}>
      <TopBar title="Activity" when={when} />
      <Screen>
        <Steps />

        <HealthCards week={week} syncOnFocus />

        <View style={styles.footnotes}>
          {savedToHealth && <Text style={styles.footnote}>Your OVOA Band&apos;s heart rate is also saved to Apple Health.</Text>}
          <Text style={styles.footnote}>Distance is an estimate based on average stride.</Text>
        </View>
      </Screen>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.paper },
  footnotes: { paddingTop: space.s4 },
  footnote: { ...type.meta, color: colors.inkMute, textAlign: "center" },
});
