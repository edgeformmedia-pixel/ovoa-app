# OVOA

Mobile app and backend for the ES100 — a mic-only wearable that captures ambient
audio, transcribes it, and makes the day searchable and answerable.

**Status:** backend and AI pipeline are built and running. The mobile app is not
started yet, and the device's BLE protocol is still unknown.

---

## Architecture

```
ES100  ──BLE──>  Phone (React Native)  ──HTTPS──>  Backend
 mic-only        decodes codec,                    STT → Claude
                 uploads PCM16                     transcripts DB
                 plays TTS back                    SSE chat
```

Three decisions worth knowing up front:

**The phone owns the codec.** It decodes whatever the ES100 emits and uploads
plain PCM16 @ 16 kHz. The codec is the part most likely to be wrong on the first
attempt, and this keeps fixing it a client-side change.

**The backend owns the keys.** No Anthropic, Deepgram, or ElevenLabs key ever
ships in the app binary — those get extracted from a mobile app within a day.

**Providers sit behind interfaces.** STT falls back to a mock transcriber when
`DEEPGRAM_API_KEY` is unset, so the whole pipeline runs end-to-end before you
have signed up for anything.

---

## Quickstart

```bash
cd backend && npm install && cp .env.example .env
```

Edit `.env` — set `DEVICE_TOKEN` to any long random string, and
`ANTHROPIC_API_KEY` to a real key. The other keys are optional.

```bash
npm run dev
```

Check it came up:

```bash
curl localhost:8787/health
```

`{"ok":true,"stt":"mock",...}` means it is running with the mock transcriber —
expected until you add `DEEPGRAM_API_KEY`.

### See it on your phone

The backend serves a web UI at `/`, so you can use OVOA from your phone before
the native app exists. Start the server and it prints the address to open:

```
Open on your phone: http://192.168.1.x:8787
```

Put that in your phone's browser — same Wi-Fi as the laptop — and enter your
`DEVICE_TOKEN` when asked. On iOS, Share → Add to Home Screen gives it an icon
and a full-screen window.

If the page will not load, Windows Firewall is the usual cause. Allow the port
once, from an elevated PowerShell:

```powershell
New-NetFirewallRule -DisplayName "OVOA dev" -Direction Inbound -LocalPort 8787 -Protocol TCP -Action Allow
```

The UI has an **Ask** tab that streams answers and shows which tools ran, and a
**Captures** tab listing recordings with their summaries and action items. The
**Test capture** button fabricates one, so the whole thing is usable with no
pendant attached.

### Test it without a device

You do not need the ES100 to exercise the pipeline. With `ANTHROPIC_API_KEY` set:

```bash
node --env-file=.env scripts/demo.mjs
```

That pushes a capture through ingest, lets the mock transcriber stand in for the
wearable, then runs both Claude calls — enrichment on close, and a streamed chat
question against the stored transcript. It prints the title, summary, action
items, the streamed answer, and token usage.

The mock transcriber returns a realistic sample conversation rather than a
placeholder, because enrichment and chat are exactly the parts worth testing
without hardware and neither does anything interesting given "captured 9s of
audio".

### Feeding it real audio

Audio must be **raw PCM16 LE, 16 kHz, mono** — the server wraps it in a WAV
header before transcription. To convert anything you already have:

```bash
ffmpeg -i input.m4a -f s16le -acodec pcm_s16le -ar 16000 -ac 1 out.pcm
```

Then post it as a chunk:

```bash
TOKEN=<your DEVICE_TOKEN>
ID=$(curl -s -X POST localhost:8787/v1/captures -H "Authorization: Bearer $TOKEN" | jq -r .id)
curl -X POST "localhost:8787/v1/captures/$ID/chunk" -H "Authorization: Bearer $TOKEN"      -H "Content-Type: application/octet-stream" --data-binary @out.pcm
curl -X POST "localhost:8787/v1/captures/$ID/close" -H "Authorization: Bearer $TOKEN"
curl "localhost:8787/v1/captures/$ID" -H "Authorization: Bearer $TOKEN"
```

Set `DEEPGRAM_API_KEY` first, or the mock transcriber will ignore your bytes.

---

## API

