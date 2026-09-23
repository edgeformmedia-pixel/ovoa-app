# 05 · Free notes: transcribe on the iPhone, not on the server

Repo: `…\ovoa-app`, folder `jarvis/app` (plus `jarvis/api` only if a notes route needs a field).
Read first:
- `docs/paywall/SPEC.md` §4.
- `docs/cost-cut-prompt.md` §1.
- `jarvis/app/AGENTS.md`, and the Expo SDK 57 docs.
- The Band SDK facts: the Band sends 16 kHz mono **opus**, and the UTE framework only works in real-device builds.
- How the Band clip is downloaded and sent for transcription today (search the app for the clip upload, and `jarvis/api/src/voice.ts` for whisper / Deepgram pre-recorded).
- How `modules/ute-ble` is guarded for web and Expo Go.

## Goal
Free users' notes, both Band recordings and in-app dictation, are turned into text by Apple's speech recognition **on the phone**, with `requiresOnDeviceRecognition` preferred so no audio leaves the phone. The server only gets the text. Paid users keep the current server path (it's better on long clips), unless you measure on-device as good enough.

## Do
1. **Pick the library.**
   - Look at `expo-speech-recognition` (jamsch) and similar packages. The library must support SDK 57, file-based recognition (`audioSource.uri`), on-device mode, and a config plugin for the permission strings (`NSSpeechRecognitionUsageDescription`, `NSMicrophoneUsageDescription`).
   - Prefer a maintained package over writing a native module.
   - Check it works with the prebuild and Codemagic setup in `codemagic.yaml`.
2. **The opus problem.**
   - Find out whether SFSpeechRecognizer accepts the Band's opus file as saved.
   - If it doesn't, convert on the phone to 16 kHz mono WAV, CAF or M4A before recognition. Use AVAudioConverter through the chosen module, or a small Swift helper in `modules/`.
   - Put a short comment at the top of the module on why the conversion exists.
3. **`transcribeOnDevice(uri): Promise<{ text, onDevice: boolean } | null>`** in `src/lib/`.
   - It returns `null` on web, Expo Go, denied permission or an unsupported locale. The caller then saves the note as audio with "Couldn't transcribe on this phone".
   - It handles clips longer than one recognition request by splitting them if needed.
   - It logs timings and failures to `device_logs`, like the rest of the app.
4. **Permission prompt.** Ask the first time a free user records, with a one-line reason. Never ask at launch.
5. **Server side.** A note can be created with text only and `source: "on_device"`. It must not require audio.

## Verify
- `npx tsc --noEmit`, plus a web run showing the graceful `null` path.
- You cannot test the real thing on Windows. Write the exact on-device test for the user: on a free account, record a 5 s and a 60 s Band clip, then check `device_logs` for `on-device transcript after N ms`.
- After the user's TestFlight run, read `device_logs` for device `ios-6mjol3py8umu7sb93z` and report what actually happened.

## Finish
Commit and push `main`. Say plainly what stays unverified until the device test.
