/**
 * Audio helpers for the speech adapters.
 *
 * Wire formats owned by Aural:
 *  - Browser → relay (STT input): mono 16 kHz s16le PCM.
 *  - Relay → browser (TTS output): mono 24 kHz s16le PCM (see src/hooks/use-voice.ts, which reads
 *    binary frames as Int16Array, and playbackAckFallbackMs, which assumes 48 bytes per ms).
 */
import { spawn } from "node:child_process";

export const RELAY_TTS_SAMPLE_RATE = 24_000;
export const STT_SAMPLE_RATE = 16_000;

export class SpeechAudioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpeechAudioError";
  }
}

export function encodeWavPcm16Mono(pcm: Buffer, sampleRate: number): Buffer {
  const dataBytes = pcm.length - (pcm.length % 2);
  const out = Buffer.alloc(44 + dataBytes);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(dataBytes, 40);
  pcm.copy(out, 44, 0, dataBytes);
  return out;
}

export interface DecodedPcm {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  floatSamples: boolean;
  data: Buffer;
}

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

export function parseWav(buf: Buffer): DecodedPcm {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new SpeechAudioError("Audio is not a valid WAV container");
  }
  let fmt: Omit<DecodedPcm, "data"> | null = null;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const declared = buf.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    if (id === "fmt ") {
      if (declared < 16 || bodyStart + 16 > buf.length) throw new SpeechAudioError("Truncated WAV fmt chunk");
      let tag = buf.readUInt16LE(bodyStart);
      if (tag === WAVE_FORMAT_EXTENSIBLE && declared >= 26 && bodyStart + 26 <= buf.length) tag = buf.readUInt16LE(bodyStart + 24);
      if (tag !== WAVE_FORMAT_PCM && tag !== WAVE_FORMAT_FLOAT) {
        throw new SpeechAudioError(`Unsupported WAV encoding (format tag ${tag}); expected PCM or IEEE float`);
      }
      const bitsPerSample = buf.readUInt16LE(bodyStart + 14);
      const floatSamples = tag === WAVE_FORMAT_FLOAT;
      if (floatSamples ? bitsPerSample !== 32 : ![16, 24, 32].includes(bitsPerSample)) {
        throw new SpeechAudioError(`Unsupported WAV sample size (${bitsPerSample} bits)`);
      }
      const channels = buf.readUInt16LE(bodyStart + 2);
      const sampleRate = buf.readUInt32LE(bodyStart + 4);
      if (channels < 1 || channels > 8 || sampleRate < 4000 || sampleRate > 192_000) {
        throw new SpeechAudioError("WAV header has an unsupported channel count or sample rate");
      }
      fmt = { sampleRate, channels, bitsPerSample, floatSamples };
    } else if (id === "data") {
      if (!fmt) throw new SpeechAudioError("WAV data chunk precedes fmt chunk");
      // Streaming encoders write 0 or 0xFFFFFFFF as the size; treat both as "to end of buffer".
      const available = buf.length - bodyStart;
      const length = declared === 0 || declared === 0xffffffff || declared > available ? available : declared;
      const frameBytes = (fmt.bitsPerSample / 8) * fmt.channels;
      const usable = length - (length % frameBytes);
      return { ...fmt, data: buf.subarray(bodyStart, bodyStart + usable) };
    }
    offset = bodyStart + declared + (declared % 2);
  }
  throw new SpeechAudioError(fmt ? "WAV has no data chunk" : "WAV has no fmt chunk");
}

function readSample(d: DecodedPcm, byteOffset: number): number {
  if (d.floatSamples) return d.data.readFloatLE(byteOffset);
  switch (d.bitsPerSample) {
    case 16: return d.data.readInt16LE(byteOffset) / 32768;
    case 24: return d.data.readIntLE(byteOffset, 3) / 8388608;
    default: return d.data.readInt32LE(byteOffset) / 2147483648;
  }
}

/** Downmix to mono, resample to `targetRate` and return s16le. Pure and bounded by input size. */
export function toRelayPcm(input: DecodedPcm, targetRate = RELAY_TTS_SAMPLE_RATE): Buffer {
  const bytesPerSample = input.bitsPerSample / 8;
  const frames = Math.floor(input.data.length / (bytesPerSample * input.channels));
  const mono = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < input.channels; c++) {
      const sample = readSample(input, (f * input.channels + c) * bytesPerSample);
      sum += Number.isFinite(sample) ? sample : 0;
    }
    mono[f] = sum / input.channels;
  }
  const outFrames = input.sampleRate === targetRate ? frames : Math.floor((frames * targetRate) / input.sampleRate);
  const out = Buffer.alloc(outFrames * 2);
  const ratio = input.sampleRate / targetRate;
  for (let i = 0; i < outFrames; i++) {
    let value: number;
    if (ratio === 1) {
      value = mono[i];
    } else if (ratio > 1) {
      // Downsampling: average the source window to limit aliasing.
      const start = Math.floor(i * ratio);
      const end = Math.max(start + 1, Math.min(frames, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (let j = start; j < end; j++) sum += mono[j];
      value = sum / (end - start);
    } else {
      const position = i * ratio;
      const lower = Math.floor(position);
      const upper = Math.min(frames - 1, lower + 1);
      const fraction = position - lower;
      value = mono[lower] * (1 - fraction) + mono[upper] * fraction;
    }
    out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), i * 2);
  }
  return out;
}

