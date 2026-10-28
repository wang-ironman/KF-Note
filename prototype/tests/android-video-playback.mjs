// Disposable emulator only. Fixtures are generated in .tools with ffmpeg:
// video-fixture.mp4: H.264, faststart; video-gallery-tail.mp4: H.264/AAC, moov at end;
// video-gallery-hevc.mp4: HEVC Main 10/AAC, faststart.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {createHouse} from '../core.mjs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.connectOverCDP(process.env.ANDROID_CDP_URL||'http://127.0.0.1:9223',{noDefaults:true});
try {
 const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().startsWith('https://app.kfnote.local/'));assert.ok(page);page.setDefaultTimeout(10000);
 const call=q=>page.evaluate(q=>{const r=JSON.parse(KFNative.storage(JSON.stringify(q)));if(!r.ok)throw Error(r.error);return r.value;},q);
 await page.waitForFunction(()=>!!window.KFNative);let state=await call({action:'loadState'});if(process.argv.includes('--cold'))assert.deepEqual(state,JSON.parse(fs.readFileSync('.tools/capture-cold-before.json','utf8')),'Cold restart must retain exact saved state');let h=state.houses.find(h=>h.name==='视频格式诊断样本');
 if(!h){h=createHouse('rent',{name:'视频格式诊断样本'});state.houses.push(h);state.settings.mode='rent';await call({action:'saveState',state});}
 const files=['video-fixture.mp4','video-gallery-tail.mp4','video-gallery-hevc.mp4'];
 for(const filename of files){if(state.photos.some(p=>p.houseId===h.id&&p.filename===filename))continue;const bytes=fs.readFileSync('.tools/'+filename);const metadata={id:crypto.randomUUID(),houseId:h.id,visitId:h.visits[0].id,sectionKey:'whole',filename,caption:'',type:'video/mp4',size:bytes.length,createdAt:new Date().toISOString()};state.photos.push(metadata);await call({action:'putPhoto',state,metadata,base64:bytes.toString('base64')});}
 await page.reload();await page.getByText(h.name,{exact:true}).first().click();const errors=[],requests=[],responses=[],failures=[],reports=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().includes('/media/'))requests.push({url:r.url(),range:r.headers().range});});page.on('response',r=>{if(r.url().includes('/media/'))responses.push({url:r.url(),status:r.status(),headers:r.headers()});});page.on('requestfailed',r=>{if(r.url().includes('/media/')&&r.failure()?.errorText!=='net::ERR_ABORTED')failures.push(r.failure());});
 for(const filename of files){const metadata=state.photos.find(p=>p.houseId===h.id&&p.filename===filename);await page.locator(`[data-open-photo="${metadata.id}"]`).click();await page.waitForFunction(()=>document.querySelector('video')?.error||document.querySelector('video')?.readyState>=1);assert.equal(await page.locator('video').evaluate(v=>v.error?.message||null),null,filename);
  await page.locator('video').evaluate(async v=>{v.muted=true;await v.play();});await page.waitForFunction(()=>document.querySelector('video').currentTime>.2);await page.locator('video').evaluate(v=>{v.pause();v.currentTime=v.duration*.8;});await page.waitForFunction(()=>{const v=document.querySelector('video');return !v.seeking&&v.currentTime>=v.duration*.79;});await page.locator('video').evaluate(v=>v.currentTime=.1);await page.waitForFunction(()=>{const v=document.querySelector('video');return !v.seeking&&v.currentTime<.2;});
  reports.push({filename,...await page.locator('video').evaluate(v=>({duration:v.duration,readyState:v.readyState,error:v.error?.message||null}))});await page.locator('[data-action="close-modal"]').click();
 }
 const tail=state.photos.find(p=>p.houseId===h.id&&p.filename==='video-gallery-tail.mp4');assert.ok(requests.some(r=>r.url.endsWith(tail.id)&&/^bytes=[1-9]\d*-/.test(r.range||'')),'MP4 tail metadata must request a nonzero file range');assert.ok(responses.some(r=>r.url.endsWith(tail.id)&&r.status===206&&/^bytes [1-9]\d*-/.test(r.headers['content-range']||'')),'Nonzero range must receive the correct partial response');assert.deepEqual(failures,[]);assert.deepEqual(errors,[]);assert.deepEqual(await call({action:'loadState'}),state,'Playback must not change saved records');
 fs.writeFileSync('prototype/test-results/android-video-playback.json',JSON.stringify({result:'PASS',reports,requests,responses,failures,errors},null,2));console.log('Android video regression passed: H.264/AAC tail metadata, faststart, HEVC Main 10, nonzero Range responses, forward/backward seek and unchanged saved state.');
}finally{await browser.close();}
