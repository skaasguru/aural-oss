import { resolveTtsConfig, type Env, type TtsConfig } from "../config";
import { createDoubaoTtsBackend } from "./doubao";
import { createOpenAiCompatibleTtsBackend } from "./openai-compatible";
import type { TtsBackend } from "./types";

/** Build exactly the backend the configuration names; there is no implicit fallback. */
export function createTtsBackend(config: TtsConfig): TtsBackend {
  switch (config.provider) {
    case "doubao": return createDoubaoTtsBackend(config);
    case "openai-compatible": return createOpenAiCompatibleTtsBackend(config);
  }
}

export function createTtsBackendFromEnv(env: Env = process.env, options?: { requireDoubaoAppPair?: boolean }): TtsBackend {
  return createTtsBackend(resolveTtsConfig(env, options));
}
