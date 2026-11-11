import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { encodeWavPcm16Mono, parseWav } from "../server/speech/audio";
import { parseMultipart, sleep, startMockServer } from "./helpers/speech-mock-server";

async function freePort(): Promise<number> {
  const socket = net.createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return port;
}

const tone = (ms: number) => { const b = Buffer.alloc(ms * 32); for (let i = 0; i < b.length; i += 2) b.writeInt16LE(i % 4 === 0 ? 6000 : -6000, i); return b; };

interface Harness {
  port: number; child: ChildProcess; logs: () => string; dir: string;
}

async function startRelay(env: Record<string, string>): Promise<Harness> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aural-speech-e2e-"));
  const envFile = path.join(dir, "empty.env");
  await writeFile(envFile, "");
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "--require", "./tests/fixtures/relay-llm-mock.cjs", "server/voice-relay.ts"], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NODE_ENV: "test", AURAL_ENV_FILE: envFile,
      VOICE_RELAY_PORT: String(port), VOICE_RELAY_HOST: "127.0.0.1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout!.on("data", (c) => { logs += c; });
  child.stderr!.on("data", (c) => { logs += c; });
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`relay exited: ${logs}`);
    if (logs.includes("Listening on")) break;
    if (Date.now() > deadline) throw new Error(`relay did not start: ${logs}`);
    await sleep(50);
  }
  await sleep(100);
  return { port, child, logs: () => logs, dir };
}
async function stopRelay(h: Harness) {
  h.child.kill("SIGTERM");
  await new Promise<void>((resolve) => { if (h.child.exitCode !== null) resolve(); else h.child.once("exit", () => resolve()); });
  await rm(h.dir, { recursive: true, force: true });
}

const KEYS = { stt: "stt-secret-e2e-key", tts: "tts-secret-e2e-key" };

