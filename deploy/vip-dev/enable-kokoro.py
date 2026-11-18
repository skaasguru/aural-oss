#!/usr/bin/env python3
"""Switch the authorized dev stack to local Kokoro after actual audio verification.
Stage compose.app.kokoro.yaml beside the live Compose file before running. No image rebuild.
Credentials stay server-side. Restore prior app settings on failure; do not touch VIP.
"""
import base64, io, json, math, os, secrets, subprocess, time, urllib.request, wave
from pathlib import Path
ROOT=Path('/srv/dev/apps/aural')
COMPOSE=['docker','compose','-f','compose.supabase.yaml','-f','compose.app.yaml']
def run(a): subprocess.run(a,cwd=ROOT,check=True)
def save(path,data,mode=0o600):
    path.write_text(data);os.chmod(path,mode)
def analyze(raw):
    with wave.open(io.BytesIO(raw)) as w:
        channels,rate,width=w.getnchannels(),w.getframerate(),w.getsampwidth()
        pcm=w.readframes(w.getnframes())
    assert channels==1 and width==2 and rate>0 and len(pcm)>rate,'Invalid/too-short PCM audio'
    import array
    samples=array.array('h');samples.frombytes(pcm)
    rms=math.sqrt(sum(x*x for x in samples)/len(samples))
    assert rms>50,'Synthesized waveform is silent'
    return {'seconds':round(len(pcm)/(rate*channels*width),3),'sample_rate':rate,'rms':round(rms,1),'bytes':len(raw)}
def idle():
    code='const fs=require("fs");let n=0;for(const f of ["/proc/net/tcp","/proc/net/tcp6"]){for(const l of fs.readFileSync(f,"utf8").trim().split("\\n").slice(1)){const a=l.trim().split(/\\s+/);if(a[1].split(":")[1]===Number(8766).toString(16).toUpperCase()&&a[3]==="01")n++;}} console.log(n);process.exit(n?2:0)'
    run(['docker','exec','aural-relay-1','node','-e',code])
