import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, RefreshControl, StyleSheet, Text, View } from "react-native";
import { Btn, Empty, Screen } from "../components/ui";
import { api, type PageWatch } from "../lib/api";
import { useSession } from "../lib/auth";
import { logFail } from "../lib/devlog";
import { colors, space, type } from "../lib/theme";

// Pages OVOA watches (api/src/watches.ts): what each looks for, the page, how
// often, until when and what it last saw, with Stop. "Tell me when Saturday
// tickets drop" in a chat starts one. Settings, "When it acts for you" opens this.

const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });

function host(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export default function WatchesScreen() {
  const { token } = useSession();
  const [watches, setWatches] = useState<PageWatch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setWatches((await api.watches(token)).watches);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const stop = (w: PageWatch) => {
    const remove = () => {
      api
        .stopWatch(token, w.id)
        .then(load)
        .catch(logFail("watches: stop"));
    };
    // One that already happened just clears off the list.
    if (w.status === "happened") return remove();
    Alert.alert("Stop watching?", `OVOA stops checking ${host(w.url)} for "${w.lookingFor}".`, [
      { text: "Keep it", style: "cancel" },
      { text: "Stop", style: "destructive", onPress: remove },
    ]);
  };

  if (!watches) {
    return (
      <View style={styles.center}>
        {error ? (
          <Empty icon="cloud-offline-outline" title="Couldn't load what you're watching" body={error} action={{ label: "Try again", onPress: () => void load() }} />
        ) : (
          <ActivityIndicator color={colors.now} />
        )}
      </View>
    );
  }

  return (
    <Screen
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            load()
              .catch(logFail("watches: refresh"))
              .finally(() => setRefreshing(false));
          }}
        />
      }
    >
      <Text style={styles.lead}>Pages OVOA checks for you. It tells you once it happens, and it never buys or books anything.</Text>
      {watches.length === 0 ? (
        <Text style={styles.meta}>Nothing yet. Ask OVOA to "tell me when Saturday tickets go on sale" with a link.</Text>
      ) : (
        watches.map((w) => (
          <View key={w.id} style={styles.card}>
            <Text style={styles.body}>{w.lookingFor}</Text>
            <Text style={styles.meta}>{host(w.url)}</Text>
            <Text style={styles.meta}>
              {w.status === "happened" ? "It happened" : `Checks ${w.checks === "hourly" ? "every hour" : "once a day"} until ${day(w.until)}`}
            </Text>
            <Text style={styles.meta}>{w.lastSaw ? `Last saw: ${w.lastSaw}` : w.timesChecked > 0 ? "No change yet" : "Not checked yet"}</Text>
            <Btn label={w.status === "happened" ? "Clear" : "Stop"} kind="quiet" style={styles.left} onPress={() => stop(w)} />
          </View>
        ))
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.paper, padding: space.s4 },
  lead: { ...type.sub, color: colors.inkDim, marginTop: space.s2 },
  card: { backgroundColor: colors.wash, borderRadius: 14, padding: space.s3, gap: 4 },
  body: { ...type.body, color: colors.ink },
  meta: { ...type.meta, color: colors.inkMute },
  left: { alignSelf: "flex-start" },
});