test("relay runs a full voice turn on OpenAI-compatible STT and TTS, and exposes a credential-free /health", { timeout: 40_000 }, async () => {
  const transcripts = ["First part of my answer.", "and the second part."];
  const stt = await startMockServer((_req, res, i) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ text: transcripts[i] ?? "extra" })); });
  const tts = await startMockServer((_req, res) => { res.setHeader("content-type", "audio/wav"); res.end(encodeWavPcm16Mono(Buffer.alloc(4800, 1), 16000)); });
  const relay = await startRelay({
    VOICE_ASR_PROVIDER: "openai-compatible", VOICE_STT_BASE_URL: `${stt.baseUrl}/openai/v1`, VOICE_STT_API_KEY: KEYS.stt,
    VOICE_STT_MODEL: "whisper-large-v3-turbo", VOICE_STT_SILENCE_MS: "300", VOICE_STT_MAX_RETRIES: "0",
    VOICE_TTS_PROVIDER: "openai-compatible", VOICE_TTS_BASE_URL: `${tts.baseUrl}/v1`, VOICE_TTS_API_KEY: KEYS.tts,
    VOICE_TTS_MODEL: "kokoro", VOICE_TTS_VOICE: "af_heart", VOICE_TTS_FORMAT: "wav",
  });
  let ws: WebSocket | undefined;
  try {
    // Health: reports providers, never credentials.
    const health = await fetch(`http://127.0.0.1:${relay.port}/health`);
    assert.equal(health.status, 200);
    const healthText = await health.text();
    const body = JSON.parse(healthText);
    assert.equal(body.status, "ok");
    assert.equal(body.asr.provider, "openai-compatible");
    assert.equal(body.asr.partials, false);
    assert.equal(body.tts.provider, "openai-compatible");
    assert.ok(!healthText.includes(KEYS.stt) && !healthText.includes(KEYS.tts));
    assert.equal((await fetch(`http://127.0.0.1:${relay.port}/nope`)).status, 404);

    ws = new WebSocket(`ws://127.0.0.1:${relay.port}`);
    const events: Array<{ type: string; text?: string }> = [];
    let binaryBytes = 0;
    ws.on("message", (data, binary) => { if (binary) binaryBytes += (data as Buffer).length; else events.push(JSON.parse(data.toString())); });
    await new Promise<void>((resolve, reject) => { ws!.once("open", resolve); ws!.once("error", reject); });
    ws.send(JSON.stringify({ type: "init", context: { title: "English interview", language: "English", aiName: "Aural",
      questions: [{ text: "Can you explain your project?", type: "OPEN_ENDED", order: 0 }] } }));

    const until = async (predicate: () => boolean, ms = 15_000) => {
      const end = Date.now() + ms;
      while (!predicate()) { if (Date.now() > end) throw new Error(`timeout; logs: ${relay.logs().slice(-1500)}`); await sleep(25); }
    };
    // Greeting: synthesized by the HTTP TTS and delivered as browser-format binary PCM (24 kHz s16le).
    await until(() => events.some((e) => e.type === "tts_ended"));
    // 4800 B of 16 kHz s16le = 2400 samples -> 3600 samples at 24 kHz = 7200 B per synthesized request.
    assert.ok(binaryBytes >= 7200 && binaryBytes % 7200 === 0, `greeting audio resampled 16k->24k s16le (got ${binaryBytes}B)`);
    const greetingInput = JSON.parse(tts.requests[0].body.toString()).input as string;
    assert.match(greetingInput, /Can you explain your project\?/, "full question text is sent, not truncated");
    assert.equal(tts.requests[0].headers.authorization, `Bearer ${KEYS.tts}`);
    const utteranceId = events.find((e) => e.type === "tts_ended") as unknown as { utteranceId: string };
    ws.send(JSON.stringify({ type: "playback_ended", utteranceId: utteranceId.utteranceId }));
    await sleep(300);

    // Speak part 1, pause briefly (longer than the VAD window, shorter than the relay's coalescing
    // window), speak part 2. Paced in real time so the relay's wall-clock timers are exercised.
    const send = async (pcm: Buffer) => {
      for (let off = 0; off < pcm.length; off += 3200) {
        ws!.send(JSON.stringify({ type: "audio", data: pcm.subarray(off, off + 3200).toString("hex") }));
        await sleep(100);
      }
    };
    await send(tone(500));
    await send(Buffer.alloc(32 * 500));
    await send(tone(500));
    await send(Buffer.alloc(32 * 600));

    await until(() => events.some((e) => e.type === "asr_ended"));
    const ended = events.filter((e) => e.type === "asr_ended");
    assert.equal(ended.length, 1, `exactly one committed turn, no premature reply: ${JSON.stringify(ended)}`);
    // Both utterances are in the one turn; the relay's own normalization may drop the inner period.
    assert.match(ended[0].text ?? "", /^First part of my answer\.? and the second part\.?$/);

    assert.equal(stt.requests.length, 2);
    for (const req of stt.requests) {
      assert.equal(req.url, "/openai/v1/audio/transcriptions");
      assert.equal(req.headers.authorization, `Bearer ${KEYS.stt}`);
      const form = parseMultipart(String(req.headers["content-type"]), req.body);
      assert.equal(form.fields.language, "en");
      assert.equal(parseWav(form.files.file.data).sampleRate, 16000);
    }
    // The interviewer reply is also spoken through the HTTP TTS.
    await until(() => tts.requests.length >= 2);
    assert.match(JSON.parse(tts.requests[1].body.toString()).input, /explain how you tested/);
    assert.ok(!relay.logs().includes(KEYS.stt) && !relay.logs().includes(KEYS.tts), "logs must not contain credentials");
  } finally {
    ws?.close();
    await stopRelay(relay);
    await stt.close(); await tts.close();
  }
});

