import Ionicons from "@expo/vector-icons/Ionicons";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { useRouter } from "expo-router";
import { useEffect, useState, type ComponentProps } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSession } from "../../lib/auth";
import { retryCapture } from "../../lib/capture";
import * as clip from "../../lib/clip";
import { deleteRecording, renameRecording, useRecordings, type Recording } from "../../lib/recordings";
import { colors, shadow } from "../../lib/theme";

// Record on the ES100 clip with buttons, bring the audio over to the phone, and
// play it back. The clip's own button works too: whatever it records is pulled in
// when it stops.

const phaseText: Record<clip.ClipPhase, string> = {
  unavailable: "Needs the installed OVOA app",
  starting: "Starting Bluetooth…",
  idle: "Not connected",
  scanning: "Looking for clips…",
  connecting: "Connecting…",
  pairing: "Press the clip's button",
  connected: "Connected",
};

function clock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** Runs a clip action and shows its error, if any. */
function act(label: string, fn: () => Promise<unknown>) {
  fn().catch((err) => Alert.alert(`${label} didn't work`, err instanceof Error ? err.message : String(err)));
}

export default function RecordScreen() {
  const state = clip.useClip();
  const recordings = useRecordings();
  const router = useRouter();

  // Keep battery, signal and the button state fresh while this tab is open.
  useEffect(() => {
    if (state.phase !== "connected") return;
    const timer = setInterval(() => clip.pollLive().catch(() => {}), 5000);
    return () => clearInterval(timer);
  }, [state.phase]);

  const connected = state.phase === "connected";
  const working = state.phase === "connecting" || state.phase === "pairing" || state.phase === "scanning";

  return (
    <ScrollView style={styles.safe} contentContainerStyle={styles.body}>
      <ClipCard state={state} onInputs={() => router.push("/dev-tools")} />

      {state.problem && (
        <View style={styles.problem}>
          <Ionicons name="alert-circle" size={18} color={colors.warning} />
          <Text style={styles.problemText}>{state.problem}</Text>
        </View>
      )}

      {!connected && state.phase !== "unavailable" && (
        <View style={styles.row}>
          {state.savedDeviceId ? (
            <Button
              label={working ? phaseText[state.phase] : "Connect"}
              icon="bluetooth"
              onPress={() => act("Connect", () => clip.connect(state.savedDeviceId!))}
              disabled={working || state.phase === "starting"}
            />
          ) : null}
          <Button
            label={state.phase === "scanning" ? "Scanning…" : "Find clips"}
            icon="search"
            onPress={() => act("Scan", clip.scan)}
            disabled={working || state.phase === "starting"}
            quiet={!!state.savedDeviceId}
          />
        </View>
      )}

      {!connected && state.devices.length > 0 && (
        <View style={styles.list}>
          {[...state.devices]
            .sort((a, b) => b.rssi - a.rssi)
            .map((device) => (
              <Pressable
                key={device.id}
                style={styles.item}
                onPress={() => act("Connect", () => clip.connect(device.id))}
                disabled={working}
              >
                <View>
                  <Text style={styles.itemTitle}>{device.name || "(no name)"}</Text>
                  <Text style={styles.dim}>
                    {device.id === state.savedDeviceId ? "your clip · " : ""}
                    {device.rssi ? `${device.rssi} dBm` : "linked to this iPhone"}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
              </Pressable>
            ))}
        </View>
      )}

      <Recorder state={state} />

      <View style={styles.sectionHead}>
        <Text style={styles.heading}>Recordings</Text>
        {connected && (
          <Pressable
            onPress={() =>
              act("Import", async () => {
                const count = await clip.importAll();
                if (!count) Alert.alert("Up to date", "Every recording on the clip is already on your phone.");
              })
            }
            disabled={state.busy !== null || !!state.recording}
            hitSlop={8}
          >
            <Text style={[styles.link, (state.busy !== null || !!state.recording) && styles.dim]}>Import from clip</Text>
          </Pressable>
        )}
      </View>

      {state.download && (
        <View style={styles.download}>
          <Text style={styles.dim}>
            Downloading from the clip… {Math.round(state.download.received / 1024)} /{" "}
            {Math.round(state.download.total / 1024)} KB
          </Text>
          <View style={styles.bar}>
            <View
              style={[
                styles.barFill,
                { width: `${Math.min(100, (state.download.received / Math.max(1, state.download.total)) * 100)}%` },
              ]}
            />
          </View>
        </View>
      )}

      <RecordingList recordings={recordings} />
    </ScrollView>
  );
}

