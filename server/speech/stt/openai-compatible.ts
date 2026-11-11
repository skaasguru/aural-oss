/**
 * Utterance-buffered STT over an OpenAI-compatible `POST {base}/audio/transcriptions`.
 *
 * Works with Groq Whisper directly, OpenAI, or a Bifrost gateway (model may carry a provider
 * prefix). This is NOT native streaming: audio is segmented locally (see segmenter.ts), each
 * utterance is uploaded once as a WAV file, and the provider answers with one final per utterance.
 * No partial transcripts exist, which `capabilities.partials === false` states.
 *
 * Bounds: audio memory is limited by `maxUtteranceMs` x (`maxQueue` + 1); requests are sequential
 * (so results are ordered and never duplicated); retries are capped by `maxRetries`.
 */
import { resolveQwenAsrLanguage } from "../../qwen-asr-controls";
import type { AsrResponse } from "../../volcengine-asr";
import { encodeWavPcm16Mono } from "../audio";
import { ERROR_BODY_SNIPPET_BYTES, ResponseTooLargeError, readBodyLimited } from "../http";
import { joinApiUrl, redactSecret } from "../url";
import { UtteranceSegmenter } from "./segmenter";
import type { SttCapabilities, SttEvent, SttOpenParams, SttProvider, SttSession } from "./types";

export interface OpenAiCompatibleSttConfig {
  /** Base URL including any `/v1`, e.g. `https://api.groq.com/openai/v1`. */
  baseUrl: string;
  apiKey?: string;
  /** Model id; with Bifrost this may include the provider prefix (`groq/whisper-large-v3-turbo`). */
  model: string;
  prompt?: string;
  /** ISO-639-1 override; otherwise derived from the interview language. */
  language?: string;
  timeoutMs: number;
  silenceMs: number;
  minSpeechMs: number;
  prerollMs: number;
  maxUtteranceMs: number;
  vadThreshold: number;
  /** Utterances waiting behind the in-flight request. */
  maxQueue: number;
  maxRetries: number;
  /** Consecutive failed utterances that end the session and open the circuit. */
  failureThreshold: number;
  /** How long `open()` refuses after the circuit opens. */
  cooldownMs: number;
  /** Max bytes read from one provider response (default 1 MiB). VOICE_STT_MAX_RESPONSE_BYTES. */
  maxResponseBytes?: number;
  /** Max transcript segments accepted per session (default 200). VOICE_STT_MAX_TRANSCRIPT_SEGMENTS. */
  maxTranscriptSegments?: number;
  /** Max cumulative transcript characters per session (default 20000). VOICE_STT_MAX_TRANSCRIPT_CHARS. */
  maxTranscriptChars?: number;
}

export const DEFAULT_STT_MAX_RESPONSE_BYTES = 1024 * 1024;
export const DEFAULT_STT_MAX_TRANSCRIPT_SEGMENTS = 200;
export const DEFAULT_STT_MAX_TRANSCRIPT_CHARS = 20_000;

export const OPENAI_COMPATIBLE_STT_CAPABILITIES: SttCapabilities = {
  id: "openai-compatible", mode: "utterance-buffered", partials: false, speechEvents: true, replaceTranscript: true,
};

class SttHttpError extends Error {
  constructor(message: string, readonly code: number, readonly retryable: boolean) { super(message); }
}

function sanitize(text: string, apiKey: string | undefined): string {
  return redactSecret(text, apiKey)
    .replace(/Bearer\s+\S+/gi, "[redacted]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200);
}

function joinSegments(segments: string[]): string {
  let out = "";
  for (const segment of segments) {
    if (!out) { out = segment; continue; }
    const cjkBoundary = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}。！？，、]$/u.test(out) && /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(segment);
    out += cjkBoundary ? segment : ` ${segment}`;
  }
  return out;
}

/** Local transcript limit: reported to the user, not a provider failure (does not open the circuit). */
class TranscriptLimitError extends Error {}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createOpenAiCompatibleSttProvider(config: OpenAiCompatibleSttConfig): SttProvider {
  const url = joinApiUrl(config.baseUrl, "audio/transcriptions");
  const maxResponseBytes = config.maxResponseBytes ?? DEFAULT_STT_MAX_RESPONSE_BYTES;
  const maxSegments = config.maxTranscriptSegments ?? DEFAULT_STT_MAX_TRANSCRIPT_SEGMENTS;
  const maxChars = config.maxTranscriptChars ?? DEFAULT_STT_MAX_TRANSCRIPT_CHARS;
  // Circuit breaker shared by all sessions of this provider.
  let consecutiveFailures = 0;
  let openUntil = 0;

