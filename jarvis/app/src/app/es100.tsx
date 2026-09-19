import Ionicons from "@expo/vector-icons/Ionicons";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as ute from "../../modules/ute-ble";
import { devlog } from "../lib/devlog";
import { colors } from "../lib/theme";

// Bring-up screen for the ES100 recording clip: scan, pair, and pull a file off
// the device. Reachable from Settings → Developer, or the /es100 route.

export default function ES100() {
  const [sdkVersion, setSdkVersion] = useState<string | null>(null);
  const [devices, setDevices] = useState<ute.UteDevice[]>([]);
  const [scanning, setScanning] = useState(false);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const connectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [device, setDevice] = useState<ute.ConnectedDevice | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [files, setFiles] = useState<ute.RecordFile[] | null>(null);
  const [progress, setProgress] = useState<ute.SyncProgress | null>(null);
  const [log, setLog] = useState<string[]>([]);

  const say = useCallback((line: string) => {
    devlog("ble", line);
    setLog((prev) => [`${new Date().toLocaleTimeString()}  ${line}`, ...prev].slice(0, 80));
  }, []);

  // Keep the latest logger without re-running the subscription effect.
  const sayRef = useRef(say);
  sayRef.current = say;

  useEffect(() => {
    if (!ute.uteAvailable) return;

    const subs = [
      ute.addListener("onDeviceFound", (device) => {
        setDevices((prev) => (prev.some((d) => d.id === device.id) ? prev : [...prev, device]));
      }),
      ute.addListener("onConnectionChange", (change) => {
        setConnected(change.connected);
        sayRef.current(`connection status ${change.status}${change.error ? ` — ${change.error}` : ""}`);
        // 4 = still connecting; anything else ends the attempt.
        if (change.status !== 4) {
          setConnecting(false);
          if (connectTimer.current) clearTimeout(connectTimer.current);
        }
        // CoreBluetooth 14/15: iOS kept pairing keys the clip has since deleted. Only the
        // user can clear them (the SDK says: forget the device in iOS Bluetooth settings).
        if (/\(CB 1[45]\)/.test(change.error ?? "")) {
          if (connectTimer.current) clearTimeout(connectTimer.current);
          sayRef.current("iPhone's saved pairing with the clip is out of date; it must be forgotten in Settings");
          Alert.alert(
            "Forget the ES100 in Bluetooth settings",
            "Your iPhone still has an old pairing for the clip, which the clip has deleted, so iOS refuses to connect.\n\n" +
              "1. Open Settings → Bluetooth.\n" +
              "2. Tap the ⓘ next to ES100 → Forget This Device.\n" +
              "3. Come back, Scan, and tap ES100.\n" +
              "4. Accept the iPhone's pairing pop-up, then press the clip's button when it vibrates.",
          );
        }
        if (!change.connected) return setDevice(null);
        ute
          .connectedDevice()
          .then((info) => {
            setDevice(info);
            if (info && info.hasAIRecording === false) {
              sayRef.current("warning: this firmware does not support the recording protocol");
            }
          })
          .catch(() => {});
      }),
      ute.addListener("onPairingChange", ({ paired, message }) => {
        sayRef.current(message ?? (paired ? "device accepted pairing" : "device refused pairing — disconnecting"));
      }),
      ute.addListener("onBluetoothState", (state) => {
        sayRef.current(`bluetooth ${state.poweredOn ? "on" : `state ${state.state}`}`);
      }),
      ute.addListener("onRecordStart", (event) => {
        sayRef.current(`recording started (${event.startedByDevice ? "device button" : "app"}) #${event.sessionId}`);
      }),
      ute.addListener("onRecordStop", (event) => {
        sayRef.current(`recording stopped #${event.sessionId}, ${event.fileSize} bytes`);
      }),
      ute.addListener("onSyncProgress", setProgress),
      ute.addListener("onLog", ({ message }) => sayRef.current(`sdk: ${message}`)),
    ];

    ute
      .initialize()
      .then((version) => {
        setSdkVersion(version);
        sayRef.current(`SDK ${version} ready`);
      })
      .catch((err: Error) => sayRef.current(`init failed — ${err.message}`));

    return () => {
      subs.forEach((s) => s.remove());
      if (connectTimer.current) clearTimeout(connectTimer.current);
    };
  }, []);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      say(`${label} failed — ${message}`);
      Alert.alert(`${label} failed`, message);
    } finally {
      setBusy(null);
    }
  };

  const scan = () =>
    run("Scan", async () => {
      setDevices([]);
      setScanning(true);
      await ute.startScan();
      say("scanning…");
      // The SDK scans until told to stop.
      setTimeout(() => {
        ute.stopScan().catch(() => {});
        setScanning(false);
      }, 10_000);
    });

  const connectTo = (device: ute.UteDevice) =>
    run("Connect", async () => {
      await ute.stopScan();
      setScanning(false);
      say(`connecting to ${device.name || device.id}…`);
      setConnecting(true);
      await ute.connect(device.id);
      if (connectTimer.current) clearTimeout(connectTimer.current);
      connectTimer.current = setTimeout(() => {
        // The vendor's advice for a stuck connect: drop it and try again, once.
        sayRef.current("no connection after 20 s; retrying once");
        ute.connect(device.id).catch((err: Error) => sayRef.current(`retry failed: ${err.message}`));
        connectTimer.current = setTimeout(() => {
          setConnecting(false);
          sayRef.current("still no connection. Press the clip's button when it vibrates to accept pairing, then tap it again");
        }, 20_000);
      }, 20_000);
    });

  const pair = () =>
    run("Pair", async () => {
      const result = await ute.bind();
      if (result.bound) say(result.ssn ? `paired, SSN ${result.ssn}` : "paired");
      else say(result.refuseCause === null ? "not paired" : `device refused pairing (cause ${result.refuseCause})`);
    });

  const refresh = () =>
    run("Read device", async () => {
      const [status, storageInfo, list] = await Promise.all([
        ute.getStatus(),
        ute.getStorageInfo(),
        ute.listFiles(),
      ]);
      setFiles(list.files);
      say(`state ${status.state}, ${Math.round(storageInfo.freeKB / 1024)} MB free, ${list.count} files`);
    });

  const download = (file: ute.RecordFile) =>
    run("Download", async () => {
      setProgress(null);
      say(`downloading #${file.sessionId} (${file.size} bytes)…`);
      const result = await ute.syncFile(file.sessionId, file.type, file.size);
      say(`saved ${result.bytes} bytes to ${result.path}`);
      Alert.alert("Downloaded", `${result.bytes} bytes\n\n${result.path}`);
    });

  if (!ute.uteAvailable) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.empty}>
          <Ionicons name="bluetooth" size={44} color={colors.textDim} />
          <Text style={styles.title}>Not available here</Text>
          <Text style={styles.dim}>
            The ES100 needs the installed OVOA app — a development build with the UTE SDK compiled in. Expo Go
            can't load it.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.title}>ES100</Text>
        <Text style={styles.dim}>
          {sdkVersion ? `SDK ${sdkVersion}` : "starting…"} · {connected ? "connected" : connecting ? "connecting…" : "not connected"}
        </Text>

        {device && (
          <View style={styles.item}>
            <View>
              <Text style={styles.itemText}>{device.name || device.model || "Device"}</Text>
              <Text style={styles.dim}>
                {device.address} · fw {device.firmware || "?"}
              </Text>
            </View>
            <Text style={[styles.dim, device.hasAIRecording === true && styles.good]}>
              {device.hasAIRecording === null ? "recording ?" : device.hasAIRecording ? "recording ✓" : "no recording"}
            </Text>
          </View>
        )}

        <View style={styles.row}>
          <Button label={scanning ? "Scanning…" : "Scan"} onPress={scan} disabled={scanning || busy !== null} />
          <Button label="Pair" onPress={pair} disabled={!connected || busy !== null} />
          <Button label="Read" onPress={refresh} disabled={!connected || busy !== null} />
        </View>

        <View style={styles.row}>
          <Button
            label="Start recording"
            onPress={() => run("Start recording", async () => void (await ute.startRecord()))}
            disabled={!connected || busy !== null}
          />
          <Button
            label="Stop"
            onPress={() => run("Stop recording", async () => void (await ute.stopRecord()))}
            disabled={!connected || busy !== null}
          />
        </View>

        {busy && (
          <View style={styles.busy}>
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.dim}>{busy}…</Text>
          </View>
        )}

        {progress && !progress.completed && (
          <Text style={styles.dim}>
            {progress.received} / {progress.total} bytes
          </Text>
        )}

        {devices.length > 0 && !connected && (
          <>
            <Text style={styles.heading}>Found</Text>
            {/* Likely UTE devices first, then strongest signal. */}
            {[...devices]
              .sort((a, b) => Number(!!b.likelyUte) - Number(!!a.likelyUte) || b.rssi - a.rssi)
              .map((device) => (
                <Pressable key={device.id} style={styles.item} onPress={() => connectTo(device)}>
                  <View>
                    <Text style={styles.itemText}>{device.name || "(no name)"}</Text>
                    <Text style={styles.dim}>{device.address}</Text>
                  </View>
                  <View style={styles.itemRight}>
                    {device.likelyUte && <Text style={[styles.dim, styles.good]}>UTE</Text>}
                    <Text style={styles.dim}>{device.rssi} dBm</Text>
                  </View>
                </Pressable>
              ))}
          </>
        )}

        {files && (
          <>
            <Text style={styles.heading}>Recordings</Text>
            {files.length === 0 && <Text style={styles.dim}>Nothing on the device.</Text>}
            {files.map((file) => (
              <Pressable key={file.sessionId} style={styles.item} onPress={() => download(file)}>
                <View>
                  <Text style={styles.itemText}>#{file.sessionId}</Text>
                  <Text style={styles.dim}>
                    {Math.round(file.size / 1024)} KB · type {file.type}
                  </Text>
                </View>
                <Ionicons name="download-outline" size={18} color={colors.accent} />
              </Pressable>
            ))}
          </>
        )}

        <Text style={styles.heading}>Log</Text>
        {log.map((line, i) => (
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
  safe: { flex: 1, backgroundColor: colors.bg },
  body: { padding: 20, gap: 10 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 12 },
  title: { color: colors.text, fontSize: 26, fontWeight: "600" },
  heading: { color: colors.text, fontSize: 15, fontWeight: "600", marginTop: 18 },
  dim: { color: colors.textDim, fontSize: 13 },
  row: { flexDirection: "row", gap: 8, flexWrap: "wrap", marginTop: 8 },
  button: {
    backgroundColor: colors.accentDim,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  buttonOff: { backgroundColor: colors.surface },
  buttonText: { color: colors.accent, fontWeight: "600", fontSize: 14 },
  busy: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 },
  item: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  itemText: { color: colors.text, fontSize: 15 },
  itemRight: { alignItems: "flex-end", gap: 2 },
  good: { color: colors.success },
  logLine: { color: colors.textDim, fontSize: 11, fontFamily: "Menlo" },
});
