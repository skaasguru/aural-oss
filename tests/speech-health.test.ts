import assert from "node:assert/strict";
import test from "node:test";

const KEYS = ["VOICE_ASR_PROVIDER", "VOICE_TTS_PROVIDER", "VOICE_STT_BASE_URL", "VOICE_STT_API_KEY", "VOICE_STT_MODEL", "VOICE_TTS_BASE_URL", "VOICE_TTS_API_KEY", "VOICE_TTS_MODEL", "VOICE_TTS_VOICE", "DOUBAO_API_KEY", "DOUBAO_APP_ID", "DOUBAO_ACCESS_TOKEN", "QWEN_ASR_API_KEY"];
async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  try { return await fn(); } finally { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test("GET /api/health reports active speech providers without exposing credentials or URLs", async () => {
  const { GET } = await import("../src/app/api/health/route");
  await withEnv({
    VOICE_ASR_PROVIDER: "openai-compatible", VOICE_STT_BASE_URL: "https://internal-gateway.example/v1", VOICE_STT_API_KEY: "stt-secret-health", VOICE_STT_MODEL: "groq/whisper-large-v3-turbo",
    VOICE_TTS_PROVIDER: "openai-compatible", VOICE_TTS_BASE_URL: "http://kokoro:8880/v1", VOICE_TTS_API_KEY: "tts-secret-health", VOICE_TTS_MODEL: "kokoro", VOICE_TTS_VOICE: "af_heart",
  }, async () => {
    const res = await GET();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const text = await res.text();
    const body = JSON.parse(text);
    assert.equal(body.status, "ok");
    assert.equal(body.speech.stt.provider, "openai-compatible");
    assert.equal(body.speech.stt.partials, false);
    assert.equal(body.speech.stt.model, "groq/whisper-large-v3-turbo");
    assert.equal(body.speech.tts.provider, "openai-compatible");
    assert.equal(body.speech.tts.voice, "af_heart");
    for (const secret of ["stt-secret-health", "tts-secret-health", "internal-gateway", "kokoro:8880"]) assert.ok(!text.includes(secret), `leaked ${secret}`);
  });
});

test("GET /api/health stays up when speech is unconfigured and names the missing variables only", async () => {
  const { GET } = await import("../src/app/api/health/route");
  await withEnv({ VOICE_TTS_PROVIDER: "openai-compatible", VOICE_TTS_API_KEY: "hidden-value" }, async () => {
    const res = await GET();
    assert.equal(res.status, 200);
    const text = await res.text();
    const body = JSON.parse(text);
    assert.equal(body.status, "ok");
    assert.equal(body.speech.tts.configured, false);
    assert.match(body.speech.tts.problems.join(" "), /VOICE_TTS_BASE_URL/);
    assert.ok(!text.includes("hidden-value"));
  });
});

test("the auth proxy skips the health probe so it never depends on Supabase", async () => {
  const { config } = await import("../src/proxy");
  const matcher = new RegExp(`^${config.matcher[0]}$`);
  assert.equal(matcher.test("/api/health"), false);
  assert.equal(matcher.test("/dashboard"), true);
  assert.equal(matcher.test("/api/voice/tts-s2s"), true);
});
