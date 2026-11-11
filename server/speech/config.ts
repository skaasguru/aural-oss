/**
 * Explicit, independently swappable speech configuration.
 *
 * Everything here is server-side only: none of these variables may carry a NEXT_PUBLIC_ prefix.
 * Resolution is pure (takes an env object) so it can be validated at startup and in tests, and it
 * throws one SpeechConfigError listing every problem by variable name (never by value).
 */
import { SPEECH_AUDIO_FORMATS, type SpeechAudioFormat } from "./audio";
import { parseHttpBaseUrl } from "./url";
import { resolveTtsSpeechRate } from "../volcengine-tts";
import { resolveAsrProvider, type AsrProvider } from "../streaming-asr";
import { resolveQwenNoiseThreshold } from "../qwen-asr-controls";

export type Env = Record<string, string | undefined>;

export class SpeechConfigError extends Error {
  constructor(readonly kind: "STT" | "TTS", readonly provider: string, readonly problems: string[]) {
    super(`Invalid ${kind} configuration: ${problems.join("; ")}`);
    this.name = "SpeechConfigError";
  }
}

class Problems {
  readonly list: string[] = [];
  add(name: string, reason: string) { this.list.push(`${name} ${reason}`); }

  int(env: Env, name: string, fallback: number, min: number, max: number): number {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      this.add(name, `must be an integer between ${min} and ${max}`);
      return fallback;
    }
    return value;
  }

  number(env: Env, name: string, min: number, max: number): number | undefined {
    const raw = env[name]?.trim();
    if (!raw) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max) {
      this.add(name, `must be a number between ${min} and ${max}`);
      return undefined;
    }
    return value;
  }

  required(env: Env, name: string): string {
    const value = env[name]?.trim() || "";
    if (!value) this.add(name, "is required");
    return value;
  }

  baseUrl(env: Env, name: string): string {
    const raw = env[name]?.trim();
    if (!raw) { this.add(name, "is required"); return ""; }
    try { return parseHttpBaseUrl(raw, name).toString().replace(/\/+$/, ""); } catch (error) {
      this.list.push((error as Error).message);
      return "";
    }
  }

  done(kind: "STT" | "TTS", provider: string) {
    if (this.list.length) throw new SpeechConfigError(kind, provider, this.list);
  }
}

// ── TTS ──────────────────────────────────────────────────────────────

export type TtsProviderId = "doubao" | "openai-compatible";

export interface DoubaoTtsConfig {
  provider: "doubao";
  appId: string;
  accessToken: string;
  apiKey: string;
  resourceId: string;
  voiceZh: string;
  voiceEn: string;
  speechRate: number | undefined;
}

export interface OpenAiCompatibleTtsSettings {
  provider: "openai-compatible";
  baseUrl: string;
  apiKey?: string;
  model: string;
  voice: string;
  voiceEn?: string;
  voiceZh?: string;
  format: SpeechAudioFormat;
  pcmSampleRate: number;
  timeoutMs: number;
  maxAudioBytes: number;
  /** Cap on total normalized PCM across all segments of one synthesis. */
  maxTotalAudioBytes: number;
  maxSegments: number;
  maxInputChars: number;
  speed?: number;
  ffmpegPath?: string;
}

export type TtsConfig = DoubaoTtsConfig | OpenAiCompatibleTtsSettings;

export function resolveTtsProviderId(env: Env): TtsProviderId {
  const value = env.VOICE_TTS_PROVIDER?.trim().toLowerCase() || "doubao";
  if (value !== "doubao" && value !== "openai-compatible") {
    throw new SpeechConfigError("TTS", value, ["VOICE_TTS_PROVIDER must be doubao or openai-compatible"]);
  }
  return value;
}

