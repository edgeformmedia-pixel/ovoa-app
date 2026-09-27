import { File, Paths } from "expo-file-system";
import { router, Stack, useLocalSearchParams, type Href } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Platform, RefreshControl, Share, StyleSheet, Text, View } from "react-native";
import { Btn, Empty, GroupLabel, IconTile, Screen } from "../../components/ui";
import { api, ApiError, type CampaignDetail } from "../../lib/api";
import { useSession } from "../../lib/auth";
import { finished, itemName, ITEM_STATUS, MODES, STATUS } from "../../lib/campaigns";
import { logFail } from "../../lib/devlog";
import { colors, numeric, space, type } from "../../lib/theme";

// One campaign (Campaigns, then a campaign; or the "Campaign finished"
// notification): how far it got, what it sends or looks up, every item's
// result, a Stop button while it's going, and the whole thing as a spreadsheet
// for the share sheet. The server pages the results 100 at a time
// (api/src/campaigns.ts GET /campaigns/:id).

const WHEN = { dateStyle: "medium", timeStyle: "short" } as const;
type Results = CampaignDetail["results"];

export default function CampaignScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { token } = useSession();
  // undefined while loading, null once the server says there's no such campaign.
  const [c, setC] = useState<CampaignDetail | null | undefined>(undefined);
  const [results, setResults] = useState<Results>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<"stop" | "share" | "more" | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api.campaign(token, id);
      setC(d);
      setResults(d.results);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setC(null);
      else setError(err instanceof Error ? err.message : String(err));
    }
  }, [token, id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (c === null) {
    return (
      <View style={styles.center}>
        <Empty
          icon="megaphone-outline"
          title="This campaign is gone"
          body="It isn't on your account any more."
          action={{ label: "Back to Campaigns", onPress: () => router.navigate("/campaigns" as Href) }}
        />
      </View>
    );
  }
  if (c === undefined) {
    return (
      <View style={styles.center}>
        {error ? (
          <Empty
            icon="cloud-offline-outline"
            title="Couldn't load this campaign"
            body={error}
            action={{ label: "Try again", onPress: () => void load() }}
          />
        ) : (
          <ActivityIndicator color={colors.now} />
        )}
      </View>
    );
  }

  const mode = MODES[c.mode] ?? MODES.research;
  const status = STATUS[c.status] ?? STATUS.stopped;
  const waiting = c.status === "waiting_for_approval";
  const going = waiting || c.status === "running";
  const done = finished(c.counts);
  const left = (c.counts.pending ?? 0) + (c.counts.working ?? 0);
  const share = c.items > 0 ? Math.min(1, done / c.items) : 0;
  const tally = [
    `${c.counts.done ?? 0} ${mode.verb}`,
    c.counts.skipped ? `${c.counts.skipped} skipped (on your do not contact list)` : "",
    c.counts.failed ? `${c.counts.failed} didn't work` : "",
    left ? `${left} ${c.status === "stopped" ? "not done" : "to go"}` : "",
  ].filter(Boolean);
  const filledIn = /\{[^}]+\}/.test(`${c.subject ?? ""}\n${c.instructions}`);

  const stop = () =>
    Alert.alert(
      waiting ? "Cancel this campaign?" : "Stop this campaign?",
      waiting ? "Nothing has gone out yet, and nothing will." : "Anything already done stays done, and nothing else goes out.",
      [
        { text: waiting ? "Keep it" : "Keep going", style: "cancel" },
        {
          text: waiting ? "Cancel it" : "Stop it",
          style: "destructive",
          onPress: async () => {
            setBusy("stop");
            try {
              await api.stopCampaign(token, c.id);
              await load();
            } catch (err) {
              Alert.alert("Couldn't stop it", err instanceof Error ? err.message : String(err));
            } finally {
              setBusy(null);
            }
          },
        },
      ],
    );

  // The spreadsheet as a .csv file on iOS, so the share sheet offers Files,
  // Mail and Numbers; Android's share takes text only, so it goes as text there.
  const shareCsv = async () => {
    setBusy("share");
    try {
      const csv = await api.campaignCsv(token, c.id);
      const name = `${c.title.replace(/[^\w ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "campaign"}.csv`;
      if (Platform.OS === "ios") {
        const file = new File(Paths.cache, name);
        file.write(csv);
        await Share.share({ url: file.uri, title: c.title });
      } else {
        await Share.share({ message: csv, title: c.title });
      }
    } catch (err) {
      Alert.alert("Couldn't share that", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const loadMore = async () => {
    setBusy("more");
    try {
      const d = await api.campaign(token, c.id, results.length);
      setResults((r) => [...r, ...d.results.filter((x) => !r.some((y) => y.idx === x.idx))]);
    } catch (err) {
      Alert.alert("Couldn't load more", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Stack.Screen options={{ title: c.title }} />
      <Screen
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              load()
                .catch(logFail("campaign: refresh"))
                .finally(() => setRefreshing(false));
            }}
          />
        }
      >
        <View style={styles.header}>
          <IconTile name={mode.icon} tone={mode.tone} size={36} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.meta}>
              {mode.label} · started {new Date(c.createdAt).toLocaleString(undefined, WHEN)}
            </Text>
            {!!c.finishedAt && (
              <Text style={styles.meta}>
                {c.status === "stopped" ? "Stopped" : "Finished"} {new Date(c.finishedAt).toLocaleString(undefined, WHEN)}
              </Text>
            )}
          </View>
          <View style={[styles.chip, { backgroundColor: status.wash }]}>
            <Text style={[styles.chipText, { color: status.ink }]}>{status.label}</Text>
          </View>
        </View>
        {!!error && <Text style={styles.error}>{error}</Text>}

        {waiting ? (
          <Text style={styles.body}>
            It's waiting for your OK where OVOA asked you, in Talk or by text, with how many it's for and what it costs. Nothing
            goes out until you say yes.
          </Text>
        ) : (
          <View style={styles.progress}>
            <Text style={styles.big}>
              {done} <Text style={styles.of}>of {c.items}</Text>
            </Text>
            <View style={styles.track}>
              <View style={[styles.fill, { width: `${share * 100}%` }]} />
            </View>
            <Text style={styles.meta}>{tally.join(" · ")}</Text>
            {c.status === "running" && (
              <Text style={styles.meta}>It works through a few at a time, only during the day and outside your quiet hours.</Text>
            )}
          </View>
        )}

        <View style={styles.row}>
          {going && (
            <Btn label={waiting ? "Cancel it" : "Stop"} kind="danger" busy={busy === "stop"} onPress={stop} />
          )}
          {!waiting && (
            <Btn label="Share as a spreadsheet" busy={busy === "share"} disabled={!!busy} onPress={() => void shareCsv()} />
          )}
        </View>

        <GroupLabel>{c.mode === "research" ? "What it looks up" : c.mode === "email" ? "The email" : "The note"}</GroupLabel>
        <View style={styles.card}>
          {!!c.subject && <Text style={styles.head}>{c.subject}</Text>}
          <Text style={styles.sub} selectable>
            {c.instructions}
          </Text>
          {filledIn && <Text style={styles.meta}>Anything in {"{curly brackets}"} is filled in from each item.</Text>}
        </View>

        <GroupLabel>Results</GroupLabel>
        {results.length === 0 ? (
          <Text style={styles.meta}>Nothing here yet.</Text>
        ) : (
          results.map((r, i) => {
            // A stopped campaign leaves the rest pending for good: they won't be done.
            const s =
              c.status === "stopped" && r.status === "pending"
                ? { label: "Not done", ink: colors.inkMute }
                : (ITEM_STATUS[r.status] ?? ITEM_STATUS.pending);
            return (
              <View key={r.idx} style={[styles.item, i === 0 && styles.itemFirst]}>
                <View style={styles.itemTop}>
                  <Text style={[styles.meta, numeric]}>{r.idx + 1}</Text>
                  <Text style={[styles.body, { flex: 1 }]} numberOfLines={1}>
                    {itemName(r.data, r.idx)}
                  </Text>
                  <Text style={[styles.status, { color: s.ink }]}>{s.label}</Text>
                </View>
                {!!r.result && (
                  <Text style={styles.sub} selectable>
                    {r.result}
                  </Text>
                )}
              </View>
            );
          })
        )}
        {results.length < c.items && (
          <Btn
            label={`Show more (${c.items - results.length} left)`}
            busy={busy === "more"}
            style={styles.left}
            onPress={() => void loadMore()}
          />
        )}
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.paper, padding: space.s4 },
  header: { flexDirection: "row", alignItems: "center", gap: space.s3, marginTop: space.s2 },
  body: { ...type.body, color: colors.ink },
  head: { ...type.head, color: colors.ink },
  sub: { ...type.sub, color: colors.inkDim },
  meta: { ...type.meta, color: colors.inkMute },
  error: { ...type.meta, color: colors.stop },
  left: { alignSelf: "flex-start" },
  row: { flexDirection: "row", alignItems: "center", gap: space.s2, flexWrap: "wrap" },
  chip: { paddingHorizontal: space.s2, paddingVertical: 3, borderRadius: 10 },
  chipText: { ...type.meta, fontWeight: "600" },
  progress: { gap: space.s2, paddingVertical: space.s2 },
  big: { ...type.title, color: colors.ink, ...numeric },
  of: { ...type.sub, color: colors.inkMute },
  track: { height: 8, borderRadius: 4, backgroundColor: colors.wash2, overflow: "hidden" },
  fill: { height: 8, borderRadius: 4, backgroundColor: colors.done },
  card: { gap: space.s2, padding: space.s4, borderRadius: 18, backgroundColor: colors.wash },
  item: { gap: 2, paddingVertical: space.s3, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  itemFirst: { borderTopWidth: 0 },
  itemTop: { flexDirection: "row", alignItems: "center", gap: space.s2 },
  status: { ...type.meta, fontWeight: "600" },
});
