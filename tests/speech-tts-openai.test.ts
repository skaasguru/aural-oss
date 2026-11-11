import assert from "node:assert/strict";
import test from "node:test";
import { encodeWavPcm16Mono } from "../server/speech/audio";
import { splitTextForTts } from "../server/speech/tts/split";
import { createOpenAiCompatibleTtsBackend, type OpenAiCompatibleTtsConfig } from "../server/speech/tts/openai-compatible";
import type { TtsEvent } from "../server/speech/tts/types";
import { sleep, startMockServer } from "./helpers/speech-mock-server";

const KEY = "sk-test-SECRET-123";

function tone(samples: number, value = 1000): Buffer {
  const out = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) out.writeInt16LE(value, i * 2);
  return out;
}
const normalize = (s: string) => s.replace(/\s+/g, " ").trim();

function config(baseUrl: string, overrides: Partial<OpenAiCompatibleTtsConfig> = {}): OpenAiCompatibleTtsConfig {
  return {
    baseUrl: `${baseUrl}/v1`, apiKey: KEY, model: "kokoro", voice: "af_heart", format: "wav",
    pcmSampleRate: 24000, timeoutMs: 2000, maxAudioBytes: 1_000_000, maxSegments: 20, ...overrides,
  };
}

async function collect(iter: AsyncIterable<TtsEvent>): Promise<TtsEvent[]> {
  const events: TtsEvent[] = [];
  for await (const e of iter) events.push(e);
  return events;
}
const audioOf = (events: TtsEvent[]) => Buffer.concat(events.filter((e) => e.type === "audio").map((e) => (e as { audio: Buffer }).audio));

test("splitTextForTts never truncates and respects the provider limit", () => {
  const sentence = "This is a reasonably long interview question about distributed systems design. ";
  const text = sentence.repeat(6).trim();
  const parts = splitTextForTts(text, 200);
  assert.ok(parts.length >= 3);
  for (const p of parts) assert.ok(p.length <= 200, `part too long: ${p.length}`);
  assert.equal(normalize(parts.join(" ")), normalize(text));
  assert.deepEqual(splitTextForTts("short", 200), ["short"]);
  assert.deepEqual(splitTextForTts("anything at all", 0), ["anything at all"]);
});

test("splitTextForTts handles CJK without spaces and over-long words", () => {
  const zh = "请介绍一下你在分布式系统方面的经验，以及你如何处理一致性问题。".repeat(12);
  const zhParts = splitTextForTts(zh, 50);
  for (const p of zhParts) assert.ok(p.length <= 50);
  assert.equal(zhParts.join(""), zh);
  const word = "x".repeat(450);
  const wordParts = splitTextForTts(`a ${word} b`, 200);
  for (const p of wordParts) assert.ok(p.length <= 200);
  assert.equal(wordParts.join("").replace(/\s/g, ""), `a${word}b`);
});

test("OpenAI-compatible TTS posts once to /v1/audio/speech with auth and returns mono 24 kHz s16le", async () => {
  const server = await startMockServer((_req, res) => {
    res.setHeader("content-type", "audio/wav");
    res.end(encodeWavPcm16Mono(tone(1600), 16000)); // 100 ms @16k -> 2400 samples @24k
  });
  try {
    const backend = createOpenAiCompatibleTtsBackend(config(server.baseUrl));
    const events = await collect(backend.synthesize({ text: "Hello there.", language: "en-US" }));
    assert.equal(server.requests.length, 1);
    const req = server.requests[0];
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/v1/audio/speech");
    assert.equal(req.headers.authorization, `Bearer ${KEY}`);
    const body = JSON.parse(req.body.toString());
    assert.deepEqual(body, { model: "kokoro", voice: "af_heart", input: "Hello there.", response_format: "wav" });
    assert.equal(audioOf(events).length, 2400 * 2);
    assert.equal(events.at(-1)?.type, "done");
    assert.equal(events.filter((e) => e.type === "done").length, 1);
    assert.equal(events.some((e) => e.type === "error"), false);
  } finally { await server.close(); }
});

test("OpenAI-compatible TTS omits Authorization without a key and picks the voice by language", async () => {
  const server = await startMockServer((_req, res) => { res.end(encodeWavPcm16Mono(tone(480), 24000)); });
  try {
    const backend = createOpenAiCompatibleTtsBackend(config(server.baseUrl, { apiKey: undefined, voiceZh: "zf_xiaobei", voiceEn: "af_bella" }));
    await collect(backend.synthesize({ text: "你好", language: "zh-CN" }));
    await collect(backend.synthesize({ text: "Hi", language: "en-US" }));
    await collect(backend.synthesize({ text: "Hi", language: undefined }));
    assert.equal(server.requests[0].headers.authorization, undefined);
    assert.deepEqual(server.requests.map((r) => JSON.parse(r.body.toString()).voice), ["zf_xiaobei", "af_bella", "af_bella"]);
  } finally { await server.close(); }
});

