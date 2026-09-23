import Ionicons from "@expo/vector-icons/Ionicons";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { useFocusEffect, useRouter, type Href } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { Btn, GroupLabel, Row, Screen, TopBar, text } from "../../components/ui";
import { api, ApiError } from "../../lib/api";
import { useSession } from "../../lib/auth";
import { noteRecording, retryCapture } from "../../lib/capture";
import * as clip from "../../lib/clip";
import { logFail } from "../../lib/devlog";
import { useDevMode } from "../../lib/devMode";
import { usePlan } from "../../lib/plan";
import { deleteRecording, markLost, renameRecording, useRecordings, wavFile, type Recording } from "../../lib/recordings";
import { colors, mono, numeric, space, type } from "../../lib/theme";

// Record on the ES100 clip (the OVOA Band, as people see it) with buttons, bring
// the audio over to the phone, and play it back. The clip's own button works too:
// whatever it records is pulled in when it stops.

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
  const devMode = useDevMode();
  const state = clip.useClip();
  const recordings = useRecordings();
  const router = useRouter();

  // Keep battery, signal and the button state fresh while this screen is open —
  // focused, not merely mounted: tab screens stay mounted after you leave them,
  // and this kept asking the band every five seconds from behind every other
  // screen, queueing ahead of the band's own one-command-at-a-time traffic.
  useFocusEffect(
    useCallback(() => {
      if (state.phase !== "connected") return;
      const timer = setInterval(() => clip.pollLive().catch(logFail("record: clip.pollLive")), 5000);
      return () => clearInterval(timer);
    }, [state.phase]),
  );

  const connected = state.phase === "connected";
  const working = state.phase === "connecting" || state.phase === "pairing" || state.phase === "scanning";

  return (
    <View style={styles.page}>
      <TopBar
        title="Record"
        when={connected && state.battery ? `Clip ${state.battery.percent}%` : phaseText[state.phase]}
      />
      <Screen>
        <Recorder state={state} />

        {!!state.problem && (
          <View style={styles.problem}>
            <Ionicons name="alert-circle" size={16} color={colors.late} />
            <Text style={styles.problemText}>{state.problem}</Text>
          </View>
        )}

        {connected ? (
          <>
            <GroupLabel>The clip</GroupLabel>
            {/* Its own name (ES100-…) is the supplier's; people know it as the OVOA Band. */}
            <Row icon="bluetooth-outline" tone="blue" title="OVOA Band" value="Connected" first />
            <Row
              icon={state.battery?.charging ? "battery-charging-outline" : "battery-half-outline"}
              tone="green"
              title="Battery"
              value={state.battery ? `${state.battery.percent}%` : "—"}
            />
            <Row
              icon="cellular-outline"
              tone="violet"
              title="Signal"
              value={state.rssi !== null ? `${state.rssi} dBm` : "—"}
            />
            <Row
              icon="save-outline"
              tone="amber"
              title="Free space"
              value={state.storageInfo ? `${Math.round(state.storageInfo.freeKB / 1024)} MB` : "—"}
            />
            {devMode && (
              <Row
                icon="options-outline"
                tone="pink"
                title="Inputs, sensors & twist"
                onPress={() => router.navigate("/dev-tools" as Href)}
                right={<Ionicons name="chevron-forward" size={16} color={colors.inkMute} />}
              />
            )}
            <View style={styles.buttons}>
              <Btn
                label="Import from clip"
                onPress={() =>
                  act("Import", async () => {
                    const count = await clip.importAll();
                    if (!count) Alert.alert("Up to date", "Every recording on the clip is already on your phone.");
                  })
                }
                disabled={state.busy !== null || !!state.recording}
              />
              <Btn label="Disconnect" kind="quiet" onPress={() => act("Disconnect", clip.disconnect)} />
            </View>
          </>
        ) : (
          state.phase !== "unavailable" && (
            <>
              <GroupLabel>The clip</GroupLabel>
              <Text style={text.sub}>{phaseText[state.phase]}</Text>
              <View style={styles.buttons}>
                {!!state.savedDeviceId && (
                  <Btn
                    label={working ? phaseText[state.phase] : "Connect"}
                    kind="go"
                    onPress={() => act("Connect", () => clip.connect(state.savedDeviceId!))}
                    disabled={working || state.phase === "starting"}
                  />
                )}
                <Btn
                  label={state.phase === "scanning" ? "Scanning…" : "Find clips"}
                  kind={state.savedDeviceId ? "plain" : "go"}
                  onPress={() => act("Scan", clip.scan)}
                  disabled={working || state.phase === "starting"}
                />
              </View>
              {[...state.devices]
                .sort((a, b) => b.rssi - a.rssi)
                .map((device, i) => (
                  <Row
                    key={device.id}
                    icon="bluetooth-outline"
                    tone="blue"
                    title={device.name || "(no name)"}
                    value={
                      device.id === state.savedDeviceId
                        ? "your clip"
                        : device.rssi
                          ? `${device.rssi} dBm`
                          : "linked to this iPhone"
                    }
                    first={i === 0}
                    onPress={() => act("Connect", () => clip.connect(device.id))}
                  />
                ))}
            </>
          )
        )}

        {!!state.download && (
          <>
            <Text style={text.meta}>
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
          </>
        )}

        <GroupLabel>Recordings</GroupLabel>
        <RecordingList recordings={recordings} />
      </Screen>
    </View>
  );
}

