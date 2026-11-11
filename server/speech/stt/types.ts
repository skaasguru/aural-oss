/**
 * Provider-agnostic STT contract.
 *
 * Aural owns the browser protocol, turn detection and interview state; a provider only turns
 * mono 16 kHz s16le PCM into text. Providers differ in how: native-streaming ones push partial
 * and final results over a long-lived connection, while utterance-buffered ones (OpenAI-compatible
 * file transcription) segment locally and return one final per utterance. Capabilities state which.
 */
import type { AsrResponse, BigModelAsrConfig } from "../../volcengine-asr";

export interface SttCapabilities {
  id: string;
  mode: "native-streaming" | "utterance-buffered";
  /** Provider emits non-final (draft) transcripts while the user is still speaking. */
  partials: boolean;
  /** Session emits speech_started / speech_stopped events. */
  speechEvents: boolean;
  /** Each transcript replaces earlier drafts for the whole session (relay "replace" mode). */
  replaceTranscript: boolean;
}

/**
 * Normalized events.
 *  - transcript: cumulative session transcript. An utterance with `definite: false` is a partial,
 *    `definite: true` is final. Buffered providers only ever emit finals.
 *  - speech_started / speech_stopped: local or provider voice-activity edges.
 *  - no_speech: an utterance ended but contained no transcribable speech.
 *  - error: `fatal` errors mean the session cannot continue and will close.
 *  - closed: terminal; nothing is emitted afterwards.
 */
export type SttEvent =
  | { type: "transcript"; response: AsrResponse }
  | { type: "speech_started" }
  | { type: "speech_stopped" }
  | { type: "no_speech" }
  | { type: "error"; code: number; message: string; fatal: boolean }
  | { type: "closed"; code: number; reason: string };

export interface SttSession {
  readonly capabilities: SttCapabilities;
  readonly isOpen: boolean;
  /** Replace the event listener. Events are delivered synchronously from provider callbacks. */
  setListener(listener: (event: SttEvent) => void): void;
  removeAllListeners(): void;
  /** Mono 16 kHz s16le PCM. Never throws; drops audio once closed or finishing. */
  sendAudio(pcm: Buffer): void;
  /** End of input: flush buffered speech, deliver outstanding results, then emit `closed`. */
  finish(): void;
  /** Cancel in-flight work and release resources. No events are emitted afterwards. */
  close(): void;
  /** True while speech is being buffered or a transcription is outstanding. */
  hasPendingWork(): boolean;
}

export interface SttOpenParams {
  requestId: string;
  /** Interview language such as `English`, `en-US`, `zh-CN`; mapped to a provider hint. */
  language?: string;
  /** Detailed endpointing/context settings used only by the native-streaming providers. */
  legacyConfig?: BigModelAsrConfig;
}

export interface SttProvider {
  readonly capabilities: SttCapabilities;
  /** Open a session. Rejects when the provider is known to be unavailable. */
  open(params: SttOpenParams): Promise<SttSession>;
  describe(): Record<string, string | number | boolean>;
}
