import assert from "node:assert/strict";
import test from "node:test";
import { SpeechConfigError, resolveSttConfig, resolveTtsConfig } from "../server/speech/config";
import { encodeWavPcm16Mono } from "../server/speech/audio";
import { createOpenAiCompatibleSttProvider, type OpenAiCompatibleSttConfig } from "../server/speech/stt/openai-compatible";
import { createOpenAiCompatibleTtsBackend, type OpenAiCompatibleTtsConfig } from "../server/speech/tts/openai-compatible";
import type { SttEvent } from "../server/speech/stt/types";
import type { TtsEvent } from "../server/speech/tts/types";
import { sleep, startMockServer } from "./helpers/speech-mock-server";

const KEY = "sk-limits-SECRET-999";
const tone = (ms: number, level = 6000) => {
  const buf = Buffer.alloc(ms * 32);
  for (let i = 0; i < buf.length; i += 2) buf.writeInt16LE(i % 4 === 0 ? level : -level, i);
  return buf;
};
const quiet = (ms: number) => Buffer.alloc(ms * 32);

// ── STT ──────────────────────────────────────────────────────────────

function sttConfig(baseUrl: string, overrides: Partial<OpenAiCompatibleSttConfig> = {}): OpenAiCompatibleSttConfig {
  return {
    baseUrl: `${baseUrl}/v1`, apiKey: KEY, model: "whisper", timeoutMs: 3000, silenceMs: 300, minSpeechMs: 200,
    prerollMs: 100, maxUtteranceMs: 30_000, vadThreshold: 0.02, maxQueue: 3, maxRetries: 0, failureThreshold: 3,
    cooldownMs: 60_000, ...overrides,
  };
}
async function openStt(cfg: OpenAiCompatibleSttConfig) {
  const session = await createOpenAiCompatibleSttProvider(cfg).open({ requestId: "r" });
  const events: SttEvent[] = [];
  session.setListener((e) => events.push(e));
  return { session, events };
}
async function until(predicate: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!predicate()) { if (Date.now() > end) throw new Error("timed out waiting"); await sleep(10); }
}
const utter = (s: { sendAudio(b: Buffer): void }) => { s.sendAudio(quiet(100)); s.sendAudio(tone(500)); s.sendAudio(quiet(500)); };
const errors = (events: SttEvent[]) => events.filter((e) => e.type === "error") as Extract<SttEvent, { type: "error" }>[];
const transcripts = (events: SttEvent[]) => events.filter((e) => e.type === "transcript") as Extract<SttEvent, { type: "transcript" }>[];

test("STT stops reading an endless success body at the response limit instead of buffering it", { timeout: 15_000 }, async () => {
  let written = 0;
  const server = await startMockServer(async (_req, res) => {
    res.setHeader("content-type", "application/json");
    res.write('{"text":"');
    const chunk = "a".repeat(16 * 1024);
    while (!res.destroyed && written < 64 * 1024 * 1024) {
      written += chunk.length;
      if (!res.write(chunk)) await new Promise<void>((r) => { res.once("drain", r); res.once("close", r); });
    }
  });
  try {
    const { session, events } = await openStt(sttConfig(server.baseUrl, { maxResponseBytes: 64 * 1024 }));
    utter(session);
    await until(() => errors(events).length > 0);
    const err = errors(events)[0];
    assert.equal(err.fatal, false);
    assert.match(err.message, /VOICE_STT_MAX_RESPONSE_BYTES/);
    assert.ok(!err.message.includes(KEY));
    assert.equal(transcripts(events).length, 0);
    await sleep(100);
    assert.ok(written < 8 * 1024 * 1024, `server was allowed to stream ${written} bytes`);
    assert.equal(server.requests[0].closedEarly, true, "connection must be cancelled");
    session.close();
  } finally { await server.close(); }
});

test("STT rejects an oversized declared content-length without reading the body", async () => {
  const server = await startMockServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ text: "x".repeat(5000) })); });
  try {
    const { session, events } = await openStt(sttConfig(server.baseUrl, { maxResponseBytes: 1024 }));
    utter(session);
    await until(() => errors(events).length > 0);
    assert.match(errors(events)[0].message, /VOICE_STT_MAX_RESPONSE_BYTES/);
    assert.equal(transcripts(events).length, 0);
    session.close();
  } finally { await server.close(); }
});

