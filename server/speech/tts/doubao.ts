/**
 * Legacy Volcengine Doubao Seed TTS 2.0 adapter. Behavior is unchanged from before the provider
 * abstraction: the relay streams `synthesizeSpeech` PCM directly, and the HTTP route keeps its
 * mp3-first/pcm fallback strategy and container sniffing.
 */
import { synthesizeCoachAudio } from "@/app/api/voice/tts-s2s/synthesize";
import { prepareCoachTtsText } from "@/lib/prep/coach-tts-text";
import {
  detectTtsSourceEncoding, resolveTtsAuthConfig, synthesizeSpeech,
  type TtsAuthConfig, type TtsSynthesisOptions,
} from "../../volcengine-tts";
import type { DoubaoTtsConfig } from "../config";
import { encodeWavPcm16Mono, RELAY_TTS_SAMPLE_RATE } from "../audio";
import { pcmToTtsFile } from "./file-output";
import type { TtsBackend, TtsEvent, TtsFileFormat, TtsFileResult, TtsRequest } from "./types";

const DEFAULT_VOICE_ZH = "zh_female_shuangkuaisisi_uranus_bigtts";
const DEFAULT_VOICE_EN = "en_female_dacey_uranus_bigtts";

export function createDoubaoTtsBackend(config: DoubaoTtsConfig): TtsBackend {
  const auth = (): TtsAuthConfig => resolveTtsAuthConfig({
    appId: config.appId, accessToken: config.accessToken, apiKey: config.apiKey, resourceId: config.resourceId,
  });
  const rate = config.speechRate != null ? { speechRate: config.speechRate } : {};

  /** Interview relay: any configured voice is used as-is. */
  function relayOptions(language: string | undefined): TtsSynthesisOptions {
    const zh = language?.toLowerCase().startsWith("zh");
    return { speaker: (zh ? config.voiceZh : config.voiceEn) || (zh ? DEFAULT_VOICE_ZH : DEFAULT_VOICE_EN), format: "pcm", sampleRate: 24000, ...rate };
  }

  /** HTTP route: an English voice must actually be an English voice id. */
  function routeOptions(language: string | undefined, format: TtsSynthesisOptions["format"]): TtsSynthesisOptions {
    const zh = language?.toLowerCase().startsWith("zh");
    const configured = (zh ? config.voiceZh : config.voiceEn).trim();
    const speaker = configured && (zh || configured.startsWith("en_")) ? configured : zh ? DEFAULT_VOICE_ZH : DEFAULT_VOICE_EN;
    return { speaker, format, sampleRate: 24000, ...rate };
  }

  async function* synthesize(request: TtsRequest): AsyncGenerator<TtsEvent> {
    for await (const event of synthesizeSpeech(request.text, auth(), relayOptions(request.language), request.signal)) {
      switch (event.type) {
        case "audio": if (event.audio) yield { type: "audio", audio: event.audio }; break;
        case "sentence_start": yield { type: "sentence_start", text: event.text }; break;
        case "sentence_end": yield { type: "sentence_end", text: event.text ?? "" }; break;
        case "error": yield { type: "error", error: event.error ?? "TTS error" }; break;
        case "done": yield { type: "done" }; break;
      }
    }
  }

  async function synthesizeFile(request: TtsRequest, preferred: TtsFileFormat): Promise<TtsFileResult | null> {
    const text = prepareCoachTtsText(request.text);
    if (!text) return null;
    const result = await synthesizeCoachAudio(text, auth(), (format) => routeOptions(request.language, format), request.signal);
    if (!result) return null;
    const { audio, wireFormat } = result;
    const source = wireFormat === "mp3" ? "mp3" : detectTtsSourceEncoding(audio);
    if (source === "mp3") return { audio, contentType: "audio/mpeg", format: "mp3" };
    if (source === "wav") return { audio, contentType: "audio/wav", format: "wav" };
    if (preferred === "wav") return { audio: encodeWavPcm16Mono(audio, RELAY_TTS_SAMPLE_RATE), contentType: "audio/wav", format: "wav" };
    if (preferred === "mp3") return { audio, contentType: "audio/mpeg", format: "mp3" }; // legacy behavior, preserved as-is
    return pcmToTtsFile(audio, "pcm_f32le");
  }

  return {
    id: "doubao",
    capabilities: { incremental: true, maxInputChars: 0, output: "pcm_s16le_mono_24k" },
    synthesize,
    synthesizeFile,
    describe: () => ({ provider: "doubao", resource: config.resourceId, authenticated: !!((config.appId && config.accessToken) || config.apiKey) }),
  };
}
