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
were removed. AMD64 image verification is delegated to the committed GitHub Actions Docker gate;
ARM64 images are not suitable for the VIP dev host.

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

## Deployment state

NOT deployed. A minimal isolated remote Supabase startup exhausted safe headroom on the shared
15 GB root disk before the Aural app image was added. All newly introduced containers/images were
rolled back; VIP services were not restarted and public VIP health remained HTTP 200.
The committed [deployment runbook](../deploy/vip-dev/README.md) requires at least 8 GiB FREE before
another attempt (40 GB root recommended), or external Supabase. No resource purchase/resize was
authorized. No main/develop merge or PR was requested.

## Remaining behavior limits

Buffered Whisper STT produces final utterances, not native partial captions. Barge-in is delayed
until transcription completes; the relay does not claim immediate speech-to-speech interruption
parity. Error notifications ask users to repeat lost utterances instead of silently losing them.
Provider-specific model/voice/language limits still apply. Switching an existing adapter backend
is server configuration plus a restart; adding a proprietary transport requires a new adapter.
