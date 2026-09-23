import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { ActivityIndicator, RefreshControl, StyleSheet, Text, View } from "react-native";
import { PartOfPlan } from "../../components/Plan";
import { Btn, Screen, TopBar, text } from "../../components/ui";
import { api, type MorningBrief } from "../../lib/api";
import { useSession } from "../../lib/auth";
import { usePlan } from "../../lib/plan";
import { colors, space, type } from "../../lib/theme";
import { SkeletonList } from "../../components/motion";

// What OVOA would say to you this morning, exactly as it would say it. The
// server builds it — api/src/rhythm.ts, buildMorningBrief — and this screen
// only reads it onto the page. It composes nothing of its own: if the brief is
// wrong here, it is wrong out loud too, which is the point of having a screen
// for it at all.

export default function Brief() {
  const { can } = usePlan();
  if (!can.chat) {
    return (
      <PartOfPlan
        title="Brief"
        what="Each morning OVOA reads you your day: the weather, your calendar, your list, and anything someone asked of you."
      />
    );
  }
  return <MorningBrief />;
}

function MorningBrief() {
  const { token, user } = useSession();
  const [brief, setBrief] = useState<MorningBrief | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  // `fresh`: a pull to refresh builds a new brief. Coming back to the screen
  // takes the one the server built in the last quarter of an hour, which is
  // weather, calendar, mail and a model call saved on every glance.
  const load = useCallback(
    async (alive: () => boolean = () => true, fresh = false) => {
      setState((s) => (s === "ok" ? s : "loading"));
      try {
        const r = await api.brief(token, fresh);
        if (!alive()) return;
        setBrief(r);
        setState("ok");
      } catch (err) {
        if (!alive()) return;
        setError(err instanceof Error ? err.message : String(err));
        setState("error");
      }
    },
    [token],
  );

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void load(() => !cancelled);
      return () => {
        cancelled = true;
      };
    }, [load]),
  );

  // How long it has had to learn anything, which is the honest framing for the
  // empty state below.
  const mornings = Math.max(1, Math.round((Date.now() - user.created_at) / 86_400_000));
  const when = new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });

  return (
    <View style={styles.page}>
      <TopBar title="Brief" when={when} />
      <Screen
        refreshControl={
          <RefreshControl refreshing={state === "loading" && !!brief} onRefresh={() => void load(undefined, true)} tintColor={colors.now} />
        }
      >
        {state === "loading" && !brief && <SkeletonList rows={5} />}

        {state === "error" && !brief && (
          <>
            <Text style={text.sub}>{error}</Text>
            <Btn label="Try again" onPress={() => void load()} style={{ alignSelf: "flex-start" }} />
          </>
        )}

        {!!brief && <Text style={styles.spoken}>{brief.text}</Text>}

        {!!brief && (
          <>
            <View style={styles.age}>
              <Text style={styles.ageText}>What it has learned</Text>
              <View style={styles.rule} />
            </View>
            {/*
              TODO(brief-learning): nothing writes to this yet. The brief is
              assembled fresh from the calendar, the list, the weather and the
              rest every morning, and nothing records what you talked over,
              asked about twice, or never once needed — so there is nothing to
              show. It is left as an empty state on purpose rather than filled
              with examples: a list of things it has "learned" that it has not
              actually learned would be a lie told in the app's own voice. The
              loop that feeds it is a separate piece of work with its own
              design.
            */}
            <Text style={text.sub}>
              Nothing yet — {mornings === 1 ? "one morning" : `${mornings} mornings`} in. It reads your calendar, your
              list and the weather, and says all of it in the order it found it.
            </Text>
          </>
        )}
      </Screen>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.paper },
  // The one paragraph on the screen, set to be read rather than scanned.
  spoken: { ...type.lead, color: colors.ink, lineHeight: 29, letterSpacing: -0.2, paddingTop: space.s2 },
  age: { flexDirection: "row", alignItems: "center", gap: space.s2, marginTop: space.s5, marginBottom: space.s2 },
  ageText: { ...type.meta, fontWeight: "600", color: colors.inkMute },
  rule: { flex: 1, height: 1, backgroundColor: colors.line },
});
