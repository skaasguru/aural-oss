import assert from "node:assert/strict";
import test from "node:test";
import { parseWav } from "../server/speech/audio";
import { createOpenAiCompatibleSttProvider, type OpenAiCompatibleSttConfig } from "../server/speech/stt/openai-compatible";
import type { SttEvent, SttSession } from "../server/speech/stt/types";
import { parseMultipart, sleep, startMockServer } from "./helpers/speech-mock-server";

const KEY = "gsk_SECRET_stt_key";
const tone = (ms: number, level = 6000) => {
  const buf = Buffer.alloc(ms * 32);
  for (let i = 0; i < buf.length; i += 2) buf.writeInt16LE(i % 4 === 0 ? level : -level, i);
  return buf;
};
const quiet = (ms: number) => Buffer.alloc(ms * 32);
const reply = (text: string) => JSON.stringify({ text });

function config(baseUrl: string, overrides: Partial<OpenAiCompatibleSttConfig> = {}): OpenAiCompatibleSttConfig {
  return {
    baseUrl: `${baseUrl}/openai/v1`, apiKey: KEY, model: "whisper-large-v3-turbo", timeoutMs: 2000,
    silenceMs: 400, minSpeechMs: 200, prerollMs: 100, maxUtteranceMs: 30_000, vadThreshold: 0.02,
    maxQueue: 3, maxRetries: 0, failureThreshold: 3, cooldownMs: 60_000, ...overrides,
  };
}

async function open(cfg: OpenAiCompatibleSttConfig, language?: string) {
  const provider = createOpenAiCompatibleSttProvider(cfg);
  const session = await provider.open({ requestId: "req-1", language });
  const events: SttEvent[] = [];
  session.setListener((e) => events.push(e));
  return { provider, session, events };
}
const finals = (events: SttEvent[]) => events.filter((e) => e.type === "transcript") as Extract<SttEvent, { type: "transcript" }>[];
async function until(predicate: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!predicate()) { if (Date.now() > end) throw new Error("timed out waiting"); await sleep(10); }
}
function speakUtterance(session: SttSession, ms = 600) {
  session.sendAudio(quiet(100));
  session.sendAudio(tone(ms));
  session.sendAudio(quiet(600));
}

test("capabilities honestly describe buffered transcription (no native partials)", async () => {
  const { provider, session } = await open(config("http://127.0.0.1:1"));
  assert.equal(provider.capabilities.mode, "utterance-buffered");
  assert.equal(provider.capabilities.partials, false);
  assert.equal(provider.capabilities.speechEvents, true);
  assert.equal(session.capabilities.partials, false);
  session.close();
});

test("an utterance becomes one multipart request with a real WAV, model, language and prompt", async () => {
  const server = await startMockServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(reply("  Hello there. ")); });
  try {
    const { session, events } = await open(config(server.baseUrl, { prompt: "Aural interview" }), "English");
    speakUtterance(session, 600);
    await until(() => finals(events).length === 1);
    assert.equal(server.requests.length, 1);
    const req = server.requests[0];
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/openai/v1/audio/transcriptions");
    assert.equal(req.headers.authorization, `Bearer ${KEY}`);
    const form = parseMultipart(String(req.headers["content-type"]), req.body);
    assert.equal(form.fields.model, "whisper-large-v3-turbo");
    assert.equal(form.fields.language, "en");
    assert.equal(form.fields.prompt, "Aural interview");
    assert.equal(form.fields.response_format, "json");
    assert.equal(form.files.file.filename, "audio.wav");
    assert.equal(form.files.file.contentType, "audio/wav");
    const wav = parseWav(form.files.file.data);
    assert.equal(wav.sampleRate, 16000);
    assert.equal(wav.channels, 1);
    assert.equal(wav.bitsPerSample, 16);
    assert.ok(wav.data.length >= 600 * 32 && wav.data.length <= (600 + 100 + 220) * 32);

    const transcript = finals(events)[0].response;
    assert.equal(transcript.text, "Hello there.");
    assert.deepEqual(transcript.utterances, [{ text: "Hello there.", definite: true }]);
    assert.deepEqual(events.map((e) => e.type), ["speech_started", "speech_stopped", "transcript"]);
    session.close();
  } finally { await server.close(); }
});

test("language and prompt are omitted when unknown, and no auth header is sent without a key", async () => {
  const server = await startMockServer((_req, res) => { res.end(reply("ok ok")); });
  try {
    const { session, events } = await open(config(server.baseUrl, { apiKey: undefined }), "Klingon");
    speakUtterance(session);
    await until(() => finals(events).length === 1);
    const form = parseMultipart(String(server.requests[0].headers["content-type"]), server.requests[0].body);
    assert.equal("language" in form.fields, false);
    assert.equal("prompt" in form.fields, false);
    assert.equal(server.requests[0].headers.authorization, undefined);
    session.close();
  } finally { await server.close(); }
});

