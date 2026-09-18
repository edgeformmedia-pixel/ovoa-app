# Reverse-engineering the ES100 BLE protocol

You need five things before the app can talk to the device:

1. The GATT **service** and **characteristic** UUIDs
2. Which characteristic carries **audio notifications**
3. The **codec and framing** of those notification payloads
4. The **control writes** that start/stop capture
5. How **battery** and **button events** are reported

This is all recoverable from the vendor's own Android app. Plan on a day.

> iOS cannot be sniffed this way — CoreBluetooth exposes no packet log. Do the
> capture work on Android even if iOS is your launch platform.

---

## Step 1 — Get the vendor app

Ask the supplier for the APK directly; most will send it. Otherwise find the app
name on the Alibaba listing and pull the APK from APKMirror or APKPure.

Install it on a real Android phone. Emulators have no Bluetooth radio.

## Step 2 — Turn on HCI snoop logging

On the phone: **Settings → Developer options → Enable Bluetooth HCI snoop log**,
then toggle Bluetooth off and on. The setting only takes effect on a fresh
Bluetooth stack start.

## Step 3 — Perform each action deliberately

Open the vendor app and do one thing at a time, pausing ~5 seconds between
actions and writing down what you did:

| Time | Action |
|---|---|
| 0:00 | Pair / connect |
| 0:10 | Read battery level |
| 0:20 | Start recording |
| 0:40 | Stop recording |
| 0:50 | Press the device button |

Those gaps become visible as silence in the packet log and make each command
trivial to isolate. Without them you are reading an undifferentiated wall of
packets.

## Step 4 — Pull the log

```bash
adb bugreport ovoa-bugreport.zip
```

The snoop log is inside at `FS/data/misc/bluetooth/logs/btsnoop_hci.log`. On some
builds you can grab it directly:

```bash
adb pull /data/misc/bluetooth/logs/btsnoop_hci.log
```

## Step 5 — Read it in Wireshark

Open the log and filter to the attribute protocol:

```
btatt
```

What to look for, in order:

**Service discovery.** `Read By Group Type Response` packets list every service
UUID. A vendor-specific 128-bit UUID (not one of the `0000xxxx-0000-1000-8000-
00805f9b34fb` standard ones) is the proprietary audio service. Note it.

**Enabling notifications.** A `Write Request` of `0100` to a handle whose type is
`0x2902` (Client Characteristic Configuration Descriptor) is the app subscribing
to a stream. The characteristic *just below* that handle is the one carrying
data. This is the single most important packet in the log.

**The audio stream.** After that subscribe, you will see a flood of
`Handle Value Notification` packets on that handle. That is your audio.

**Control commands.** Short `Write Request` / `Write Command` packets on a
*different* handle, landing at the timestamps where you pressed start and stop.
Usually 1–8 bytes. Compare the start-recording write to the stop-recording write
— often they differ by a single byte (e.g. `0x01` vs `0x00`).

## Step 6 — Identify the codec

Measure two numbers from the notification packets: **payload size** and **packets
per second**. Multiply for the bitrate.

| Payload | Rate | Bitrate | Almost certainly |
|---|---|---|---|
| 40–80 B | ~50/s | 16–32 kbps | **Opus**, 16 kHz, 20 ms frames |
| 120–160 B | ~50/s | ~64 kbps | **ADPCM** (4-bit, 16 kHz) |
| ~244 B | high | >128 kbps | **SBC**, or raw PCM over 2M PHY |

Raw PCM16 at 16 kHz is 256 kbps, which does not fit comfortably in classic BLE —
if the numbers are low, it is compressed, and Opus is the overwhelming default in
this device category.

Many vendor packets carry a small header before the codec frame — a sequence
number, sometimes a timestamp. If byte 0 increments by one on every packet and
wraps at 256, that is a sequence counter, not audio. Strip it before decoding.

## Step 7 — Confirm with live exploration

Install **nRF Connect for Mobile** (Nordic, free). Connect to the ES100 directly
and it will enumerate every service and characteristic with its properties
(`READ` / `WRITE` / `NOTIFY`). You can subscribe to a characteristic and watch
raw bytes arrive, and you can replay the control writes you found in Step 5 to
confirm they do what you think.

If writing your suspected start-recording bytes makes the device's LED change,
you have the command.

## Step 8 — Cross-check against the APK

Static analysis confirms guesses fast:

```bash
jadx -d vendor-app-decompiled vendor-app.apk
grep -ri "0000[0-9a-f]\{4\}-0000-1000-8000-00805f9b34fb" vendor-app-decompiled/ | head
grep -rn "BluetoothGattCharacteristic" vendor-app-decompiled/sources/ | head -40
```

Two high-signal checks:

- **UUID constants.** Hardcoded UUID strings in the decompiled source should
  match what you saw in Wireshark. If they match, you have the right service.
- **`lib/arm64-v8a/` contents.** A bundled `libopus.so` is near-proof the stream
  is Opus. `libsbc.so`, likewise, for SBC. No audio library at all suggests
  ADPCM, which is simple enough to implement inline.

---

## What to hand the app

Once you know all five, the phone side owns decode and framing, and uploads
plain PCM16 to the backend. That boundary is deliberate: the codec is the part
most likely to be wrong on the first try, and keeping it on the device means
fixing it does not require a backend deploy.

Record your findings in `docs/es100-protocol.md` as you go — UUIDs, byte
offsets, and command bytes are exactly the details you will not remember in
three weeks.
