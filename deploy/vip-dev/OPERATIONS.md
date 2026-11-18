# Aural dev operations

Host: VIP dev (`13.232.80.96`), deployment root `/srv/dev/apps/aural`.
Do not use these commands on the production SKaaS hosts.

## Access and boundaries

- Web: `https://aural.dev.skaaslabs.com` (HTTP Basic authentication, then Aural login).
- Supabase API: `https://aural-api.dev.skaaslabs.com` (normal JWT/RLS authorization).
- `/srv/dev/apps/aural/access.json`, mode 0600, contains the generated dev access credentials.
  Do not print it into terminal logs or commit it. Public signup is disabled after installation.
- `.env`, database files, storage objects, access credentials and backups remain outside Git.
- Groq provider credentials remain in existing Bifrost; Aural receives its runtime gateway key.
- No email delivery is configured; this is a development-only installation.
- The shared Caddy process is reloaded, not restarted. Existing VIP and Bifrost routes are preserved.

## Inspect safely

```sh
cd /srv/dev/apps/aural
docker compose -f compose.supabase.yaml -f compose.app.yaml ps
cat deployment.json
cat logs/build.exit
cat logs/activate.exit
df -h /
```

Never print `docker compose config` without `--quiet`, `.env`, `access.json`, or raw
container environments. The build logs include only public build variables; service keys
must never be supplied as build arguments. `deployment.json` identifies immutable image
references and the source revision. `source` points to the installed per-commit release.

## Rebuild / first installation

`build.py` builds both amd64 images using the dedicated `aural-build` BuildKit builder
(capped at 1800 MiB and one CPU), selects webpack, and boots disposable runtime smoke
containers. It stops its builder on exit and writes `logs/build.exit`. It does not restart
VIP or deploy application containers. Review `logs/build.log` and the exit marker.

`activate.py` is a FIRST-INSTALL tool, not an update tool: it runs minimal Supabase,
applies checksummed migrations, verifies disposable Auth/RLS/Storage, creates dev access,
disables public signup, starts web/relay, and validates/reloads protected Caddy routes.
It writes `logs/activate.exit`. Do not rerun it against an installation serving users.

## Application-only updates

Prepare a clean Git worktree at the intended full commit on this VM; record that exact
commit in an untracked `REVISION` file. Confirm no Aural interviews or voice sessions are
active. From `/srv/dev/apps/aural`:

```sh
./update.sh /absolute/path/to/immutable-worktree --confirmed-idle
```

The script refuses a dirty worktree or mismatched revision, saves the old source pointer,
image settings and app Compose configuration in a protected timestamped backup, builds
new images, recreates ONLY Aural web/relay, and checks authenticated public Aural health
and unchanged VIP health. Failure restores old source/config/images and recreates only
web/relay. Prior images are retained. It DOES NOT upgrade Supabase or apply new database
migrations; review and approve those separately. The idle flag is an operator assertion,
not an automated session-occupancy measurement. The full update/rollback procedure must
be rehearsed before relying on it for a production upgrade.

## Live browser smoke

`verify-browser.mjs` requires Playwright/Chromium 1.58.2 and protected credentials mounted
at `/run/access.json`; mount it at `/qa/verify-browser.mjs` in the matching Playwright image.
It checks login, dashboard, WebSocket handshake and actual AI question generation. Its JSON
reports `ttsStatus` separately: exit zero with 502 records the known terms-blocked TTS path,
NOT successful speech. AI checks make real provider requests. Never log cookies or passwords.

## Backups / rollback

For database backups, use engine-consistent `pg_dump` against ONLY `aural-db-1`, with
mode-0600 output in a protected backup directory. Quiesce Aural writes before taking a
matching storage/config snapshot. Never copy a live Postgres data directory as a backup.
Preserve `.env` and the named `aural_db-config` volume with the database.

For a failed first install, stop only the `aural` Compose project, without `-v`, retaining
data and configuration. If needed, restore `Caddyfile.before-aural`, validate the full
shared Caddyfile and reload. Do not restore that backup blindly after unrelated ingress
changes; remove only the Aural managed block instead. Never prune unrelated images,
networks, volumes or VIP rollback assets. EBS enlargement cannot be undone by shrinking
this live volume; a smaller replacement volume would require a separate migration.

## Voice acceptance

STT is `groq/whisper-large-v3`; TTS is `groq/canopylabs/orpheus-v1-english`, voice `troy`;
text generation is `groq/openai/gpt-oss-120b`, all through existing Bifrost.
Groq Whisper is utterance-buffered, not native live-partial transcription.
An HTTP 200 readiness response does not establish successful speech synthesis or a full
browser microphone session. Verify actual providers, WebSocket ingress, microphone capture,
interruptions, playback and recording independently. Groq model terms must be accepted by
the account owner; do not accept them on the user's behalf.
