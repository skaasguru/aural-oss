#!/usr/bin/env bash
# Update Aural from a clean immutable Git worktree already on this VM.
# Usage: ./update.sh /absolute/path/to/worktree --confirmed-idle
# Operator must confirm there are no active Aural sessions before invoking.
set -euo pipefail
umask 077
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
python3 - "$backup/vip-state.json" <<'PY'
import json,subprocess,sys
with open(sys.argv[1],'w') as f:
    json.dump({n:subprocess.check_output(['docker','inspect',n,'--format','{{.State.Running}}']).decode().strip() for n in ['vip-api','vip-agent-1']},f)
PY
resume_kokoro=0
if [[ $(docker inspect aural-kokoro-1 --format '{{.State.Running}}' 2>/dev/null || true) == true ]]; then
  resume_kokoro=1
fi
rollback() {
  trap - ERR
  cp "$backup/env" .env
  cp "$backup/compose.app.yaml" compose.app.yaml
  ln -sfn "$old_source" source
  if [[ $resume_kokoro == 1 ]]; then
    docker compose -f compose.supabase.yaml -f compose.app.yaml up -d --no-deps --wait --wait-timeout 180 kokoro
  fi
  docker compose -f compose.supabase.yaml -f compose.app.yaml up -d --no-deps --wait --wait-timeout 180 web relay
  printf '%s\n' 'Update failed; restored previous source, configuration and images.' >&2
}
trap 'status=$?; rollback; exit "$status"' ERR
# A 4 GiB VM cannot safely run the inference model and the image builder at peak together.
if [[ $resume_kokoro == 1 ]]; then docker stop aural-kokoro-1; fi
ln -sfn "$new_source" source
python3 build.py > logs/update-build.log 2>&1
cp "$new_source/deploy/vip-dev/compose.app.yaml" compose.app.yaml
docker compose -f compose.supabase.yaml -f compose.app.yaml config --quiet
if [[ $resume_kokoro == 1 ]]; then
  docker compose -f compose.supabase.yaml -f compose.app.yaml up -d --no-deps --wait --wait-timeout 180 kokoro
fi
docker compose -f compose.supabase.yaml -f compose.app.yaml up -d --no-deps --wait --wait-timeout 180 web relay
python3 - "$backup/vip-state.json" "$revision" <<'PY'
import base64,json,subprocess,sys,urllib.request
from pathlib import Path
a=json.loads(Path('access.json').read_text())
h=base64.b64encode((a['http_username']+':'+a['http_password']).encode()).decode()
r=urllib.request.Request(a['url']+'/api/health',headers={'Authorization':'Basic '+h})
with urllib.request.urlopen(r,timeout=30) as response: assert response.status==200
before=json.loads(Path(sys.argv[1]).read_text())
after={n:subprocess.check_output(['docker','inspect',n,'--format','{{.State.Running}}']).decode().strip() for n in before}
assert before==after, 'Unexpected VIP state change'
bf=json.loads(subprocess.check_output(['docker','inspect','vip-bifrost-1']))[0]
ip=bf['NetworkSettings']['Networks']['dev-ingress']['IPAddress']
with urllib.request.urlopen('http://'+ip+':8080/health',timeout=30) as response: assert response.status==200
e=dict(l.split('=',1) for l in Path('.env').read_text().splitlines() if l and not l.startswith('#') and '=' in l)
p=Path('deployment.json');state=json.loads(p.read_text())
state.update(source_revision=sys.argv[2],web_image=e['AURAL_WEB_IMAGE'],relay_image=e['AURAL_RELAY_IMAGE'])
p.write_text(json.dumps(state,indent=2)+'\n')
print('PASS: public Aural, Bifrost health and unchanged VIP app state')
PY
trap - ERR
printf 'Updated Aural to %s; rollback files: %s\n' "$revision" "$backup"