function ClipCard({ state, onInputs }: { state: clip.ClipState; onInputs: () => void }) {
  const connected = state.phase === "connected";
  const dot = connected ? colors.success : state.phase === "idle" || state.phase === "unavailable" ? colors.textDim : colors.warning;
  return (
    <View style={[styles.card, shadow]}>
      <View style={styles.cardTop}>
        <View style={styles.cardLeft}>
          <View style={[styles.dot, { backgroundColor: dot }]} />
          <View>
            <Text style={styles.itemTitle}>{state.device?.name || "ES100 clip"}</Text>
            <Text style={styles.dim}>{phaseText[state.phase]}</Text>
          </View>
        </View>
        {connected && (
          <Pressable onPress={() => act("Disconnect", clip.disconnect)} hitSlop={8}>
            <Text style={styles.link}>Disconnect</Text>
          </Pressable>
        )}
      </View>
      {connected && (
        <View style={styles.stats}>
          <Stat
            icon={state.battery?.charging ? "battery-charging" : "battery-half"}
            text={state.battery ? `${state.battery.percent}%` : "—"}
          />
          <Stat icon="cellular" text={state.rssi !== null ? `${state.rssi} dBm` : "—"} />
          <Stat
            icon="save-outline"
            text={state.storageInfo ? `${Math.round(state.storageInfo.freeKB / 1024)} MB free` : "—"}
          />
          <Pressable onPress={onInputs} hitSlop={8} style={styles.inputsLink}>
            <Text style={styles.link}>Inputs</Text>
            <Ionicons name="chevron-forward" size={14} color={colors.accent} />
          </Pressable>
        </View>
      )}
    </View>
  );
}

function Stat({ icon, text }: { icon: ComponentProps<typeof Ionicons>["name"]; text: string }) {
  return (
    <View style={styles.stat}>
      <Ionicons name={icon} size={14} color={colors.textDim} />
      <Text style={styles.dim}>{text}</Text>
    </View>
  );
}

function Recorder({ state }: { state: clip.ClipState }) {
  const rec = state.recording;
  const connected = state.phase === "connected";
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!rec || rec.paused) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [rec]);

  const busy = state.busy !== null;
  const canStart = connected && !rec && !busy;

  return (
    <View style={[styles.recorder, shadow]}>
      <Pressable
        style={[styles.recordButton, rec && styles.recordButtonOn, !canStart && !rec && styles.recordButtonOff]}
        onPress={() => (rec ? act("Stop", clip.stopRecording) : act("Record", clip.startRecording))}
        disabled={rec ? busy : !canStart}
        accessibilityLabel={rec ? "Stop and save" : "Start recording"}
      >
        {busy && !rec ? (
          <ActivityIndicator color={colors.bg} />
        ) : (
          <View style={rec ? styles.stopGlyph : styles.recGlyph} />
        )}
      </Pressable>
      <Text style={styles.timer}>{rec ? clock((now - rec.startedAt) / 1000) : "0:00"}</Text>
      <Text style={styles.dim}>
        {!connected
          ? "Connect the clip to record"
          : rec
            ? rec.paused
              ? "Paused"
              : `Recording on the clip${rec.byDevice ? " (started with its button)" : ""}`
            : state.busy
              ? `${state.busy}…`
              : "Tap to record on the clip"}
      </Text>
      {rec && (
        <View style={styles.row}>
          <Button
            label={rec.paused ? "Resume" : "Pause"}
            icon={rec.paused ? "play" : "pause"}
            onPress={() => act(rec.paused ? "Resume" : "Pause", rec.paused ? clip.resumeRecording : clip.pauseRecording)}
            disabled={busy || rec.sessionId === 0}
            quiet
          />
          <Button label="Stop & save" icon="stop" onPress={() => act("Stop", clip.stopRecording)} disabled={busy} />
        </View>
      )}
    </View>
  );
}

