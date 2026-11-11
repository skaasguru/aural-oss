/**
 * Adapter that exposes the existing socket-centric native-streaming ASR connections
 * (Seed / Qwen / Qwen Audio) through the typed SttSession contract. Protocol handling stays in
 * streaming-asr.ts; this layer only translates sockets into normalized events, it does not
 * pretend anything else is a socket.
 */
import type { AsrResponse } from "../../volcengine-asr";
import type { SttCapabilities, SttEvent, SttSession } from "./types";

export interface LegacyAsrConnection {
  readonly readyState: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeAllListeners(): unknown;
  sendAudio(audio: Buffer): void;
  finish(): void;
  close(): void;
  parseMessage(data: Buffer): AsrResponse | null;
}

const WS_OPEN = 1;

export function adaptLegacyAsr(conn: LegacyAsrConnection, info: { id: string; replaceTranscript: boolean }): SttSession {
  const capabilities: SttCapabilities = {
    id: info.id, mode: "native-streaming", partials: true, speechEvents: false, replaceTranscript: info.replaceTranscript,
  };
  let listener: ((event: SttEvent) => void) | null = null;
  let bound = false;

  const emit = (event: SttEvent) => listener?.(event);

  function bind() {
    if (bound) return;
    bound = true;
    conn.on("message", (data: Buffer) => {
      if (!listener) return;
      let response: AsrResponse | null;
      try {
        response = conn.parseMessage(Buffer.from(data));
      } catch (error) {
        emit({ type: "error", code: -1, message: `ASR parse error: ${error instanceof Error ? error.message : "invalid message"}`, fatal: false });
        return;
      }
      if (!response) return;
      if (response.errorCode != null) {
        emit({ type: "error", code: response.errorCode, message: response.errorMessage || "ASR error", fatal: true });
        return;
      }
      emit({ type: "transcript", response });
    });
    conn.on("error", (error: Error) => emit({ type: "error", code: -1, message: error.message, fatal: false }));
    conn.on("close", (code: number, reason: Buffer | string) => emit({ type: "closed", code, reason: reason?.toString() || "" }));
  }

  return {
    capabilities,
    get isOpen() { return conn.readyState === WS_OPEN; },
    setListener(next) { listener = next; bind(); },
    removeAllListeners() { listener = null; bound = false; conn.removeAllListeners(); },
    sendAudio: (pcm) => conn.sendAudio(pcm),
    finish: () => conn.finish(),
    close: () => conn.close(),
    hasPendingWork: () => false,
  };
}
