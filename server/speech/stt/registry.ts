import type { SttConfig } from "../config";
import type { StreamingAsrOptions } from "../../streaming-asr";
import { adaptLegacyAsr, type LegacyAsrConnection } from "./legacy";
import { createOpenAiCompatibleSttProvider } from "./openai-compatible";
import type { SttCapabilities, SttOpenParams, SttProvider, SttSession } from "./types";

export interface SttDeps {
  /** Connector for the native-streaming providers (injected so the relay owns the socket module). */
  connectLegacy(options: StreamingAsrOptions): Promise<LegacyAsrConnection>;
}

/** Build exactly the provider the configuration names; there is no implicit fallback. */
export function createSttProvider(config: SttConfig, deps: SttDeps): SttProvider {
  if (config.provider === "openai-compatible") return createOpenAiCompatibleSttProvider(config);

  const capabilities: SttCapabilities = {
    id: config.provider, mode: "native-streaming", partials: true, speechEvents: false, replaceTranscript: config.provider !== "seed",
  };
  return {
    capabilities,
    async open(params: SttOpenParams): Promise<SttSession> {
      const connection = await deps.connectLegacy({
        provider: config.provider,
        apiKey: config.apiKey,
        appId: config.appId,
        accessToken: config.accessToken,
        resourceId: config.resourceId,
        requestId: params.requestId,
        config: params.legacyConfig ?? { language: params.language },
        noiseThreshold: config.noiseThreshold,
      });
      return adaptLegacyAsr(connection, { id: config.provider, replaceTranscript: capabilities.replaceTranscript });
    },
    describe: () => ({ provider: config.provider, mode: "native-streaming", partials: true, resource: config.provider === "seed" ? config.resourceId : "qwen" }),
  };
}
