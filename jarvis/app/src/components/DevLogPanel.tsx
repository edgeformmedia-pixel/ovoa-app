import * as Clipboard from "expo-clipboard";
import { useRef } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { clearDevLog, clock, formatDevLog, useDevLog, type LogKind, type LogLevel } from "../lib/devlog";
import { colors, mono as monoFont, space, type } from "../lib/theme";

const KIND_COLORS: Record<LogKind, string> = {
  req: colors.blue,
  res: colors.done,
  err: colors.stop,
  voice: colors.inkMute,
  log: colors.inkMute,
  warn: colors.stop,
  ble: colors.blue,
  probe: colors.late,
  push: colors.agent,
  agent: colors.agent,
  perf: colors.done,
  file: colors.inkMute,
  nav: colors.ink,
};

/** How bad it is, which is not the same question as which part of the app said it. */
const LEVEL_COLORS: Record<LogLevel, string> = {
  trace: colors.inkMute,
  debug: colors.inkMute,
  info: colors.ink,
  warn: colors.late,
  error: colors.stop,
  fatal: colors.stop,
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
              {e.count > 1 && <Text style={styles.count}>× {e.count} </Text>}
              <Text style={{ color: LEVEL_COLORS[e.level] }}>{e.text}</Text>
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

// 11px is the floor the type scale sets, and a log is the one place it earns it.
const mono = { ...monoFont, fontSize: 11 } as const;

const styles = StyleSheet.create({
  panel: {
    flex: 1.3,
    backgroundColor: colors.wash,
    borderTopColor: colors.line,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: space.s3,
    paddingVertical: space.s2,
    borderBottomColor: colors.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  live: { ...mono, flex: 1, color: colors.inkDim },
  action: { ...type.meta, fontWeight: "600", color: colors.ink },
  line: { ...mono, lineHeight: 15 },
  time: { color: colors.inkMute },
  count: { color: colors.late, fontWeight: "600" },
  detail: { ...mono, color: colors.inkMute, marginLeft: 12, lineHeight: 15 },
});
