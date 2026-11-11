# Provider-agnostic speech

Aural owns the browser WebSocket protocol, interview state, mic tests, practice capture, turn
detection, cancellation, playback acknowledgement and reconnection. STT and TTS providers sit
behind thin typed contracts in `server/speech/` and are selected independently with server-side
variables (never `NEXT_PUBLIC_`).

## Selecting providers

| Setting | Values | Default |
|---|---|---|
| `VOICE_ASR_PROVIDER` | `seed`, `qwen`, `qwen-audio`, `openai-compatible` | `seed` |
| `VOICE_TTS_PROVIDER` | `doubao`, `openai-compatible` | `doubao` |

No aliases and no fallback: an unknown value, or a missing required variable, stops the relay at
startup (exit 1) and the TTS route answers 503. Messages name variables, never values. Doubao
credentials are only required when a Doubao provider is selected.

## STT: `openai-compatible` (utterance-buffered)

`POST {VOICE_STT_BASE_URL}/audio/transcriptions`, multipart: `file` (real 16 kHz mono WAV),
`model`, `language` (derived from the interview language, or `VOICE_STT_LANGUAGE`), optional
`prompt`, `response_format=json`, `temperature=0`. The base URL must include `/v1` where the
provider uses it (Groq: `https://api.groq.com/openai/v1`; Bifrost: `http://host:8080/v1`); `/v1`
is never doubled. With Bifrost the model may carry the provider prefix.

This is **not** native streaming. Aural segments speech locally (energy VAD), uploads one WAV per
utterance and gets one final transcript back. Capability flags say `partials: false`, so there are
no live captions in this mode. A pause shorter than `VOICE_STT_SILENCE_MS` stays in one utterance;
beyond that the relay additionally holds the pending reply while new speech or an upload is
outstanding (bounded to 25 s), and merges follow-up utterances into one turn.

Bounds: audio memory <= `VOICE_STT_MAX_UTTERANCE_MS` x (`VOICE_STT_MAX_QUEUE` + 1); requests are
sequential (ordered, never duplicated); retries (`VOICE_STT_MAX_RETRIES`) apply to 429/5xx/network
errors only. After `VOICE_STT_FAILURE_THRESHOLD` consecutive failed utterances the session ends and
new sessions are refused for `VOICE_STT_COOLDOWN_MS`, so the browser sees a disconnect instead of
silence. Closing a session aborts in-flight uploads; late completions are discarded.

Memory/size limits (all enforced locally, whatever the upstream sends):

| Setting | Default | Range | Meaning |
|---|---|---|---|
| `VOICE_STT_MAX_RESPONSE_BYTES` | 1048576 (1 MiB) | 1024 - 16 MiB | Response body is read as a stream and the connection is cancelled the moment this is exceeded (a declared oversized `Content-Length` is rejected without reading). Error bodies of failed requests are read with a fixed 4 KiB cap. |
| `VOICE_STT_MAX_TRANSCRIPT_SEGMENTS` | 200 | 1 - 10000 | Transcript segments accepted per STT session (one interview question / mic-test session). |
| `VOICE_STT_MAX_TRANSCRIPT_CHARS` | 20000 | 100 - 1000000 | Cumulative transcript characters per STT session. A segment that would exceed it is dropped whole, never truncated. |

Exceeding a response limit counts as a provider failure (toward `VOICE_STT_FAILURE_THRESHOLD`).
Exceeding a transcript limit is a local, non-fatal error: the speech is not captured, nothing is
appended, and the user is told. Setting names appear only in server logs, never in the browser.

### What the browser is told

Every non-fatal STT failure (failed upload, timeout, bad response, backlog drop, transcript limit)
sends the browser `{"type":"error","code":"stt_...","recoverable":true,"message":"..."}` with a
fixed, sanitized sentence asking the user to repeat the answer (provider text, URLs and settings
are never forwarded). No reply is generated for the lost utterance, and the session continues.
Only after `VOICE_STT_FAILURE_THRESHOLD` consecutive failures does the relay send
`recoverable:false` and disconnect. The web client shows recoverable errors as a banner/toast
without clearing pending turns; the onboarding mic test keeps listening. Seed/Qwen keep their
transparent reconnect behavior and are not announced. Messages deliberately avoid words the client
treats as connection-failover errors, so they are not swallowed.

## TTS: `openai-compatible`