function Recorder({ state }: { state: clip.ClipState }) {
  const { free } = usePlan();
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
    <View style={styles.recorder}>
      <Pressable
        style={[styles.big, !!rec && styles.bigOn, !canStart && !rec && styles.bigOff]}
        onPress={() => (rec ? act("Stop", clip.stopRecording) : act("Record", clip.startRecording))}
        disabled={rec ? busy : !canStart}
        accessibilityLabel={rec ? "Stop and save" : "Start recording"}
      >
        {busy && !rec ? (
          <ActivityIndicator color={colors.paper} />
        ) : (
          <Ionicons name={rec ? "square" : "mic"} size={44} color={canStart || rec ? colors.paper : colors.inkMute} />
        )}
      </Pressable>
      <Text style={styles.timer}>{rec ? clock((now - rec.startedAt) / 1000) : "0:00"}</Text>
      <Text style={styles.hint}>
        {!connected
          ? "Connect the clip to record"
          : rec
            ? rec.paused
              ? "Paused"
              : `Recording on the clip${rec.byDevice ? " (started with its button)" : ""}`
            : state.busy
              ? `${state.busy}…`
              : free
                ? "Double-press the clip's button, or tap here. It becomes a note."
                : "Press the clip's button, or tap here"}
      </Text>
      {!!rec && (
        <View style={styles.buttons}>
          <Btn
            label={rec.paused ? "Resume" : "Pause"}
            onPress={() => act(rec.paused ? "Resume" : "Pause", rec.paused ? clip.resumeRecording : clip.pauseRecording)}
            disabled={busy || rec.sessionId === 0}
          />
          <Btn label="Stop & save" kind="go" onPress={() => act("Stop", clip.stopRecording)} disabled={busy} />
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
    return <Text style={text.meta}>Adding to your timeline…</Text>;
  }
  if (recording.blockTitle) {
    return (
      <Text style={[text.meta, { color: colors.done }]} numberOfLines={1}>
        {recording.blockTitle}
      </Text>
    );
  }
  // Lost first: it is also a captureError, but retrying it can never work, so it
  // must not be offered as something to tap (device_logs 2026-09-20 23:18).
  if (recording.lost) {
    return (
      <Text style={[text.meta, { color: colors.late }]} numberOfLines={2}>
        {recording.lost}
      </Text>
    );
  }
  if (recording.captureError) {
    return (
      <Pressable onPress={onRetry} hitSlop={6}>
        <Text style={[text.meta, { color: colors.late }]} numberOfLines={1}>
          {recording.captureError} Tap to try again.
        </Text>
      </Pressable>
    );
  }
  return null;
}

/**
 * The free plan: whether this recording became a note, written out on the
 * phone (capture.ts noteRecording). One that hasn't can be made into one.
 */
function NoteState({ recording, onNote }: { recording: Recording; onNote: () => void }) {
  if (recording.capturing) return <Text style={text.meta}>Writing it out on your phone…</Text>;
  if (recording.noteText) {
    return (
      <Text style={[text.meta, { color: colors.done }]} numberOfLines={2}>
        {recording.noteText}
      </Text>
    );
  }
  if (recording.lost) {
    return (
      <Text style={[text.meta, { color: colors.late }]} numberOfLines={2}>
        {recording.lost}
      </Text>
    );
  }
  if (!recording.wavName) return null;
  return (
    <Pressable onPress={onNote} hitSlop={6}>
      <Text style={[text.meta, recording.captureError ? { color: colors.late } : { color: colors.inkDim }]} numberOfLines={2}>
        {recording.captureError ? `${recording.captureError} Tap to try again.` : "Tap to make it a note"}
      </Text>
    </Pressable>
  );
}

function RecordingList({ recordings }: { recordings: Recording[] }) {
  const { token, user } = useSession();
  const { free } = usePlan();
  // keepAudioSessionActive, as in voice.ts and cues.ts: without it expo-audio
  // switches the audio session off when a recording stops playing, under the
  // phone's ear, which then hears nothing until the mic is restarted.
  const player = useAudioPlayer(null, { keepAudioSessionActive: true });
  const status = useAudioPlayerStatus(player);
  const [current, setCurrent] = useState<string | null>(null);

  // Back to the start when a recording finishes, so play starts it over.
  useEffect(() => {
    if (status.didJustFinish) {
      player.pause();
      player.seekTo(0).catch(logFail("record: player.seekTo"));
    }
  }, [status.didJustFinish, player]);

  const toggle = (recording: Recording) => {
    const audio = wavFile(recording);
    if (!audio?.exists) {
      // Checked here and not from a stored uri, so "it's gone" is a fact about the
      // folder we are in now rather than about the one the app used to live in.
      if (audio && !recording.lost) markLost(recording.id, "The audio for this one is no longer on the phone.");
      Alert.alert("Can't play this one", recording.lost ?? recording.decodeError ?? "It has no playable audio.");
      return;
    }
    if (current === recording.id) {
      if (status.playing) player.pause();
      else player.play();
      return;
    }
    player.replace({ uri: audio.uri });
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
                  if (!(await forget(recording))) return;
                  await clip.deleteFromClip(recording.sessionId!);
                  remove(recording);
                }),
            },
          ]
        : []),
      {
        text: recording.blockId ? "Delete from phone and OVOA" : "Delete from phone",
        style: "destructive",
        onPress: () => void forget(recording).then((gone) => gone && remove(recording)),
      },
      { text: "Cancel", style: "cancel" },
    ]);

  /**
   * What OVOA kept of a recording (its summary and its words, on the server,
   * kept until deleted) goes first. Deleted here first, the block's id would
   * go with it, and the server's copy could never be found again. False, with
   * an alert, when that couldn't be done; the recording stays for another try.
   */
  const forget = async (recording: Recording) => {
    if (!recording.blockId || !token) return true;
    try {
      await api.forgetBlock(token, recording.blockId);
      return true;
    } catch (err) {
      // Already gone there ("Forget the last hour", say): nothing left to delete.
      if (err instanceof ApiError && err.status === 404) return true;
      Alert.alert("Couldn't delete it from OVOA", "Nothing was deleted. Try again when you're online.");
      return false;
    }
  };

  const remove = (recording: Recording) => {
    if (current === recording.id) {
      player.pause();
      setCurrent(null);
    }
    deleteRecording(recording.id);
  };

  if (!recordings.length) return <Text style={text.sub}>Your recordings will show up here.</Text>;

  return (
    <>
      {recordings.map((recording, i) => {
        const active = current === recording.id;
        const playing = active && status.playing;
        const duration = active && status.duration > 0 ? status.duration : (recording.seconds ?? 0);
        const broken = !recording.wavName || !!recording.lost;
        return (
          <View key={recording.id} style={[styles.rec, i === 0 && { borderTopWidth: 0 }]}>
            <Pressable
              style={styles.play}
              onPress={() => toggle(recording)}
              accessibilityLabel={playing ? "Pause" : "Play"}
            >
              <Ionicons
                name={playing ? "pause" : broken ? "alert" : "play"}
                size={16}
                color={broken ? colors.late : colors.now}
              />
            </Pressable>
            <Pressable style={styles.recMain} onPress={() => toggle(recording)} onLongPress={() => options(recording)}>
              <Text style={text.body} numberOfLines={1}>
                {recording.title}
              </Text>
              <Text style={styles.stamp}>
                {active ? `${clock(status.currentTime)} / ` : ""}
                {clock(duration)}
                {recording.lost ? " · audio gone" : recording.decodeError ? " · not playable" : ""}
              </Text>
              {free ? (
                <NoteState recording={recording} onNote={() => void noteRecording(token, recording)} />
              ) : (
                user.settings.contextEnabled && (
                  <TimelineState recording={recording} onRetry={() => retryCapture(token, recording)} />
                )
              )}
              {active && (
                <View style={styles.bar}>
                  <View
                    style={[
                      styles.barFill,
                      { width: `${Math.min(100, (status.currentTime / Math.max(0.1, duration)) * 100)}%` },
                    ]}
                  />
                </View>
              )}
            </Pressable>
            <Pressable onPress={() => options(recording)} hitSlop={10} accessibilityLabel="More">
              <Ionicons name="ellipsis-horizontal" size={18} color={colors.inkMute} />
            </Pressable>
          </View>
        );
      })}
    </>
  );
}