All routes except `/health` require `Authorization: Bearer <DEVICE_TOKEN>`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness plus which providers are configured |
| `POST` | `/v1/captures` | Start a capture, returns its `id` |
| `POST` | `/v1/captures/:id/chunk` | Append raw PCM16 (`application/octet-stream`) |
| `POST` | `/v1/captures/:id/close` | Finish; transcription and enrichment run in background |
| `GET` | `/v1/captures` | List recent captures |
| `GET` | `/v1/captures/:id` | One capture with transcript, summary, action items |
| `POST` | `/v1/chat` | Ask a question across recent transcripts (SSE) |
| `POST` | `/v1/device/state` | Phone reports location, pendant battery, timezone |
| `GET` | `/v1/device/state` | Last reported state |
| `POST` | `/v1/tts` | Text → MPEG audio for phone playback |

`/v1/chat` streams `token` events carrying `{text}`, then a terminal `done` or
`error`. Post `{"turns":[{"role":"user","content":"..."}]}`.

A capture moves `recording → processing → ready`, or `failed` with the reason in
its `error` field. Processing happens after the close request returns, so the
phone can disconnect as soon as its bytes are on disk — poll `GET /v1/captures/:id`
for the result.

---

## How Claude is used

**Enrichment** (`enrichTranscript`) runs on every capture: title, summary, action
items, via structured outputs so the result is schema-valid without parsing
prose. Effort is `low` — bounded extraction that runs constantly.

**Chat** (`streamChat`) answers open-ended questions through tool use rather than
a stuffed prompt. Transcripts are reached with a search tool because a day of
wear is roughly 40k tokens: context-stuffing stops fitting within a week and can
never reach older recordings at any size.

| Tool | Does |
|---|---|
| `search_transcripts` | Full-text search over everything recorded, with a date window |
| `get_capture` | Full transcript of one capture |
| `list_captures` | Recent captures for "what happened today" questions |
| `get_current_context` | Time, phone location, pendant battery — with the age of the location |
| `locate_family_member` | Explains that live location is unavailable (see below) |
| `web_search` | Anthropic-hosted, nothing to implement |

Search OR-joins terms so an imperfect transcript still matches, which makes the
stopword list load-bearing: one common word left in the query matches every
capture ever recorded. `"where is my kid"` correctly returns nothing rather than
the entire archive on the strength of `"is"`.

Both prompts are explicit that transcripts are unreliable — diarization mislabels
speakers and ambient audio drops words. A confident wrong answer about the
user's own life is worse than an admission that the audio did not catch it.

Server-side refusal fallbacks are enabled on the chat path (`fallbacks: "default"`),
so a category-specific refusal reroutes rather than failing.

### "Where's my kid?"

Worth understanding, because it is three different questions
(→ [docs/capabilities.md](docs/capabilities.md)):

- **Recall** — *"she said she'd be at Maya's until six"*. Transcript search.
  Works today, and is usually what the person actually wanted.
- **Live location** — needs per-user accounts, a revocable grant from the person
  being located, and an audit trail they can see. Blocked on real auth.
- **Covert tracking** — not built. Location sharing the subject cannot see or
  revoke is the defining property of stalkerware, and family-tracking products
  are a known vector for intimate-partner surveillance.

`locate_family_member` currently returns a structured "not available" that tells
the model to search the transcripts and be clear it is reporting what someone
said, not where they are.

## Before you ship

These are known gaps, not oversights:

- **Auth is a single shared token.** Fine for your own phone on your own Wi-Fi,
  unacceptable once it is on the internet. Needs real per-user accounts, and
  captures need an owner column.
- **Storage is SQLite on local disk.** The query layer is plain SQL so Postgres
  is a driver swap, but audio files need to move to object storage.
- **Audio is stored indefinitely and unencrypted.** Decide on a retention window
  and encrypt at rest before real recordings exist.
- **Recording consent.** Always-on capture is two-party consent in roughly 11 US
  states. You need explicit in-app disclosure and a visible recording indicator.
  Design it in now — retrofitting consent UX is painful.

---

## Next

1. **Sniff the BLE protocol** — [docs/ble-reverse-engineering.md](docs/ble-reverse-engineering.md).
   Everything on the device side is blocked on this.
2. **Scaffold the app** — React Native + Expo dev build (not Expo Go; raw BLE
   needs native modules), `react-native-ble-plx`. iOS needs
   `UIBackgroundModes: bluetooth-central`; Android needs a foreground service
   plus `BLUETOOTH_SCAN`/`BLUETOOTH_CONNECT`.
3. **Swap the mock transcriber** for Deepgram once there is real audio to feed it.
