import Ionicons from "@expo/vector-icons/Ionicons";
import { router, useFocusEffect, type Href } from "expo-router";
import { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { Empty, GroupLabel, IconTile, Screen } from "../components/ui";
import { api, type Campaign, type CampaignDetail } from "../lib/api";
import { useSession } from "../lib/auth";
import { finished, MODES, STATUS } from "../lib/campaigns";
import { logFail } from "../lib/devlog";
import { colors, numeric, space, type } from "../lib/theme";

// Campaigns (api/src/campaigns.ts): one job done for many people or things,
// like the same email to 40 venues or a lookup for every row of a list. OVOA
// asks once, with the count and the cost, then works through it a few at a
// time in the daytime. They're started by talking or texting OVOA; this is
// where they're watched, and one opens to its results and a Stop button
// (app/campaign/[id].tsx). Settings, Assistant, "When it acts for you" opens it.

const DAY = { month: "short", day: "numeric" } as const;
const active = (c: Campaign) => c.status === "running" || c.status === "waiting_for_approval";

export default function Campaigns() {
  const { token } = useSession();
  const [list, setList] = useState<Campaign[] | null>(null);
  // How far along the running ones are. The list doesn't carry counts, and
  // there are at most three going at once (MAX_ACTIVE), so each is asked for.
  const [counts, setCounts] = useState<Record<string, CampaignDetail["counts"]>>({});
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const { campaigns } = await api.campaigns(token);
      setList(campaigns);
      setError(null);
      const going = await Promise.all(
        campaigns.filter((c) => c.status === "running").map((c) =>
          api
            .campaign(token, c.id)
            .then((d) => [c.id, d.counts] as const)
            .catch(() => null),
        ),
      );
      setCounts(Object.fromEntries(going.filter((g) => g !== null)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [token]);

  // Fresh each time it's opened: one may have finished, or been stopped, meanwhile.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (!list) {
    return (
      <View style={styles.center}>
        {error ? (
          <Empty
            icon="cloud-offline-outline"
            title="Couldn't load your campaigns"
            body={error}
            action={{ label: "Try again", onPress: () => void load() }}
          />
        ) : (
          <ActivityIndicator color={colors.now} />
        )}
      </View>
    );
  }

  const going = list.filter(active);
  const over = list.filter((c) => !active(c));

  return (
    <Screen
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            load()
              .catch(logFail("campaigns: refresh"))
              .finally(() => setRefreshing(false));
          }}
        />
      }
    >
      <Text style={styles.lead}>
        One job for lots of people or things, like the same email to 40 venues. OVOA asks you once before it starts, then works
        through it a few at a time during the day.
      </Text>
      {!!error && <Text style={styles.error}>{error}</Text>}

      {list.length === 0 ? (
        <Empty
          icon="megaphone-outline"
          title="No campaigns yet"
          body={`Text or tell OVOA something like "email these 20 venues asking about their availability" and it'll ask you once before it starts.`}
        />
      ) : (
        <>
          {going.length > 0 && (
            <View>
              <GroupLabel>Going now</GroupLabel>
              {going.map((c, i) => (
                <CampaignRow key={c.id} c={c} counts={counts[c.id]} first={i === 0} />
              ))}
            </View>
          )}
          {over.length > 0 && (
            <View>
              <GroupLabel>Finished</GroupLabel>
              {over.map((c, i) => (
                <CampaignRow key={c.id} c={c} first={i === 0} />
              ))}
            </View>
          )}
        </>
      )}
    </Screen>
  );
}

function CampaignRow({ c, counts, first }: { c: Campaign; counts?: CampaignDetail["counts"]; first: boolean }) {
  const mode = MODES[c.mode] ?? MODES.research;
  const status = STATUS[c.status] ?? STATUS.stopped;
  // Only a running one has progress worth showing: one waiting for its OK hasn't started.
  const done = counts && c.status === "running" ? finished(counts) : null;
  const share = done !== null && c.items > 0 ? Math.min(1, done / c.items) : 0;
  return (
    <Pressable
      style={[styles.row, first && styles.rowFirst]}
      onPress={() => router.push(`/campaign/${c.id}` as Href)}
      accessibilityRole="button"
    >
      <IconTile name={mode.icon} tone={mode.tone} size={36} />
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={styles.head} numberOfLines={2}>
          {c.title}
        </Text>
        <Text style={styles.meta}>
          {mode.label} · {new Date(c.createdAt).toLocaleDateString(undefined, DAY)} ·{" "}
          <Text style={numeric}>
            {done !== null ? `${done} of ${c.items} done` : `${c.items} ${c.items === 1 ? "item" : "items"}`}
          </Text>
        </Text>
        {done !== null && (
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${share * 100}%` }]} />
          </View>
        )}
      </View>
      <View style={[styles.chip, { backgroundColor: status.wash }]}>
        <Text style={[styles.chipText, { color: status.ink }]}>{status.label}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.inkMute} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.paper, padding: space.s4 },
  lead: { ...type.sub, color: colors.inkDim, marginTop: space.s2 },
  head: { ...type.head, color: colors.ink },
  meta: { ...type.meta, color: colors.inkMute },
  error: { ...type.meta, color: colors.stop },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.s3,
    paddingVertical: space.s3,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  rowFirst: { borderTopWidth: 0 },
  track: { height: 6, borderRadius: 3, backgroundColor: colors.wash2, overflow: "hidden", marginTop: 2 },
  fill: { height: 6, borderRadius: 3, backgroundColor: colors.done },
  chip: { paddingHorizontal: space.s2, paddingVertical: 3, borderRadius: 10 },
  chipText: { ...type.meta, fontWeight: "600" },
});