test("STT error bodies are read with a small cap and the surfaced snippet stays sanitized", { timeout: 15_000 }, async () => {
  let written = 0;
  const server = await startMockServer(async (_req, res) => {
    res.statusCode = 502;
    res.write(`Bearer ${KEY} ${KEY} `);
    const chunk = "z".repeat(16 * 1024);
    while (!res.destroyed && written < 64 * 1024 * 1024) {
      written += chunk.length;
      if (!res.write(chunk)) await new Promise<void>((r) => { res.once("drain", r); res.once("close", r); });
    }
  });
  try {
    const { session, events } = await openStt(sttConfig(server.baseUrl));
    utter(session);
    await until(() => errors(events).length > 0);
    const message = errors(events)[0].message;
    assert.match(message, /HTTP 502/);
    assert.ok(!message.includes(KEY) && message.length < 300);
    await sleep(100);
    assert.ok(written < 8 * 1024 * 1024, `server was allowed to stream ${written} bytes`);
    session.close();
  } finally { await server.close(); }
});

test("STT caps cumulative transcript segments; excess is an actionable non-fatal error and nothing is appended", async () => {
  const server = await startMockServer((_req, res, i) => { res.end(JSON.stringify({ text: `part ${i}` })); });
  try {
    const { session, events } = await openStt(sttConfig(server.baseUrl, { maxTranscriptSegments: 2, failureThreshold: 2 }));
    for (let i = 0; i < 4; i++) { utter(session); await until(() => transcripts(events).length + errors(events).length === i + 1); }
    assert.equal(transcripts(events).length, 2);
    assert.equal(transcripts(events)[1].response.text, "part 0 part 1");
    const errs = errors(events);
    assert.equal(errs.length, 2);
    for (const e of errs) { assert.equal(e.fatal, false, "a local limit must not open the provider circuit"); assert.match(e.message, /VOICE_STT_MAX_TRANSCRIPT_SEGMENTS/); }
    assert.equal(session.isOpen, true);
    session.close();
  } finally { await server.close(); }
});

test("STT caps cumulative transcript characters and never truncates silently", async () => {
  const texts = ["0123456789", "abcdefghij", "this one does not fit at all", "ok"];
  const server = await startMockServer((_req, res, i) => { res.end(JSON.stringify({ text: texts[i] })); });
  try {
    const { session, events } = await openStt(sttConfig(server.baseUrl, { maxTranscriptChars: 25 }));
    for (let i = 0; i < 4; i++) { utter(session); await until(() => transcripts(events).length + errors(events).length === i + 1); }
    const finals = transcripts(events);
    assert.deepEqual(finals.map((f) => f.response.text), ["0123456789", "0123456789 abcdefghij", "0123456789 abcdefghij ok"]);
    assert.equal(errors(events).length, 1);
    assert.match(errors(events)[0].message, /VOICE_STT_MAX_TRANSCRIPT_CHARS/);
    session.close();
  } finally { await server.close(); }
});

test("STT limits resolve from named env settings with sensible defaults and named validation errors", () => {
  const base = { VOICE_ASR_PROVIDER: "openai-compatible", VOICE_STT_BASE_URL: "http://x/v1", VOICE_STT_MODEL: "m" };
  const def = resolveSttConfig(base) as Extract<ReturnType<typeof resolveSttConfig>, { provider: "openai-compatible" }>;
  assert.equal(def.maxResponseBytes, 1024 * 1024);
  assert.equal(def.maxTranscriptSegments, 200);
  assert.equal(def.maxTranscriptChars, 20_000);
  const custom = resolveSttConfig({ ...base, VOICE_STT_MAX_RESPONSE_BYTES: "4096", VOICE_STT_MAX_TRANSCRIPT_SEGMENTS: "5", VOICE_STT_MAX_TRANSCRIPT_CHARS: "500" }) as typeof def;
  assert.deepEqual([custom.maxResponseBytes, custom.maxTranscriptSegments, custom.maxTranscriptChars], [4096, 5, 500]);
  assert.throws(() => resolveSttConfig({ ...base, VOICE_STT_MAX_RESPONSE_BYTES: "10", VOICE_STT_MAX_TRANSCRIPT_CHARS: "abc" }),
    (e) => e instanceof SpeechConfigError && /VOICE_STT_MAX_RESPONSE_BYTES/.test(e.message) && /VOICE_STT_MAX_TRANSCRIPT_CHARS/.test(e.message));
});

// ── TTS ──────────────────────────────────────────────────────────────

function ttsConfig(baseUrl: string, overrides: Partial<OpenAiCompatibleTtsConfig> = {}): OpenAiCompatibleTtsConfig {
  return {
    baseUrl: `${baseUrl}/v1`, apiKey: KEY, model: "m", voice: "v", format: "wav", pcmSampleRate: 24000, timeoutMs: 3000,
    maxAudioBytes: 1_000_000, maxSegments: 20, maxInputChars: 25, ...overrides,
  };
}
// Each segment is 2400 samples = 4800 B of 24 kHz s16le: individually tiny.
const smallWav = () => encodeWavPcm16Mono(Buffer.alloc(4800, 1), 24000);
const FIVE_SENTENCES = "Sentence number one. Sentence number two. Sentence number three. Sentence number four. Sentence number five.";
const collect = async (it: AsyncIterable<TtsEvent>) => { const out: TtsEvent[] = []; for await (const e of it) out.push(e); return out; };

