import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SpeechAudioError, decodeSpeechAudio, encodeWavPcm16Mono, parseWav, toRelayPcm,
} from "../server/speech/audio";
import { joinApiUrl, parseHttpBaseUrl } from "../server/speech/url";

function s16(...values: number[]): Buffer {
  const out = Buffer.alloc(values.length * 2);
  values.forEach((v, i) => out.writeInt16LE(v, i * 2));
  return out;
}

test("joinApiUrl appends the path once and never doubles /v1", () => {
  assert.equal(joinApiUrl("https://api.groq.com/openai/v1", "audio/transcriptions"), "https://api.groq.com/openai/v1/audio/transcriptions");
  assert.equal(joinApiUrl("http://bifrost:8080/v1/", "/audio/speech"), "http://bifrost:8080/v1/audio/speech");
  assert.equal(joinApiUrl("http://kokoro:8880/v1", "/v1/audio/speech"), "http://kokoro:8880/v1/audio/speech");
  assert.equal(joinApiUrl("http://kokoro:8880", "v1/audio/speech"), "http://kokoro:8880/v1/audio/speech");
});

test("parseHttpBaseUrl rejects non-http schemes, embedded credentials and query strings", () => {
  assert.throws(() => parseHttpBaseUrl("ftp://x/v1", "VOICE_STT_BASE_URL"), /VOICE_STT_BASE_URL/);
  assert.throws(() => parseHttpBaseUrl("not a url", "VOICE_STT_BASE_URL"), /VOICE_STT_BASE_URL/);
  assert.throws(() => parseHttpBaseUrl("http://user:secret@host/v1", "VOICE_STT_BASE_URL"), (e: Error) => /credentials/.test(e.message) && !e.message.includes("secret"));
  assert.throws(() => parseHttpBaseUrl("http://host/v1?key=1", "VOICE_STT_BASE_URL"), /query/);
});

test("encodeWavPcm16Mono produces a RIFF container that parseWav reads back", () => {
  const pcm = s16(0, 1000, -1000, 32767);
  const wav = encodeWavPcm16Mono(pcm, 16000);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  const parsed = parseWav(wav);
  assert.equal(parsed.sampleRate, 16000);
  assert.equal(parsed.channels, 1);
  assert.equal(parsed.bitsPerSample, 16);
  assert.deepEqual(parsed.data, pcm);
});

test("parseWav skips unknown chunks and tolerates streaming data sizes", () => {
  const wav = encodeWavPcm16Mono(s16(1, 2, 3), 24000);
  const list = Buffer.concat([Buffer.from("LIST"), Buffer.from([4, 0, 0, 0]), Buffer.from("abcd")]);
  const withList = Buffer.concat([wav.subarray(0, 36), list, wav.subarray(36)]);
  assert.deepEqual(parseWav(withList).data, s16(1, 2, 3));
  const streaming = Buffer.from(wav);
  streaming.writeUInt32LE(0xffffffff, 40);
  assert.deepEqual(parseWav(streaming).data, s16(1, 2, 3));
});

test("parseWav rejects malformed containers with a clear error", () => {
  assert.throws(() => parseWav(Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00")), SpeechAudioError);
  assert.throws(() => parseWav(Buffer.alloc(10)), /WAV/);
  const wav = encodeWavPcm16Mono(s16(1, 2), 24000);
  assert.throws(() => parseWav(wav.subarray(0, 30)), /WAV/);
  const noData = wav.subarray(0, 36);
  assert.throws(() => parseWav(noData), /data/);
  const adpcm = Buffer.from(wav); adpcm.writeUInt16LE(2, 20);
  assert.throws(() => parseWav(adpcm), /unsupported/i);
});

test("toRelayPcm downmixes stereo, converts float32 and resamples to mono 24 kHz s16le", () => {
  const frames = 480; // 10 ms at 48 kHz
  const data = Buffer.alloc(frames * 2 * 4);
  for (let i = 0; i < frames; i++) { data.writeFloatLE(0.5, i * 8); data.writeFloatLE(-0.5, i * 8 + 4); }
  const wav = Buffer.concat([encodeWavPcm16Mono(Buffer.alloc(0), 48000).subarray(0, 12)]);
  void wav;
  const out = toRelayPcm({ sampleRate: 48000, channels: 2, bitsPerSample: 32, floatSamples: true, data });
  assert.equal(out.length, 240 * 2);
  for (let i = 0; i < 240; i++) assert.ok(Math.abs(out.readInt16LE(i * 2)) <= 1, "L+R of +0.5/-0.5 cancels");
  const up = toRelayPcm({ sampleRate: 16000, channels: 1, bitsPerSample: 16, floatSamples: false, data: s16(1000, 1000, 1000, 1000) });
  assert.equal(up.length, 6 * 2);
  assert.equal(up.readInt16LE(0), 1000);
});

test("decodeSpeechAudio handles wav and pcm and never forwards container bytes as samples", async () => {
  const wav = encodeWavPcm16Mono(s16(5, 6, 7, 8), 24000);
  assert.deepEqual(await decodeSpeechAudio(wav, { format: "wav" }), s16(5, 6, 7, 8));
  assert.deepEqual(await decodeSpeechAudio(s16(5, 6), { format: "pcm" }), s16(5, 6));
  // pcm configured but server sent a WAV: parse the container, do not treat the header as samples
  assert.deepEqual(await decodeSpeechAudio(wav, { format: "pcm" }), s16(5, 6, 7, 8));
  await assert.rejects(decodeSpeechAudio(Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00junk"), { format: "pcm" }), /mp3|compressed/i);
  await assert.rejects(decodeSpeechAudio(Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00junk"), { format: "wav" }), SpeechAudioError);
  await assert.rejects(decodeSpeechAudio(Buffer.alloc(0), { format: "wav" }), /empty/i);
  await assert.rejects(decodeSpeechAudio(s16(1, 2, 3).subarray(0, 5), { format: "pcm" }), /odd|aligned/i);
});

test("decodeSpeechAudio decodes compressed formats through ffmpeg and fails clearly when it is missing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fake-ffmpeg-"));
  try {
    const fake = path.join(dir, "ffmpeg");
    // Consumes stdin, asserts the requested output shape, then emits 3 known samples.
    await writeFile(fake, `#!/bin/sh\ncat >/dev/null\ncase "$*" in *"-f s16le"*"-ar 24000"*"-ac 1"*) printf '\\001\\000\\002\\000\\003\\000';; *) echo bad args >&2; exit 3;; esac\n`);
    await chmod(fake, 0o755);
    const out = await decodeSpeechAudio(Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00frames"), { format: "mp3", ffmpegPath: fake });
    assert.deepEqual(out, s16(1, 2, 3));
    await assert.rejects(
      decodeSpeechAudio(Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00frames"), { format: "mp3", ffmpegPath: path.join(dir, "missing") }),
      /ffmpeg/i,
    );
    const failing = path.join(dir, "fail");
    await writeFile(failing, "#!/bin/sh\ncat >/dev/null\necho SECRET-KEY-LEAK >&2\nexit 1\n");
    await chmod(failing, 0o755);
    await assert.rejects(
      decodeSpeechAudio(Buffer.from("x"), { format: "mp3", ffmpegPath: failing }),
      (e: Error) => /ffmpeg/i.test(e.message) && !e.message.includes("SECRET-KEY-LEAK"),
    );
  } finally { await rm(dir, { recursive: true, force: true }); }
});
