import assert from "node:assert/strict";
import test from "node:test";
import { SpeechConfigError, resolveTtsConfig } from "../server/speech/config";
import { createTtsBackend } from "../server/speech/tts/registry";
import { encodeWavPcm16Mono, parseWav } from "../server/speech/audio";
import { startMockServer } from "./helpers/speech-mock-server";

const doubaoEnv = { DOUBAO_APP_ID: "app", DOUBAO_ACCESS_TOKEN: "tok", DOUBAO_API_KEY: "key" };

test("TTS defaults to the legacy Doubao provider and keeps its settings", () => {
  const cfg = resolveTtsConfig({ ...doubaoEnv, DOUBAO_VOICE_EN: "en_x", DOUBAO_TTS_RESOURCE_ID: "seed-tts-2.0" });
  assert.equal(cfg.provider, "doubao");
  if (cfg.provider !== "doubao") return;
  assert.equal(cfg.appId, "app");
  assert.equal(cfg.voiceEn, "en_x");
  assert.equal(createTtsBackend(cfg).id, "doubao");
});

test("legacy Doubao still requires its credentials, but only when selected", () => {
  assert.throws(() => resolveTtsConfig({}, { requireDoubaoAppPair: true }), (e: Error) => e instanceof SpeechConfigError && /DOUBAO_APP_ID/.test(e.message));
  assert.throws(() => resolveTtsConfig({}), /DOUBAO/);
  assert.doesNotThrow(() => resolveTtsConfig({ DOUBAO_API_KEY: "k" }));
  // Alternatives selected: no Doubao credential is needed.
  const cfg = resolveTtsConfig({ VOICE_TTS_PROVIDER: "openai-compatible", VOICE_TTS_BASE_URL: "http://kokoro:8880/v1", VOICE_TTS_MODEL: "kokoro", VOICE_TTS_VOICE: "af_heart" }, { requireDoubaoAppPair: true });
  assert.equal(cfg.provider, "openai-compatible");
});

test("openai-compatible TTS config applies documented defaults and independent settings", () => {
  const cfg = resolveTtsConfig({
    VOICE_TTS_PROVIDER: "openai-compatible", VOICE_TTS_BASE_URL: "https://api.groq.com/openai/v1", VOICE_TTS_API_KEY: "gsk_x",
    VOICE_TTS_MODEL: "canopylabs/orpheus-v1-english", VOICE_TTS_VOICE: "hannah", VOICE_TTS_VOICE_ZH: "zh1",
    VOICE_TTS_MAX_INPUT_CHARS: "200", VOICE_TTS_FORMAT: "wav", VOICE_TTS_SPEED: "1.1",
  });
  assert.equal(cfg.provider, "openai-compatible");
  if (cfg.provider !== "openai-compatible") return;
  assert.equal(cfg.maxInputChars, 200);
  assert.equal(cfg.format, "wav");
  assert.equal(cfg.voiceZh, "zh1");
  assert.equal(cfg.speed, 1.1);
  assert.equal(cfg.timeoutMs, 30_000);
  assert.equal(cfg.pcmSampleRate, 24_000);
  const noKey = resolveTtsConfig({ VOICE_TTS_PROVIDER: "openai-compatible", VOICE_TTS_BASE_URL: "http://kokoro:8880/v1", VOICE_TTS_MODEL: "kokoro", VOICE_TTS_VOICE: "af" });
  assert.equal((noKey as { apiKey?: string }).apiKey, undefined);
});

test("invalid TTS configuration fails with every problem named and no secret values", () => {
  let error: Error | undefined;
  try {
    resolveTtsConfig({ VOICE_TTS_PROVIDER: "openai-compatible", VOICE_TTS_BASE_URL: "http://u:hunter2@host/v1", VOICE_TTS_FORMAT: "flv", VOICE_TTS_TIMEOUT_MS: "-5", VOICE_TTS_API_KEY: "sk-secret-value" });
  } catch (e) { error = e as Error; }
  assert.ok(error instanceof SpeechConfigError);
  for (const name of ["VOICE_TTS_BASE_URL", "VOICE_TTS_MODEL", "VOICE_TTS_VOICE", "VOICE_TTS_FORMAT", "VOICE_TTS_TIMEOUT_MS"]) assert.match(error.message, new RegExp(name));
  assert.ok(!error.message.includes("hunter2") && !error.message.includes("sk-secret-value"));
});

test("unknown TTS providers are rejected rather than aliased or silently replaced", () => {
  for (const provider of ["openai", "kokoro", "groq", "seed"]) {
    assert.throws(() => resolveTtsConfig({ ...doubaoEnv, VOICE_TTS_PROVIDER: provider }), /VOICE_TTS_PROVIDER/);
  }
});