test("transcripts accumulate across utterances without duplicating finals", async () => {
  let n = 0;
  const server = await startMockServer((_req, res) => { res.end(reply(["First answer.", "Second answer."][n++])); });
  try {
    const { session, events } = await open(config(server.baseUrl));
    speakUtterance(session);
    await until(() => finals(events).length === 1);
    speakUtterance(session);
    await until(() => finals(events).length === 2);
    await sleep(100);
    assert.equal(finals(events).length, 2);
    assert.equal(server.requests.length, 2);
    assert.equal(finals(events)[1].response.text, "First answer. Second answer.");
    assert.deepEqual(finals(events)[1].response.utterances?.map((u) => u.text), ["First answer.", "Second answer."]);
    assert.ok(finals(events)[1].response.utterances?.every((u) => u.definite));
    session.close();
  } finally { await server.close(); }
});

test("silence-only audio and sub-threshold blips never reach the provider", async () => {
  const server = await startMockServer((_req, res) => { res.end(reply("hallucinated thank you")); });
  try {
    const { session, events } = await open(config(server.baseUrl));
    session.sendAudio(quiet(3000));
    session.sendAudio(tone(60));
    session.sendAudio(quiet(800));
    await sleep(150);
    assert.equal(server.requests.length, 0);
    assert.equal(finals(events).length, 0);
    assert.ok(events.some((e) => e.type === "no_speech"));
    session.close();
  } finally { await server.close(); }
});

test("an empty provider transcript is reported as no_speech and does not become a final", async () => {
  const server = await startMockServer((_req, res) => { res.end(reply("   ")); });
  try {
    const { session, events } = await open(config(server.baseUrl));
    speakUtterance(session);
    await until(() => events.some((e) => e.type === "no_speech"));
    assert.equal(finals(events).length, 0);
    session.close();
  } finally { await server.close(); }
});

test("a brief pause inside speech stays in a single request", async () => {
  const server = await startMockServer((_req, res) => { res.end(reply("one two")); });
  try {
    const { session, events } = await open(config(server.baseUrl));
    session.sendAudio(tone(500)); session.sendAudio(quiet(300)); session.sendAudio(tone(500)); session.sendAudio(quiet(600));
    await until(() => finals(events).length === 1);
    assert.equal(server.requests.length, 1);
    session.close();
  } finally { await server.close(); }
});

test("hasPendingWork covers buffered speech and in-flight requests", async () => {
  const server = await startMockServer(async (_req, res) => { await sleep(150); res.end(reply("done")); });
  try {
    const { session, events } = await open(config(server.baseUrl));
    assert.equal(session.hasPendingWork(), false);
    session.sendAudio(tone(300));
    assert.equal(session.hasPendingWork(), true, "speech in progress");
    session.sendAudio(quiet(600));
    assert.equal(session.hasPendingWork(), true, "request in flight");
    await until(() => finals(events).length === 1);
    assert.equal(session.hasPendingWork(), false);
    session.close();
  } finally { await server.close(); }
});

test("finish() flushes buffered speech, delivers its result, then closes exactly once", async () => {
  const server = await startMockServer((_req, res) => { res.end(reply("trailing words")); });
  try {
    const { session, events } = await open(config(server.baseUrl));
    session.sendAudio(tone(700)); // no trailing silence: only a flush can end this utterance
    session.finish();
    await until(() => events.some((e) => e.type === "closed"));
    assert.deepEqual(events.map((e) => e.type), ["speech_started", "speech_stopped", "transcript", "closed"]);
    assert.equal(finals(events)[0].response.text, "trailing words");
    session.sendAudio(tone(700)); session.sendAudio(quiet(800));
    await sleep(100);
    assert.equal(server.requests.length, 1, "audio after finish is ignored");
    assert.equal(events.filter((e) => e.type === "closed").length, 1);
    assert.equal(session.isOpen, false);
  } finally { await server.close(); }
});

test("close() cancels the in-flight request and a late completion is never emitted", async () => {
  const server = await startMockServer(async (_req, res) => { await sleep(300); if (!res.destroyed) res.end(reply("too late")); });
  try {
    const { session, events } = await open(config(server.baseUrl));
    speakUtterance(session);
    await until(() => server.requests.length === 1);
    session.close();
    await sleep(450);
    assert.equal(events.some((e) => e.type === "transcript" || e.type === "error" || e.type === "closed"), false);
    assert.equal(server.requests[0].closedEarly, true);
    assert.equal(session.isOpen, false);
    session.sendAudio(tone(500)); session.sendAudio(quiet(800));
    assert.equal(server.requests.length, 1);
  } finally { await server.close(); }
});

test("results are delivered in utterance order even when the first request is slower", async () => {
  const server = await startMockServer(async (_req, res, index) => { if (index === 0) await sleep(200); res.end(reply(index === 0 ? "alpha" : "beta")); });
  try {
    const { session, events } = await open(config(server.baseUrl));
    speakUtterance(session); speakUtterance(session);
    await until(() => finals(events).length === 2);
    assert.deepEqual(finals(events).map((e) => e.response.text), ["alpha", "alpha beta"]);
    session.close();
  } finally { await server.close(); }
});

