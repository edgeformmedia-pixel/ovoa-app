# ES100 "twist to listen": implementation guide

Goal: flicking the **left wrist counter-clockwise** while wearing the ES100 starts
a listening turn, the same as saying "Hey OVOA". The clip buzzes once when it starts
listening. Settings gets a listen mode: `wake word` | `twist` | `both`.

Researched from the vendor SDK on 2026-09-18: iOS headers in
`jarvis/app/modules/ute-ble/ios/Frameworks/UTEBluetoothRYApi.framework/Headers/`, the
vendor demo (`GitHub/sdks/iossdk/iOS-SDK1.3.1/iOS_UTERYDemo.zip`, see
`FactoryAPI/FactoryAPIViewController.m` and `NoScreen/NoScreenViewController.m`), and
the Android PDF (`GitHub/sdks/UteWatchSDK_Android…_V1.3.5/*.pdf`, §2.18, §2.107, §2.118).

## Read this first: what is verified and what isn't

| Claim | Status |
|---|---|
| Method names and signatures below | **Verified** against the headers |
| The SDK has a built-in wrist-gesture event | **No, it has none.** We detect the twist ourselves from motion data |
| The ES100 firmware supports the motion stream or the sensor tests | **Unknown.** The SDK is shared by watches, glasses and earbuds. Probe first (Phase 0) |
| Sample rate, units and axis orientation of the motion data | **Unknown.** Log the raw data first; calibration handles orientation |
| The ES100 has a vibration motor | Likely: it buzzes during pairing ("SDK send pair") |

The ES100 has never connected successfully (CoreBluetooth error 14, a stale iOS
pairing). The fix is to Forget ES100 in iOS Bluetooth settings, then reconnect and
press the clip button. Nothing below can be tested until that works.

## Architecture

```
ES100 ──BLE──▶ UteBleBridge.m (ObjC)          ──▶ UteBleModule.swift ──▶ JS
               • motion source (A/B/C below)        onMotion event          src/lib/twist.ts (detector)
               • buzz(count)                        buzz() function          │ onTwist
               • probe()                            probe() function         ▼
                                                                            voice.ts useConversation:
                                                                            start an addressed turn,
                                                                            then buzz(1)
```

Keep every vendor call in `UteBleBridge.m`, following the existing pattern: Swift only
sees Foundation types, and the SDK's success code 100000 is normalized to 0 with
`UteNormalize`. Report unprompted events through the existing
`reportInput:`/`onInput`, or add a dedicated `onMotion` event, since motion is
high-frequency and shouldn't flood the `onInput` log in `clip.ts`.

---

## Phase 0: capability probe (build this first)

Run it once after the post-connect handshake succeeds, and send the result to
`devlog` so it lands in D1 `device_logs`.

```objc
// UteBleBridge.m
- (void)probeCapabilities:(UteBleResultCallback)completion {
  UTEModelDevice *d = [self mgr].connnectModel;
  if (!d) { completion(-1000, nil); return; }
  NSMutableDictionary *out = [@{
    @"hasGame"              : @(d.hasGame),              // motion-sensing game stream (source A)
    @"hasNoScreen"          : @(d.hasNoScreen),
    @"hasButtonWakeUpVoice" : @(d.hasButtonWakeUpVoice), // button -> voice assistant
    @"hasVoiceAssistant"    : @(d.hasVoiceAssistant),
    @"hasChatGPT"           : @(d.hasChatGPT),
    @"hasWearingHands"      : @(d.hasWearingHands),      // setWearingHands:0 = left
    @"hasAIRecording"       : @(d.hasAIRecording),
    @"hasAIRecordRealTime"  : @(d.hasAIRecordRealTime),
    @"hasGlasses"           : @(d.hasGlasses),
    @"hasEarphone"          : @(d.hasEarphone),
  } mutableCopy];

  // Factory capabilities: which sensor tests the firmware supports (sources B and C).
  [[UTEDeviceMgr sharedInstance] checkFactoryFuntion:^(UTEModelFactoryFuntion *f) {
    if (f) {
      out[@"f_gsensor"]  = @(f.isSupportG_sensorTest || f.isSupportGsensorTest);
      out[@"f_gyro"]     = @(f.isSupportGyroscopeTest);
      out[@"f_motor"]    = @(f.isSupportMotorSwitchTest);
      out[@"f_key"]      = @(f.isSupportKeyTest);
      out[@"f_noscreen"] = @(f.isSupportScreenlessWtchTest);
    }
    dispatch_async(dispatch_get_main_queue(), ^{ completion(0, out); });
  }];
}
```

