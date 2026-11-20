# Speech adapter verification

Scope: independently selectable STT and TTS for the primary voice relay, interviews, microphone
checks and practice/coaching, with direct or Bifrost OpenAI-compatible endpoints and preserved
legacy Seed/Qwen/Doubao adapters. The Azure backup relay remains separate.

## Supervisor-run checks

All Node builds/tests were executed in Docker, independently of Kiro's reported results.

| Check | Actual result |
| --- | --- |
| `npm run test:web` in `node:22-bookworm` | 509 tests: 505 passed, 4 real-ffmpeg tests skipped because that test image lacks ffmpeg, zero failures |
| `tests/speech-ffmpeg-real.test.ts` in a Docker image with ffmpeg | All 4 passed: real MP3 -> PCM duration/pitch, rejection of non-audio, output cap, HTTP TTS backend round-trip through real ffmpeg |
| `npx tsc --noEmit` | Passed |
| `npm run lint` | Zero errors; four existing Next.js navigation warnings in account/register/sidebar |
| `npm run build` | Passed using explicitly inert Supabase build-time placeholders, not live credentials |
| Browser functional suite, upstream `6f85feea999cff2b123366b1b85e634a7366037f` | 16/17 passed |
| Browser functional suite, adapter code | 16/17 passed; identical failing test and assertion as upstream |
| Secret-shaped source scan | No live GitHub/Groq/OpenAI token or private-key patterns found; only `.env.example` is eligible for tracking |
| Compose configuration + Supabase gateway Caddy validation | Passed |

The browser failure is `live captions stay visible while drafts pulse across pending and resumed
speech`, at `tests/functional.test.ts:416`. It was reproduced on an immutable archive of upstream
and on the changed code in separate source snapshots with the same Playwright Docker image.
This is a known baseline failure, not an all-green browser acceptance result.

A supervisor image smoke caught a missing ffmpeg binary in the standalone web image. Since the
HTTP coaching TTS route decodes compressed audio too, ffmpeg was added to that runtime, not only
the relay. `scripts/verify-speech-images.sh` is the committed readiness/non-root/ffmpeg regression
harness. Both rebuilt ARM64 images passed that harness: actual `/api/health` and relay `/health`
responses, ffmpeg availability and non-root runtime were checked, and the disposable containers
were removed. Both targets were subsequently built and booted on the actual AMD64 VIP dev
host at `d8a75bcb143b4837a1128c4c80d57148dbe52f5e`, and the same runtime harness passed.
The four real-ffmpeg tests also passed directly in that AMD64 relay image with no skips.
The first memory-capped Turbopack build exhausted its 1800 MiB cgroup; the successful build
used webpack, one worker and a 1024 MiB JavaScript heap, without stopping existing VIP services.
ARM64 images were not deployed.

## Real infrastructure / provider boundary

- A dedicated local Supabase stack passed fresh startup, all five application migrations and a
  repeated hash-verified migration run. The disposable smoke exercised actual signup/session,
  profile trigger, anonymous profile RLS, private object upload/authenticated download and cleanup.
  It does NOT establish complete production or cross-tenant authorization coverage.
- On the VIP development host, a real Groq Whisper transcription succeeded through its existing
  Bifrost. A real `groq/openai/gpt-oss-120b` text completion also succeeded.
- Groq Orpheus TTS returned `model_terms_required` at the last live check. Its organization admin
  must accept the terms; no acceptance was performed by an agent.
- Adapter transport tests use real loopback HTTP/WebSocket servers at provider boundaries.
  A live browser microphone interview through the new deployed stack has NOT been verified.

## Current voice acceptance

Kokoro was activated after the configured Gemini key returned HTTP 401. A strict public
Chromium test passed actual voice-relay initialization, audible PCM playback and playback
acknowledgement, successful HTTP WAV synthesis/decoding, login/dashboard and live AI generation.
The relay delivered 387720 bytes in nine played chunks; first audio took 22.857 seconds.
Full physical-microphone/human-interview acceptance remains unverified. Kokoro on CPU was
functional but slow (roughly 3-6 seconds of audio per 10-17 seconds) and has since been replaced
by the gateway selection in [Gateway-only AI](bifrost-gateway.md).

VIP API/agent are now intentionally paused with owner approval after verifying zero LiveKit
participants. Bifrost, databases and shared ingress remain running. The VIP HTTP 200 and
Orpheus 502 figures below describe the INITIAL deployment, not current service selection.

## Initial deployment state

Deployed on 2026-11-18 at **https://aural.dev.skaaslabs.com**, behind Basic authentication.
The owner authorized a 64 GiB root EBS volume; partition and ext4 growth succeeded online,
with approximately 41 GiB free after installation. No VIP application/container restart
was required. Existing VIP public health remained HTTP 200.

The actual remote Supabase stack passed all five migrations and disposable Auth/profile-RLS/
private Storage/cleanup checks. Public signup was then disabled. A real Chromium session
passed login, dashboard rendering (zero page errors), secure voice WebSocket handshake and
AI question generation through the deployed Aural API/Bifrost path (three actual generated
questions). The deployed HTTP TTS route returned 502, consistent with Groq's terms gate.
Readiness and a WebSocket handshake do NOT prove an audio conversation.

The versioned [deployment runbook](../deploy/vip-dev/README.md) and
[operations guide](../deploy/vip-dev/OPERATIONS.md) document protected access, immutable image
and source references, update/rollback boundaries and the remaining voice limitation.
No main/develop merge or PR was requested.

## Remaining behavior limits

Buffered Whisper STT produces final utterances, not native partial captions. Barge-in is delayed
until transcription completes; the relay does not claim immediate speech-to-speech interruption
parity. Error notifications ask users to repeat lost utterances instead of silently losing them.
Provider-specific model/voice/language limits still apply. Switching an existing adapter backend
is server configuration plus a restart; adding a proprietary transport requires a new adapter.
