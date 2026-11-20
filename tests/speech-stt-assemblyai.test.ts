import assert from "node:assert/strict";
import test from "node:test";
import { parseWav } from "../server/speech/audio";
import { resolveSttConfig, SpeechConfigError } from "../server/speech/config";
import { createSttProvider } from "../server/speech/stt/registry";
import type { SttEvent, SttSession } from "../server/speech/stt/types";
import { parseMultipart, sleep, startMockServer } from "./helpers/speech-mock-server";

const KEY = "sk-bf-SECRET-virtual-key";
const tone = (ms: number, level = 6000) => {
  const buf = Buffer.alloc(ms * 32);
  for (let i = 0; i < buf.length; i += 2) buf.writeInt16LE(i % 4 === 0 ? level : -level, i);
  return buf;
};
const quiet = (ms: number) => Buffer.alloc(ms * 32);

function env(baseUrl: string, extra: Record<string, string> = {}) {
  return {
    VOICE_ASR_PROVIDER: "assemblyai", VOICE_STT_BASE_URL: baseUrl, VOICE_STT_API_KEY: KEY, VOICE_STT_MODEL: "universal-3-6-pro",
    VOICE_STT_SILENCE_MS: "400", VOICE_STT_PREROLL_MS: "100", VOICE_STT_VAD_THRESHOLD: "0.02", VOICE_STT_MAX_RETRIES: "0",
    VOICE_STT_TIMEOUT_MS: "2000", ...extra,
  };
}
async function open(vars: Record<string, string>, language?: string) {
  const provider = createSttProvider(resolveSttConfig(vars), { connectLegacy: async () => { throw new Error("buffered providers never open a legacy socket"); } });
  const session = await provider.open({ requestId: "req-1", language });
  const events: SttEvent[] = [];
  session.setListener((e) => events.push(e));
  return { provider, session, events };
}
async function until(predicate: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!predicate()) { if (Date.now() > end) throw new Error("timed out waiting"); await sleep(10); }
}
function speakUtterance(session: SttSession, ms = 600) {
  session.sendAudio(quiet(100));
  session.sendAudio(tone(ms));
  session.sendAudio(quiet(600));
}

test("assemblyai is selected explicitly, needs no Doubao/Qwen credential, and is utterance-buffered", () => {
  const cfg = resolveSttConfig(env("http://bifrost:8080/relay/assemblyai-stt"));
  assert.equal(cfg.provider, "assemblyai");
  const provider = createSttProvider(cfg, { connectLegacy: async () => { throw new Error("unused"); } });
  assert.equal(provider.capabilities.id, "assemblyai");
  assert.equal(provider.capabilities.mode, "utterance-buffered");
  assert.equal(provider.capabilities.partials, false);
  const described = provider.describe();
  assert.equal(described.provider, "assemblyai");
  assert.equal(described.model, "universal-3-6-pro");
  assert.ok(!JSON.stringify(described).includes(KEY) && !JSON.stringify(described).includes("bifrost"));
  assert.throws(() => resolveSttConfig({ VOICE_ASR_PROVIDER: "assemblyai", VOICE_STT_API_KEY: KEY }),
    (e: Error) => e instanceof SpeechConfigError && /VOICE_STT_BASE_URL/.test(e.message) && /VOICE_STT_MODEL/.test(e.message) && !e.message.includes(KEY));
});

test("an utterance is one Sync STT request through a gateway relay path: audio part, JSON config, model header", async () => {
  const server = await startMockServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ text: "  Hello there. ", words: [], confidence: 0.97, audio_duration_ms: 700 }));
  });
  try {
    const { session, events } = await open(env(`${server.baseUrl}/relay/assemblyai-stt`, { VOICE_STT_PROMPT: "Job interview." }), "English");
    speakUtterance(session);
    await until(() => events.some((e) => e.type === "transcript"));
    assert.equal(server.requests.length, 1);
    const req = server.requests[0];
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/relay/assemblyai-stt/v1/transcribe");
    assert.equal(req.headers.authorization, `Bearer ${KEY}`);
    assert.equal(req.headers["x-aai-model"], "universal-3-6-pro");
    const { fields, files } = parseMultipart(String(req.headers["content-type"]), req.body);
    assert.ok(files.audio, "audio part present");
    assert.equal(files.audio.contentType, "audio/wav");
    const wav = parseWav(files.audio.data);
    assert.equal(wav.sampleRate, 16_000);
    assert.equal(wav.channels, 1);
    assert.ok(!("file" in files) && !("model" in fields), "no OpenAI-shaped fields are sent");
    const config = files.config ? JSON.parse(files.config.data.toString("utf8")) : JSON.parse(fields.config);
    assert.deepEqual(config, { language_codes: "en", prompt: "Job interview." });
    const final = events.find((e) => e.type === "transcript") as Extract<SttEvent, { type: "transcript" }>;
    assert.equal(final.response.text, "Hello there.");
    session.close();
  } finally { await server.close(); }
});

test("upstream problem+json errors are reported from `detail`, sanitized, and never leak the key", async () => {
  const server = await startMockServer((_req, res) => {
    res.statusCode = 401;
    res.setHeader("content-type", "application/problem+json");
    res.end(JSON.stringify({ status: 401, title: "Unauthorized", detail: `Invalid API key ${KEY}` }));
  });
  try {
    const { session, events } = await open(env(server.baseUrl));
    speakUtterance(session);
    await until(() => events.some((e) => e.type === "error"));
    const error = events.find((e) => e.type === "error") as Extract<SttEvent, { type: "error" }>;
    assert.equal(error.code, 401);
    assert.match(error.message, /HTTP 401: Invalid API key/);
    assert.ok(!error.message.includes(KEY));
    assert.equal(server.requests.length, 1, "auth failures are not retried");
    session.close();
  } finally { await server.close(); }
});

test("an empty transcript is no_speech, and transcripts accumulate across utterances", async () => {
  const replies = ["", "First answer.", "Second part."];
  const server = await startMockServer((_req, res, index) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ text: replies[index] })); });
  try {
    const { session, events } = await open(env(server.baseUrl));
    speakUtterance(session);
    await until(() => events.some((e) => e.type === "no_speech"));
    speakUtterance(session);
    await until(() => events.filter((e) => e.type === "transcript").length === 1);
    speakUtterance(session);
    await until(() => events.filter((e) => e.type === "transcript").length === 2);
    const finals = events.filter((e) => e.type === "transcript") as Extract<SttEvent, { type: "transcript" }>[];
    assert.equal(finals[1].response.text, "First answer. Second part.");
    session.close();
  } finally { await server.close(); }
});
