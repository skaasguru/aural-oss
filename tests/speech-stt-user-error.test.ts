import assert from "node:assert/strict";
import test from "node:test";
import { isRecoverableRelayErrorMessage } from "../src/lib/voice/relay-routing";
import { describeSttErrorForBrowser } from "../server/speech/stt/user-error";

const KEY = "gsk_SECRET_key_in_provider_text";

test("browser-facing STT errors never echo provider text and are actionable", () => {
  const cases = [
    { code: 500, message: `STT provider returned HTTP 500: Bearer ${KEY} http://10.0.0.5:8080/internal` },
    { code: -1, message: "STT request failed (ECONNREFUSED)" },
    { code: -2, message: "STT request timed out after 20000ms" },
    { code: -3, message: "STT provider returned an invalid (non-JSON) response" },
    { code: -4, message: "STT backlog full; dropped the oldest queued utterance" },
    { code: -5, message: "STT transcript length limit (20000 characters) reached VOICE_STT_MAX_TRANSCRIPT_CHARS" },
    { code: -6, message: "STT provider response exceeded 1048576 bytes VOICE_STT_MAX_RESPONSE_BYTES" },
  ];
  for (const c of cases) {
    const out = describeSttErrorForBrowser({ type: "error", code: c.code, message: c.message, fatal: false });
    assert.equal(out.recoverable, true, String(c.code));
    assert.match(out.message, /repeat|continue|again/i, `actionable: ${out.message}`);
    assert.ok(!out.message.includes(KEY) && !/10\.0\.0\.5|VOICE_STT|ECONN|Bearer/.test(out.message), out.message);
    // Must not be swallowed by the client's connection-failover heuristics.
    assert.equal(isRecoverableRelayErrorMessage(out.message), false, out.message);
    assert.match(out.code, /^stt_[a-z_]+$/);
  }
  const fatal = describeSttErrorForBrowser({ type: "error", code: 500, message: "x", fatal: true });
  assert.equal(fatal.recoverable, false);
  assert.equal(isRecoverableRelayErrorMessage(fatal.message), false, fatal.message);
});