export type SpeechAudioFormat = "wav" | "pcm" | "mp3" | "opus" | "aac" | "flac";
export const SPEECH_AUDIO_FORMATS: readonly SpeechAudioFormat[] = ["wav", "pcm", "mp3", "opus", "aac", "flac"];
const FFMPEG_FORMATS = new Set<SpeechAudioFormat>(["mp3", "opus", "aac", "flac"]);

export function formatNeedsFfmpeg(format: SpeechAudioFormat): boolean {
  return FFMPEG_FORMATS.has(format);
}

function looksLikeWav(buf: Buffer): boolean {
  return buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE";
}

function looksCompressed(buf: Buffer): string | null {
  if (buf.length >= 3 && buf.toString("latin1", 0, 3) === "ID3") return "mp3";
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return "mp3";
  if (buf.length >= 4 && buf.toString("ascii", 0, 4) === "OggS") return "ogg/opus";
  if (buf.length >= 4 && buf.toString("ascii", 0, 4) === "fLaC") return "flac";
  return null;
}

export interface DecodeOptions {
  format: SpeechAudioFormat;
  /** Sample rate of raw `pcm` responses. OpenAI's `pcm` format is 24 kHz. */
  pcmSampleRate?: number;
  ffmpegPath?: string;
  /** Kill ffmpeg after this long. */
  timeoutMs?: number;
  /** Abort ffmpeg once its decoded output exceeds this many bytes (default 256 MiB). */
  maxOutputBytes?: number;
}

/** Decode a provider response body into mono 24 kHz s16le for the browser relay. */
export async function decodeSpeechAudio(body: Buffer, options: DecodeOptions): Promise<Buffer> {
  if (body.length === 0) throw new SpeechAudioError("Speech provider returned empty audio");
  const { format } = options;
  if (formatNeedsFfmpeg(format)) return decodeWithFfmpeg(body, options);

  if (looksLikeWav(body)) return toRelayPcm(parseWav(body));
  const compressed = looksCompressed(body);
  if (compressed) {
    throw new SpeechAudioError(
      `Provider returned compressed ${compressed} audio but the configured format is ${format}; set the TTS format to ${compressed === "mp3" ? "mp3 (requires ffmpeg)" : "wav"}`,
    );
  }
  if (format === "wav") throw new SpeechAudioError("Provider response is not a WAV container");
  if (body.length % 2 !== 0) throw new SpeechAudioError("Raw PCM response has an odd byte count (not 16-bit aligned)");
  return toRelayPcm({
    sampleRate: options.pcmSampleRate ?? RELAY_TTS_SAMPLE_RATE, channels: 1, bitsPerSample: 16, floatSamples: false, data: body,
  });
}

const MAX_FFMPEG_OUTPUT_BYTES = 256 * 1024 * 1024;

export function decodeWithFfmpeg(body: Buffer, options: Pick<DecodeOptions, "ffmpegPath" | "timeoutMs" | "maxOutputBytes">): Promise<Buffer> {
  const bin = options.ffmpegPath || "ffmpeg";
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(/* turbopackIgnore: true */ bin, ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "s16le", "-ar", String(RELAY_TTS_SAMPLE_RATE), "-ac", "1", "pipe:1"], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const done = (error: Error | null, value?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { child.kill("SIGKILL"); reject(error); } else resolve(value as Buffer);
    };
    const timer = setTimeout(() => done(new SpeechAudioError("ffmpeg decode timed out")), options.timeoutMs ?? 30_000);
    child.on("error", (error: NodeJS.ErrnoException) => {
      done(new SpeechAudioError(error.code === "ENOENT"
        ? "ffmpeg is required to decode this TTS format but was not found (set VOICE_TTS_FFMPEG_PATH or use wav/pcm)"
        : "ffmpeg could not be started"));
    });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > (options.maxOutputBytes ?? MAX_FFMPEG_OUTPUT_BYTES)) return done(new SpeechAudioError("ffmpeg output exceeded the size limit"));
      chunks.push(chunk);
    });
    child.stdin.on("error", () => { /* surfaced through the exit code */ });
    child.on("close", (code) => {
      if (code !== 0) return done(new SpeechAudioError(`ffmpeg failed to decode the audio (exit ${code})`));
      const out = Buffer.concat(chunks);
      if (out.length === 0) return done(new SpeechAudioError("ffmpeg produced no audio"));
      done(null, out.subarray(0, out.length - (out.length % 2)));
    });
    child.stdin.end(body);
  });
}