test("TTS bounds total normalized PCM across segments when each segment is individually small (streaming)", async () => {
  const server = await startMockServer((_req, res) => { res.setHeader("content-type", "audio/wav"); res.end(smallWav()); });
  try {
    const backend = createOpenAiCompatibleTtsBackend(ttsConfig(server.baseUrl, { maxTotalAudioBytes: 12_000 }));
    const events = await collect(backend.synthesize({ text: FIVE_SENTENCES }));
    const audio = events.filter((e) => e.type === "audio").reduce((n, e) => n + (e as { audio: Buffer }).audio.length, 0);
    assert.ok(audio <= 12_000, `delivered ${audio} B above the aggregate bound`);
    assert.equal(audio, 9_600, "the two segments that fit are delivered");
    const last = events[events.length - 1];
    assert.equal(last.type, "error");
    assert.match((last as { error: string }).error, /VOICE_TTS_MAX_TOTAL_AUDIO_BYTES/);
    assert.ok(!(last as { error: string }).error.includes(KEY));
    assert.equal(events.some((e) => e.type === "done"), false);
    await sleep(100);
    assert.ok(server.requests.length <= 4, `cancelled before requesting the remaining segments (${server.requests.length} requests)`);
  } finally { await server.close(); }
});

test("TTS synthesizeFile rejects before accumulating beyond the aggregate bound", async () => {
  const server = await startMockServer((_req, res) => { res.setHeader("content-type", "audio/wav"); res.end(smallWav()); });
  try {
    const backend = createOpenAiCompatibleTtsBackend(ttsConfig(server.baseUrl, { maxTotalAudioBytes: 12_000 }));
    await assert.rejects(backend.synthesizeFile({ text: FIVE_SENTENCES }, "wav"), (e: Error) => /VOICE_TTS_MAX_TOTAL_AUDIO_BYTES/.test(e.message) && !e.message.includes(KEY));
    const ok = await backend.synthesizeFile({ text: "Sentence number one. Sentence number two." }, "pcm_f32le");
    assert.ok(ok && ok.audio.length === 9_600 * 2, "within the bound still works");
  } finally { await server.close(); }
});

test("TTS: unbounded error and non-audio bodies are read with a small cap", { timeout: 15_000 }, async () => {
  for (const mode of ["error", "json"] as const) {
    let written = 0;
    const server = await startMockServer(async (_req, res) => {
      if (mode === "error") res.statusCode = 500; else res.setHeader("content-type", "application/json");
      const chunk = "q".repeat(16 * 1024);
      while (!res.destroyed && written < 64 * 1024 * 1024) {
        written += chunk.length;
        if (!res.write(chunk)) await new Promise<void>((r) => { res.once("drain", r); res.once("close", r); });
      }
    });
    try {
      const backend = createOpenAiCompatibleTtsBackend(ttsConfig(server.baseUrl));
      const events = await collect(backend.synthesize({ text: "Hello." }));
      assert.equal(events[events.length - 1].type, "error", mode);
      await sleep(100);
      assert.ok(written < 8 * 1024 * 1024, `${mode}: server was allowed to stream ${written} bytes`);
      assert.equal(server.requests[0].closedEarly, true, mode);
    } finally { await server.close(); }
  }
});

test("TTS aggregate limit resolves from VOICE_TTS_MAX_TOTAL_AUDIO_BYTES, default 32 MiB", () => {
  const base = { VOICE_TTS_PROVIDER: "openai-compatible", VOICE_TTS_BASE_URL: "http://x/v1", VOICE_TTS_MODEL: "m", VOICE_TTS_VOICE: "v" };
  assert.equal((resolveTtsConfig(base) as { maxTotalAudioBytes: number }).maxTotalAudioBytes, 32 * 1024 * 1024);
  assert.equal((resolveTtsConfig({ ...base, VOICE_TTS_MAX_TOTAL_AUDIO_BYTES: "1048576" }) as { maxTotalAudioBytes: number }).maxTotalAudioBytes, 1048576);
  assert.throws(() => resolveTtsConfig({ ...base, VOICE_TTS_MAX_TOTAL_AUDIO_BYTES: "5" }), (e) => e instanceof SpeechConfigError && /VOICE_TTS_MAX_TOTAL_AUDIO_BYTES/.test(e.message));
});
