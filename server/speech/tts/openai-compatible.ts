/**
 * OpenAI-compatible `POST {base}/audio/speech` TTS backend.
 *
 * Works with local Kokoro-FastAPI, OpenAI, Groq (Orpheus: wav only, 200 char input limit) or a
 * Bifrost gateway fronting any of them. Each request returns a complete audio body, which is
 * decoded to mono 24 kHz s16le PCM. There is no hidden fallback to any other provider.
 */
import { SpeechAudioError, decodeSpeechAudio, type SpeechAudioFormat } from "../audio";
import { ERROR_BODY_SNIPPET_BYTES, ResponseTooLargeError, readBodyLimited } from "../http";
import { joinApiUrl, redactSecret } from "../url";
import { pcmToTtsFile } from "./file-output";
import { splitTextForTts } from "./split";
import type { TtsBackend, TtsEvent, TtsFileFormat, TtsFileResult, TtsRequest } from "./types";

export interface OpenAiCompatibleTtsConfig {
  /** Base URL including any `/v1`, e.g. `http://kokoro:8880/v1`. */
  baseUrl: string;
  apiKey?: string;
  model: string;
  voice: string;
  voiceEn?: string;
  voiceZh?: string;
  format: SpeechAudioFormat;
  /** Sample rate of raw `pcm` responses (OpenAI: 24000). */
  pcmSampleRate: number;
  timeoutMs: number;
  maxAudioBytes: number;
  /** Cap on total normalized PCM across all segments of one synthesis (default 32 MiB). */
  maxTotalAudioBytes?: number;
  /** Upper bound on requests per utterance. */
  maxSegments: number;
  /** Provider input limit; 0/undefined = unlimited. */
  maxInputChars?: number;
  speed?: number;
  ffmpegPath?: string;
}

export const DEFAULT_TTS_MAX_TOTAL_AUDIO_BYTES = 32 * 1024 * 1024;
const OUTPUT_CHUNK_BYTES = 48_000; // 1 s of 24 kHz s16le

