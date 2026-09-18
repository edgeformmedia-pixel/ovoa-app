import path from "node:path";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  dataDir: path.resolve(process.env.DATA_DIR ?? "./data"),
  deviceToken: required("DEVICE_TOKEN"),

  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  deepgramApiKey: process.env.DEEPGRAM_API_KEY,
  elevenLabsApiKey: process.env.ELEVENLABS_API_KEY,
  elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID ?? "21m00Tcm4TlvDq8ikWAM",

  /**
   * The ES100 is mic-only, so the phone owns BLE framing and codec decode and
   * uploads plain PCM. Everything downstream assumes this shape; if the sniffed
   * protocol turns out to use a different rate, change it here and in the app.
   */
  audio: {
    sampleRate: 16_000,
    channels: 1,
    bitsPerSample: 16,
  },
} as const;

export const MODEL = "claude-opus-5";
