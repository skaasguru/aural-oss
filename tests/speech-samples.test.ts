import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolveSttConfig, resolveTtsConfig } from "../server/speech/config";

function parseEnv(file: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
  return env;
}

test("sample speech configs resolve to the documented providers", () => {
  const groq = parseEnv("docs/examples/speech-groq-kokoro.env");
  const stt = resolveSttConfig(groq);
  const tts = resolveTtsConfig(groq, { requireDoubaoAppPair: true });
  assert.equal(stt.provider, "openai-compatible");
  assert.equal(tts.provider, "openai-compatible");
  if (stt.provider === "openai-compatible") assert.equal(stt.baseUrl, "https://api.groq.com/openai/v1");

  const bifrost = parseEnv("docs/examples/speech-bifrost.env");
  const bStt = resolveSttConfig(bifrost);
  const bTts = resolveTtsConfig(bifrost);
  if (bStt.provider === "openai-compatible") assert.equal(bStt.model, "groq/whisper-large-v3-turbo");
  if (bTts.provider === "openai-compatible") { assert.equal(bTts.maxInputChars, 200); assert.equal(bTts.format, "wav"); }
});

test("no sample or compose file exposes provider settings through NEXT_PUBLIC_ variables", () => {
  for (const file of ["docs/examples/speech-groq-kokoro.env", "docs/examples/speech-bifrost.env"]) {
    assert.ok(!/NEXT_PUBLIC_[A-Z_]*(KEY|TOKEN|SECRET|STT|TTS)/.test(readFileSync(file, "utf8")), file);
  }
});