test("long text is split at the provider limit, in order, without truncation", async () => {
  const server = await startMockServer((req, res, index) => {
    res.end(encodeWavPcm16Mono(tone(240, 100 * (index + 1)), 24000));
    void req;
  });
  try {
    const sentence = "Tell me about a time you resolved a difficult production incident under pressure. ";
    const text = sentence.repeat(7).trim(); // ~570 chars
    const backend = createOpenAiCompatibleTtsBackend(config(server.baseUrl, { maxInputChars: 200 }));
    const events = await collect(backend.synthesize({ text }));
    const inputs = server.requests.map((r) => JSON.parse(r.body.toString()).input as string);
    assert.ok(inputs.length >= 3);
    for (const input of inputs) assert.ok(input.length <= 200);
    assert.equal(normalize(inputs.join(" ")), normalize(text));
    const pcm = audioOf(events);
    assert.equal(pcm.length, inputs.length * 240 * 2);
    // Segment order is preserved in the output stream.
    inputs.forEach((_, i) => assert.equal(pcm.readInt16LE(i * 240 * 2), 100 * (i + 1)));
    assert.equal(events.filter((e) => e.type === "sentence_end").length, inputs.length);
  } finally { await server.close(); }
});

test("a request needing more segments than the configured bound fails instead of truncating", async () => {
  const server = await startMockServer((_req, res) => { res.end(encodeWavPcm16Mono(tone(24), 24000)); });
  try {
    const backend = createOpenAiCompatibleTtsBackend(config(server.baseUrl, { maxInputChars: 20, maxSegments: 2 }));
    const events = await collect(backend.synthesize({ text: "A sentence that is definitely much longer than twenty characters." }));
    assert.equal(server.requests.length, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "error");
    assert.match((events[0] as { error: string }).error, /segment/i);
  } finally { await server.close(); }
});

test("provider HTTP errors surface the status but never the credential", async () => {
  const server = await startMockServer((req, res) => {
    res.statusCode = 401;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: { message: `Invalid API key ${req.headers.authorization}` } }));
  });
  try {
    const events = await collect(createOpenAiCompatibleTtsBackend(config(server.baseUrl)).synthesize({ text: "Hello" }));
    assert.equal(events.length, 1);
    const err = (events[0] as { error: string }).error;
    assert.match(err, /401/);
    assert.ok(!err.includes(KEY), "error must not disclose the API key");
    assert.ok(!/Bearer/.test(err));
  } finally { await server.close(); }
});

test("malformed or wrong-format audio fails clearly and is never forwarded as samples", async () => {
  let mode = 0;
  const server = await startMockServer((_req, res) => {
    if (mode === 0) res.end(Buffer.concat([Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00"), Buffer.alloc(64)]));
    else if (mode === 1) { res.setHeader("content-type", "application/json"); res.end('{"error":"model not loaded"}'); }
    else res.end(Buffer.alloc(0));
  });
  try {
    const backend = createOpenAiCompatibleTtsBackend(config(server.baseUrl));
    for (mode = 0; mode < 3; mode++) {
      const events = await collect(backend.synthesize({ text: "Hello" }));
      assert.equal(events.some((e) => e.type === "audio"), false, `mode ${mode} must not emit audio`);
      assert.equal(events.some((e) => e.type === "done"), false);
      assert.equal(events.at(-1)?.type, "error");
    }
  } finally { await server.close(); }
});

test("oversized responses are rejected by the memory bound", async () => {
  const server = await startMockServer((_req, res) => { res.end(encodeWavPcm16Mono(tone(5000), 24000)); });
  try {
    const events = await collect(createOpenAiCompatibleTtsBackend(config(server.baseUrl, { maxAudioBytes: 4000 })).synthesize({ text: "Hello" }));
    assert.equal(events.at(-1)?.type, "error");
    assert.match((events.at(-1) as { error: string }).error, /limit|large/i);
  } finally { await server.close(); }
});

test("slow providers hit the request timeout", async () => {
  const server = await startMockServer(async (_req, res) => { await sleep(600); res.end(encodeWavPcm16Mono(tone(24), 24000)); });
  try {
    const started = Date.now();
    const events = await collect(createOpenAiCompatibleTtsBackend(config(server.baseUrl, { timeoutMs: 100 })).synthesize({ text: "Hello" }));
    assert.ok(Date.now() - started < 500);
    assert.equal(events.at(-1)?.type, "error");
    assert.match((events.at(-1) as { error: string }).error, /timed out/i);
  } finally { await server.close(); }
});

test("cancellation aborts the in-flight request, stops further segments and emits nothing late", async () => {
  const server = await startMockServer(async (_req, res) => { await sleep(300); if (!res.destroyed) res.end(encodeWavPcm16Mono(tone(24), 24000)); });
  try {
    const abort = new AbortController();
    const backend = createOpenAiCompatibleTtsBackend(config(server.baseUrl, { maxInputChars: 30 }));
    const text = "First sentence goes here. Second sentence goes here. Third sentence goes here.";
    const pending = collect(backend.synthesize({ text, signal: abort.signal }));
    await sleep(60);
    abort.abort();
    const events = await pending;
    assert.deepEqual(events, [], "no audio/done/error after cancellation");
    await sleep(450);
    assert.ok(server.requests.length <= 2, `cancelled run must not keep requesting (${server.requests.length})`);
    assert.ok(server.requests.every((r) => r.closedEarly), "in-flight requests must be aborted");
  } finally { await server.close(); }
});

test("synthesizeFull-style callers can stop early without leaking pending prefetches", async () => {
  const server = await startMockServer(async (_req, res) => { res.end(encodeWavPcm16Mono(tone(24), 24000)); });
  try {
    const backend = createOpenAiCompatibleTtsBackend(config(server.baseUrl, { maxInputChars: 30 }));
    for await (const event of backend.synthesize({ text: "First sentence goes here. Second sentence goes here. Third sentence goes here." })) {
      if (event.type === "audio") break;
    }
    await sleep(100);
    assert.ok(server.requests.length <= 2);
  } finally { await server.close(); }
});
