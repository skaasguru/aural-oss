import assert from "node:assert/strict";
import test from "node:test";
import { UtteranceSegmenter, type SegmenterOutput } from "../server/speech/stt/segmenter";

const opts = { threshold: 0.02, silenceMs: 400, minSpeechMs: 200, prerollMs: 100, maxUtteranceMs: 60_000 };

function pcm(ms: number, level: number): Buffer {
  const bytes = (ms * 16) * 2;
  const buf = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i += 2) buf.writeInt16LE(i % 4 === 0 ? level : -level, i);
  return buf;
}
const speech = (ms: number) => pcm(ms, 6000);
const silence = (ms: number) => pcm(ms, 0);
const types = (out: SegmenterOutput[]) => out.map((o) => o.type);

function run(seg: UtteranceSegmenter, ...chunks: Buffer[]): SegmenterOutput[] {
  return chunks.flatMap((c) => seg.push(c));
}

test("silence alone never produces events", () => {
  const seg = new UtteranceSegmenter(opts);
  assert.deepEqual(run(seg, silence(2000)), []);
  assert.equal(seg.isSpeaking, false);
  assert.deepEqual(seg.flush(), []);
});

test("speech followed by enough silence yields started, stopped and one utterance with preroll", () => {
  const seg = new UtteranceSegmenter(opts);
  const out = run(seg, silence(300), speech(600), silence(600));
  assert.deepEqual(types(out), ["speech_started", "speech_stopped", "utterance"]);
  const utt = out.find((o) => o.type === "utterance") as Extract<SegmenterOutput, { type: "utterance" }>;
  const ms = utt.pcm.length / 32;
  assert.ok(ms >= 600 + 100 - 20, `includes preroll (${ms}ms)`);
  assert.ok(ms <= 600 + 100 + 220, `trailing silence is trimmed (${ms}ms)`);
  assert.equal(utt.reason, "silence");
  assert.equal(seg.isSpeaking, false);
});

test("a brief pause shorter than the silence window stays inside one utterance", () => {
  const seg = new UtteranceSegmenter(opts);
  const out = run(seg, speech(500), silence(300), speech(500), silence(600));
  assert.equal(out.filter((o) => o.type === "utterance").length, 1);
  assert.equal(out.filter((o) => o.type === "speech_started").length, 1);
  const utt = out.find((o) => o.type === "utterance") as Extract<SegmenterOutput, { type: "utterance" }>;
  assert.ok(utt.pcm.length / 32 >= 1300);
});

test("a pause longer than the window splits utterances", () => {
  const seg = new UtteranceSegmenter(opts);
  const out = run(seg, speech(500), silence(600), speech(500), silence(600));
  assert.equal(out.filter((o) => o.type === "utterance").length, 2);
});

test("blips under the minimum speech duration are reported as no_speech, not sent for transcription", () => {
  const seg = new UtteranceSegmenter(opts);
  const out = run(seg, speech(60), silence(600));
  assert.equal(out.some((o) => o.type === "utterance"), false);
  assert.deepEqual(types(out).filter((t) => t !== "speech_stopped"), ["speech_started", "no_speech"]);
  // A single noisy frame never even starts speech.
  assert.deepEqual(run(new UtteranceSegmenter(opts), speech(20), silence(600)), []);
});

test("continuous speech is cut at the maximum duration without losing or duplicating audio", () => {
  const seg = new UtteranceSegmenter({ ...opts, maxUtteranceMs: 1000, prerollMs: 0 });
  const out = run(seg, speech(3500), silence(600));
  const utts = out.filter((o) => o.type === "utterance") as Extract<SegmenterOutput, { type: "utterance" }>[];
  assert.ok(utts.length >= 3);
  assert.deepEqual(utts.slice(0, -1).map((u) => u.reason), utts.slice(0, -1).map(() => "max_duration"));
  for (const u of utts) assert.ok(u.pcm.length / 32 <= 1000 + 20);
  const total = utts.reduce((n, u) => n + u.pcm.length, 0);
  assert.ok(Math.abs(total / 32 - 3500) <= 240, `no gaps or overlap (${total / 32}ms)`);
  assert.equal(out.filter((o) => o.type === "speech_started").length, 1);
});

test("arbitrary chunk boundaries, including odd byte counts, give the same result", () => {
  const whole = Buffer.concat([silence(200), speech(600), silence(600)]);
  const a = run(new UtteranceSegmenter(opts), whole);
  const b = new UtteranceSegmenter(opts);
  const out: SegmenterOutput[] = [];
  for (let i = 0; i < whole.length; i += 331) out.push(...b.push(whole.subarray(i, Math.min(whole.length, i + 331))));
  assert.deepEqual(types(out), types(a));
  const ua = a.find((o) => o.type === "utterance") as Extract<SegmenterOutput, { type: "utterance" }>;
  const ub = out.find((o) => o.type === "utterance") as Extract<SegmenterOutput, { type: "utterance" }>;
  assert.equal(ub.pcm.length, ua.pcm.length);
});

test("flush emits the in-progress utterance once and then the segmenter is idle", () => {
  const seg = new UtteranceSegmenter(opts);
  run(seg, speech(500));
  assert.equal(seg.isSpeaking, true);
  const flushed = seg.flush();
  assert.deepEqual(types(flushed), ["speech_stopped", "utterance"]);
  assert.equal((flushed.find((o) => o.type === "utterance") as { reason: string }).reason, "flush");
  assert.deepEqual(seg.flush(), []);
  const short = new UtteranceSegmenter(opts);
  run(short, speech(60));
  assert.deepEqual(types(short.flush()).filter((t) => t === "utterance"), []);
});

test("the segmenter validates its parameters", () => {
  assert.throws(() => new UtteranceSegmenter({ ...opts, silenceMs: 0 }), /silenceMs/);
  assert.throws(() => new UtteranceSegmenter({ ...opts, threshold: 2 }), /threshold/);
});
