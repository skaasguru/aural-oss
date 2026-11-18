#!/usr/bin/env python3
"""First installation on the authorized VIP dev VM; preserves existing VIP services.
Run after deploy-build.py succeeds. Outputs status only, never credentials.
"""
import base64, json, os, secrets, subprocess, time, urllib.error, urllib.request
from pathlib import Path
ROOT=Path('/srv/dev/apps/aural')
ENV=ROOT/'.env'
def loadenv():
    return dict(l.split('=',1) for l in ENV.read_text().splitlines() if l and not l.startswith('#') and '=' in l)
def saveenv(e):
    with open(ENV,'w') as f: f.write(''.join(k+'='+v+'\n' for k,v in e.items()))
    os.chmod(ENV,0o600)
def run(a,**kw): return subprocess.run(a,cwd=ROOT,check=True,**kw)
def ip(name,network):
    c=json.loads(subprocess.check_output(['docker','inspect',name]))[0]
    return c['NetworkSettings']['Networks'][network]['IPAddress']
def request(base,path,env,method='GET',data=None,token=None):
    headers={'apikey':env['ANON_KEY'],'Authorization':'Bearer '+(token or env['ANON_KEY'])}
    body=None
    if data is not None: headers['Content-Type']='application/json';body=json.dumps(data).encode()
    with urllib.request.urlopen(urllib.request.Request(base+path,data=body,headers=headers,method=method),timeout=30) as r:
        b=r.read()
        return json.loads(b) if b else {}