  async function transcribeOnce(wav: Buffer, language: string | undefined, signal: AbortSignal): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
    form.append("model", config.model);
    if (language) form.append("language", language);
    if (config.prompt) form.append("prompt", config.prompt);
    form.append("response_format", "json");
    form.append("temperature", "0");
    const timeout = AbortSignal.timeout(config.timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST", body: form, redirect: "error", signal: AbortSignal.any([signal, timeout]),
        headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
      });
      if (!res.ok) {
        const body = (await readBodyLimited(res, ERROR_BODY_SNIPPET_BYTES, { truncate: true })).toString("utf8");
        let message = body;
        try { const json = JSON.parse(body); message = json?.error?.message ?? json?.message ?? body; } catch { /* plain text */ }
        throw new SttHttpError(`STT provider returned HTTP ${res.status}${message ? `: ${sanitize(String(message), config.apiKey)}` : ""}`, res.status, res.status === 429 || res.status >= 500);
      }
      let body: string;
      try { body = (await readBodyLimited(res, maxResponseBytes)).toString("utf8"); } catch (error) {
        if (error instanceof ResponseTooLargeError) {
          throw new SttHttpError(`STT provider response exceeded ${maxResponseBytes} bytes; check the STT endpoint/model or raise VOICE_STT_MAX_RESPONSE_BYTES`, -6, false);
        }
        throw error;
      }
      let parsed: unknown;
      try { parsed = JSON.parse(body); } catch { throw new SttHttpError("STT provider returned an invalid (non-JSON) response", -3, false); }
      const text = (parsed as { text?: unknown })?.text;
      if (typeof text !== "string") throw new SttHttpError("STT provider returned an invalid response (missing text)", -3, false);
      return text.trim();
    } catch (error) {
      if (signal.aborted) throw error;
      if (timeout.aborted) throw new SttHttpError(`STT request timed out after ${config.timeoutMs}ms`, -2, false);
      if (error instanceof SttHttpError) throw error;
      const code = (error as { cause?: { code?: unknown } })?.cause?.code;
      throw new SttHttpError(`STT request failed (${typeof code === "string" ? code : "network error"})`, -1, true);
    }
  }

  class BufferedSttSession implements SttSession {
    readonly capabilities = OPENAI_COMPATIBLE_STT_CAPABILITIES;
    private listener: ((event: SttEvent) => void) | null = null;
    private readonly segmenter = new UtteranceSegmenter({
      threshold: config.vadThreshold, silenceMs: config.silenceMs, minSpeechMs: config.minSpeechMs,
      prerollMs: config.prerollMs, maxUtteranceMs: config.maxUtteranceMs,
    });
    private readonly queue: Buffer[] = [];
    private readonly segments: string[] = [];
    private chars = 0;
    private inFlight: AbortController | null = null;
    private closed = false;
    private detached = false;
    private finishing = false;
    private readonly language: string | undefined;

    constructor(params: SttOpenParams) {
      this.language = config.language || resolveQwenAsrLanguage(params.language);
    }

    get isOpen(): boolean { return !this.closed; }

    setListener(listener: (event: SttEvent) => void): void { this.listener = listener; }
    removeAllListeners(): void { this.listener = null; this.detached = true; }

    hasPendingWork(): boolean {
      return !this.closed && (this.segmenter.isSpeaking || this.queue.length > 0 || this.inFlight !== null);
    }

    sendAudio(pcm: Buffer): void {
      if (this.closed || this.finishing) return;
      this.handle(this.segmenter.push(pcm));
    }

    finish(): void {
      if (this.closed || this.finishing) return;
      this.handle(this.segmenter.flush());
      this.finishing = true;
      this.settle();
    }

    close(): void {
      if (this.closed) return;
      this.closed = true;
      this.listener = null;
      this.queue.length = 0;
      this.inFlight?.abort();
      this.inFlight = null;
    }

    private emit(event: SttEvent): void {
      if (this.closed) return;
      this.listener?.(event);
    }

    private handle(outputs: ReturnType<UtteranceSegmenter["push"]>): void {
      for (const output of outputs) {
        if (output.type === "utterance") this.enqueue(output.pcm);
        else this.emit({ type: output.type });
      }
    }

    private enqueue(pcm: Buffer): void {
      if (this.queue.length >= config.maxQueue) {
        this.queue.shift();
        this.emit({ type: "error", code: -4, message: "STT backlog full; dropped the oldest queued utterance", fatal: false });
      }
      this.queue.push(pcm);
      void this.pump();
    }

    private async pump(): Promise<void> {
      if (this.inFlight || this.closed) return;
      const pcm = this.queue.shift();
      if (!pcm) { this.settle(); return; }
      const controller = new AbortController();
      this.inFlight = controller;
      try {
        const text = await this.transcribeWithRetry(pcm, controller.signal);
        if (this.closed || controller.signal.aborted) return;
        consecutiveFailures = 0;
        if (!text) {
          this.emit({ type: "no_speech" });
        } else {
          this.checkTranscriptLimits(text);
          this.segments.push(text);
          this.chars += text.length + 1;
          const response: AsrResponse = {
            messageType: 9,
            text: joinSegments(this.segments),
            utterances: this.segments.map((segment) => ({ text: segment, definite: true })),
          };
          this.emit({ type: "transcript", response });
        }
      } catch (error) {
        if (this.closed || controller.signal.aborted) return;
        if (error instanceof TranscriptLimitError) {
          this.emit({ type: "error", code: -5, message: error.message, fatal: false });
        } else {
          consecutiveFailures++;
          const failure = error instanceof SttHttpError ? error : new SttHttpError("STT request failed", -1, false);
          const fatal = consecutiveFailures >= config.failureThreshold;
          if (fatal) openUntil = Date.now() + config.cooldownMs;
          const listener = this.listener;
          this.emit({ type: "error", code: failure.code, message: failure.message, fatal });
          // The owner may close() us from its error handler; it still needs to learn we ended.
          if (fatal) { this.closeAfterEmit(listener, 1011, "STT provider unavailable"); return; }
        }
      } finally {
        if (this.inFlight === controller) this.inFlight = null;
      }
      void this.pump();
    }

    private checkTranscriptLimits(text: string): void {
      if (this.segments.length + 1 > maxSegments) {
        throw new TranscriptLimitError(`STT transcript segment limit (${maxSegments}) reached for this answer; the latest speech was not captured. Raise VOICE_STT_MAX_TRANSCRIPT_SEGMENTS or ask the speaker to continue in a new turn`);
      }
      if (this.chars + text.length + 1 > maxChars + 1) {
        throw new TranscriptLimitError(`STT transcript length limit (${maxChars} characters) reached for this answer; the latest speech was not captured. Raise VOICE_STT_MAX_TRANSCRIPT_CHARS or ask the speaker to continue in a new turn`);
      }
    }

    private async transcribeWithRetry(pcm: Buffer, signal: AbortSignal): Promise<string> {
      const wav = encodeWavPcm16Mono(pcm, 16_000);
      for (let attempt = 0; ; attempt++) {
        try {
          return await transcribeOnce(wav, this.language, signal);
        } catch (error) {
          if (signal.aborted || !(error instanceof SttHttpError) || !error.retryable || attempt >= config.maxRetries) throw error;
          await sleep(Math.min(1000, 150 * (attempt + 1)));
          if (signal.aborted) throw error;
        }
      }
    }

    private closeAfterEmit(listener: ((event: SttEvent) => void) | null, code: number, reason: string): void {
      this.close();
      if (!this.detached) listener?.({ type: "closed", code, reason });
    }

    /** After `finish()`, close once every outstanding result has been delivered. */
    private settle(): void {
      if (!this.finishing || this.closed || this.inFlight || this.queue.length > 0) return;
      this.closeAfterEmit(this.listener, 1000, "finished");
    }
  }

  return {
    capabilities: OPENAI_COMPATIBLE_STT_CAPABILITIES,
    async open(params: SttOpenParams): Promise<SttSession> {
      if (Date.now() < openUntil) {
        throw new Error("STT provider unavailable after repeated failures; retrying shortly");
      }
      return new BufferedSttSession(params);
    },
    describe: () => ({
      provider: "openai-compatible", mode: "utterance-buffered", model: config.model, partials: false,
      silenceMs: config.silenceMs, maxUtteranceMs: config.maxUtteranceMs, timeoutMs: config.timeoutMs, authenticated: !!config.apiKey,
    }),
  };
}