`POST {VOICE_TTS_BASE_URL}/audio/speech` with `{model, voice, input, response_format}`. Works with
local Kokoro-FastAPI, OpenAI, Groq, or Bifrost. Voice per language: `VOICE_TTS_VOICE_EN` /
`VOICE_TTS_VOICE_ZH`, falling back to `VOICE_TTS_VOICE`. Responses are decoded to the browser
format (**mono 24 kHz s16le**; `use-voice.ts` reads binary frames as Int16Array), resampling WAV or
raw PCM as needed. Compressed formats (`mp3`, `opus`, `aac`, `flac`) are decoded with `ffmpeg`
(included in the Docker image); without it they fail with a clear error. Container bytes are never
forwarded as samples. Text longer than `VOICE_TTS_MAX_INPUT_CHARS` is split at sentence, clause,
word, then character boundaries and synthesized in order; a request needing more than
`VOICE_TTS_MAX_SEGMENTS` fails rather than truncating.

Memory limits: `VOICE_TTS_MAX_AUDIO_BYTES` (default 32 MiB) caps one provider response (streamed,
cancelled when exceeded); `VOICE_TTS_MAX_TOTAL_AUDIO_BYTES` (default 33554432 = 32 MiB, range
1024 - 512 MiB) caps the **total normalized 24 kHz s16le PCM across all segments** of one
synthesis, for both the relay and `synthesizeFile` (HTTP route). A segment that would cross it is
rejected before it is delivered or accumulated, in-flight prefetches are cancelled, and the error
names the setting (`~10 min` of audio fits in 32 MiB). ffmpeg output is capped at the remaining
budget. Error and non-audio bodies are read with a fixed 4 KiB cap.

The same backend serves the interview relay and `POST /api/voice/tts-s2s`. That route returns WAV
(or `pcm_f32le` when asked) and labels the real format in `X-Aural-TTS-Format`; it cannot produce
MP3 from these providers, so an `?format=mp3` request receives `audio/wav`.

## Text LLMs

`LLM_CHAT_MODEL`, `LLM_GENERATOR_MODEL`, `LLM_REPORT_MODEL` override the built-in model ids. Point
`OPENAI_BASE_URL` at a compatible gateway and use its model ids. `RELAY_LLM_*` already configures
the relay's reply model.

## Samples, health, deployment

- `docs/examples/speech-groq-kokoro.env`, `docs/examples/speech-bifrost.env` (placeholders only).
- `GET /api/health` (web) and `GET /health` (relay, same port as the WebSocket) report the active
  providers without credentials or URLs.
- `Dockerfile` + `docker-compose.speech.example.yml`: two targets, `web` (Next.js standalone
  server, `node web-entrypoint.mjs`) and `relay` (`node --import tsx server/voice-relay.ts`, Alpine,
  with ffmpeg), plus an optional Kokoro service (`--profile kokoro`). The relay image contains only
  the packages the relay really imports (`scripts/relay-runtime.mjs check` fails the build if that
  set grows); `tsx` and `npm run start:voice` still work in it.
- `NEXT_PUBLIC_*` are build args compiled into the browser bundle. The web container records them
  and refuses to start if its runtime `NEXT_PUBLIC_*` differ (override: `AURAL_ALLOW_PUBLIC_ENV_MISMATCH=1`).
  Provider keys are never build args or image content; pass them at run time.
- Real-ffmpeg check: `npm run test:speech:ffmpeg` (needs `ffmpeg` on PATH; otherwise the test is
  skipped with a visible reason, or fails when `AURAL_REQUIRE_FFMPEG=1`).

## Barge-in with buffered STT

During TTS playback, speech is detected by the local VAD but the relay acts on the *transcript*:
a user interruption is recognized only after that utterance ends and its upload is transcribed
(roughly silence window + provider latency), not the instant they start talking. This is
deliberate: the local VAD is an energy gate and cannot tell the user's voice from the interviewer's
own audio leaking from speakers, so cancelling playback on `speech_started` would risk the AI
interrupting itself. Native streaming providers (Seed/Qwen) keep their faster partial-based
barge-in. Headphones, the browser's echo cancellation and a higher `VOICE_STT_VAD_THRESHOLD` help.

## Scope

The backup Azure relay (`server/openai-voice-relay.ts`) is unchanged and does not use these
providers.
