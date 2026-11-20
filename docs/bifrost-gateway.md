# Gateway-only AI: Claude + AssemblyAI through Bifrost

Aural dev sends every model, speech-to-text and text-to-speech request to the shared Bifrost
gateway on VIP dev. Aural holds one credential, its Bifrost virtual key; provider keys live only in
Bifrost. The gateway is the single place to observe requests, latency and cost.

| Purpose | Aural setting | Bifrost route | Upstream |
|---|---|---|---|
| Interactive replies, question generation, chat | `anthropic/claude-haiku-4-5` | provider `anthropic`, `/v1/chat/completions` | Claude API |
| Reports and feedback | `anthropic/claude-sonnet-4-5` | provider `anthropic` | Claude API |
| Text-to-speech | `assemblyai/assemblyai-tts-en`, voice `aai-kyla`, `pcm` | custom provider `assemblyai` (OpenAI base), `/v1/audio/speech` | `tts.us.assemblyai.com/v1/openai/audio/speech` |
| Speech-to-text | `VOICE_ASR_PROVIDER=assemblyai`, `universal-3-6-pro` | relay `assemblyai-stt`, `/relay/assemblyai-stt/v1/transcribe` | `sync.assemblyai.com/v1/transcribe` |

Model ids are compose defaults in `deploy/vip-dev/compose.app.yaml`; override with
`AURAL_LLM_FAST_MODEL`, `AURAL_LLM_REPORT_MODEL`, `AURAL_TTS_MODEL`, `AURAL_TTS_VOICE` or
`AURAL_STT_MODEL` in the protected `.env`.

## Why speech-to-text is a relay

AssemblyAI has an OpenAI-compatible route for speech synthesis but not for transcription, and
Bifrost has no native AssemblyAI provider. Its Sync API (one multipart request per finished
utterance) is therefore registered as a Bifrost relay, which forwards plain HTTP unchanged with the
stored AssemblyAI key and records each call in Relay Logs, priced from `audio_duration_ms`.

Consequences:

- Transcription is utterance-buffered: Aural detects the end of speech locally and uploads that
  utterance. There are no live partial transcripts, and an interruption is recognized after the
  utterance is transcribed.
- AssemblyAI's live WebSocket transcription cannot pass through Bifrost: relays are HTTP-only and
  Bifrost's realtime endpoint serves other providers. Using it would mean a direct connection that
  bypasses the gateway.
- Speech synthesis is requested per text segment and delivered when the segment is complete.
  Bifrost can stream it (`stream_format: "sse"`); Aural's adapter does not consume that stream yet.

## Bifrost configuration

`deploy/vip-dev/bifrost-seed.json` is the VM's `/srv/dev/apps/vip/bifrost-seed.json`. It contains
references only (`env.NAME`); values live in `/srv/dev/apps/vip/.env` (mode 0600):

- `ANTHROPIC_API_KEY`, `ASSEMBLYAI_API_KEY`: provider keys. The AssemblyAI key serves both the
  provider (speech synthesis) and the relay (transcription).
- `AURAL_BIFROST_VK`, `VIP_BIFROST_VK`: one virtual key per application. `aural-dev` may use
  `anthropic`, `assemblyai`, `groq` and the relay; `vip-dev` may use `openrouter`, `groq`, `gemini`.
- `BIFROST_ADMIN_USERNAME`, `BIFROST_ADMIN_PASSWORD`: dashboard and management API login, also
  written to `/srv/dev/secrets/bifrost-admin.txt`.

Bifrost is pinned to `maximhq/bifrost:v2.6.0`. From 2.6 the management API is locked until an admin
exists, and with `enforce_auth_on_inference` every inference or relay call needs a virtual key, so
the image, seed, credentials and callers were changed together by `upgrade-bifrost.py`. It keeps a
rollback: `/srv/dev/apps/vip/backups/bifrost-pre-v2.6.0-*` (SQLite backups, compose, seed, env) and
the image tag `maximhq/bifrost:rollback-pre-v2.6.0`.

The seed runs in Bifrost's default split mode: dashboard edits persist until the matching entry in
the seed file changes, at which point the file wins for that entry on the next start.

## Switching Aural over

`cutover-assemblyai.py` (run on the VM from `/srv/dev/apps/aural`) changes nothing unless a real
round trip passes with Aural's virtual key: Claude chat on both models, AssemblyAI speech
synthesis, then transcription of that synthesized audio through the relay with at least 80% of the
spoken words recovered. It then removes the transitional overrides from `.env`, recreates web and
relay on the compose defaults and stops the former self-hosted Kokoro container.
`--probe-only` runs the checks without switching.

Until the provider keys exist, `.env` pins the previous working selection through the same
gateway and virtual key: Groq Whisper, Groq text generation, and the private Kokoro container.
