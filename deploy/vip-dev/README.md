# Isolated Aural deployment on the VIP development host

## Status / safety boundary

Deployment is **paused for disk capacity**. The existing development host has a 15 GB root
filesystem. An initial isolated Supabase startup succeeded, but the downloaded amd64 layers
and database left only 571 MB free before the app image was added. The supervisor stopped and
removed only the new `aural-*` containers and their four Supabase image references; free space
returned to about 3.6 GiB. Existing VIP API, agent, database, Bifrost and shared ingress were
not restarted or reconfigured; public VIP health remained HTTP 200.

There are prepared configuration files and a protected `.env` under `/srv/dev/apps/aural`,
plus an unused initialized Aural database directory and named config volume. There is no
public Aural route and no running Aural service. No VIP data was modified. Do not treat those
prepared files as a running installation.

Before retrying, obtain at least **8 GiB free** (a root volume of at least 40 GB is recommended),
or use external Supabase. Do not automatically prune VIP images, backups, or volumes.

## What is included

- `compose.supabase.yaml`: dedicated Supabase Postgres, Auth, REST, file Storage and a small
  Caddy API gateway. No Studio, Realtime, image transforms, analytics, edge functions or pooler
  are included because Aural's audited paths don't require them. This is a minimal development
  stack, not a claim of parity with the full Supabase distribution.
- `compose.app.yaml`: resource-limited web and relay, independently configured STT/TTS and text
  models via the EXISTING `vip-bifrost` on `dev-ingress`. No new Bifrost instance/configuration.
- `bootstrap-env.py`: creates fresh random DB/JWT credentials in a mode-0600 file, never overwrites
  an existing file and never prints values. Anon JWT expiry is one year; rotate/rebuild as needed.
- `migrate.py`: applies each Aural migration transactionally, records hashes, rejects changed
  applied migrations and reloads PostgREST. Only allows an explicitly named `aural-*` DB container.
- `verify-supabase.py`: disposable signup, profile trigger/RLS, storage upload/download and cleanup.
- `preflight.py`: read-only disk/RAM/architecture/Docker/network gate before pulling any image.

Persistence: DB data in `data/postgres`, objects in `data/storage`, and a deterministic named
`aural_db-config` volume for Supabase's image-populated config/pgsodium key. An empty bind mount
must NOT replace that config volume: it hides required image-provided configuration files.
No database or gateway host ports are published.

## Deployment after capacity is resolved

1. Run `python3 preflight.py` on the host. Do not continue on nonzero exit.
2. Clone/fetch `skaasguru/aural-oss` into an app-specific checkout, resolve the approved feature
   commit, and create an immutable per-commit source worktree. Do not deploy from a dirty tree.
3. Copy this folder's versioned files into `/srv/dev/apps/aural`; retain `.env` and `data/` there,
   outside the checkout. `bootstrap-env.py .env` is only for a FRESH install. Never regenerate
   JWT/DB credentials against the retained initialized database.
4. Populate `BIFROST_API_KEY` via a server-side protected mechanism (prefer a dedicated scoped
   virtual key). Never put provider credentials into Git, public variables, image layers or build
   arguments. Existing Bifrost model discovery has verified `groq/whisper-large-v3`,
   `groq/openai/gpt-oss-120b` and the Orpheus model identifier. Groq Orpheus still requires its
   organization admin to accept model terms; do not accept those on someone's behalf.
5. Build **amd64** web and relay images on an amd64 builder/CI runner and publish immutable tags.
   The supervisor's machine is arm64 and lacks qemu. Do not ship its arm64 image to this host.
   The browser build must use the SAME `NEXT_PUBLIC_SUPABASE_URL`, anon JWT and app URL as `.env`,
   plus `NEXT_PUBLIC_VOICE_RELAY_URL=wss://aural.dev.skaaslabs.com/ws/voice` and primary `voice`.
   Provider keys are runtime-only. Set `AURAL_WEB_IMAGE` and `AURAL_RELAY_IMAGE` accordingly;
   inspect the image architecture before startup. Use Dockerfile web/relay targets when present.
6. `docker compose -f compose.supabase.yaml -f compose.app.yaml config --quiet`
7. `docker compose -f compose.supabase.yaml up -d --wait`
8. `python3 migrate.py --container aural-db-1 --source /srv/dev/apps/aural/source`
9. Run `verify-supabase.py --env .env --base-url http://<gateway-private-IP>:8000`; it cleans up
   its disposable data. Verify the exit status, not just an individual printed PASS line.
10. `docker compose -f compose.supabase.yaml -f compose.app.yaml up -d --wait`
11. Only after internal checks pass, add separate shared-ingress hostname blocks:
    `aural.dev.skaaslabs.com` -> `aural-web:3000`, with `/ws/voice` -> `aural-relay:8766`;
    `aural-api.dev.skaaslabs.com` -> `aural-supabase:8000`. Preserve existing VIP/Bifrost blocks,
    back up/validate the complete Caddyfile before reload and do not change its network/persistence.
    Protect the app and its unauthenticated speech/mic-test entrypoints with private ingress/access
    control before public exposure; don't assume upstream Aural's existing handlers are a complete
    abuse-control boundary. Configure public Auth/signup restrictions appropriately as well.
12. Verify HTTPS/certificates, signup/login, a real interview + practice + mic test, real STT/TTS,
    interruptions, reconnects, recording persistence, and unchanged VIP public health. A 200 health
    response is only process/config readiness; it does not prove provider inference or microphone UX.

Email auto-confirm is enabled in this **development-only** example because SMTP is not configured.
Recovery/verification email delivery requires a real SMTP setup. No demo credentials are committed.
Upstream storage policies also warrant a separate production authorization audit before using real
candidate recordings; the disposable smoke only proves anonymous isolation, not cross-tenant isolation.

## Backup / rollback

Before updates, keep the previous source commit and immutable image tags. Take an engine-consistent
`pg_dump` of ONLY the Aural database and a consistent snapshot of `data/storage` plus the config volume;
protect the env and backups as secrets. Do not copy a running Postgres data directory as a backup.

If the new app fails, restore previous image tags AND source pointer and recreate only Aural web/relay.
For a failed first stand-up, `docker compose -f compose.supabase.yaml -f compose.app.yaml down` stops
only Aural; retain data and the named config volume (no `-v`). Remove only a newly added Aural Caddy
block after validating the full file. Never use global prune or stop the shared ingress/VIP services.

## Verification already performed

Local ARM64 Docker: fresh minimal Supabase startup; all five Aural SQL migrations applied, then a
second idempotent/hash-verified run; actual signup/session, profile creation, anonymous profile RLS,
private recording object upload and authenticated download, and disposal of the object/user/org/profile.
Idle measured memory across the five local services was approximately 240 MiB (not a load benchmark).
Compose merging/configuration and Caddy syntax were validated. On VIP dev, Groq Whisper transcription
and a text completion succeeded through existing Bifrost; Groq Orpheus returned `model_terms_required`.
Full Aural deployment and browser microphone acceptance remain unverified.
