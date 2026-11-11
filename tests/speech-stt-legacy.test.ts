import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { adaptLegacyAsr, type LegacyAsrConnection } from "../server/speech/stt/legacy";
import { createSttProvider } from "../server/speech/stt/registry";
import { resolveSttConfig } from "../server/speech/config";
import type { SttEvent } from "../server/speech/stt/types";

class FakeConn extends EventEmitter implements LegacyAsrConnection {
  readyState = 1;
  sent: Buffer[] = [];
  finished = 0;
  closed = 0;
  sendAudio(b: Buffer) { this.sent.push(b); }
  finish() { this.finished++; }
  close() { this.closed++; this.readyState = 3; }
  parseMessage(data: Buffer) {
    const packet = JSON.parse(data.toString());
    if (packet.boom) throw new Error("unparseable");
    return packet.ignore ? null : packet;
  }
}

test("legacy adapter normalizes native-streaming results into typed events and forwards control calls", () => {
  const conn = new FakeConn();
  const session = adaptLegacyAsr(conn, { id: "qwen-audio", replaceTranscript: true });
  const events: SttEvent[] = [];
  session.setListener((e) => events.push(e));
  assert.equal(session.capabilities.mode, "native-streaming");
  assert.equal(session.capabilities.partials, true);
  assert.equal(session.capabilities.replaceTranscript, true);
  assert.equal(session.isOpen, true);

  conn.emit("message", Buffer.from(JSON.stringify({ text: "hel", utterances: [{ text: "hel", definite: false }] })));
  conn.emit("message", Buffer.from(JSON.stringify({ ignore: true })));
  conn.emit("message", Buffer.from(JSON.stringify({ errorCode: 45, errorMessage: "quota" })));
  conn.emit("message", Buffer.from(JSON.stringify({ boom: true })));
  conn.emit("error", new Error("socket reset"));
  conn.emit("close", 1006, Buffer.from("gone"));

  assert.deepEqual(events.map((e) => e.type), ["transcript", "error", "error", "error", "closed"]);
  const errors = events.filter((e) => e.type === "error") as Extract<SttEvent, { type: "error" }>[];
  assert.deepEqual(errors.map((e) => e.fatal), [true, false, false], "provider error packets are fatal, parse/socket errors are not");
  assert.deepEqual(events.at(-1), { type: "closed", code: 1006, reason: "gone" });

  session.sendAudio(Buffer.alloc(4)); session.finish(); session.close();
  assert.equal(conn.sent.length, 1);
  assert.equal(conn.finished, 1);
  assert.equal(conn.closed, 1);
  assert.equal(session.hasPendingWork(), false);
});

test("removeAllListeners detaches the connection so stale events are dropped", () => {
  const conn = new FakeConn();
  const session = adaptLegacyAsr(conn, { id: "seed", replaceTranscript: false });
  const events: SttEvent[] = [];
  session.setListener((e) => events.push(e));
  session.removeAllListeners();
  conn.emit("message", Buffer.from(JSON.stringify({ text: "late", utterances: [] })));
  assert.deepEqual(events, []);
  assert.equal(conn.listenerCount("message"), 0);
});

test("the registry opens legacy providers through the injected connector with unchanged options", async () => {
  const conn = new FakeConn();
  let seen: unknown;
  const provider = createSttProvider(resolveSttConfig({ VOICE_ASR_PROVIDER: "qwen-audio", QWEN_ASR_API_KEY: "k" }), {
    connectLegacy: async (options) => { seen = options; return conn; },
  });
  assert.equal(provider.capabilities.mode, "native-streaming");
  const session = await provider.open({ requestId: "abc", language: "en-US", legacyConfig: { language: "en-US", endWindowSize: 800 } });
  assert.equal(session.isOpen, true);
  assert.deepEqual({ ...(seen as object), apiKey: "[hidden]" }, { provider: "qwen-audio", apiKey: "[hidden]", appId: "", accessToken: "", resourceId: "volc.seedasr.sauc.duration", requestId: "abc", config: { language: "en-US", endWindowSize: 800 }, noiseThreshold: 0.1 });
});