function sanitizeSnippet(text: string, apiKey: string | undefined): string {
  return redactSecret(text, apiKey)
    .replace(/Bearer\s+\S+/gi, "[redacted]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, 200);
}

async function readAudioLimited(res: Response, maxBytes: number): Promise<Buffer> {
  try {
    return await readBodyLimited(res, maxBytes);
  } catch (error) {
    if (error instanceof ResponseTooLargeError) throw new SpeechAudioError("TTS response exceeds the configured size limit (VOICE_TTS_MAX_AUDIO_BYTES)");
    throw error;
  }
}

const snippetOf = async (res: Response) => (await readBodyLimited(res, ERROR_BODY_SNIPPET_BYTES, { truncate: true }).catch(() => Buffer.alloc(0))).toString("utf8");

export function createOpenAiCompatibleTtsBackend(config: OpenAiCompatibleTtsConfig): TtsBackend {
  const url = joinApiUrl(config.baseUrl, "audio/speech");
  const maxTotal = config.maxTotalAudioBytes ?? DEFAULT_TTS_MAX_TOTAL_AUDIO_BYTES;
  const maxInputChars = config.maxInputChars && config.maxInputChars > 0 ? config.maxInputChars : 0;

  function voiceFor(language: string | undefined): string {
    const zh = language?.toLowerCase().startsWith("zh");
    return (zh ? config.voiceZh : config.voiceEn) || config.voice;
  }

  async function requestSegment(input: string, voice: string, signal: AbortSignal, outputBudget: number): Promise<Buffer> {
    const body: Record<string, unknown> = { model: config.model, voice, input, response_format: config.format };
    if (config.speed != null) body.speed = config.speed;
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "audio/*" };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    const timeout = AbortSignal.timeout(config.timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    try {
      const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: combined, redirect: "error" });
      if (!res.ok) {
        const text = await snippetOf(res);
        let message = text;
        try { message = JSON.parse(text)?.error?.message ?? JSON.parse(text)?.message ?? text; } catch { /* plain text */ }
        throw new SpeechAudioError(`TTS provider returned HTTP ${res.status}${message ? `: ${sanitizeSnippet(String(message), config.apiKey)}` : ""}`);
      }
      if (/json|text\//i.test(res.headers.get("content-type") || "")) {
        const text = (await snippetOf(res)).slice(0, 400);
        throw new SpeechAudioError(`TTS provider returned a non-audio response: ${sanitizeSnippet(text, config.apiKey)}`);
      }
      const raw = await readAudioLimited(res, config.maxAudioBytes);
      return await decodeSpeechAudio(raw, { format: config.format, pcmSampleRate: config.pcmSampleRate, ffmpegPath: config.ffmpegPath, maxOutputBytes: Math.max(2, outputBudget) });
    } catch (error) {
      if (signal.aborted) throw error;
      if (timeout.aborted) throw new SpeechAudioError(`TTS request timed out after ${config.timeoutMs}ms`);
      if (error instanceof SpeechAudioError) throw error;
      // Network failures: never include the underlying message verbatim (it can embed the URL).
      const code = (error as { cause?: { code?: unknown } })?.cause?.code;
      throw new SpeechAudioError(`TTS request failed (${typeof code === "string" ? code : "network error"})`);
    }
  }

  async function* synthesize(request: TtsRequest): AsyncGenerator<TtsEvent> {
    const { signal } = request;
    if (signal?.aborted) return;
    const segments = splitTextForTts(request.text, maxInputChars);
    if (segments.length === 0) { yield { type: "error", error: "TTS text is empty" }; return; }
    if (segments.length > config.maxSegments) {
      yield { type: "error", error: `TTS text needs ${segments.length} segments, above the limit of ${config.maxSegments}` };
      return;
    }
    const voice = voiceFor(request.language);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let total = 0; // normalized PCM already accepted for delivery
    const start = (index: number): Promise<Buffer> => {
      const promise = requestSegment(segments[index], voice, controller.signal, maxTotal - total);
      promise.catch(() => {}); // a prefetch we never await must not become an unhandled rejection
      return promise;
    };
    try {
      let next = start(0);
      for (let i = 0; i < segments.length; i++) {
        let pcm: Buffer;
        try { pcm = await next; } catch (error) {
          if (signal?.aborted) return;
          yield { type: "error", error: error instanceof Error ? error.message : "TTS request failed" };
          return;
        }
        if (signal?.aborted) return;
        if (total + pcm.length > maxTotal) {
          // Nothing from this segment is emitted, and `finally` cancels any prefetch in flight.
          yield { type: "error", error: `TTS audio exceeds the total limit of ${maxTotal} bytes across ${segments.length} segments; shorten the text or raise VOICE_TTS_MAX_TOTAL_AUDIO_BYTES` };
          return;
        }
        total += pcm.length;
        if (i + 1 < segments.length) next = start(i + 1); // prefetch overlaps playback of this segment
        yield { type: "sentence_start", text: segments[i] };
        for (let offset = 0; offset < pcm.length; offset += OUTPUT_CHUNK_BYTES) {
          yield { type: "audio", audio: pcm.subarray(offset, Math.min(pcm.length, offset + OUTPUT_CHUNK_BYTES)) };
          if (signal?.aborted) return;
        }
        yield { type: "sentence_end", text: segments[i] };
      }
      yield { type: "done" };
    } finally {
      signal?.removeEventListener("abort", onAbort);
      controller.abort();
    }
  }

  async function synthesizeFile(request: TtsRequest, preferred: TtsFileFormat): Promise<TtsFileResult | null> {
    const chunks: Buffer[] = [];
    for await (const event of synthesize(request)) {
      if (request.signal?.aborted) return null;
      if (event.type === "audio") chunks.push(event.audio);
      else if (event.type === "error") throw new Error(event.error);
    }
    if (request.signal?.aborted) return null;
    const pcm = Buffer.concat(chunks);
    if (pcm.length === 0) return null;
    return pcmToTtsFile(pcm, preferred);
  }

  return {
    id: "openai-compatible",
    capabilities: { incremental: false, maxInputChars, output: "pcm_s16le_mono_24k" },
    synthesize,
    synthesizeFile,
    describe: () => ({
      provider: "openai-compatible", model: config.model, voice: config.voice, format: config.format,
      maxInputChars, timeoutMs: config.timeoutMs, authenticated: !!config.apiKey,
    }),
  };
}
