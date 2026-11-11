/**
 * Provider-agnostic TTS contract.
 *
 * Every backend emits mono 24 kHz s16le PCM in `audio` events, which is what the browser relay
 * protocol (src/hooks/use-voice.ts) plays. Containers (WAV/MP3) and foreign sample rates are
 * normalized inside the backend and never reach the browser.
 */
export type TtsEvent =
  | { type: "audio"; audio: Buffer }
  | { type: "sentence_start"; text?: string }
  | { type: "sentence_end"; text: string }
  | { type: "done" }
  | { type: "error"; error: string };

export interface TtsRequest {
  text: string;
  /** BCP-47-ish language tag such as `en-US` or `zh-CN`; used for voice selection. */
  language?: string;
  /** Aborting must stop in-flight work and suppress any further events. */
  signal?: AbortSignal;
}

export interface TtsCapabilities {
  /** Whether audio is produced incrementally within one request (false = buffered per request). */
  incremental: boolean;
  /** Provider input limit in characters; longer text is split, never truncated. 0 = unlimited. */
  maxInputChars: number;
  /** Fixed output contract. */
  output: "pcm_s16le_mono_24k";
}

export type TtsFileFormat = "wav" | "mp3" | "pcm_f32le";

/** A complete audio file for HTTP callers such as /api/voice/tts-s2s. */
export interface TtsFileResult {
  audio: Buffer;
  contentType: string;
  format: string;
}

export interface TtsBackend {
  readonly id: "doubao" | "openai-compatible";
  readonly capabilities: TtsCapabilities;
  /** Streaming interface used by the interview relay. */
  synthesize(request: TtsRequest): AsyncGenerator<TtsEvent>;
  /**
   * One-shot interface used by HTTP routes. Returns null when cancelled or when the provider
   * produced no audio. Throws on provider/configuration errors (messages never contain secrets).
   */
  synthesizeFile(request: TtsRequest, preferred: TtsFileFormat): Promise<TtsFileResult | null>;
  /** Non-secret description for startup logs and health endpoints. */
  describe(): Record<string, string | number | boolean>;
}
