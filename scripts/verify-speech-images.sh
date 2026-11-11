#!/usr/bin/env bash
# Runtime/readiness smoke only: no provider inference or real Supabase connection is claimed.
# Build images first, then: bash scripts/verify-speech-images.sh aural-web:local aural-relay:local
set -Eeuo pipefail
web_image=${1:?web image required}
relay_image=${2:?relay image required}
web="aural-image-smoke-web-$$"
relay="aural-image-smoke-relay-$$"
cleanup() { docker rm -f "$web" "$relay" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --network none --name "$web" \
  -e SUPABASE_URL=http://placeholder.invalid \
  -e SUPABASE_ANON_KEY=readiness-placeholder \
  -e SUPABASE_SERVICE_ROLE_KEY=readiness-placeholder \
  "$web_image" >/dev/null

docker run -d --network none --name "$relay" \
  -e VOICE_ASR_PROVIDER=openai-compatible \
  -e VOICE_STT_BASE_URL=http://127.0.0.1:1/v1 \
  -e VOICE_STT_MODEL=readiness-placeholder \
  -e VOICE_TTS_PROVIDER=openai-compatible \
  -e VOICE_TTS_BASE_URL=http://127.0.0.1:1/v1 \
  -e VOICE_TTS_MODEL=readiness-placeholder \
  -e VOICE_TTS_VOICE=readiness-placeholder \
  "$relay_image" >/dev/null

probe() {
  local container=$1 url=$2
  for attempt in $(seq 1 30); do
    if docker exec "$container" node -e "fetch('$url').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      return 0
    fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$container")" != true ]; then
      printf 'FAIL: %s stopped during readiness check\n' "$container" >&2
      return 1
    fi
    sleep 1
  done
  printf 'FAIL: %s did not become ready\n' "$container" >&2
  return 1
}
probe "$web" http://127.0.0.1:3000/api/health
probe "$relay" http://127.0.0.1:8766/health
for container in "$web" "$relay"; do
  docker exec "$container" ffmpeg -version >/dev/null
  test "$(docker exec "$container" id -u)" != 0
  printf 'PASS: %s readiness, ffmpeg and non-root runtime\n' "$container"
done
