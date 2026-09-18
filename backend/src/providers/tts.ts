import { config } from "../config.js";

/**
 * The ES100 has no speaker, so synthesized audio plays on the phone. Returns
 * MPEG bytes the app can hand straight to its audio player.
 */
export async function synthesize(text: string): Promise<Buffer> {
  if (!config.elevenLabsApiKey) throw new Error("ELEVENLABS_API_KEY is not set");

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${config.elevenLabsVoiceId}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": config.elevenLabsApiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({ text, model_id: "eleven_turbo_v2_5" }),
    },
  );

  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}
