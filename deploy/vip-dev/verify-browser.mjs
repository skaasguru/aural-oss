// Live dev-stack smoke. Requires Playwright 1.58.2, Chromium and protected /run/access.json.
// Run in the Playwright container with this file mounted at /qa/verify-browser.mjs.
// The JSON result explicitly records a blocked TTS response; exit 0 does NOT prove speech synthesis.
import fs from 'node:fs';
import { chromium } from 'playwright';
(async () => {
  const a = JSON.parse(fs.readFileSync('/run/access.json', 'utf8'));
  const browser = await chromium.launch({headless:true});
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
    const socket=await page.evaluate(() => new Promise((resolve,reject) => {
      const ws=new WebSocket('wss://aural.dev.skaaslabs.com/ws/voice');
      const timer=setTimeout(()=>{ws.close();reject(new Error('WebSocket handshake timeout'));},15000);
      ws.onopen=()=>{clearTimeout(timer);ws.close();resolve({opened:true});};
      ws.onerror=()=>{clearTimeout(timer);reject(new Error('WebSocket handshake failed'));};
    }));
    const gen=await context.request.post(a.url+'/api/ai/generate',{data:{description:'Generate one technical interview question about the Node.js event loop. Deployment verification only.',durationMinutes:1,language:'en'},timeout:120000});
    const events=(await gen.text()).split('\n').filter(x=>x.startsWith('data: ')).map(x=>JSON.parse(x.slice(6)));
    const generated=events.find(x=>x.type==='done');
    if(gen.status()!==200 || !generated?.data?.questions?.length) throw new Error('Live Aural AI generation failed');
    const tts=await context.request.post(a.url+'/api/voice/tts-s2s',{data:{text:'Aural live voice verification.',language:'en'},timeout:90000});
    const ttsStatus=tts.status();
    if(![200,502].includes(ttsStatus)) throw new Error('Unexpected TTS route status '+ttsStatus);
    await page.screenshot({path:'/qa/dashboard.png',fullPage:true});
    const result={login:true,dashboard:true,websocket:socket.opened,liveQuestionGeneration:true,generatedQuestions:generated.data.questions.length,ttsStatus,pageErrors:failures,url:page.url()};
    fs.writeFileSync('/qa/result.json',JSON.stringify(result,null,2));
    console.log(JSON.stringify(result));
    if(failures.length) throw new Error('Browser page errors detected');
    await context.close();
  } finally {await browser.close();}
})().catch(error=>{console.error(error.message);process.exit(1);});
