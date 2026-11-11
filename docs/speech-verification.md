# Speech adapter verification

The primary voice relay supports independently configured transcription and synthesis adapters.
Automated tests use loopback HTTP and WebSocket servers to exercise provider boundaries without
external accounts. The Azure backup relay is separate.

- `npm run test:speech` exercises the speech adapter and relay tests.
- `npm run test:speech:ffmpeg` requires ffmpeg and exercises real audio decoding and limits.
- `scripts/verify-speech-images.sh` checks container readiness, non-root execution, and ffmpeg.
- A service readiness check or successful WebSocket handshake is not a microphone interview test.
  Check recognition, playback, and reconnection in a browser against your configured providers.

Buffered transcription produces final utterances rather than native live captions. Interruption
detection is delayed until transcription completes. Provider-specific model, voice, and language
limits still apply.
