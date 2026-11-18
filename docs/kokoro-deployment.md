# Kokoro on Aural dev

## Active selection

The configured Gemini key returned HTTP 401 on model discovery, and installed Bifrost
listed no Gemini TTS models. Under the owner's authorized fallback, Aural now synthesizes
speech using **self-hosted Kokoro**, directly over its private Docker network. Groq Whisper
recognition and Groq text generation remain routed through existing Bifrost.

- Image: `ghcr.io/remsky/kokoro-fastapi-cpu:v0.10.0`, pinned in Compose to manifest digest
  `sha256:f54c5960c2b9387f6349080a9944f8bc7e8cdb98a4ef9238cb0b0f9ff9795f44`.
- Model/voice: `kokoro` / `af_heart` (English).
- Private base URL: `http://aural-kokoro:8880/v1`; no published host ports or public ingress.
- One inference worker, two math threads, 1.5 CPU cap, **2048 MiB memory cap**.
- API key generated server-side, retained in protected `.env`, never committed.
- Baked-in models; model downloads and Hugging Face telemetry/network checks disabled.
- Aural splits input at 160 characters and uses a 60-second per-request timeout; existing
  aggregate audio bounds and interruption/cancellation behavior remain in force.

The `kokoro` Compose profile is enabled through `COMPOSE_PROFILES=kokoro` in the protected
environment. Both Aural web and voice relay use the same `AURAL_TTS_*` selection. Aural's
application images did not need rebuilding; the runtime application source remains
`d8a75bcb143b4837a1128c4c80d57148dbe52f5e`, with separately versioned deployment configuration.

## Resource failure and correction

The first 1400 MiB cap passed short HTTP clips but OOM-killed Kokoro on the full interview
greeting. Kernel logs confirmed a memory-cgroup kill. A real browser relay test failed;
this was not treated as successful voice acceptance.

After confirming zero LiveKit rooms/participants (despite one persisted `in_progress`
interview row), the supervisor paused **only `vip-api` and `vip-agent-1`**, as previously
authorized by the owner, and raised Kokoro's cap to 2048 MiB. Existing VIP database,
Bifrost and shared Caddy remain running. VIP's application is intentionally unavailable
while paused; do not describe its public health as healthy. Do not restart it automatically
without checking total model/application headroom and obtaining operator approval.

## Real acceptance

The strict `deploy/vip-dev/verify-browser.mjs` test passed against public HTTPS:

- Login/dashboard and actual AI question generation through the deployed web API.
- Initialized the real voice relay with a synthetic interview context (no real candidate data).
- Received **387720 bytes** of real Kokoro-generated 24 kHz mono signed-16-bit PCM.
- Chromium scheduled and completed playback of **9 chunks**, then sent playback acknowledgement.
- First relay audio arrived after **22.857 seconds**.
- The separate HTTP TTS endpoint returned **200**; Chromium decoded its WAV as audible mono
  audio, approximately **2.074 seconds** long. Zero browser page errors.

These are real model-generated audio checks, not fabricated provider output. The browser
harness deliberately permits autoplay for headless testing. It does NOT establish physical
microphone capture, iPhone permissions, or full human interview/recording acceptance.

The CPU setup is functional but **not low-latency conversational speech**: sample requests
produced roughly 3–6 seconds of audio in roughly 10–17 seconds. No concurrency/load guarantee
is made. Tamil synthesis has not been configured or claimed.

## Operation

`enable-kokoro.py` stages and validates `compose.app.kokoro.yaml`, keeps protected backups,
checks real direct and public HTTP audio, checks the relay has no established connections
before recreation, and restores prior app configuration on failure. It never stops VIP.
The owner's temporary VIP pause was a separate explicitly authorized action.

`update.sh` requires operator-confirmed idle sessions. On this small VM it pauses an active
Kokoro container while building app images, resumes it after build (or on rollback), and
preserves VIP's pre-existing running/stopped state. Full future application update/rollback
has not been rehearsed; current acceptance covers the configuration switch and live audio.

The current `logs/browser-smoke.json` and `deployment.json` on the VM record acceptance and
selection. Never print `.env`, `access.json`, raw container environment, or API key headers.
