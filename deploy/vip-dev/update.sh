#!/usr/bin/env bash
# Update only Aural web/relay from a clean immutable Git worktree already on this VM.
# Usage: ./update.sh /absolute/path/to/worktree --confirmed-idle
# Operator must confirm there are no active Aural sessions before invoking.
set -euo pipefail
cd /srv/dev/apps/aural
[[ ${2:-} == --confirmed-idle ]] || { printf '%s\n' 'Refusing: confirm no active Aural sessions with --confirmed-idle'; exit 2; }
new_source=$(realpath "${1:?provide an immutable source worktree}")
[[ -f "$new_source/Dockerfile" && -f "$new_source/REVISION" ]] || exit 2
revision=$(git -C "$new_source" rev-parse HEAD)
[[ $(<"$new_source/REVISION") == "$revision" ]] || exit 2
[[ -z $(git -C "$new_source" status --porcelain --untracked-files=no) ]] || { printf '%s\n' 'Refusing dirty source'; exit 2; }
[[ -L source ]] || { printf '%s\n' 'Source pointer has not been initialized'; exit 2; }
old_source=$(readlink -f source)
backup="backups/update-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup"
chmod 700 backups "$backup"
cp .env "$backup/env"
cp compose.app.yaml "$backup/compose.app.yaml"
printf '%s\n' "$old_source" > "$backup/source"
chmod 600 "$backup"/*
rollback() {
  cp "$backup/env" .env
  cp "$backup/compose.app.yaml" compose.app.yaml
  ln -sfn "$old_source" source
  docker compose -f compose.supabase.yaml -f compose.app.yaml up -d --wait --wait-timeout 180 web relay
  printf '%s\n' 'Update failed; restored previous source, configuration and images.' >&2
}
trap 'rollback' ERR
ln -sfn "$new_source" source
python3 build.py > logs/update-build.log 2>&1
cp "$new_source/deploy/vip-dev/compose.app.yaml" compose.app.yaml
docker compose -f compose.supabase.yaml -f compose.app.yaml config --quiet
docker compose -f compose.supabase.yaml -f compose.app.yaml up -d --wait --wait-timeout 180 web relay
python3 - <<'PY'
import base64,json,urllib.request
from pathlib import Path
a=json.loads(Path('access.json').read_text())
h=base64.b64encode((a['http_username']+':'+a['http_password']).encode()).decode()
r=urllib.request.Request(a['url']+'/api/health',headers={'Authorization':'Basic '+h})
with urllib.request.urlopen(r,timeout=30) as response: assert response.status==200
with urllib.request.urlopen('https://vip.dev.skaaslabs.com/api/health',timeout=30) as response: assert response.status==200
print('PASS: public Aural and unchanged VIP health')
PY
trap - ERR
printf 'Updated Aural to %s; rollback files: %s\n' "$revision" "$backup"
