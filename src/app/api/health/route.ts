import { NextResponse } from "next/server";
import { SpeechConfigError, resolveSttConfig } from "../../../../server/speech/config";
import { createSttProvider } from "../../../../server/speech/stt/registry";
import { createTtsBackendFromEnv } from "../../../../server/speech/tts/registry";

// Probes must reflect the live environment, never a build-time snapshot.
export const dynamic = "force-dynamic";

type Described = Record<string, unknown>;

function describe(build: () => Described): Described {
  try {
    return { configured: true, ...build() };
  } catch (error) {
    // Config errors list variable names only, never values.
    if (error instanceof SpeechConfigError) return { configured: false, problems: error.problems };
    return { configured: false, problems: ["unexpected configuration error"] };
  }
}

/**
 * GET /api/health: liveness plus the active speech providers. Credentials, base URLs and
 * hostnames are never included. Speech being unconfigured does not fail the probe (a
 * text-only deployment is valid); the voice relay refuses to start instead.
 */
export async function GET() {
  const stt = describe(() => createSttProvider(resolveSttConfig(process.env), {
    connectLegacy: async () => { throw new Error("health probes never open provider connections"); },
  }).describe());
  const tts = describe(() => createTtsBackendFromEnv(process.env).describe());
  return NextResponse.json({ status: "ok", service: "web", speech: { stt, tts } }, { headers: { "Cache-Control": "no-store" } });
}