Decision after the probe:
- `hasGame == YES`: use **source A**. This is the production path.
- Otherwise, if `f_gyro` or `f_gsensor` is true: use **source B/C**. Prototype only: factory mode may block recording and use more battery.
- Nothing is supported: fall back to the button (`onNotifyStartRecordBlock` or `chatGPT onNotifyChatGPTStatus`, which are already wired) and ask UTE for a firmware gesture event.

---

## Motion sources

### A: motion-sensing game stream (preferred)

Headers: `UTEMgrGame.h`, and `UTEModelGameOperate` in `UTEModelDevice.h`. Android
equivalent: `motionSensingGameEnable(true)` + `NotifyType.MOTION_SENSING_GAME_NOTIFY` (PDF §2.107).

```objc
- (void)setMotionStreaming:(BOOL)on completion:(void (^)(NSInteger errorCode))completion {
  UTEMgrGame *game = [UTEDeviceMgr sharedInstance].game;
  if (on) {
    __weak UteBleBridge *weakSelf = self;
    // Samples arrive in batches.
    [game onNotifyGameOperateBlock:^(NSInteger errorCode, NSArray<UTEModelGameOperate *> *arr) {
      if (UteNormalize(errorCode) != 0) return;
      NSMutableArray *samples = [NSMutableArray arrayWithCapacity:arr.count];
      for (UTEModelGameOperate *m in arr) {
        [samples addObject:@[ @(m.x), @(m.y), @(m.Speed),
                              @(m.X_Throw), @(m.Y_Throw), @(m.Speed_Throw) ]];
      }
      [weakSelf reportMotion:@{ @"source" : @"game",
                                @"t" : @([[NSDate date] timeIntervalSince1970] * 1000),
                                @"samples" : samples }];
    }];
  }
  [game sendGameStatus:on ? 1 : 0 Block:^(NSInteger errorCode) {   // 1 start, 0 end
    dispatch_async(dispatch_get_main_queue(), ^{ completion(UteNormalize(errorCode)); });
  }];
}
```

Notes:
- The fields are `x`, `y` and `Speed` (the header comments call the other ones gravity
  acceleration X/Y/Z). There is **no z axis**, so the detector must work from x/y alone.
  Calibration (below) picks whichever axis the twist moves.
- Android has a "game ended from the device" notify (`MOTION_SENSING_GAME_STATUS_NOTIFY`).
  The iOS header doesn't have one, so **re-send `sendGameStatus:1` after every reconnect**,
  and restart the stream if no samples arrive for about 5 s.
- Always send `sendGameStatus:0` on disconnect and when the user switches twist off.

### B: raw accelerometer (factory test, prototype only)

```objc
// Streaming callback: range, x, y, z, speed (total acceleration of all three axes).
[[UTEDeviceMgr sharedInstance] factoryGsensorTestBlock:^(NSInteger range, NSInteger x, NSInteger y, NSInteger z, NSInteger speed) {
  [weakSelf reportMotion:@{ @"source" : @"gsensor", @"t" : @(nowMs),
                            @"samples" : @[ @[ @(x), @(y), @(z), @(speed), @(range) ] ] }];
}];
[[UTEDeviceMgr sharedInstance] factoryOpenTestGsensor:YES];   // ...and NO to stop
```

The wearables (glasses/earbuds) variant is `[UTEDeviceMgr sharedInstance].wear`:
`factoryGsensor6:YES block:` + `onNotifyFactoryGsensor6:^(angle, x, y, z)`, and
`factoryStopAll` to stop it.

### C: gyroscope (factory test, possibly one reading per call)

```objc
// If it only returns one reading per call, poll it with an NSTimer at about 25 Hz.
[[UTEDeviceMgr sharedInstance] factoryReadGyroData:^(NSInteger range, NSInteger x, NSInteger y, NSInteger z) { ... }];
```

A gyroscope is the ideal twist sensor: rotation speed around the forearm axis. Check
whether it streams or returns a single reading, and at what rate, before relying on it.

**Warning for B/C:** the recorder has a `UTERecordStateTypeFactoryTest` (7) state.
After enabling a factory test, check `getRecordStatusBlock`. If the state becomes 7,
recording and live audio are blocked, which rules B/C out for daily use.

---

## Output: make the clip vibrate

