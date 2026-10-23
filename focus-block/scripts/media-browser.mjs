const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const profile = await mkdtemp(path.join(os.tmpdir(),'focusblock-media-'));
const ext = fileURLToPath(new URL('../', import.meta.url));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.BROWSER_EXECUTABLE || undefined, // Playwright normally suppresses all audio output, which also disables the
  // browser's audible-tab signal. Keep that signal enabled for this test.
  headless:true, ignoreDefaultArgs: ['--mute-audio'],
  args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required'],
});
try {
  let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const wav = Buffer.alloc(44+16000*20);
  wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
  for(let i=44;i<wav.length;i+=2)wav.writeInt16LE(Math.round(5000*Math.sin((i-44)/2*2*Math.PI*440/8000)),i);
  await context.route('http://**.test/**',async route=>{
    const url = new URL(route.request().url());
    if(url.pathname==='/sound.wav')return route.fulfill({contentType:'audio/wav',body:wav});
    const body = url.pathname === '/work' ? '<h1>Work</h1>' : url.pathname === '/embed' ? '<iframe src="http://player.test/media"></iframe>' : '<audio id="player" autoplay loop src="/sound.wav"></audio>';
    await route.fulfill({contentType:'text/html',body:`<!doctype html><html><body>${body}</body></html>`});
  });
  const options = await context.newPage();
  const errors=[];options.on('pageerror',e=>errors.push(e.message));
  await options.goto(`chrome-extension://${id}/options/options.html`);
  await options.waitForFunction(()=>document.querySelector('#historyStatus').textContent==='');
  const media = await context.newPage();await media.goto('http://video.test/media');
  await media.waitForFunction(()=>document.querySelector('audio').currentTime>0);
  const work = await context.newPage();await work.goto('http://work.test/work');await work.bringToFront();
  const read = () => worker.evaluate(()=>chrome.storage.local.get(['mediaUsage','usage']));
  const siteTime = (data,site) => Object.values(data.mediaUsage||{}).reduce((a,b)=>a+(b[site]||0),0);
  await options.waitForTimeout(6500);
  let data=await read();
  assert.ok(siteTime(data,'video.test')>=4, JSON.stringify(data));
  console.log('PASS: real audio plays and records in a background tab');
  await media.evaluate(()=>{document.querySelector('audio').pause()});
  await options.waitForTimeout(3000);
  await options.evaluate(()=>chrome.runtime.sendMessage({type:'getStats'}));
  const stopped=siteTime(await read(),'video.test');
  await options.waitForTimeout(2500);
  await options.evaluate(()=>chrome.runtime.sendMessage({type:'getStats'}));
  assert.ok(siteTime(await read(),'video.test')-stopped<1);
  console.log('PASS: paused audio stops accumulating');
  // Muted HTML playback cannot rely on the audible-tab fallback.
  await media.evaluate(()=>{const a=document.querySelector('audio');a.muted=true;return a.play()});
  await work.bringToFront();await options.waitForTimeout(6000);
  assert.ok(siteTime(await read(),'video.test')-stopped>=4);
  console.log('PASS: muted background HTML media is measured by actual progress');
  const embedded=await context.newPage();await embedded.goto('http://host.test/embed');
  await work.bringToFront();await options.waitForTimeout(6000);
  data=await read();assert.ok(siteTime(data,'host.test')>=3);assert.equal(siteTime(data,'player.test'),0);
  console.log('PASS: cross-origin embedded player is attributed to the host website');
  const video=await context.newPage(); await video.goto('http://silent-video.test/work');
  await video.evaluate(async()=>{
    const canvas=document.createElement('canvas'); canvas.width=64;canvas.height=64;
    const ctx=canvas.getContext('2d'), stream=canvas.captureStream(15);
    const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'}), chunks=[];
    recorder.ondataavailable=e=>chunks.push(e.data);
    const done=new Promise(resolve=>recorder.onstop=resolve);
    recorder.start(); let frame=0;
    const timer=setInterval(()=>{ctx.fillStyle=frame++%2?'red':'blue';ctx.fillRect(0,0,64,64)},60);
    await new Promise(resolve=>setTimeout(resolve,3000)); recorder.stop();await done;clearInterval(timer);
    stream.getTracks().forEach(track=>track.stop());
    const player=document.createElement('video');player.muted=true;player.loop=true;
    player.src=URL.createObjectURL(new Blob(chunks,{type:'video/webm'}));
    document.body.append(player);await player.play();
  });
  await work.bringToFront();await options.waitForTimeout(6000);
  assert.ok(siteTime(await read(),'silent-video.test')>=3);
  console.log('PASS: actual silent video is tracked while another tab has focus');
  const webAudio=await context.newPage();await webAudio.goto('http://webaudio.test/work');
  await webAudio.evaluate(async()=>{
    window.audioContext=new AudioContext();await audioContext.resume();
    window.oscillator=audioContext.createOscillator();
    const gain=audioContext.createGain();gain.gain.value=0.1;
    oscillator.connect(gain).connect(audioContext.destination);oscillator.start();
  });
  await work.bringToFront();await options.waitForTimeout(6000);
  await options.evaluate(()=>chrome.runtime.sendMessage({type:'getStats'}));
  assert.ok(siteTime(await read(),'webaudio.test')>=4);
  await webAudio.evaluate(()=>{oscillator.stop();return audioContext.close()});
  console.log('PASS: Web Audio without HTML media uses browser audio detection');
  await options.bringToFront();await options.click('#refreshStats');
  assert.equal(await options.locator('#historyMetric').count(),0);
  await options.waitForFunction(()=>document.querySelector('#historySitesPie').textContent.includes('video.test'));
  assert.match(await options.locator('#historyDaySummary').innerText(),/total/);
  assert.equal(await options.locator('#historySummary .stat-label').nth(0).textContent(),'Total usage');
  const popup=await context.newPage();await popup.goto(`chrome-extension://${id}/popup/popup.html`);await popup.click('[data-tab="stats"]');
  assert.equal(await popup.locator('#statsMetric').count(),0);
  await popup.waitForFunction(()=>document.querySelector('#topSites').textContent.includes('video.test'));
  assert.equal(await popup.locator('#todayMetricLabel').textContent(),'Total today');
  assert.deepEqual(errors,[]);
  console.log('PASS: real extension options + popup show combined usage statistics');
  await options.evaluate(()=>chrome.runtime.sendMessage({type:'setSetting',key:'trackUsage',value:false}));
  const before=siteTime(await read(),'video.test');await options.waitForTimeout(6000);
  assert.equal(siteTime(await read(),'video.test'),before);
  await options.evaluate(()=>chrome.runtime.sendMessage({type:'clearStats'}));
  assert.deepEqual((await read()).mediaUsage,{});
  console.log('PASS: disabling tracking stops media and clearing removes media history');
} finally {await context.close();await rm(profile,{recursive:true,force:true});}