def main():
    backup=ROOT/'backups'/('before-kokoro-'+str(time.time_ns()));backup.mkdir(parents=True,mode=0o700)
    envpath=ROOT/'.env';apppath=ROOT/'compose.app.yaml'
    oldenv=envpath.read_text();oldapp=apppath.read_text()
    save(backup/'env',oldenv);save(backup/'compose.app.yaml',oldapp)
    env=dict(l.split('=',1) for l in oldenv.splitlines() if l and not l.startswith('#') and '=' in l)
    vip_before={n:json.loads(subprocess.check_output(['docker','inspect',n]))[0]['State']['Running'] for n in ['vip-api','vip-agent-1']}
    env.update({'COMPOSE_PROFILES':'kokoro','AURAL_TTS_BASE_URL':'http://aural-kokoro:8880/v1','AURAL_TTS_MODEL':'kokoro','AURAL_TTS_VOICE':'af_heart','AURAL_TTS_MAX_INPUT_CHARS':'160','AURAL_TTS_TIMEOUT_MS':'60000'})
    env['AURAL_TTS_API_KEY']=env.get('AURAL_TTS_API_KEY') or secrets.token_urlsafe(32)
    probe=subprocess.run(['docker','inspect','aural-kokoro-1'],capture_output=True,text=True)
    was_running=probe.returncode==0 and json.loads(probe.stdout)[0]['State']['Running']
    started=False;app_touched=False
    try:
        save(envpath,''.join(k+'='+v+'\n' for k,v in env.items()))
        apppath.write_text((ROOT/'compose.app.kokoro.yaml').read_text())
        run(COMPOSE+['config','--quiet'])
        started=True
        run(COMPOSE+['up','-d','--no-deps','--wait','--wait-timeout','240','kokoro'])
        c=json.loads(subprocess.check_output(['docker','inspect','aural-kokoro-1']))[0]
        assert c['HostConfig']['PortBindings'] in (None,{}) and c['Config']['User'] not in ('','root','0')
        ip=c['NetworkSettings']['Networks']['aural_private']['IPAddress']
        metrics=[]
        for text in ['Hello. Your self hosted Aural interviewer is ready.', 'Please explain how you would diagnose a slow application and measure whether your changes improved it.']:
            req=urllib.request.Request('http://'+ip+':8880/v1/audio/speech',data=json.dumps({'model':'kokoro','voice':'af_heart','input':text,'response_format':'wav'}).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+env['AURAL_TTS_API_KEY']})
            start=time.monotonic()
            with urllib.request.urlopen(req,timeout=90) as r:raw=r.read();assert r.status==200
            m=analyze(raw);m['wall_seconds']=round(time.monotonic()-start,3);metrics.append(m)
            (ROOT/'logs/kokoro-direct.wav').write_bytes(raw)
        print('PASS direct Kokoro actual waveform:',json.dumps(metrics),flush=True)
        idle() # Recheck immediately before recreating voice relay; fail closed on live connections.
        app_touched=True
        run(COMPOSE+['up','-d','--no-deps','--wait','--wait-timeout','180','web','relay'])
        access=json.loads((ROOT/'access.json').read_text())
        auth=base64.b64encode((access['http_username']+':'+access['http_password']).encode()).decode()
        req=urllib.request.Request(access['url']+'/api/voice/tts-s2s',data=json.dumps({'text':'Welcome to Aural. Please tell me about a challenging technical project you worked on.','language':'en'}).encode(),headers={'Content-Type':'application/json','Authorization':'Basic '+auth})
        start=time.monotonic()
        with urllib.request.urlopen(req,timeout=90) as r:
            raw=r.read();assert r.status==200
            assert r.headers.get('X-Aural-TTS-Provider')=='openai-compatible'
        app_audio=analyze(raw);app_audio['wall_seconds']=round(time.monotonic()-start,3)
        (ROOT/'logs/kokoro-aural.wav').write_bytes(raw)
        vip_after={n:json.loads(subprocess.check_output(['docker','inspect',n]))[0]['State']['Running'] for n in vip_before}
        assert vip_after==vip_before,'Unexpected VIP service state change'
        bifrost=json.loads(subprocess.check_output(['docker','inspect','vip-bifrost-1']))[0]
        bifrost_ip=bifrost['NetworkSettings']['Networks']['dev-ingress']['IPAddress']
        with urllib.request.urlopen('http://'+bifrost_ip+':8080/health',timeout=15) as r:assert r.status==200
        evidence={'direct':metrics,'aural_http_tts':app_audio,'voice':'af_heart','model':'kokoro','vip_app_states':vip_after,'bifrost_health':200}
        (ROOT/'logs/kokoro-verification.json').write_text(json.dumps(evidence,indent=2)+'\n')
        manifest=json.loads((ROOT/'deployment.json').read_text());manifest['tts']={'backend':'self-hosted-kokoro','voice':'af_heart','image':c['Config']['Image']}
        (ROOT/'deployment.json').write_text(json.dumps(manifest,indent=2)+'\n')
        print('PASS public Aural TTS actual audio:',json.dumps(app_audio),flush=True)
    except Exception:
        save(envpath,oldenv);apppath.write_text(oldapp)
        if app_touched:run(COMPOSE+['up','-d','--no-deps','--wait','--wait-timeout','180','web','relay'])
        if started and not was_running:subprocess.run(['docker','stop','aural-kokoro-1'],stdout=subprocess.DEVNULL)
        elif started and was_running:run(COMPOSE+['up','-d','--no-deps','--wait','--wait-timeout','180','kokoro'])
        print('Restored prior Aural settings; VIP untouched.',flush=True)
        raise
if __name__=='__main__':
    result=1
    try:main();result=0
    finally:(ROOT/'logs/kokoro-enable.exit').write_text(str(result)+'\n')