```objc
- (void)buzz:(NSInteger)count {
  UTEDeviceMgr *dev = [UTEDeviceMgr sharedInstance];
  // Option 1 (production API): "find my device". The device may also ring.
  [dev setFindWearCmd:1 block:^(NSInteger errorCode, NSDictionary *d) {}];
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.25 * count * NSEC_PER_SEC)),
                 dispatch_get_main_queue(), ^{
    [dev setFindWearCmd:0 block:^(NSInteger errorCode, NSDictionary *d) {}];
  });
  // Option 2 (factory API, cleaner pulses): [dev factoryVibration:count];
  // Option 3 (factory API, raw motor): factoryMotorTestCMD:1 / :0 Block:^(NSInteger state){}
}
```

Try option 2 first on the device. If it works and doesn't change the record state,
it's the nicest-feeling buzz. `setSoundVibration` only changes vibration **settings**;
it doesn't trigger a buzz.

Android: `mUteBleConnection.setFindWearCmd(1)` / `(0)` (PDF §2.18).

Also set once after pairing: `setWearingHands:0 Block:` (0 = left). This tells the
firmware how it's worn and is harmless if the firmware ignores it.

---

## Swift and JS surface

```swift
// UteBleModule.swift: add "onMotion" to Events(...)
self.bridge.onMotion = { [weak self] m in self?.sendEvent("onMotion", m) }
AsyncFunction("probe")            { (p: Promise) in bridge.probeCapabilities { c, r in c == 0 ? p.resolve(r) : p.reject(UteException("probe failed \(c)")) } }
AsyncFunction("setMotionStreaming") { (on: Bool, p: Promise) in bridge.setMotionStreaming(on) { c in c == 0 ? p.resolve(nil) : p.reject(UteException("motion \(c)")) } }
AsyncFunction("buzz")             { (count: Int) in bridge.buzz(count) }
```

```ts
// src/UteBle.types.ts
export type MotionEvent = {
  source: "game" | "gsensor" | "gyro";
  t: number;              // ms, phone clock at batch arrival
  samples: number[][];    // game: [x, y, speed, xThrow, yThrow, speedThrow]; gsensor: [x, y, z, speed, range]
};
// UteBleEvents: onMotion: (e: MotionEvent) => void;
```

---

## Detector: `jarvis/app/src/lib/twist.ts` (pure TypeScript, testable)

Orientation is unknown, since a clip can be worn many ways. So **calibration learns
which axis and which sign a counter-clockwise twist produces**, and detection watches
for a fast swing on that axis that comes back.

```ts
export type TwistProfile = { axis: number; sign: 1 | -1; threshold: number };

type Sample = { t: number; v: number[] };

const WINDOW_MS = 600;      // the swing must happen this fast
const RETURN_MS = 700;      // ...and come back within this long (a flick, not a held pose)
const REFRACTORY_MS = 2000; // ignore the next 2 s after firing
const BASELINE_ALPHA = 0.02;

/** Calibration: record ~3 s of stillness, then 3 twists. Picks the axis/sign with the largest twist-vs-rest swing. */
export function calibrate(rest: Sample[], twists: Sample[][], axes: number[]): TwistProfile {
  let best = { axis: axes[0], sign: 1 as 1 | -1, score: 0, peak: 0 };
  for (const axis of axes) {
    const restVals = rest.map((s) => s.v[axis]);
    const mean = restVals.reduce((a, b) => a + b, 0) / restVals.length;
    const noise = Math.sqrt(restVals.reduce((a, b) => a + (b - mean) ** 2, 0) / restVals.length) || 1;
    // The signed peak deviation in each twist; all three must agree on the sign.
    const peaks = twists.map((tw) => {
      const devs = tw.map((s) => s.v[axis] - mean);
      const max = Math.max(...devs), min = Math.min(...devs);
      return Math.abs(max) >= Math.abs(min) ? max : min;
    });
    const sameSign = peaks.every((p) => Math.sign(p) === Math.sign(peaks[0]));
    const minPeak = Math.min(...peaks.map(Math.abs));
    const score = sameSign ? minPeak / noise : 0;
    if (score > best.score) best = { axis, sign: Math.sign(peaks[0]) as 1 | -1, score, peak: minPeak };
  }
  if (best.score < 4) throw new Error("Twist not distinct enough from rest. Try a sharper flick.");
  return { axis: best.axis, sign: best.sign, threshold: best.peak * 0.6 };
}

/** Streaming detector. Feed every sample; it calls onTwist at most once per REFRACTORY_MS. */
export function createTwistDetector(profile: TwistProfile, onTwist: () => void) {
  let baseline: number | null = null;
  let armedAt: number | null = null;  // when the swing crossed the threshold
  let lastFire = 0;

  return (s: Sample) => {
    const raw = s.v[profile.axis];
    if (baseline === null) baseline = raw;
    const d = profile.sign * (raw - baseline);

    // The baseline only follows while no swing is in progress, so a twist doesn't pull it along.
    if (armedAt === null) baseline += BASELINE_ALPHA * (raw - baseline);

    if (s.t - lastFire < REFRACTORY_MS) return;

    if (armedAt === null) {
      if (d > profile.threshold) armedAt = s.t;           // counter-clockwise swing started
      return;
    }
    if (s.t - armedAt > RETURN_MS) { armedAt = null; return; } // held too long: a pose change, not a flick
    if (d < profile.threshold / 3) {                        // came back: that's a flick
      armedAt = null;
      lastFire = s.t;
      onTwist();
    }
  };
}
```