test("a backlog beyond maxQueue is dropped with an error instead of growing without bound", async () => {
  const server = await startMockServer(async (_req, res) => { await sleep(400); res.end(reply("x")); });
  try {
    const { session, events } = await open(config(server.baseUrl, { maxQueue: 2 }));
    for (let i = 0; i < 6; i++) speakUtterance(session);
    await sleep(100);
    assert.ok(events.some((e) => e.type === "error" && /backlog/i.test(e.message) && !e.fatal));
    session.close();
    assert.ok(server.requests.length <= 3);
  } finally { await server.close(); }
});

test("transient 503 is retried within the configured bound", async () => {
  const server = await startMockServer((_req, res, index) => {
    if (index === 0) { res.statusCode = 503; res.end("busy"); } else res.end(reply("recovered"));
  });
  try {
    const { session, events } = await open(config(server.baseUrl, { maxRetries: 1 }));
    speakUtterance(session);
    await until(() => finals(events).length === 1);
    assert.equal(server.requests.length, 2);
    assert.equal(finals(events)[0].response.text, "recovered");
    session.close();
  } finally { await server.close(); }
});

test("auth failures are not retried and never leak the key", async () => {
  const server = await startMockServer((req, res) => {
    res.statusCode = 401; res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: { message: `bad key ${req.headers.authorization}` } }));
  });
  try {
    const { session, events } = await open(config(server.baseUrl, { maxRetries: 2 }));
    speakUtterance(session);
    await until(() => events.some((e) => e.type === "error"));
    const err = events.find((e) => e.type === "error") as Extract<SttEvent, { type: "error" }>;
    assert.equal(err.code, 401);
    assert.equal(err.fatal, false);
    assert.ok(!err.message.includes(KEY) && !/Bearer/.test(err.message));
    assert.equal(server.requests.length, 1);
    session.close();
  } finally { await server.close(); }
});

test("malformed JSON and timeouts are reported as errors", async () => {
  let mode = 0;
  const server = await startMockServer(async (_req, res) => {
    if (mode === 0) res.end("not json at all"); else { await sleep(500); if (!res.destroyed) res.end(reply("late")); }
  });
  try {
    const { session, events } = await open(config(server.baseUrl, { timeoutMs: 150 }));
    speakUtterance(session);
    await until(() => events.some((e) => e.type === "error"));
    assert.match((events.find((e) => e.type === "error") as { message: string }).message, /invalid|malformed|response/i);
    mode = 1; events.length = 0;
    speakUtterance(session);
    await until(() => events.some((e) => e.type === "error"));
    assert.match((events.find((e) => e.type === "error") as { message: string }).message, /timed out/i);
    await sleep(450);
    assert.equal(finals(events).length, 0, "timed-out request must not produce a late final");
    session.close();
  } finally { await server.close(); }
});

test("repeated failures open a circuit: the session ends fatally and new sessions are refused until cooldown", async () => {
  const server = await startMockServer((_req, res) => { res.statusCode = 500; res.end("down"); });
  try {
    const { provider, session, events } = await open(config(server.baseUrl, { failureThreshold: 2, cooldownMs: 200 }));
    speakUtterance(session); speakUtterance(session);
    await until(() => events.some((e) => e.type === "closed"));
    const errors = events.filter((e) => e.type === "error") as Extract<SttEvent, { type: "error" }>[];
    assert.equal(errors.at(-1)?.fatal, true);
    await assert.rejects(provider.open({ requestId: "r2" }), /unavailable/i);
    await sleep(250);
    const again = await provider.open({ requestId: "r3" });
    assert.equal(again.isOpen, true);
    again.close();
  } finally { await server.close(); }
});

test("an owner that close()s the session from its fatal-error handler still receives closed", async () => {
  const server = await startMockServer((_req, res) => { res.statusCode = 500; res.end("down"); });
  try {
    const provider = createOpenAiCompatibleSttProvider(config(server.baseUrl, { failureThreshold: 1 }));
    const session = await provider.open({ requestId: "r" });
    const seen: string[] = [];
    session.setListener((e) => { seen.push(e.type); if (e.type === "error" && e.fatal) session.close(); });
    speakUtterance(session);
    await until(() => seen.includes("closed"));
    assert.deepEqual(seen, ["speech_started", "speech_stopped", "error", "closed"]);
  } finally { await server.close(); }
});

test("an owner that detaches listeners never receives events, even from an in-flight failure", async () => {
  const server = await startMockServer(async (_req, res) => { await sleep(100); res.statusCode = 500; res.end("down"); });
  try {
    const provider = createOpenAiCompatibleSttProvider(config(server.baseUrl, { failureThreshold: 1 }));
    const session = await provider.open({ requestId: "r" });
    const seen: string[] = [];
    session.setListener((e) => seen.push(e.type));
    speakUtterance(session);
    await until(() => server.requests.length === 1);
    session.removeAllListeners();
    await sleep(250);
    assert.deepEqual(seen, ["speech_started", "speech_stopped"]);
  } finally { await server.close(); }
});
