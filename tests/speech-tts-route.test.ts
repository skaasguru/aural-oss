import assert from "node:assert/strict";
import test from "node:test";
import { encodeWavPcm16Mono, parseWav } from "../server/speech/audio";
import { startMockServer } from "./helpers/speech-mock-server";

const ENV_KEYS = ["VOICE_TTS_PROVIDER", "VOICE_TTS_BASE_URL", "VOICE_TTS_API_KEY", "VOICE_TTS_MODEL", "VOICE_TTS_VOICE", "VOICE_TTS_FORMAT", "DOUBAO_APP_ID", "DOUBAO_ACCESS_TOKEN", "DOUBAO_API_KEY"];

async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  try { return await fn(); } finally {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

function post(body: unknown, query = ""): Request {
  return new Request(`http://localhost/api/voice/tts-s2s${query}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

test("tts-s2s route serves openai-compatible audio as a valid 24 kHz WAV, without Doubao credentials", async () => {
  const server = await startMockServer((_req, res) => { res.end(encodeWavPcm16Mono(Buffer.alloc(960, 1), 24000)); });
  try {
    const { POST } = await import("../src/app/api/voice/tts-s2s/route");
    await withEnv({ VOICE_TTS_PROVIDER: "openai-compatible", VOICE_TTS_BASE_URL: `${server.baseUrl}/v1`, VOICE_TTS_API_KEY: "k-route-secret", VOICE_TTS_MODEL: "kokoro", VOICE_TTS_VOICE: "af_heart" }, async () => {
      // The practice coach asks for mp3 first; the route must label what it really returns.
      const res = await POST(post({ text: "Great answer!", language: "en-US" }, "?format=mp3"));
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "audio/wav");
      assert.equal(res.headers.get("x-aural-tts-format"), "wav");
      assert.equal(res.headers.get("x-aural-tts-provider"), "openai-compatible");
      const wav = parseWav(Buffer.from(await res.arrayBuffer()));
      assert.equal(wav.sampleRate, 24000);
      assert.equal(wav.data.length, 960);
      assert.equal(server.requests[0].headers.authorization, "Bearer k-route-secret");
      assert.equal(JSON.parse(server.requests[0].body.toString()).input, "Great answer!");

      const f32 = await POST(post({ text: "Hi" }, "?format=pcm_f32le"));
      assert.equal(f32.headers.get("x-aural-tts-format"), "pcm_f32le");
      assert.equal((await f32.arrayBuffer()).byteLength, 960 * 2); // 480 samples -> float32
    });
  } finally { await server.close(); }
});

test("tts-s2s route does not truncate long text for openai-compatible providers", async () => {
  const server = await startMockServer((_req, res) => { res.end(encodeWavPcm16Mono(Buffer.alloc(48), 24000)); });
  try {
    const { POST } = await import("../src/app/api/voice/tts-s2s/route");
    const text = "Please walk me through how you would design a rate limiter for a public API. ".repeat(8).trim();
    await withEnv({ VOICE_TTS_PROVIDER: "openai-compatible", VOICE_TTS_BASE_URL: `${server.baseUrl}/v1`, VOICE_TTS_MODEL: "m", VOICE_TTS_VOICE: "v" }, async () => {
      const res = await POST(post({ text }));
      assert.equal(res.status, 200);
      assert.equal(JSON.parse(server.requests[0].body.toString()).input, text);
    });
  } finally { await server.close(); }
});

test("tts-s2s route reports invalid config clearly without leaking values, and provider errors as 502", async () => {
  const { POST } = await import("../src/app/api/voice/tts-s2s/route");
  await withEnv({ VOICE_TTS_PROVIDER: "openai-compatible", VOICE_TTS_API_KEY: "never-print-me" }, async () => {
    const res = await POST(post({ text: "Hi" }));
    assert.equal(res.status, 503);
    const text = await res.text();
    assert.match(text, /VOICE_TTS_BASE_URL/);
    assert.ok(!text.includes("never-print-me"));
  });
  const server = await startMockServer((_req, res) => { res.statusCode = 500; res.end("boom"); });
  try {
    await withEnv({ VOICE_TTS_PROVIDER: "openai-compatible", VOICE_TTS_BASE_URL: `${server.baseUrl}/v1`, VOICE_TTS_MODEL: "m", VOICE_TTS_VOICE: "v", VOICE_TTS_API_KEY: "never-print-me" }, async () => {
      const res = await POST(post({ text: "Hi" }));
      assert.equal(res.status, 502);
      assert.ok(!(await res.text()).includes("never-print-me"));
    });
  } finally { await server.close(); }
});

test("tts-s2s route keeps the legacy 503 when Doubao is selected without credentials", async () => {
  const { POST } = await import("../src/app/api/voice/tts-s2s/route");
  await withEnv({}, async () => {
    const res = await POST(post({ text: "Hi" }));
    assert.equal(res.status, 503);
    assert.match(await res.text(), /Doubao TTS credentials not configured/);
  });
});