const BIG = 132;

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.paper },

  recorder: { alignItems: "center", gap: space.s2, paddingVertical: space.s4 },
  big: {
    width: BIG,
    height: BIG,
    borderRadius: BIG / 2,
    backgroundColor: colors.stop,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: space.s3,
    shadowColor: colors.stop,
    shadowOpacity: 0.45,
    shadowRadius: 26,
    shadowOffset: { width: 0, height: 12 },
    elevation: 6,
  },
  bigOn: { backgroundColor: colors.ink, shadowOpacity: 0, transform: [{ scale: 0.94 }] },
  bigOff: { backgroundColor: colors.wash2, shadowOpacity: 0 },
  timer: { ...type.display, fontWeight: "400", color: colors.ink, ...numeric },
  hint: { ...type.sub, color: colors.inkMute, textAlign: "center" },

  buttons: { flexDirection: "row", gap: space.s2, flexWrap: "wrap", paddingTop: space.s2 },

  problem: { flexDirection: "row", gap: space.s2, alignItems: "flex-start" },
  problemText: { ...type.meta, color: colors.late, flex: 1 },

  bar: { height: 4, borderRadius: 2, backgroundColor: colors.wash2, overflow: "hidden", marginTop: 6 },
  barFill: { height: 4, backgroundColor: colors.ink },

  rec: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.s3,
    paddingVertical: space.s3,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  recMain: { flex: 1, gap: 2 },
  play: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.wash, alignItems: "center", justifyContent: "center" },
  stamp: { ...type.meta, ...mono, ...numeric, color: colors.inkMute },
});
