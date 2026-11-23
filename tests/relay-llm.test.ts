import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import * as relayLlm from "../server/relay-llm";

async function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void | Promise<void>,
): Promise<void> {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    prev[key] = process.env[key];
    const v = vars[key];
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  }
  relayLlm.resetRelayLlmCacheForTests();
  try {
    await fn();
  } finally {
    for (const key of Object.keys(vars)) {
      const v = prev[key];
      if (v === undefined) delete process.env[key];
      else process.env[key] = v;
    }
    relayLlm.resetRelayLlmCacheForTests();
  }
}

afterEach(() => {
  relayLlm.resetRelayLlmCacheForTests();
});

test("default primary is gemini-3.1-flash-lite with abab6.5s-chat fallback when MiniMax key set", () => {
  return withEnv(
    {
      RELAY_LLM_MODEL: undefined,
      GEMINI_API_KEY: "g-test",
      MINIMAX_API_KEY: "m-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    },
    () => {
      assert.equal(relayLlm.getRelayLlmModel(), "gemini-3.1-flash-lite");
      assert.equal(relayLlm.getRelayLlmFallbackModel(), "abab6.5s-chat");
    },
  );
});

test("no fallback when primary is already abab6.5s-chat on MiniMax", () => {
  return withEnv(
    {
      RELAY_LLM_MODEL: "abab6.5s-chat",
      RELAY_LLM_API_KEY: "m-test",
      RELAY_LLM_BASE_URL: "https://api.minimaxi.com/v1",
      RELAY_LLM_PROVIDER: "openai",
      MINIMAX_API_KEY: "m-test",
    },
    () => {
      assert.equal(relayLlm.getRelayLlmFallbackModel(), null);
    },
  );
});

test("no fallback without MINIMAX_API_KEY", () => {
  return withEnv(
    {
      GEMINI_API_KEY: "g-test",
      MINIMAX_API_KEY: undefined,
    },
    () => {
      assert.equal(relayLlm.getRelayLlmFallbackModel(), null);
    },
  );
});

for (const model of ["anthropic/claude-haiku-5-5", "groq/llama-3.3-70b-versatile"]) {
  test(`voice interview request settings for ${model}`, async (t) => {
    const bodies: Array<Record<string, unknown>> = [];
    t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Response.json({ choices: [{ message: { content: "How did you measure the improvement?" } }] });
    });

    await withEnv({
      RELAY_LLM_PROVIDER: "openai",
      RELAY_LLM_MODEL: model,
      RELAY_LLM_API_KEY: "relay-test",
      RELAY_LLM_BASE_URL: "https://gateway.example/v1",
      MINIMAX_API_KEY: undefined,
    }, async () => {
      assert.equal(await relayLlm.callInterviewTurnLLM("Interview prompt"), "How did you measure the improvement?");
      await relayLlm.callRelayLLM("Summarize the previous answer");
    });

    assert.equal(bodies[0]?.max_tokens, 512);
    assert.deepEqual(bodies[0]?.reasoning, model.startsWith("anthropic/") ? { effort: "none" } : undefined);
    assert.equal(bodies[1]?.max_tokens, 150);
    assert.equal(bodies[1]?.reasoning, undefined);
  });
}