def main():
    assert (ROOT/'logs/build.exit').read_text().strip()=='0','Build has not passed'
    e=loadenv()
    e['AURAL_DISABLE_SIGNUP']='false' # Internal-only smoke; disabled before public ingress.
    saveenv(e)
    for k in ['AURAL_WEB_IMAGE','AURAL_RELAY_IMAGE']:
        assert subprocess.check_output(['docker','image','inspect',e[k],'--format','{{.Architecture}}']).strip()==b'amd64'
    compose=['docker','compose','-f','compose.supabase.yaml','-f','compose.app.yaml']
    run(compose+['config','--quiet'])
    run(['docker','compose','-f','compose.supabase.yaml','up','-d','--wait','--wait-timeout','240'])
    run(['python3','migrate.py','--container','aural-db-1','--source',str(ROOT/'source')])
    base='http://'+ip('aural-gateway-1','aural_private')+':8000'
    run(['python3','verify-supabase.py','--env','.env','--base-url',base])
    accessfile=ROOT/'access.json'
    if accessfile.exists(): access=json.loads(accessfile.read_text())
    else:
        access={'url':e['PUBLIC_APP_URL'],'http_username':'aural','http_password':secrets.token_urlsafe(24),'email':'admin@aural.dev.skaaslabs.com','password':secrets.token_urlsafe(24)}
        fd=os.open(accessfile,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'w') as f: json.dump(access,f,indent=2)
    users=request(base,'/auth/v1/admin/users?page=1&per_page=100',e,token=e['SERVICE_ROLE_KEY']).get('users',[])
    if not any(u.get('email')==access['email'] for u in users):
        request(base,'/auth/v1/admin/users',e,'POST',{'email':access['email'],'password':access['password'],'email_confirm':True,'user_metadata':{'full_name':'Aural Dev Admin'}},e['SERVICE_ROLE_KEY'])
    login=request(base,'/auth/v1/token?grant_type=password',e,'POST',{'email':access['email'],'password':access['password']})
    assert login.get('access_token')
    print('PASS: persistent dev account login',flush=True)
    e['AURAL_DISABLE_SIGNUP']='true';saveenv(e)
    run(compose+['up','-d','--wait','--wait-timeout','180'])
    print('PASS: all Aural containers ready',flush=True)
    hashed=subprocess.check_output(['docker','exec','-i','dev-ingress-caddy-1','caddy','hash-password'],input=(access['http_password']+'\n').encode()).decode().strip()
    assert hashed.startswith('$2'), 'Unexpected password hash format'
    caddy=Path('/srv/dev/Caddyfile'); old=caddy.read_text()
    marker='# BEGIN AURAL MANAGED'
    end='# END AURAL MANAGED'
    blocks='\n'+marker+'\naural.dev.skaaslabs.com {\n    encode zstd gzip\n    basic_auth {\n        aural '+hashed+'\n    }\n    handle /ws/voice {\n        reverse_proxy aural-relay:8766\n    }\n    handle {\n        reverse_proxy aural-web:3000\n    }\n}\n\naural-api.dev.skaaslabs.com {\n    encode zstd gzip\n    reverse_proxy aural-supabase:8000\n}\n'+end+'\n'
    if marker in old:
        prefix,rest=old.split(marker,1);_,suffix=rest.split(end,1);new=prefix.rstrip()+blocks+suffix
    else: new=old.rstrip()+'\n'+blocks
    backup=ROOT/'Caddyfile.before-aural'
    if not backup.exists(): backup.write_text(old);os.chmod(backup,0o600)
    caddy.write_text(new)
    try:
        run(['docker','exec','dev-ingress-caddy-1','caddy','validate','--config','/etc/caddy/Caddyfile'])
        run(['docker','exec','dev-ingress-caddy-1','caddy','reload','--config','/etc/caddy/Caddyfile'])
    except Exception:
        caddy.write_text(old)
        run(['docker','exec','dev-ingress-caddy-1','caddy','reload','--config','/etc/caddy/Caddyfile'])
        raise
    print('PASS: shared ingress validated and reloaded (existing routes preserved)',flush=True)
    for attempt in range(30):
        try:
            auth=base64.b64encode((access['http_username']+':'+access['http_password']).encode()).decode()
            req=urllib.request.Request(e['PUBLIC_APP_URL']+'/api/health',headers={'Authorization':'Basic '+auth})
            with urllib.request.urlopen(req,timeout=15) as r: assert r.status==200
            with urllib.request.urlopen('https://vip.dev.skaaslabs.com/api/health',timeout=15) as r: assert r.status==200
            login=request(e['PUBLIC_SUPABASE_URL'],'/auth/v1/token?grant_type=password',e,'POST',{'email':access['email'],'password':access['password']})
            assert login.get('access_token')
            print('PASS: public HTTPS web readiness, Supabase login, VIP health',flush=True)
            break
        except Exception as err:
            if attempt==29: raise RuntimeError('Public acceptance failed: '+type(err).__name__) from None
            time.sleep(5)
    try:
        urllib.request.urlopen(e['PUBLIC_APP_URL']+'/api/voice/tts-s2s',timeout=15)
        raise AssertionError('Speech endpoint missing ingress protection')
    except urllib.error.HTTPError as err: assert err.code==401
    try:
        request(e['PUBLIC_SUPABASE_URL'],'/auth/v1/signup',e,'POST',{'email':'blocked-'+secrets.token_hex(6)+'@example.com','password':secrets.token_urlsafe(24)})
        raise AssertionError('Public signup should be disabled')
    except urllib.error.HTTPError as err: assert err.code in (400,422)
    print('PASS: unauthenticated speech blocked and public signup disabled',flush=True)
    source=ROOT/'source'
    revision=(source/'REVISION').read_text().strip()
    if not source.is_symlink():
        release=ROOT/'releases'/revision
        release.parent.mkdir(exist_ok=True)
        assert not release.exists()
        source.rename(release)
        source.symlink_to(release,target_is_directory=True)
    (ROOT/'deployment.json').write_text(json.dumps({'source_revision':revision,'web_image':e['AURAL_WEB_IMAGE'],'relay_image':e['AURAL_RELAY_IMAGE'],'public_url':e['PUBLIC_APP_URL']},indent=2)+'\n')

if __name__=='__main__':
    result=1
    try: main();result=0
    finally: (ROOT/'logs/activate.exit').write_text(str(result)+'\n')
