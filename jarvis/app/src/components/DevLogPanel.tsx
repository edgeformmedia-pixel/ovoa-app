import * as Clipboard from "expo-clipboard";
import { useRef } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { clearDevLog, clock, formatDevLog, useDevLog, type LogKind } from "../lib/devlog";
import { colors } from "../lib/theme";

const KIND_COLORS: Record<LogKind, string> = {
  req: colors.accent,
  res: colors.success,
  err: colors.danger,
  voice: colors.textDim,
  log: colors.textDim,
  warn: colors.danger,
  ble: colors.accent,
  probe: colors.warning,
  push: colors.accent,
  agent: colors.warning,
};

/** Live log of app ↔ API traffic and the voice engine, for debugging. */
export function DevLogPanel({ live, onClose }: { live: string; onClose: () => void }) {
  const entries = useDevLog();
  const scroll = useRef<ScrollView>(null);

  return (
    <View style={styles.panel}>
      <View style={styles.bar}>
        <Text style={styles.live} numberOfLines={1}>
          {live}
        </Text>
        <Pressable hitSlop={8} onPress={() => Clipboard.setStringAsync(formatDevLog(entries))}>
          <Text style={styles.action}>Copy</Text>
        </Pressable>
        <Pressable hitSlop={8} onPress={clearDevLog}>
          <Text style={styles.action}>Clear</Text>
        </Pressable>
        <Pressable hitSlop={8} onPress={onClose}>
          <Text style={styles.action}>Close</Text>
        </Pressable>
      </View>
      <ScrollView
        ref={scroll}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 10, gap: 6 }}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
      >
        {entries.length === 0 && <Text style={styles.detail}>Nothing yet. Turn listening on and say something.</Text>}
        {entries.map((e) => (
          <View key={e.id}>
            <Text style={styles.line} selectable>
              <Text style={styles.time}>{clock(e.time)} </Text>
              <Text style={{ color: KIND_COLORS[e.kind], fontWeight: "700" }}>{e.kind.toUpperCase()} </Text>
              <Text style={{ color: e.kind === "err" ? colors.danger : colors.text }}>{e.text}</Text>
            </Text>
            {e.detail && (
              <Text style={styles.detail} selectable>
                {e.detail}
              </Text>
            )}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const mono = { fontFamily: "Menlo", fontSize: 11 } as const;

const styles = StyleSheet.create({
  panel: {
    flex: 1.3,
    backgroundColor: colors.surface,
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  live: { ...mono, flex: 1, color: colors.textDim },
  action: { color: colors.accent, fontSize: 14, fontWeight: "600" },
  line: { ...mono, lineHeight: 15 },
  time: { color: colors.textDim },
  detail: { ...mono, color: colors.textDim, marginLeft: 12, lineHeight: 15 },
});