**Clockwise vs counter-clockwise:** calibration records the user's counter-clockwise
twist, so `sign` is counter-clockwise by definition. A clockwise flick moves the other
way (`d` goes negative) and never arms the detector. Don't assume a sign from the
header's axis names.

**Samples in a batch:** the phone only sees the time a batch arrived. Spread the
samples in a batch evenly back to the previous batch's time:
`t_i = prevT + (e.t - prevT) * (i + 1) / n`.

Store `TwistProfile` in `storage` next to `alwaysListenPref` in `voice.ts`, for example
under `ovoa.twistProfile`.

---

## Wiring into listening (`jarvis/app/src/lib/voice.ts`)

`useConversation(token, onUserSaid, { background, name })` with `background: true`
(Always listen) only answers when the user says the name. A twist has to count as
being addressed:

1. Add a ref to `useConversation`: `forceAddressedUntil = useRef(0)`, and return
   `summon()`, which sets it to `Date.now() + 8000` and, if `phase === "off"`, calls `start()`.
2. Wherever `addressed` is computed for an utterance, use
   `addressed || Date.now() < forceAddressedUntil.current`.
3. In the provider that owns the conversation (`assistant.tsx`):
   ```ts
   useEffect(() => {
     if (mode === "wake") return;
     let detector: ((s: Sample) => void) | null = null;
     twistProfile.get().then((p) => { if (p) detector = createTwistDetector(p, () => { ute.buzz(1); conversation.summon(); }); });
     const sub = ute.addListener("onMotion", (e) => { /* spread timestamps; detector?.(sample) */ });
     ute.setMotionStreaming(true).catch((err) => devlog("err", "twist: motion stream failed", String(err)));
     return () => { sub.remove(); ute.setMotionStreaming(false).catch(() => {}); };
   }, [mode, clipConnected]);
   ```
4. Optional: `buzz(2)` when a reply finishes speaking.

Mode `twist`: the microphone stays closed until a twist, so wake-word listening is off
and it's easier on the battery. Mode `both`: keep Always listen on and add the twist
summon.

---

## Background and battery

- The motion stream only runs while BLE is connected. `bluetooth-central` must be in
  `UIBackgroundModes` in `app.json`; check whether it already is.
- A continuous BLE stream costs battery on both devices. Log the clip's battery
  (`onInput` kind `battery`) over an hour with streaming on, and compare with it off.
- Stop the stream when the clip disconnects or the app turns twist off.

---

## Test plan (read the results in D1 `device_logs`)

1. Fix the pairing, connect, and run `probe()`. Log the result with the text `twist probe`.
2. Stream for 10 s at rest, then 10 s of counter-clockwise flicks, then 10 s of
   walking. `devlog` every raw batch with the text `motion raw`.
3. ```bash
   npx wrangler d1 execute jarvis-db --remote --command "SELECT time,text,detail FROM device_logs WHERE text LIKE 'motion%' OR text LIKE 'twist%' ORDER BY id DESC LIMIT 300"
   ```
   (run from `jarvis/api`). Check the sample rate, value ranges, and which axis moves.
4. Tune `WINDOW_MS`, `RETURN_MS` and the threshold multiplier. Target: 10 of 10 flicks
   detected, and 0 false triggers in 5 minutes of walking or typing.
5. Test `buzz` options 1, 2 and 3. Check `getRecordStatusBlock` after each: the state must not be 7.

## Fallbacks if the ES100 can't stream motion

- The clip button is already reported: `onRecordStart` from the device, and
  `onInput` kind `voiceButton` (via `chatGPT onNotifyChatGPTStatus`). Map one of them
  to `summon()`.
- Ask UTE for firmware that sends a gesture event, or turns `setButtonWakeUpVoiceAssistant:1`
  into a twist-triggered wake.
