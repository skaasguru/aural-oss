// Live dev-stack smoke. Requires Playwright 1.58.2, Chromium and protected /run/access.json.
// Run in the Playwright container with this file mounted at /qa/verify-browser.mjs.
// Requires real successful synthesis and browser decode/playback; no mocked provider audio.
import fs from 'node:fs';
import { chromium } from 'playwright';
(async () => {
  const a = JSON.parse(fs.readFileSync('/run/access.json', 'utf8'));
  const browser = await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required']});
  try {
    const context = await browser.newContext({httpCredentials:{username:a.http_username,password:a.http_password,origin:a.url}, viewport:{width:1440,height:1000}});
    const page = await context.newPage();
    const failures=[];
    page.on('pageerror', error => failures.push(error.message));
    await page.goto(a.url+'/login', {waitUntil:'networkidle',timeout:60000});
    await page.fill('#email',a.email);
    await page.fill('#password',a.password);
    await page.click('button[type=submit]');
    await page.waitForURL('**/dashboard', {timeout:60000});
    await page.waitForLoadState('networkidle');
    await page.locator('main').waitFor({timeout:30000});
    const text=await page.locator('body').innerText();
    if (/Application error|Internal Server Error/.test(text)) throw new Error('Dashboard returned an error page');
    const socket=await page.evaluate(async () => {
      const audio=new AudioContext({sampleRate:24000});
      await audio.resume();
      return await new Promise((resolve,reject) => {
        const ws=new WebSocket('wss://aural.dev.skaaslabs.com/ws/voice');
        ws.binaryType='arraybuffer';
        const started=performance.now();
        let bytes=0,active=0,played=0,done=false,utteranceId='',firstAudio=0,cursor=0,energy=0;
        const stop=(error) => {clearTimeout(timer);ws.close();audio.close();reject(error);};
        const finish=() => {
          if(!done || active) return;
          if(!bytes || energy===0) return stop(new Error('Relay returned no audible PCM'));
          clearTimeout(timer);
          ws.send(JSON.stringify({type:'playback_ended',utteranceId}));
          ws.close();audio.close();
          resolve({opened:true,receivedPCMBytes:bytes,playedChunks:played,firstAudioSeconds:Number((firstAudio/1000).toFixed(3)),browserPlayback:true});
        };
        const timer=setTimeout(()=>stop(new Error('Relay greeting/audio playback timeout')),180000);
        ws.onopen=()=>ws.send(JSON.stringify({type:'init',context:{title:'Speech check',aiName:'Aural',aiTone:'friendly',language:'en',followUpDepth:'low',questions:[{text:'Please say hello.',type:'OPEN_ENDED',order:0}]}}));
        ws.onerror=()=>stop(new Error('WebSocket handshake failed'));
        ws.onmessage=event=>{
          if(event.data instanceof ArrayBuffer){
            if(!firstAudio) firstAudio=performance.now()-started;
            const data=new DataView(event.data),samples=data.byteLength/2;
            const buffer=audio.createBuffer(1,samples,24000),channel=buffer.getChannelData(0);
            for(let i=0;i<samples;i++){const sample=data.getInt16(i*2,true)/32768;channel[i]=sample;energy+=sample*sample;}
            bytes+=data.byteLength;
            const source=audio.createBufferSource();source.buffer=buffer;source.connect(audio.destination);
            cursor=Math.max(cursor,audio.currentTime+0.02);active++;
            source.onended=()=>{active--;played++;finish();};source.start(cursor);cursor+=buffer.duration;
          }else{
            const message=JSON.parse(event.data);
            if(message.type==='error') return stop(new Error('Relay initialization failed'));
            if(message.type==='tts_ended'){done=true;utteranceId=message.utteranceId;finish();}
          }
        };
      });
    });
    const gen=await context.request.post(a.url+'/api/ai/generate',{data:{description:'Generate one technical interview question about the Node.js event loop. Deployment verification only.',durationMinutes:1,language:'en'},timeout:120000});
    const events=(await gen.text()).split('\n').filter(x=>x.startsWith('data: ')).map(x=>JSON.parse(x.slice(6)));
    const generated=events.find(x=>x.type==='done');
    if(gen.status()!==200 || !generated?.data?.questions?.length) throw new Error('Live Aural AI generation failed');
    const tts=await context.request.post(a.url+'/api/voice/tts-s2s',{data:{text:'Aural live voice verification.',language:'en'},timeout:90000});
    const ttsStatus=tts.status();
    if(ttsStatus!==200) throw new Error('TTS must succeed, HTTP '+ttsStatus);
    const wav=await tts.body();
    if(wav.subarray(0,4).toString()!=='RIFF') throw new Error('TTS did not return WAV audio');
    fs.writeFileSync('/qa/kokoro-aural.wav',wav);
    const ttsAudio=await page.evaluate(async base64=>{
      const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
      const audio=new AudioContext();const decoded=await audio.decodeAudioData(bytes.buffer);
      const channel=decoded.getChannelData(0);let energy=0;for(const sample of channel)energy+=sample*sample;
      const result={duration:decoded.duration,channels:decoded.numberOfChannels,rms:Math.sqrt(energy/channel.length)};
      await audio.close();return result;
    },wav.toString('base64'));
    if(ttsAudio.duration<0.5 || ttsAudio.rms<0.001) throw new Error('Browser decoded silent/invalid audio');
    await page.screenshot({path:'/qa/dashboard.png',fullPage:true});
    const result={login:true,dashboard:true,websocket:socket.opened,relayAudio:socket,liveQuestionGeneration:true,generatedQuestions:generated.data.questions.length,ttsStatus,ttsAudio,pageErrors:failures,url:page.url()};
    fs.writeFileSync('/qa/result.json',JSON.stringify(result,null,2));
    console.log(JSON.stringify(result));
    if(failures.length) throw new Error('Browser page errors detected');
    await context.close();
  } finally {await browser.close();}
})().catch(error=>{console.error(error.message);process.exit(1);});
