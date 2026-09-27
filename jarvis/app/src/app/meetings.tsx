import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, RefreshControl, StyleSheet, Text, View } from "react-native";
import { Btn, Empty, Screen } from "../components/ui";
import { api, type MeetingOffer } from "../lib/api";
import { useSession } from "../lib/auth";
import { logFail } from "../lib/devlog";
import { colors, space, type } from "../lib/theme";

// Offers of meeting times sent by email (api/src/meetings.ts): the ones still
// waiting for your approval or for the other person's reply, with Cancel.
// "Find a time with dana@x.com" in a chat starts one. Settings, "When it acts
// for you" opens this.

export default function MeetingsScreen() {
  const { token } = useSession();
  const [offers, setOffers] = useState<MeetingOffer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setOffers((await api.meetings(token)).meetings);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const cancel = (offer: MeetingOffer) =>
    Alert.alert("Cancel this?", `OVOA stops finding a time with ${offer.name ?? offer.email}.`, [
      { text: "Keep it", style: "cancel" },
      {
        text: "Cancel it",
        style: "destructive",
        onPress: () => {
          api
            .cancelMeeting(token, offer.id)
            .then(load)
            .catch(logFail("meetings: cancel"));
        },
      },
    ]);

  if (!offers) {
    return (
      <View style={styles.center}>
        {error ? (
          <Empty icon="cloud-offline-outline" title="Couldn't load your offers" body={error} action={{ label: "Try again", onPress: () => void load() }} />
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
              .catch(logFail("meetings: refresh"))
              .finally(() => setRefreshing(false));
          }}
        />
      }
    >
      <Text style={styles.lead}>
        Times OVOA offered someone by email. It asks you before sending the offer, and again before sending the invite.
      </Text>
      {offers.length === 0 ? (
        <Text style={styles.meta}>Nothing open. Ask OVOA to "find a time with dana@example.com next week".</Text>
      ) : (
        offers.map((o) => (
          <View key={o.id} style={styles.card}>
            <Text style={styles.body}>
              {o.title} with {o.name ?? o.email}
            </Text>
            <Text style={styles.meta}>{o.status === "waiting_for_your_approval" ? "Waiting for your OK to send" : "Sent, waiting for their reply"}</Text>
            {o.times.map((t) => (
              <Text key={t} style={styles.meta}>
                {t}
              </Text>
            ))}
            <Btn label="Cancel" kind="quiet" style={styles.left} onPress={() => cancel(o)} />
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