/**
 * Whether this recording made it into the timeline. Worth showing: filing takes
 * a few seconds and happens on its own, so without this the user is left
 * guessing whether it worked.
 */
function TimelineState({ recording, onRetry }: { recording: Recording; onRetry: () => void }) {
  if (recording.capturing) {
    return (
      <View style={styles.timelineRow}>
        <ActivityIndicator size="small" color={colors.textDim} />
        <Text style={styles.dim}>Adding to your timeline…</Text>
      </View>
    );
  }
  if (recording.blockTitle) {
    return (
      <View style={styles.timelineRow}>
        <Ionicons name="book-outline" size={12} color={colors.success} />
        <Text style={styles.dim} numberOfLines={1}>
          {recording.blockTitle}
        </Text>
      </View>
    );
  }
  if (recording.captureError) {
    return (
      <Pressable style={styles.timelineRow} onPress={onRetry} hitSlop={6}>
        <Ionicons name="refresh" size={12} color={colors.warning} />
        <Text style={[styles.dim, { color: colors.warning, flex: 1 }]} numberOfLines={1}>
          {recording.captureError} Tap to try again.
        </Text>
      </Pressable>
    );
  }
  return null;
}

function RecordingList({ recordings }: { recordings: Recording[] }) {
  const { token, user } = useSession();
  const player = useAudioPlayer(null);
  const status = useAudioPlayerStatus(player);
  const [current, setCurrent] = useState<string | null>(null);

  // Back to the start when a recording finishes, so play starts it over.
  useEffect(() => {
    if (status.didJustFinish) {
      player.pause();
      player.seekTo(0).catch(() => {});
    }
  }, [status.didJustFinish, player]);

  const toggle = (recording: Recording) => {
    if (!recording.wavUri) {
      Alert.alert("Can't play this one", recording.decodeError ?? "It has no playable audio.");
      return;
    }
    if (current === recording.id) {
      if (status.playing) player.pause();
      else player.play();
      return;
    }
    player.replace({ uri: recording.wavUri });
    setCurrent(recording.id);
    player.play();
  };

  const options = (recording: Recording) =>
    Alert.alert(recording.title, undefined, [
      {
        text: "Rename",
        onPress: () =>
          Alert.prompt("Rename", undefined, (title) => renameRecording(recording.id, title), "plain-text", recording.title),
      },
      ...(recording.sessionId && clip.getClipState().phase === "connected"
        ? [
            {
              text: "Delete from clip too",
              style: "destructive" as const,
              onPress: () =>
                act("Delete", async () => {
                  await clip.deleteFromClip(recording.sessionId!);
                  remove(recording);
                }),
            },
          ]
        : []),
      { text: "Delete from phone", style: "destructive", onPress: () => remove(recording) },
      { text: "Cancel", style: "cancel" },
    ]);

  const remove = (recording: Recording) => {
    if (current === recording.id) {
      player.pause();
      setCurrent(null);
    }
    deleteRecording(recording.id);
  };

  if (!recordings.length) {
    return (
      <View style={styles.empty}>
        <Ionicons name="mic-outline" size={30} color={colors.textDim} />
        <Text style={styles.dim}>Your recordings will show up here.</Text>
      </View>
    );
  }

  return (
    <View style={styles.list}>
      {recordings.map((recording) => {
        const active = current === recording.id;
        const playing = active && status.playing;
        const duration = active && status.duration > 0 ? status.duration : (recording.seconds ?? 0);
        return (
          <View key={recording.id} style={styles.item}>
            <Pressable style={styles.play} onPress={() => toggle(recording)} accessibilityLabel={playing ? "Pause" : "Play"}>
              <Ionicons
                name={playing ? "pause" : recording.wavUri ? "play" : "alert"}
                size={18}
                color={recording.wavUri ? colors.accent : colors.warning}
              />
            </Pressable>
            <Pressable style={styles.itemMain} onPress={() => toggle(recording)} onLongPress={() => options(recording)}>
              <Text style={styles.itemTitle} numberOfLines={1}>
                {recording.title}
              </Text>
              <Text style={styles.dim}>
                {active ? `${clock(status.currentTime)} / ` : ""}
                {clock(duration)}
                {recording.decodeError ? " · not playable" : ""}
              </Text>
              {user.settings.contextEnabled && <TimelineState recording={recording} onRetry={() => retryCapture(token, recording)} />}
              {active && (
                <View style={styles.bar}>
                  <View style={[styles.barFill, { width: `${Math.min(100, (status.currentTime / Math.max(0.1, duration)) * 100)}%` }]} />
                </View>
              )}
            </Pressable>
            <Pressable onPress={() => options(recording)} hitSlop={10} accessibilityLabel="More">
              <Ionicons name="ellipsis-horizontal" size={18} color={colors.textDim} />
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}

function Button({
  label,
  icon,
  onPress,
  disabled,
  quiet,
}: {
  label: string;
  icon?: ComponentProps<typeof Ionicons>["name"];
  onPress: () => void;
  disabled?: boolean;
  quiet?: boolean;
}) {
  return (
    <Pressable
      style={[styles.button, quiet && styles.buttonQuiet, disabled && styles.buttonOff]}
      onPress={onPress}
      disabled={disabled}
    >
      {icon && <Ionicons name={icon} size={16} color={disabled ? colors.textDim : quiet ? colors.accent : "#fff"} />}
      <Text style={[styles.buttonText, quiet && styles.buttonTextQuiet, disabled && styles.dim]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  body: { padding: 20, gap: 12, paddingBottom: 48 },
  dim: { color: colors.textDim, fontSize: 13 },
  heading: { color: colors.text, fontSize: 17, fontWeight: "600" },
  sectionHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 12 },
  link: { color: colors.accent, fontSize: 14, fontWeight: "600" },
  row: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  card: { backgroundColor: colors.bg, borderColor: colors.border, borderWidth: 1, borderRadius: 16, padding: 16, gap: 12 },
  cardTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  cardLeft: { flexDirection: "row", alignItems: "center", gap: 12 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  stats: { flexDirection: "row", alignItems: "center", gap: 14, flexWrap: "wrap" },
  stat: { flexDirection: "row", alignItems: "center", gap: 4 },
  inputsLink: { flexDirection: "row", alignItems: "center", marginLeft: "auto" },
  problem: {
    flexDirection: "row",
    gap: 8,
    backgroundColor: colors.surfaceHigh,
    borderRadius: 12,
    padding: 12,
    alignItems: "flex-start",
  },
  problemText: { color: colors.text, fontSize: 13, flex: 1, lineHeight: 18 },
  recorder: {
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 20,
    paddingVertical: 28,
    paddingHorizontal: 16,
    alignItems: "center",
    gap: 10,
  },
  recordButton: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: colors.danger,
    alignItems: "center",
    justifyContent: "center",
  },
  recordButtonOn: { backgroundColor: colors.text },
  recordButtonOff: { backgroundColor: colors.surfaceHigh },
  recGlyph: { width: 30, height: 30, borderRadius: 15, backgroundColor: "#fff" },
  stopGlyph: { width: 26, height: 26, borderRadius: 5, backgroundColor: "#fff" },
  timer: { color: colors.text, fontSize: 34, fontWeight: "300", fontVariant: ["tabular-nums"] },
  download: { gap: 6 },
  bar: { height: 4, backgroundColor: colors.surfaceHigh, borderRadius: 2, overflow: "hidden", marginTop: 6 },
  barFill: { height: 4, backgroundColor: colors.accent },
  list: { gap: 8 },
  item: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  itemMain: { flex: 1, gap: 2 },
  timelineRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 2 },
  itemTitle: { color: colors.text, fontSize: 15, fontWeight: "500" },
  play: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.accentDim,
    alignItems: "center",
    justifyContent: "center",
  },
  empty: { alignItems: "center", gap: 8, paddingVertical: 28 },
  button: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 11,
    paddingHorizontal: 16,
  },
  buttonQuiet: { backgroundColor: colors.accentDim },
  buttonOff: { backgroundColor: colors.surface },
  buttonText: { color: colors.bg, fontWeight: "600", fontSize: 14 },
  buttonTextQuiet: { color: colors.accent },
});
