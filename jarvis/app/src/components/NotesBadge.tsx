import { StyleSheet, Text, View } from "react-native";
import { useAgent } from "../lib/agent";
import { colors } from "../lib/theme";

/** The count on the Journal tab: how many things OVOA said that you haven't read. */
export function NotesBadge() {
  const { unread } = useAgent();
  if (!unread) return null;
  return (
    <View style={styles.badge}>
      <Text style={styles.badgeText}>{unread > 9 ? "9+" : unread}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    position: "absolute",
    top: -3,
    right: -10,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 4,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { color: colors.bg, fontSize: 10, fontWeight: "700" },
});
