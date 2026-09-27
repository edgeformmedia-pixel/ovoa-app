import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Share, StyleSheet, Text, View } from "react-native";
import { Btn, Empty, GroupLabel, Screen } from "../components/ui";
import { api, type Invite } from "../lib/api";
import { useSession } from "../lib/auth";
import { logFail } from "../lib/devlog";
import { colors, space, type } from "../lib/theme";

// Invite a friend (api/src/invites.ts). The invite is a text they send
// themselves, through the Share sheet; OVOA never texts the friend. When the
// friend texts OVOA saying who sent them and later links an account, the
// person who invited them hears about it, and the count here goes up.
// Settings, "Other people's OVOAs" opens it.

export default function InviteScreen() {
  const { token } = useSession();
  const [invite, setInvite] = useState<Invite | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setInvite(await api.invites(token));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!invite) {
    return (
      <View style={styles.center}>
        {error ? (
          <Empty icon="cloud-offline-outline" title="Couldn't load your invite" body={error} action={{ label: "Try again", onPress: () => void load() }} />
        ) : (
          <ActivityIndicator color={colors.now} />
        )}
      </View>
    );
  }

  const share = () => Share.share({ message: invite.text }).catch(logFail("invite: share"));

  return (
    <Screen>
      <Text style={styles.lead}>Send a friend this text. They text OVOA and can try it right away, no app needed.</Text>
      <View style={styles.card}>
        <Text style={styles.body}>{invite.text}</Text>
      </View>
      <Btn label="Share invite" kind="go" style={styles.left} onPress={share} />
      {!invite.username && (
        <Text style={styles.meta}>
          Pick a username in Settings so OVOA knows your friends came from you. Until then the invite still works, you just
          won't hear when they join.
        </Text>
      )}

      <GroupLabel>Your invites</GroupLabel>
      <Text style={styles.body}>
        {invite.joined === 1 ? "1 friend joined" : `${invite.joined} friends joined`}
        {invite.waiting ? `, ${invite.waiting} tried it and haven't joined yet` : ""}.
      </Text>
      <Text style={styles.meta}>OVOA only texts people who text it first. It never messages your friends for you.</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.paper, padding: space.s4 },
  lead: { ...type.sub, color: colors.inkDim, marginTop: space.s2 },
  card: { backgroundColor: colors.wash, borderRadius: 14, padding: space.s3 },
  body: { ...type.body, color: colors.ink },
  meta: { ...type.meta, color: colors.inkMute },
  left: { alignSelf: "flex-start" },
});
