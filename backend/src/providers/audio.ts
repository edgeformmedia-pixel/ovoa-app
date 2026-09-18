import { config } from "../config.js";

/**
 * Wrap raw PCM16 in a WAV container. STT providers accept raw PCM only if you
 * describe the encoding out-of-band; a WAV header is self-describing and costs
 * 44 bytes, so we always upload WAV.
 */
export function pcmToWav(pcm: Buffer): Buffer {
  const { sampleRate, channels, bitsPerSample } = config.audio;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

export function pcmDurationSec(bytes: number): number {
  const { sampleRate, channels, bitsPerSample } = config.audio;
  return bytes / ((sampleRate * channels * bitsPerSample) / 8);
}
