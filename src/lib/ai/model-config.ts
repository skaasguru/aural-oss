/**
 * Text-LLM model selection. Defaults are unchanged; each role can be pointed at any model id
 * served by the configured provider (for example an OpenAI-compatible gateway via
 * OPENAI_BASE_URL) with a server-side variable:
 *
 *   LLM_CHAT_MODEL       live chat interviewing, when the interview does not pick a model
 *   LLM_GENERATOR_MODEL  interview generation, refinement and practice coaching
 *   LLM_REPORT_MODEL     post-interview reports, summaries and feedback
 */
type Env = Record<string, string | undefined>;

const clean = (value: string | undefined) => value?.trim() || undefined;

export function resolveReportModel(env: Env = process.env): string {
  return clean(env.LLM_REPORT_MODEL)
    ?? (env.OPENAI_API_KEY ? "gpt-4o"
      : env.GEMINI_API_KEY ? "gemini-3.1-flash-lite"
        : env.KIMI_API_KEY ? "kimi-k2.6"
          : "MiniMax-M2.1-lightning");
}

export function resolveGeneratorModel(env: Env = process.env): string {
  return clean(env.LLM_GENERATOR_MODEL)
    ?? (env.OPENAI_API_KEY ? "gpt-4o-mini"
      : env.GEMINI_API_KEY ? "gemini-3.1-flash-lite"
        : env.KIMI_API_KEY ? "moonshot-v1-8k"
          : "MiniMax-M2.1-lightning");
}

export function resolveFallbackGeneratorModel(env: Env = process.env): string {
  return env.MINIMAX_API_KEY ? "MiniMax-M2.1-lightning"
    : env.KIMI_API_KEY ? "moonshot-v1-8k"
      : resolveGeneratorModel(env);
}

/** Model for chat interviewing when `interview.llmModel` is unset; undefined = provider default. */
export function resolveChatModelOverride(env: Env = process.env): string | undefined {
  return clean(env.LLM_CHAT_MODEL);
}

/** Explicit generator override, if any (placed first in the generator chain). */
export function resolveGeneratorModelOverride(env: Env = process.env): string | undefined {
  return clean(env.LLM_GENERATOR_MODEL);
}
