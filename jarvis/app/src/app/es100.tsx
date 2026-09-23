import Ionicons from "@expo/vector-icons/Ionicons";
import { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as ute from "../../modules/ute-ble";
import * as clip from "../lib/clip";
import { colors } from "../lib/theme";

// Bring-up screen for the ES100 recording clip: the raw connection, pairing, the
// file list on the device, and the SDK's log. Everyday recording lives in the
// Record tab; both share one connection (lib/clip.ts).

export default function ES100() {
  const state = clip.useClip();
  const [files, setFiles] = useState<ute.RecordFile[] | null>(null);
  const connected = state.phase === "connected";
  const idle = state.busy === null;

  const run = (label: string, fn: () => Promise<unknown>) =>
    fn().catch((err) => Alert.alert(`${label} failed`, err instanceof Error ? err.message : String(err)));

  if (!ute.uteAvailable) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.empty}>
          <Ionicons name="bluetooth" size={44} color={colors.inkMute} />
          <Text style={styles.title}>Not available here</Text>
          <Text style={styles.dim}>
            The OVOA Band needs the installed OVOA app — a development build with the UTE SDK compiled in. Expo Go
            can't load it.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.title}>OVOA Band</Text>
        <Text style={styles.dim}>
          {state.sdkVersion ? `SDK ${state.sdkVersion}` : "starting…"} · {state.phase}
          {state.savedDeviceId ? ` · saved ${state.savedDeviceId.slice(0, 8)}` : ""}
        </Text>
        {state.problem && <Text style={styles.problem}>{state.problem}</Text>}

        {state.device && (
          <View style={styles.item}>
            <View>
              <Text style={styles.itemText}>{state.device.name || state.device.model || "Device"}</Text>
              <Text style={styles.dim}>
                {state.device.address} · fw {state.device.firmware || "?"}
              </Text>
            </View>
            <Text style={[styles.dim, state.device.hasAIRecording === true && styles.good]}>
              {state.device.hasAIRecording === null ? "recording ?" : state.device.hasAIRecording ? "recording ✓" : "no recording"}
            </Text>
          </View>
        )}

        <View style={styles.row}>
          <Button label={state.phase === "scanning" ? "Scanning…" : "Scan"} onPress={() => run("Scan", clip.scan)} disabled={state.phase !== "idle"} />
          {connected ? (
            <Button label="Disconnect" onPress={() => run("Disconnect", clip.disconnect)} />
          ) : (
            <Button
              label="Connect saved"
              onPress={() => run("Connect", () => clip.connect(state.savedDeviceId!))}
              disabled={!state.savedDeviceId || state.phase !== "idle"}
            />
          )}
          <Button label="Forget" onPress={() => run("Forget", clip.forget)} disabled={!state.savedDeviceId} />
        </View>

        <View style={styles.row}>
          <Button
            label="Pair (bind)"
            onPress={() =>
              run("Pair", async () => {
                const r = await ute.bind();
                Alert.alert("Bind", `bound ${r.bound}, SSN ${r.ssn ?? "?"}, refuse cause ${r.refuseCause ?? "-"}`);
              })
            }
            disabled={!connected || !idle}
          />
          <Button label="Read info" onPress={() => run("Read", clip.refreshInfo)} disabled={!connected || !idle} />
          <Button
            label="List files"
            onPress={() => run("List", async () => setFiles((await ute.listFiles()).files))}
            disabled={!connected || !idle || !!state.recording}
          />
        </View>

        {state.busy && <Text style={styles.dim}>{state.busy}…</Text>}

        {state.devices.length > 0 && !connected && (
          <>
            <Text style={styles.heading}>Found</Text>
            {[...state.devices]
              .sort((a, b) => Number(!!b.likelyUte) - Number(!!a.likelyUte) || b.rssi - a.rssi)
              .map((device) => (
                <Pressable key={device.id} style={styles.item} onPress={() => run("Connect", () => clip.connect(device.id))}>
                  <View>
                    <Text style={styles.itemText}>{device.name || "(no name)"}</Text>
                    <Text style={styles.dim}>{device.address || device.id}</Text>
                  </View>
                  <Text style={styles.dim}>{device.rssi ? `${device.rssi} dBm` : "linked"}</Text>
                </Pressable>
              ))}
          </>
        )}

        {files && (
          <>
            <Text style={styles.heading}>On the clip</Text>
            {files.length === 0 && <Text style={styles.dim}>Nothing on the device.</Text>}
            {files.map((file) => (
              <Pressable
                key={file.sessionId}
                style={styles.item}
                onPress={() => run("Download", () => clip.importSession(file.sessionId, file.size))}
              >
                <View>
                  <Text style={styles.itemText}>#{file.sessionId}</Text>
                  <Text style={styles.dim}>
                    {new Date(file.sessionId * 1000).toLocaleString()} · {Math.round(file.size / 1024)} KB · type {file.type}
                  </Text>
                </View>
                <Ionicons name="download-outline" size={18} color={colors.blue} />
              </Pressable>
            ))}
          </>
        )}

        <Text style={styles.heading}>Log</Text>
        {state.log.map((line, i) => (
          <Text key={i} style={styles.logLine}>
            {line}
          </Text>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

function Button({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable style={[styles.button, disabled && styles.buttonOff]} onPress={onPress} disabled={disabled}>
      <Text style={[styles.buttonText, disabled && styles.dim]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.paper },
  body: { padding: 20, gap: 10 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 12 },
  title: { color: colors.ink, fontSize: 26, fontWeight: "600" },
  heading: { color: colors.ink, fontSize: 15, fontWeight: "600", marginTop: 18 },
  dim: { color: colors.inkMute, fontSize: 13 },
  problem: { color: colors.late, fontSize: 13, lineHeight: 18 },
  row: { flexDirection: "row", gap: 8, flexWrap: "wrap", marginTop: 8 },
  button: { backgroundColor: colors.nowWash, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 14 },
  buttonOff: { backgroundColor: colors.wash },
  buttonText: { color: colors.blue, fontWeight: "600", fontSize: 14 },
  item: {
    backgroundColor: colors.wash,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  itemText: { color: colors.ink, fontSize: 15 },
  good: { color: colors.done },
  logLine: { color: colors.inkMute, fontSize: 11, fontFamily: "Menlo" },
});
