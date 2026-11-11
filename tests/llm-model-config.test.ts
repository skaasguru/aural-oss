import assert from "node:assert/strict";
import test from "node:test";
import { resolveChatModelOverride, resolveFallbackGeneratorModel, resolveGeneratorModel, resolveReportModel } from "../src/lib/ai/model-config";
import { getGeneratorModelChain } from "../src/lib/ai/generator-run";
import { getProvider } from "../src/lib/ai/registry";

test("model defaults are unchanged when no override is set", () => {
  assert.equal(resolveReportModel({ OPENAI_API_KEY: "k" }), "gpt-4o");
  assert.equal(resolveReportModel({ GEMINI_API_KEY: "k" }), "gemini-3.1-flash-lite");
  assert.equal(resolveReportModel({ KIMI_API_KEY: "k" }), "kimi-k2.6");
  assert.equal(resolveReportModel({ MINIMAX_API_KEY: "k" }), "MiniMax-M2.1-lightning");
  assert.equal(resolveGeneratorModel({ OPENAI_API_KEY: "k" }), "gpt-4o-mini");
  assert.equal(resolveGeneratorModel({ KIMI_API_KEY: "k" }), "moonshot-v1-8k");
  assert.equal(resolveFallbackGeneratorModel({ OPENAI_API_KEY: "k", MINIMAX_API_KEY: "k" }), "MiniMax-M2.1-lightning");
  assert.equal(resolveChatModelOverride({}), undefined);
});

test("LLM_*_MODEL overrides let any OpenAI-compatible model id drive chat, generation and reports", () => {
  const env = { OPENAI_API_KEY: "k", LLM_REPORT_MODEL: " llama-3.3-70b-versatile ", LLM_GENERATOR_MODEL: "groq/openai/gpt-oss-20b", LLM_CHAT_MODEL: "qwen3:8b" };
  assert.equal(resolveReportModel(env), "llama-3.3-70b-versatile");
  assert.equal(resolveGeneratorModel(env), "groq/openai/gpt-oss-20b");
  assert.equal(resolveChatModelOverride(env), "qwen3:8b");
  assert.equal(resolveReportModel({ OPENAI_API_KEY: "k", LLM_REPORT_MODEL: "   " }), "gpt-4o");
});

test("the generator chain starts with the override and keeps configured fallbacks without duplicates", () => {
  const saved = { ...process.env };
  try {
    for (const k of ["OPENAI_API_KEY", "GEMINI_API_KEY", "KIMI_API_KEY", "MINIMAX_API_KEY", "LLM_GENERATOR_MODEL"]) delete process.env[k];
    process.env.OPENAI_API_KEY = "k";
    process.env.GEMINI_API_KEY = "k";
    process.env.LLM_GENERATOR_MODEL = "my-local-model";
    assert.deepEqual(getGeneratorModelChain(), ["my-local-model", "gemini-3.1-flash-lite"]);
    process.env.LLM_GENERATOR_MODEL = "gemini-3.1-flash-lite";
    assert.deepEqual(getGeneratorModelChain(), ["gemini-3.1-flash-lite"]);
  } finally {
    for (const k of ["OPENAI_API_KEY", "GEMINI_API_KEY", "KIMI_API_KEY", "MINIMAX_API_KEY", "LLM_GENERATOR_MODEL"]) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});

test("an unknown model id resolves to the configured OpenAI-compatible provider rather than failing", () => {
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "k";
  try { assert.equal(getProvider("llama-3.3-70b-versatile").id, "openai"); } finally { if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved; }
});