export function resolveTtsConfig(env: Env, options: { requireDoubaoAppPair?: boolean } = {}): TtsConfig {
  const provider = resolveTtsProviderId(env);
  const problems = new Problems();
  if (provider === "doubao") {
    const appId = env.DOUBAO_APP_ID?.trim() || "";
    const accessToken = env.DOUBAO_ACCESS_TOKEN?.trim() || "";
    const apiKey = env.DOUBAO_API_KEY?.trim() || "";
    if (options.requireDoubaoAppPair ? !(appId && accessToken) : !((appId && accessToken) || apiKey)) {
      problems.add(options.requireDoubaoAppPair ? "DOUBAO_APP_ID and DOUBAO_ACCESS_TOKEN" : "DOUBAO_APP_ID + DOUBAO_ACCESS_TOKEN (or DOUBAO_API_KEY)", "are required for VOICE_TTS_PROVIDER=doubao");
    }
    problems.done("TTS", provider);
    return {
      provider, appId, accessToken, apiKey,
      resourceId: env.DOUBAO_TTS_RESOURCE_ID?.trim() || "seed-tts-2.0",
      voiceZh: env.DOUBAO_VOICE_ZH?.trim() || "",
      voiceEn: env.DOUBAO_VOICE_EN?.trim() || "",
      speechRate: resolveTtsSpeechRate(env.DOUBAO_TTS_SPEECH_RATE),
    };
  }

  const baseUrl = problems.baseUrl(env, "VOICE_TTS_BASE_URL");
  const model = problems.required(env, "VOICE_TTS_MODEL");
  const voice = problems.required(env, "VOICE_TTS_VOICE");
  const format = (env.VOICE_TTS_FORMAT?.trim().toLowerCase() || "wav") as SpeechAudioFormat;
  if (!SPEECH_AUDIO_FORMATS.includes(format)) problems.add("VOICE_TTS_FORMAT", `must be one of ${SPEECH_AUDIO_FORMATS.join(", ")}`);
  const config: OpenAiCompatibleTtsSettings = {
    provider, baseUrl, model, voice, format,
    apiKey: env.VOICE_TTS_API_KEY?.trim() || undefined,
    voiceEn: env.VOICE_TTS_VOICE_EN?.trim() || undefined,
    voiceZh: env.VOICE_TTS_VOICE_ZH?.trim() || undefined,
    pcmSampleRate: problems.int(env, "VOICE_TTS_PCM_SAMPLE_RATE", 24_000, 8_000, 96_000),
    timeoutMs: problems.int(env, "VOICE_TTS_TIMEOUT_MS", 30_000, 100, 300_000),
    maxAudioBytes: problems.int(env, "VOICE_TTS_MAX_AUDIO_BYTES", 32 * 1024 * 1024, 1_024, 512 * 1024 * 1024),
    maxTotalAudioBytes: problems.int(env, "VOICE_TTS_MAX_TOTAL_AUDIO_BYTES", 32 * 1024 * 1024, 1_024, 512 * 1024 * 1024),
    maxSegments: problems.int(env, "VOICE_TTS_MAX_SEGMENTS", 40, 1, 500),
    maxInputChars: problems.int(env, "VOICE_TTS_MAX_INPUT_CHARS", 0, 0, 100_000),
    speed: problems.number(env, "VOICE_TTS_SPEED", 0.25, 4),
    ffmpegPath: env.VOICE_TTS_FFMPEG_PATH?.trim() || undefined,
  };
  problems.done("TTS", provider);
  return config;
}

// ── STT ──────────────────────────────────────────────────────────────

export type SttProviderId = AsrProvider | "openai-compatible";

export interface LegacySttConfig {
  provider: AsrProvider;
  apiKey: string;
  appId: string;
  accessToken: string;
  resourceId: string;
  noiseThreshold: number | undefined;
}

export interface OpenAiCompatibleSttSettings {
  provider: "openai-compatible";
  baseUrl: string;
  apiKey?: string;
  model: string;
  prompt?: string;
  language?: string;
  timeoutMs: number;
  silenceMs: number;
  minSpeechMs: number;
  prerollMs: number;
  maxUtteranceMs: number;
  vadThreshold: number;
  maxQueue: number;
  maxRetries: number;
  failureThreshold: number;
  cooldownMs: number;
  maxResponseBytes: number;
  maxTranscriptSegments: number;
  maxTranscriptChars: number;
}

export type SttConfig = LegacySttConfig | OpenAiCompatibleSttSettings;

