# Aural dev operations

Host: VIP dev (`13.232.80.96`), deployment root `/srv/dev/apps/aural`.
Do not use these commands on the production SKaaS hosts.

## Access and boundaries

- Web: `https://aural.dev.skaaslabs.com` (HTTP Basic authentication, then Aural login).
- Supabase API: `https://aural-api.dev.skaaslabs.com` (normal JWT/RLS authorization).
- `/srv/dev/apps/aural/access.json`, mode 0600, contains the generated dev access credentials.
  Do not print it into terminal logs or commit it. Public signup is disabled after installation.
- `.env`, database files, storage objects, access credentials and backups remain outside Git.
- Groq provider credentials remain in existing Bifrost for STT/text generation. Kokoro uses a
  separate generated private-service key in protected `.env`, not a cloud-provider key.
- VIP API/agent are intentionally paused with owner approval to free model memory; VIP DB,
  Bifrost and shared ingress remain running. Check capacity before resuming the VIP app.
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
image settings and app Compose configuration in a protected timestamped backup. It pauses a
running Kokoro container during the memory-intensive image build, then resumes it and recreates
Aural web/relay. It checks public Aural/Bifrost readiness and preserves VIP's prior running/stopped
state (VIP is currently intentionally paused). Failure restores old source/config/images and
resumes a previously running Kokoro. Prior images are retained. It DOES NOT upgrade Supabase or apply new database
migrations; review and approve those separately. The idle flag is an operator assertion,
not an automated session-occupancy measurement. The full update/rollback procedure must
be rehearsed before relying on it for a production upgrade.

## Live browser smoke

`verify-browser.mjs` requires Playwright/Chromium 1.58.2 and protected credentials mounted
at `/run/access.json`; mount it at `/qa/verify-browser.mjs` in the matching Playwright image.
It checks login, dashboard, actual AI generation, real relay PCM playback/acknowledgement and
HTTP TTS. It REQUIRES HTTP 200 synthesis plus valid audible audio decoded by Chromium;
502 no longer counts as acceptance. The controlled headless browser permits autoplay.
It does not simulate a physical microphone. AI checks make real provider requests.
Never log cookies or passwords.

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

STT remains `groq/whisper-large-v3`; text generation remains `groq/openai/gpt-oss-120b`,
through Bifrost. TTS is now local Kokoro (`af_heart`) on Aural's private network, after the
configured Gemini key failed authentication. See [Kokoro deployment](../../docs/kokoro-deployment.md)
for the pinned image, limits, memory incident, successful browser playback and measured latency.
Groq Whisper is utterance-buffered, not native live-partial transcription. Real-device microphone,
interruptions/reconnects under load and full human interview/recording acceptance remain separate
checks. The current CPU TTS is functional but not low-latency conversational inference.
