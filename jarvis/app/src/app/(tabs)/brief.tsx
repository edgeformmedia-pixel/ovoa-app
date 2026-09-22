import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { ActivityIndicator, RefreshControl, StyleSheet, Text, View } from "react-native";
import { Screen, TopBar, text } from "../../components/ui";
import { api, type MorningBrief } from "../../lib/api";
import { useSession } from "../../lib/auth";
import { colors, space, type } from "../../lib/theme";

// What OVOA would say to you this morning, exactly as it would say it. The
// server builds it (api/src/rhythm.ts, buildMorningBrief); this screen only
// reads it out onto the page.

export default function Brief() {
  const { token } = useSession();
  const [brief, setBrief] = useState<MorningBrief | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (alive: () => boolean = () => true) => {
      try {
        const r = await api.brief(token);
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

  const when = new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });

  return (
    <View style={styles.page}>
      <TopBar title="Brief" when={when} />
      <Screen
        refreshControl={
          <RefreshControl refreshing={state === "loading"} onRefresh={() => void load()} tintColor={colors.now} />
        }
      >
        {state === "loading" && !brief && <ActivityIndicator color={colors.now} style={{ marginTop: space.s8 }} />}
        {state === "error" && <Text style={text.sub}>{error}</Text>}
        {!!brief && <Text style={styles.spoken}>{brief.text}</Text>}
      </Screen>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.paper },
  spoken: { ...type.lead, color: colors.ink, lineHeight: 29, letterSpacing: -0.2 },
});
