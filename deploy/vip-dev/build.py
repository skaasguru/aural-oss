#!/usr/bin/env python3
"""Build immutable Aural targets on the authorized dev VM; no secret output."""
import json, os, subprocess, sys
from pathlib import Path
root = Path('/srv/dev/apps/aural')
status = root / 'logs/build.exit'
status.unlink(missing_ok=True)
code = 1
try:
    envfile = root / '.env'
    env = dict(l.split('=', 1) for l in envfile.read_text().splitlines() if l and not l.startswith('#') and '=' in l)
    c = json.loads(subprocess.check_output(['docker','inspect','vip-bifrost-1']))[0]
    bf = dict(x.split('=',1) for x in c['Config']['Env'])
    # Aural authenticates to the shared gateway with its own virtual key (`aural-dev`).
    assert bf.get('AURAL_BIFROST_VK'), 'Bifrost virtual key for Aural absent (run upgrade-bifrost.py)'
    env['BIFROST_API_KEY'] = bf['AURAL_BIFROST_VK']
    revision = (root/'source/REVISION').read_text().strip()
    env['AURAL_WEB_IMAGE'] = 'aural-web:' + revision
    env['AURAL_RELAY_IMAGE'] = 'aural-relay:' + revision
    env.setdefault('AURAL_DISABLE_SIGNUP', 'true')
    fd = os.open(envfile, os.O_WRONLY|os.O_TRUNC, 0o600)
    with os.fdopen(fd,'w') as f: f.write(''.join(k+'='+v+'\n' for k,v in env.items()))
    os.chmod(envfile,0o600)
    def run(args): subprocess.run(args,cwd=root/'source',check=True)
    check = subprocess.run(['docker','buildx','inspect','aural-build'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    if check.returncode:
        run(['docker','buildx','create','--name','aural-build','--driver','docker-container','--driver-opt','memory=1800m','--driver-opt','cpu-quota=100000'])
    public = {'NEXT_PUBLIC_SUPABASE_URL':env['PUBLIC_SUPABASE_URL'], 'NEXT_PUBLIC_SUPABASE_ANON_KEY':env['ANON_KEY'], 'NEXT_PUBLIC_APP_URL':env['PUBLIC_APP_URL'], 'NEXT_PUBLIC_VOICE_RELAY_URL':'wss://aural.dev.skaaslabs.com/ws/voice','NEXT_PUBLIC_VOICE_RELAY_PRIMARY':'voice'}
    args = ['docker','buildx','build','--builder','aural-build','--platform','linux/amd64','--load','--build-arg','AURAL_NEXT_BUILD_FLAGS=--webpack','--target','web','-t',env['AURAL_WEB_IMAGE']]
    for k,v in public.items(): args += ['--build-arg',k+'='+v]
    run(args+['.'])
    run(['docker','buildx','build','--builder','aural-build','--platform','linux/amd64','--load','--target','relay','-t',env['AURAL_RELAY_IMAGE'],'.'])
    run(['bash','scripts/verify-speech-images.sh',env['AURAL_WEB_IMAGE'],env['AURAL_RELAY_IMAGE']])
    code=0
finally:
    subprocess.run(['docker','buildx','stop','aural-build'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    status.write_text(str(code)+'\n')
    print('Aural build exit:',code,flush=True)
sys.exit(code)