export function resolveSttProviderId(env: Env): SttProviderId {
  const value = env.VOICE_ASR_PROVIDER?.trim().toLowerCase();
  if (value === "openai-compatible") return value;
  try {
    return resolveAsrProvider(value);
  } catch {
    throw new SpeechConfigError("STT", value || "", ["VOICE_ASR_PROVIDER must be seed, qwen, qwen-audio or openai-compatible"]);
  }
}

export function resolveSttConfig(env: Env): SttConfig {
  const provider = resolveSttProviderId(env);
  const problems = new Problems();
  if (provider !== "openai-compatible") {
    const apiKey = (provider === "seed" ? env.DOUBAO_API_KEY : env.QWEN_ASR_API_KEY)?.trim() || "";
    if (!apiKey) problems.add(provider === "seed" ? "DOUBAO_API_KEY" : "QWEN_ASR_API_KEY", `is required for VOICE_ASR_PROVIDER=${provider}`);
    let noiseThreshold: number | undefined;
    if (provider !== "seed") {
      try { noiseThreshold = resolveQwenNoiseThreshold(env.QWEN_ASR_NOISE_THRESHOLD, provider === "qwen" ? 0.3 : 0.1); } catch (error) { problems.list.push((error as Error).message); }
    }
    problems.done("STT", provider);
    return {
      provider, apiKey, noiseThreshold,
      appId: env.DOUBAO_APP_ID?.trim() || env.DOUBAO_APP_KEY?.trim() || "",
      accessToken: env.DOUBAO_ACCESS_TOKEN?.trim() || "",
      resourceId: env.DOUBAO_ASR_RESOURCE_ID?.trim() || "volc.seedasr.sauc.duration",
    };
  }

  const config: OpenAiCompatibleSttSettings = {
    provider,
    baseUrl: problems.baseUrl(env, "VOICE_STT_BASE_URL"),
    model: problems.required(env, "VOICE_STT_MODEL"),
    apiKey: env.VOICE_STT_API_KEY?.trim() || undefined,
    prompt: env.VOICE_STT_PROMPT?.trim() || undefined,
    language: env.VOICE_STT_LANGUAGE?.trim().toLowerCase() || undefined,
    timeoutMs: problems.int(env, "VOICE_STT_TIMEOUT_MS", 20_000, 500, 120_000),
    silenceMs: problems.int(env, "VOICE_STT_SILENCE_MS", 800, 200, 6_000),
    minSpeechMs: problems.int(env, "VOICE_STT_MIN_SPEECH_MS", 200, 0, 5_000),
    prerollMs: problems.int(env, "VOICE_STT_PREROLL_MS", 300, 0, 2_000),
    maxUtteranceMs: problems.int(env, "VOICE_STT_MAX_UTTERANCE_MS", 30_000, 1_000, 120_000),
    vadThreshold: problems.number(env, "VOICE_STT_VAD_THRESHOLD", 0.001, 0.5) ?? 0.015,
    maxQueue: problems.int(env, "VOICE_STT_MAX_QUEUE", 4, 1, 32),
    maxRetries: problems.int(env, "VOICE_STT_MAX_RETRIES", 1, 0, 3),
    failureThreshold: problems.int(env, "VOICE_STT_FAILURE_THRESHOLD", 3, 1, 20),
    cooldownMs: problems.int(env, "VOICE_STT_COOLDOWN_MS", 15_000, 0, 600_000),
    maxResponseBytes: problems.int(env, "VOICE_STT_MAX_RESPONSE_BYTES", 1024 * 1024, 1_024, 16 * 1024 * 1024),
    maxTranscriptSegments: problems.int(env, "VOICE_STT_MAX_TRANSCRIPT_SEGMENTS", 200, 1, 10_000),
    maxTranscriptChars: problems.int(env, "VOICE_STT_MAX_TRANSCRIPT_CHARS", 20_000, 100, 1_000_000),
  };
  if (config.language && !/^[a-z]{2,3}(-[a-z0-9]+)?$/.test(config.language)) problems.add("VOICE_STT_LANGUAGE", "must be an ISO-639-1 code such as en or zh");
  problems.done("STT", provider);
  return config;
}
