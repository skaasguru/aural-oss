import { isAbortError } from "@/lib/abort-error";
import { createLogger } from "@/lib/logger";
import { NextResponse } from "next/server";
import { SpeechConfigError } from "../../../../../server/speech/config";
import { createTtsBackendFromEnv } from "../../../../../server/speech/tts/registry";
import type { TtsFileFormat } from "../../../../../server/speech/tts/types";

const log = createLogger("api/voice/tts-s2s");

function resolveClientFormat(req: Request): TtsFileFormat {
  const url = new URL(req.url);
  const queryFormat = url.searchParams.get("format")?.toLowerCase();
  const format = req.headers.get("x-aural-tts-format")?.toLowerCase();
  const accept = req.headers.get("accept")?.toLowerCase() || "";

  /** Raw float32 LE — only for callers that decode PCM manually (not HTMLAudioElement). */
  if (queryFormat === "pcm_f32le" || format === "pcm_f32le") return "pcm_f32le";

  if (queryFormat === "mp3" || format === "mp3" || accept.includes("audio/mpeg")) return "mp3";

  // Default WAV so HTMLAudioElement / browser playback always receives a decodeable container.
  // Defaulting to pcm_f32le caused garbage noise when any client omitted format hints (e.g. first load / dev).
  return "wav";
}

function toArrayBuffer(input: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(input.byteLength);
  new Uint8Array(out).set(input);
  return out;
}

/**
 * POST /api/voice/tts-s2s
 *
 * Mic-test and coach synthesis through the configured TTS backend (VOICE_TTS_PROVIDER). Returns
 * WAV by default (browser-safe). Use `?format=pcm_f32le` only if the client decodes raw PCM itself.
 * The response headers state the container that was actually produced.
 */
export async function POST(req: Request) {
  let body: { text?: unknown; language?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const rawText = typeof body.text === "string" ? body.text.trim() : "";
  const language = typeof body.language === "string" ? body.language : undefined;

  if (!rawText) {
    return NextResponse.json({ error: "Missing text" }, { status: 400 });
  }

  let backend;
  try {
    backend = createTtsBackendFromEnv(process.env);
  } catch (err) {
    if (err instanceof SpeechConfigError) {
      // Problems name variables only, never values.
      log.error(err.message);
      return NextResponse.json(
        { error: err.provider === "doubao" ? "Doubao TTS credentials not configured" : err.message },
        { status: 503 },
      );
    }
    throw err;
  }

  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort(), { once: true });

  try {
    const clientFormat = resolveClientFormat(req);
    const startedAt = Date.now();
    const result = await backend.synthesizeFile({ text: rawText, language, signal: abort.signal }, clientFormat);

    if (abort.signal.aborted) return new Response(null, { status: 499 });
    if (!result) {
      log.warn(`TTS (${backend.id}) returned no audio (${rawText.length} chars in)`);
      return NextResponse.json({ error: "TTS returned no audio", fallback: "browser" }, { status: 502 });
    }

    log.info(
      `TTS ${backend.id} synthesized ${result.format}: response=${result.audio.byteLength}B, ${Date.now() - startedAt}ms`,
    );

    return new Response(toArrayBuffer(result.audio), {
      status: 200,
      headers: {
        "Content-Type": result.contentType,
        "Cache-Control": "no-store",
        "X-Aural-TTS-Format": result.format,
        "X-Aural-TTS-Provider": backend.id === "doubao" ? "seed-tts-2.0" : backend.id,
      },
    });
  } catch (err) {
    if (abort.signal.aborted || isAbortError(err)) {
      return new Response(null, { status: 499 });
    }
    // Backend messages are credential-free by construction (see openai-compatible.ts).
    const message = err instanceof Error ? err.message : String(err);
    log.error(`TTS (${backend.id}) synthesis failed:`, message);
    return NextResponse.json({ error: "TTS synthesis failed" }, { status: 502 });
  }
}
