/**
 * Local energy-based utterance segmenter for providers that only transcribe whole audio files.
 *
 * It is clocked by the audio it receives (not by wall time), so behavior is deterministic and
 * independent of how the browser chunks microphone frames. Input is mono 16 kHz s16le PCM.
 * Memory is bounded by `maxUtteranceMs` plus the pre-roll window.
 */
export const SEGMENTER_SAMPLE_RATE = 16_000;
const FRAME_MS = 20;
const FRAME_BYTES = (SEGMENTER_SAMPLE_RATE * FRAME_MS * 2) / 1000; // 640
const START_FRAMES = 2; // consecutive voiced frames needed to open an utterance
const TRAILING_SILENCE_KEEP_FRAMES = 10; // keep 200 ms of tail so words do not end abruptly

export interface SegmenterOptions {
  /** RMS level (0..1 of full scale) at or above which a 20 ms frame counts as speech. */
  threshold: number;
  /** Trailing silence that ends an utterance. Pauses shorter than this stay inside it. */
  silenceMs: number;
  /** Utterances with less voiced audio than this are reported as no_speech. */
  minSpeechMs: number;
  /** Audio kept from before speech was detected, so first phonemes are not clipped. */
  prerollMs: number;
  /** Hard cap per utterance (bounds memory and request size). */
  maxUtteranceMs: number;
}

export type SegmenterOutput =
  | { type: "speech_started" }
  | { type: "speech_stopped" }
  | { type: "no_speech" }
  | { type: "utterance"; pcm: Buffer; reason: "silence" | "max_duration" | "flush"; voicedMs: number };

function rms(frame: Buffer): number {
  const samples = frame.length / 2;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const v = frame.readInt16LE(i * 2) / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / samples);
}

export class UtteranceSegmenter {
  private carry: Buffer = Buffer.alloc(0);
  private preroll: Buffer[] = [];
  private utterance: Buffer[] = [];
  private speaking = false;
  private consecutiveVoiced = 0;
  private voicedFrames = 0;
  private silentFrames = 0;
  private emittedWhileSpeaking = false;
  private readonly prerollFrames: number;

  constructor(private readonly options: SegmenterOptions) {
    if (!(options.threshold > 0 && options.threshold < 1)) throw new Error("segmenter threshold must be between 0 and 1");
    if (!(options.silenceMs >= FRAME_MS)) throw new Error("segmenter silenceMs must be at least 20");
    if (!(options.minSpeechMs >= 0)) throw new Error("segmenter minSpeechMs must not be negative");
    if (!(options.maxUtteranceMs >= 1000)) throw new Error("segmenter maxUtteranceMs must be at least 1000");
    this.prerollFrames = Math.max(0, Math.round(options.prerollMs / FRAME_MS));
  }

  get isSpeaking(): boolean { return this.speaking; }

  push(chunk: Buffer): SegmenterOutput[] {
    const out: SegmenterOutput[] = [];
    let data = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    let offset = 0;
    for (; offset + FRAME_BYTES <= data.length; offset += FRAME_BYTES) {
      this.frame(Buffer.from(data.subarray(offset, offset + FRAME_BYTES)), out);
    }
    this.carry = Buffer.from(data.subarray(offset));
    data = Buffer.alloc(0);
    return out;
  }

  /** End of input: emit whatever utterance is in progress. */
  flush(): SegmenterOutput[] {
    const out: SegmenterOutput[] = [];
    this.carry = Buffer.alloc(0);
    if (this.speaking) this.end("flush", out);
    this.reset();
    return out;
  }

  reset(): void {
    this.carry = Buffer.alloc(0);
    this.preroll = [];
    this.utterance = [];
    this.speaking = false;
    this.consecutiveVoiced = 0;
    this.voicedFrames = 0;
    this.silentFrames = 0;
    this.emittedWhileSpeaking = false;
  }

  private frame(frame: Buffer, out: SegmenterOutput[]): void {
    const voiced = rms(frame) >= this.options.threshold;
    if (!this.speaking) {
      this.preroll.push(frame);
      while (this.preroll.length > Math.max(this.prerollFrames, START_FRAMES)) this.preroll.shift();
      this.consecutiveVoiced = voiced ? this.consecutiveVoiced + 1 : 0;
      if (this.consecutiveVoiced >= START_FRAMES) {
        this.speaking = true;
        this.utterance = this.preroll.splice(0);
        this.voicedFrames = this.consecutiveVoiced;
        this.silentFrames = 0;
        this.emittedWhileSpeaking = false;
        out.push({ type: "speech_started" });
      }
      return;
    }

    this.utterance.push(frame);
    if (voiced) { this.voicedFrames++; this.silentFrames = 0; } else { this.silentFrames++; }
    if (this.silentFrames * FRAME_MS >= this.options.silenceMs) {
      this.end("silence", out);
    } else if (this.utterance.length * FRAME_MS >= this.options.maxUtteranceMs) {
      this.emit("max_duration", out);
      this.utterance = [];
      this.voicedFrames = 0;
      this.silentFrames = 0;
      this.emittedWhileSpeaking = true;
    }
  }

  private emit(reason: "silence" | "max_duration" | "flush", out: SegmenterOutput[]): void {
    const trim = reason === "max_duration" ? 0 : Math.max(0, this.silentFrames - TRAILING_SILENCE_KEEP_FRAMES);
    const frames = this.utterance.slice(0, this.utterance.length - trim);
    out.push({ type: "utterance", pcm: Buffer.concat(frames), reason, voicedMs: this.voicedFrames * FRAME_MS });
  }

  private end(reason: "silence" | "flush", out: SegmenterOutput[]): void {
    out.push({ type: "speech_stopped" });
    if (this.voicedFrames * FRAME_MS >= this.options.minSpeechMs && this.voicedFrames > 0) {
      this.emit(reason, out);
    } else if (!this.emittedWhileSpeaking) {
      out.push({ type: "no_speech" });
    }
    this.speaking = false;
    this.utterance = [];
    this.preroll = [];
    this.consecutiveVoiced = 0;
    this.voicedFrames = 0;
    this.silentFrames = 0;
    this.emittedWhileSpeaking = false;
  }
}
