/**
 * Browser-facing wording for STT failures. Provider text, URLs, header values and setting names
 * stay in server logs; the browser only ever sees these fixed, actionable sentences.
 *
 * Wording avoids the substrings the client treats as "connection failover" errors
 * (see isRecoverableRelayErrorMessage), so a recoverable notice is never silently swallowed.
 */
import type { SttEvent } from "./types";

export interface BrowserSttError {
  /** Wire code: `stt_...`. */
  code: string;
  message: string;
  /** True when the session continues and the user can simply try again. */
  recoverable: boolean;
}

export function describeSttErrorForBrowser(event: Extract<SttEvent, { type: "error" }>): BrowserSttError {
  if (event.fatal) {
    return { code: "stt_unavailable", recoverable: false, message: "Speech recognition is unavailable right now. Please try again in a moment." };
  }
  switch (event.code) {
    case -4:
      return { code: "stt_backlog_dropped", recoverable: true, message: "Speech recognition fell behind and dropped part of your answer. Please repeat your last answer." };
    case -5:
      return { code: "stt_transcript_limit", recoverable: true, message: "Your answer reached the transcript length limit, so the latest part was not captured. Please continue in your next turn." };
    case -2:
      return { code: "stt_slow", recoverable: true, message: "Speech recognition took too long to answer for your last response. Please repeat it." };
    case -3:
    case -6:
      return { code: "stt_bad_result", recoverable: true, message: "Speech recognition returned an unusable result for your last response. Please repeat it." };
    default:
      return { code: "stt_utterance_failed", recoverable: true, message: "Speech recognition could not process your last response. Please repeat it." };
  }
}

/** JSON frame for the browser WebSocket. */
export function sttErrorFrame(event: Extract<SttEvent, { type: "error" }>): string {
  const { code, message, recoverable } = describeSttErrorForBrowser(event);
  return JSON.stringify({ type: "error", code, message, recoverable });
}