test("relay refuses to start on invalid speech configuration, naming variables but not secrets", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aural-speech-bad-"));
  const envFile = path.join(dir, "empty.env");
  await writeFile(envFile, "");
  try {
    for (const env of [
      { VOICE_ASR_PROVIDER: "openai-compatible", VOICE_STT_API_KEY: "stt-hidden-value", DOUBAO_APP_ID: "a", DOUBAO_ACCESS_TOKEN: "t" },
      { VOICE_ASR_PROVIDER: "seed", DOUBAO_API_KEY: "k", VOICE_TTS_PROVIDER: "openai-compatible", VOICE_TTS_API_KEY: "tts-hidden-value" },
      { VOICE_ASR_PROVIDER: "seed", DOUBAO_API_KEY: "k", VOICE_TTS_PROVIDER: "nope" },
    ]) {
      const child = spawn(process.execPath, ["--import", "tsx", "server/voice-relay.ts"], {
        env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test", AURAL_ENV_FILE: envFile, VOICE_RELAY_PORT: String(await freePort()), ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout!.on("data", (c) => { out += c; }); child.stderr!.on("data", (c) => { out += c; });
      const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
      assert.equal(code, 1, out);
      assert.match(out, /VOICE_(STT|TTS|ASR)_/);
      assert.ok(!out.includes("hidden-value"));
      assert.ok(!/Listening on/.test(out));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

async function micTestSession(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const events: Array<{ type: string; text?: string; data?: { results: Array<{ text: string; definite: boolean }> } }> = [];
  ws.on("message", (data, binary) => { if (!binary) events.push(JSON.parse(data.toString())); });
  await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  ws.send(JSON.stringify({ type: "mic_test", language: "en-US" }));
  const until = async (predicate: () => boolean, ms = 10_000) => {
    const end = Date.now() + ms;
    while (!predicate()) { if (Date.now() > end) throw new Error(`timeout: ${JSON.stringify(events)}`); await sleep(25); }
  };
  const speak = async (pcm: Buffer) => {
    for (let off = 0; off < pcm.length; off += 3200) { ws.send(JSON.stringify({ type: "audio", data: pcm.subarray(off, off + 3200).toString("hex") })); await sleep(20); }
  };
  return { ws, events, until, speak };
}

const sttEnv = (base: string, extra: Record<string, string> = {}) => ({
  VOICE_ASR_PROVIDER: "openai-compatible", VOICE_STT_BASE_URL: `${base}/v1`, VOICE_STT_MODEL: "whisper-1", VOICE_STT_SILENCE_MS: "300",
  VOICE_STT_MAX_RETRIES: "0", VOICE_TTS_PROVIDER: "openai-compatible", VOICE_TTS_BASE_URL: `${base}/v1`, VOICE_TTS_MODEL: "m", VOICE_TTS_VOICE: "v", ...extra,
});

test("mic test and practice dictation (mic_test mode) transcribe through the buffered provider without a Doubao credential", { timeout: 30_000 }, async () => {
  const stt = await startMockServer((_req, res) => { res.end(JSON.stringify({ text: "testing one two three" })); });
  const relay = await startRelay(sttEnv(stt.baseUrl));
  try {
    const { ws, events, until, speak } = await micTestSession(relay.port);
    try {
      await until(() => events.some((e) => e.type === "ready"));
      await speak(tone(600)); await speak(Buffer.alloc(32 * 600));
      await until(() => events.some((e) => e.type === "asr_ended"));
      assert.deepEqual(events.filter((e) => e.type === "asr_ended").map((e) => e.text), ["testing one two three"]);
      const asr = events.find((e) => e.type === "asr");
      assert.deepEqual(asr?.data?.results, [{ text: "testing one two three", definite: true }]);
      // A second utterance yields only the new text (no replay of the settled first turn).
      await speak(tone(600)); await speak(Buffer.alloc(32 * 600));
      await until(() => events.filter((e) => e.type === "asr_ended").length === 2);
      assert.equal(events.filter((e) => e.type === "asr_ended").length, 2);
      assert.equal(stt.requests.length, 2);
    } finally { ws.close(); }
  } finally { await stopRelay(relay); await stt.close(); }
});

test("a failing STT provider surfaces a clear disconnect to the browser instead of hanging silently", { timeout: 30_000 }, async () => {
  const stt = await startMockServer((_req, res) => { res.statusCode = 500; res.end("down"); });
  const relay = await startRelay(sttEnv(stt.baseUrl, { VOICE_STT_FAILURE_THRESHOLD: "2", VOICE_STT_COOLDOWN_MS: "60000" }));
  try {
    const { ws, events, until, speak } = await micTestSession(relay.port);
    try {
      await until(() => events.some((e) => e.type === "ready"));
      await speak(tone(600)); await speak(Buffer.alloc(32 * 600));
      await speak(tone(600)); await speak(Buffer.alloc(32 * 600));
      await until(() => events.some((e) => e.type === "disconnected"));
      assert.equal(events.some((e) => e.type === "asr_ended"), false);
    } finally { ws.close(); }
  } finally { await stopRelay(relay); await stt.close(); }
});

const sttFailThenOk = (texts: string[]) => startMockServer((_req, res, i) => {
  if (i === 0) { res.statusCode = 500; res.end(`upstream exploded Bearer ${KEYS.stt} http://10.9.9.9:1234/secret-internal`); return; }
  res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ text: texts[i - 1] ?? "extra" }));
});
const assertSanitizedNotice = (notice: { message?: string; recoverable?: boolean; code?: string } | undefined, logs: string) => {
  assert.ok(notice, "browser must receive an error notification");
  assert.equal(notice.recoverable, true);
  assert.match(notice.code ?? "", /^stt_/);
  assert.match(notice.message ?? "", /repeat|again/i);
  const wire = JSON.stringify(notice);
  assert.ok(!wire.includes(KEYS.stt) && !/10\.9\.9\.9|secret-internal|exploded|Bearer/.test(wire), wire);
  assert.ok(!logs.includes(KEYS.stt), "server logs must not contain the credential");
};

test("mic test: one failed utterance sends a sanitized recoverable error, the session survives and the next utterance succeeds", { timeout: 30_000 }, async () => {
  const stt = await sttFailThenOk(["second try works"]);
  const relay = await startRelay(sttEnv(stt.baseUrl, { VOICE_STT_API_KEY: KEYS.stt }));
  try {
    const { ws, events, until, speak } = await micTestSession(relay.port);
    try {
      await until(() => events.some((e) => e.type === "ready"));
      await speak(tone(600)); await speak(Buffer.alloc(32 * 600));
      await until(() => events.some((e) => e.type === "error"));
      assert.equal(events.some((e) => e.type === "asr_ended"), false, "a failed utterance must not look like a success");
      assert.equal(events.some((e) => e.type === "disconnected"), false);
      assertSanitizedNotice(events.find((e) => e.type === "error") as never, relay.logs());
      assert.equal(ws.readyState, WebSocket.OPEN);
      await speak(tone(600)); await speak(Buffer.alloc(32 * 600));
      await until(() => events.some((e) => e.type === "asr_ended"));
      assert.deepEqual(events.filter((e) => e.type === "asr_ended").map((e) => e.text), ["second try works"]);
    } finally { ws.close(); }
  } finally { await stopRelay(relay); await stt.close(); }
});

test("interview: a failed utterance is reported to the browser without ending the session, then the next one is answered", { timeout: 40_000 }, async () => {
  const stt = await sttFailThenOk(["I tested it with a loopback server."]);
  const tts = await startMockServer((_req, res) => { res.setHeader("content-type", "audio/wav"); res.end(encodeWavPcm16Mono(Buffer.alloc(4800, 1), 16000)); });
  const relay = await startRelay({
    ...sttEnv(stt.baseUrl, { VOICE_STT_API_KEY: KEYS.stt }),
    VOICE_TTS_BASE_URL: `${tts.baseUrl}/v1`,
  });
  let ws: WebSocket | undefined;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${relay.port}`);
    const events: Array<{ type: string; text?: string; message?: string; recoverable?: boolean; code?: string }> = [];
    let closed = false;
    ws.on("message", (data, binary) => { if (!binary) events.push(JSON.parse(data.toString())); });
    ws.on("close", () => { closed = true; });
    await new Promise<void>((resolve, reject) => { ws!.once("open", resolve); ws!.once("error", reject); });
    ws.send(JSON.stringify({ type: "init", context: { title: "English interview", language: "English", aiName: "Aural",
      questions: [{ text: "Can you explain your project?", type: "OPEN_ENDED", order: 0 }] } }));
    const until = async (predicate: () => boolean, ms = 15_000) => {
      const end = Date.now() + ms;
      while (!predicate()) { if (Date.now() > end) throw new Error(`timeout; events=${JSON.stringify(events.map((e) => e.type))} logs: ${relay.logs().slice(-1200)}`); await sleep(25); }
    };
    await until(() => events.some((e) => e.type === "tts_ended"));
    ws.send(JSON.stringify({ type: "playback_ended", utteranceId: (events.find((e) => e.type === "tts_ended") as unknown as { utteranceId: string }).utteranceId }));
    await sleep(300);
    const send = async (pcm: Buffer) => { for (let off = 0; off < pcm.length; off += 3200) { ws!.send(JSON.stringify({ type: "audio", data: pcm.subarray(off, off + 3200).toString("hex") })); await sleep(100); } };
    await send(tone(500)); await send(Buffer.alloc(32 * 600));
    await until(() => events.some((e) => e.type === "error"));
    assertSanitizedNotice(events.find((e) => e.type === "error"), relay.logs());
    assert.equal(events.some((e) => e.type === "asr_ended"), false, "no reply may be generated for the lost answer");
    assert.equal(closed, false);
    assert.equal(events.some((e) => e.type === "disconnected"), false);
    await send(tone(500)); await send(Buffer.alloc(32 * 1200));
    await until(() => events.some((e) => e.type === "asr_ended"));
    assert.match(events.find((e) => e.type === "asr_ended")?.text ?? "", /tested it with a loopback server/);
    assert.equal(closed, false);
  } finally {
    ws?.close();
    await stopRelay(relay); await stt.close(); await tts.close();
  }
});
