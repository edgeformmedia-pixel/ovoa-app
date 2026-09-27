import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, RefreshControl, StyleSheet, Text, View } from "react-native";
import { Btn, Empty, GroupLabel, IconTile, Screen } from "../components/ui";
import { api, type SignedInSite } from "../lib/api";
import { useSession } from "../lib/auth";
import { logFail } from "../lib/devlog";
import { colors, space, type } from "../lib/theme";

// Signed-in sites (api/src/sitesessions.ts, docs/logins-without-passwords.md):
// sites they signed into themselves and lent to OVOA's browser, so it can act
// there as them. OVOA never sees a password. Each lasts 30 days at most and
// can be removed here. Adding one needs the site's cookies read out of an
// in-app browser, which takes a native cookie library the app doesn't have
// yet, so for now this lists and removes, and says adding is coming.
// Settings, Assistant, "When it acts for you" opens it.

const DAY = { month: "short", day: "numeric" } as const;
const day = (at: number) => new Date(at).toLocaleDateString(undefined, DAY);

export default function SignedInSites() {
  const { token } = useSession();
  const [sites, setSites] = useState<SignedInSite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setSites((await api.signedInSites(token)).sites);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = (site: SignedInSite) =>
    Alert.alert(`Remove ${site.host}?`, "OVOA won't be signed in there any more.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: async () => {
          try {
            await api.removeSignedInSite(token, site.host);
            setSites((list) => list?.filter((s) => s.host !== site.host) ?? null);
          } catch (err) {
            Alert.alert("Couldn't remove that", err instanceof Error ? err.message : String(err));
          }
        },
      },
    ]);

  if (!sites) {
    return (
      <View style={styles.center}>
        {error ? (
          <Empty
            icon="cloud-offline-outline"
            title="Couldn't load your sites"
            body={error}
            action={{ label: "Try again", onPress: () => void load() }}
          />
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
              .catch(logFail("signed-in sites: refresh"))
              .finally(() => setRefreshing(false));
          }}
        />
      }
    >
      <Text style={styles.lead}>
        Sites you've signed into for OVOA, so it can use them for you, like booking a table or checking an order. It never sees
        your password, anything it'd buy or book still waits for your OK, and it never signs into banks or payment apps.
      </Text>
      {!!error && <Text style={styles.error}>{error}</Text>}

      <View style={styles.card}>
        <Text style={styles.head}>Adding a site is coming soon</Text>
        <Text style={styles.sub}>
          You'll sign in once, right here in the app, and OVOA can use that site for up to 30 days. Until then, the ones below
          can be removed any time.
        </Text>
      </View>

      <GroupLabel>Your sites</GroupLabel>
      {sites.length === 0 ? (
        <Text style={styles.meta}>No signed-in sites yet.</Text>
      ) : (
        sites.map((site, i) => (
          <View key={site.host} style={[styles.site, i === 0 && styles.siteFirst]}>
            <IconTile name="globe-outline" tone="blue" />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.body} numberOfLines={1}>
                {site.host}
              </Text>
              <Text style={styles.meta}>
                {site.lastUsed ? `Last used ${day(site.lastUsed)}` : "Not used yet"} · good until {day(site.expiresAt)}
              </Text>
            </View>
            <Btn label="Remove" kind="quiet" onPress={() => remove(site)} />
          </View>
        ))
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.paper, padding: space.s4 },
  lead: { ...type.sub, color: colors.inkDim, marginTop: space.s2 },
  head: { ...type.head, color: colors.ink },
  body: { ...type.body, color: colors.ink },
  sub: { ...type.sub, color: colors.inkDim },
  meta: { ...type.meta, color: colors.inkMute },
  error: { ...type.meta, color: colors.stop },
  card: { gap: space.s2, padding: space.s4, borderRadius: 18, backgroundColor: colors.wash, marginTop: space.s2 },
  site: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.s3,
    paddingVertical: space.s3,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  siteFirst: { borderTopWidth: 0 },
});
