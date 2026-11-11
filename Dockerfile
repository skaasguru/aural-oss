# Two small runtime targets built from one source tree:
#
#   web    Next.js standalone server (port 3000). No node_modules tree, no source, no build cache.
#   relay  voice WebSocket relay run from TypeScript with tsx (port 8766) + ffmpeg (Alpine). Only the
#          packages the relay actually imports (see scripts/relay-runtime.mjs), not the web tree.
#
#   docker build --target web -t aural-web \
#     --build-arg NEXT_PUBLIC_SUPABASE_URL=... --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=... \
#     --build-arg NEXT_PUBLIC_APP_URL=... --build-arg NEXT_PUBLIC_VOICE_RELAY_URL=wss://your-host/ws/voice .
#   docker build --target relay -t aural-relay .
#
# NEXT_PUBLIC_* values are public and compiled into the browser bundle; the web container refuses to
# start if its runtime NEXT_PUBLIC_* differ from the build. Provider keys (STT/TTS/LLM/Supabase
# service role) are NEVER build args: pass them at run time (see docker-compose.speech.example.yml).
FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS toolchain
# bufferutil/utf-8-validate (ws accelerators) fall back to compiling when no prebuilt binary matches.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

FROM toolchain AS deps
COPY package.json package-lock.json .npmrc ./
COPY vendor ./vendor
RUN npm ci --no-audit --no-fund

FROM deps AS build
ARG NEXT_PUBLIC_SUPABASE_URL=http://placeholder.invalid
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder-public-anon-key
ARG NEXT_PUBLIC_APP_URL=http://localhost:3000
ARG NEXT_PUBLIC_VOICE_RELAY_URL=ws://localhost:8766
ARG NEXT_PUBLIC_VOICE_RELAY_PRIMARY=voice
# Server modules that create clients at import time need *a* value to finish `next build`.
# These are inert placeholders for the build only (this stage is not shipped); real values come
# from the runtime env.
ENV SUPABASE_URL=http://placeholder.invalid SUPABASE_ANON_KEY=placeholder-anon SUPABASE_SERVICE_ROLE_KEY=placeholder-service
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_VOICE_RELAY_URL=$NEXT_PUBLIC_VOICE_RELAY_URL \
    NEXT_PUBLIC_VOICE_RELAY_PRIMARY=$NEXT_PUBLIC_VOICE_RELAY_PRIMARY \
    AURAL_NEXT_OUTPUT=standalone
COPY . .
# Fails the build if the relay imports a package that the relay image would not contain.
RUN node scripts/relay-runtime.mjs check
RUN npm run build
# Record exactly the public values compiled into the bundle (no secrets) for the runtime guard.
RUN node -e 'const fs=require("fs");const o={};for(const k of Object.keys(process.env).filter(k=>k.startsWith("NEXT_PUBLIC_")).sort())o[k]=process.env[k];fs.writeFileSync(".next/standalone/public-env.json",JSON.stringify(o))' \
    && cp docker/web-entrypoint.mjs .next/standalone/web-entrypoint.mjs

# The relay runs on Alpine (musl): the ffmpeg install is ~250 MB smaller than Debian's. Its npm
# dependencies are installed in the same libc so native addons (ws accelerators, esbuild) match.
FROM node:22-alpine AS relay-deps
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/relay-runtime.mjs ./scripts/
RUN mkdir /relay && node scripts/relay-runtime.mjs manifest /relay
WORKDIR /relay
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:22-alpine AS relay
WORKDIR /app
# ffmpeg decodes mp3/opus/aac/flac TTS responses (VOICE_TTS_FORMAT); wav/pcm need none.
RUN apk add --no-cache ffmpeg ca-certificates
ENV NODE_ENV=production VOICE_RELAY_HOST=0.0.0.0 VOICE_RELAY_PORT=8766
COPY --from=relay-deps --chown=node:node /relay/package.json ./
COPY --from=relay-deps --chown=node:node /relay/node_modules ./node_modules
COPY --chown=node:node tsconfig.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node src ./src
USER node
EXPOSE 8766
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.VOICE_RELAY_PORT||8766)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--import", "tsx", "server/voice-relay.ts"]

# Default target (last stage): the web app.
FROM base AS web
# The HTTP coaching/mic-test TTS route also decodes compressed provider audio.
# Keep its capabilities identical to the relay, not dependent on which surface is used.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "web-entrypoint.mjs"]
