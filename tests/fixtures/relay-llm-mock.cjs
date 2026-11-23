/* eslint-disable @typescript-eslint/no-require-imports -- Node's --require preloads this isolated CommonJS fixture. */
// Replaces only the relay's text LLM so end-to-end speech tests exercise the real STT and TTS
// adapters, real HTTP, and the real relay turn logic without any provider credentials.
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function(request, parent) {
  if (parent?.filename.endsWith('/server/voice-relay.ts') && request === './relay-llm') {
    return {
      logRelayLlmStartup() {},
      callRelayLLM: async () => 'Thanks. Could you explain how you tested the architecture?',
      callInterviewTurnLLM: async () => 'Thanks. Could you explain how you tested the architecture?',
      INTERVIEW_TURN_MAX_TOKENS: 512,
    };
  }
  return originalLoad.apply(this, arguments);
};
