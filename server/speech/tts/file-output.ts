import { RELAY_TTS_SAMPLE_RATE, encodeWavPcm16Mono } from "../audio";
import type { TtsFileFormat, TtsFileResult } from "./types";

/** Convert normalized 24 kHz s16le PCM into the file shape an HTTP caller asked for. */
export function pcmToTtsFile(pcm: Buffer, preferred: TtsFileFormat): TtsFileResult {
  if (preferred === "pcm_f32le") {
    const samples = Math.floor(pcm.length / 2);
    const out = Buffer.alloc(samples * 4);
    for (let i = 0; i < samples; i++) out.writeFloatLE(pcm.readInt16LE(i * 2) / 32768, i * 4);
    return { audio: out, contentType: "application/octet-stream", format: "pcm_f32le" };
  }
  // MP3 cannot be produced without an encoder; return an honest WAV container instead of
  // mislabelled bytes. Browsers play it, and the response header states the real format.
  return { audio: encodeWavPcm16Mono(pcm, RELAY_TTS_SAMPLE_RATE), contentType: "audio/wav", format: "wav" };
}