test("openai-compatible TTS is the only backend used when selected (no hidden fallback)", async () => {
  const server = await startMockServer((_req, res) => { res.end(encodeWavPcm16Mono(Buffer.alloc(480), 24000)); });
  try {
    const backend = createTtsBackend(resolveTtsConfig({
      VOICE_TTS_PROVIDER: "openai-compatible", VOICE_TTS_BASE_URL: `${server.baseUrl}/v1`, VOICE_TTS_MODEL: "m", VOICE_TTS_VOICE: "v", ...doubaoEnv,
    }));
    const file = await backend.synthesizeFile({ text: "Hello" }, "wav");
    assert.equal(file?.contentType, "audio/wav");
    assert.equal(parseWav(file!.audio).sampleRate, 24000);
    assert.equal(server.requests.length, 1);
    assert.equal(backend.describe().provider, "openai-compatible");
    assert.ok(!JSON.stringify(backend.describe()).includes("key"), "describe() must not expose credentials");
  } finally { await server.close(); }
});

// ── STT ─────────────────────────────────────────────────────────────

import { resolveSttConfig, resolveSttProviderId } from "../server/speech/config";
import { createSttProvider } from "../server/speech/stt/registry";

test("STT defaults to Seed and legacy selections need only their own credential", () => {
  assert.equal(resolveSttProviderId({}), "seed");
  assert.equal(resolveSttProviderId({ VOICE_ASR_PROVIDER: " QWEN-AUDIO " }), "qwen-audio");
  assert.equal(resolveSttConfig({ DOUBAO_API_KEY: "k" }).provider, "seed");
  assert.throws(() => resolveSttConfig({}), /DOUBAO_API_KEY/);
  assert.throws(() => resolveSttConfig({ VOICE_ASR_PROVIDER: "qwen" }), /QWEN_ASR_API_KEY/);
  assert.doesNotThrow(() => resolveSttConfig({ VOICE_ASR_PROVIDER: "qwen", QWEN_ASR_API_KEY: "k" }));
});

test("an unknown ASR provider is rejected and mentions the new option", () => {
  for (const provider of ["whisper", "groq", "openai"]) {
    assert.throws(() => resolveSttConfig({ VOICE_ASR_PROVIDER: provider }), (e: Error) => e instanceof SpeechConfigError && /VOICE_ASR_PROVIDER/.test(e.message) && /openai-compatible/.test(e.message));
  }
});

test("openai-compatible STT needs no Doubao/Qwen credential and applies bounded defaults", () => {
  const cfg = resolveSttConfig({ VOICE_ASR_PROVIDER: "openai-compatible", VOICE_STT_BASE_URL: "https://api.groq.com/openai/v1", VOICE_STT_API_KEY: "gsk", VOICE_STT_MODEL: "whisper-large-v3-turbo" });
  assert.equal(cfg.provider, "openai-compatible");
  if (cfg.provider !== "openai-compatible") return;
  assert.equal(cfg.silenceMs, 800);
  assert.equal(cfg.maxUtteranceMs, 30_000);
  assert.equal(cfg.timeoutMs, 20_000);
  assert.equal(cfg.maxQueue, 4);
  assert.equal(cfg.maxRetries, 1);
  assert.ok(cfg.vadThreshold > 0 && cfg.vadThreshold < 1);
  const provider = createSttProvider(cfg, { connectLegacy: async () => { throw new Error("must not be used"); } });
  assert.equal(provider.capabilities.mode, "utterance-buffered");
  assert.ok(!JSON.stringify(provider.describe()).includes("gsk"));
});

test("invalid STT configuration names every bad variable and hides secret values", () => {
  let error: Error | undefined;
  try {
    resolveSttConfig({ VOICE_ASR_PROVIDER: "openai-compatible", VOICE_STT_API_KEY: "gsk-hidden", VOICE_STT_SILENCE_MS: "10", VOICE_STT_VAD_THRESHOLD: "7", VOICE_STT_MAX_UTTERANCE_MS: "abc" });
  } catch (e) { error = e as Error; }
  assert.ok(error instanceof SpeechConfigError);
  for (const name of ["VOICE_STT_BASE_URL", "VOICE_STT_MODEL", "VOICE_STT_SILENCE_MS", "VOICE_STT_VAD_THRESHOLD", "VOICE_STT_MAX_UTTERANCE_MS"]) assert.match(error.message, new RegExp(name));
  assert.ok(!error.message.includes("gsk-hidden"));
});

test("STT and TTS providers are selected independently", () => {
  const env = { VOICE_ASR_PROVIDER: "openai-compatible", VOICE_STT_BASE_URL: "http://x/v1", VOICE_STT_MODEL: "w", DOUBAO_APP_ID: "a", DOUBAO_ACCESS_TOKEN: "t" };
  assert.equal(resolveSttConfig(env).provider, "openai-compatible");
  assert.equal(resolveTtsConfig(env).provider, "doubao");
});
