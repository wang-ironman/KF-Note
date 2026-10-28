import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const server = spawn(process.execPath, ['prototype/server.mjs'], { env: { ...process.env, PORT: '4175' }, stdio: 'ignore' });
let browser;
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch('http://localhost:4175')).ok) break; } catch {} await delay(100); }
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge' });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    let state = JSON.parse(localStorage.getItem('native-state') || 'null');
    let photos = JSON.parse(localStorage.getItem('native-photos') || '{}');
    const snapshots = new Map(), imports = new Map();
    const persist = () => { localStorage.setItem('native-state', JSON.stringify(state)); localStorage.setItem('native-photos', JSON.stringify(photos)); };
    window.nativeCalls = [];
    window.KFNative = {
      storage(json) {
        const q = JSON.parse(json); window.nativeCalls.push(q.action);
        try {
          let value = null;
          if (q.action === 'loadState') value = state;
          if (q.action === 'saveState') { state = q.state; persist(); }
          if (q.action === 'putPhoto') { state = q.state; photos[q.metadata.id] = { base64: q.base64, type: q.metadata.type }; persist(); }
          if (q.action === 'putPickedMedia') { if(q.token!=='recorded-token') throw Error('Invalid recorder token'); state=q.state;photos[q.metadata.id]={base64:'AQID',type:q.metadata.type};persist(); }
          if (q.action === 'getPhoto') value = photos[q.id] || null;
          if (q.action === 'openSnapshot') { snapshots.set('snapshot', structuredClone({ state, photos })); value = { token: 'snapshot', state }; }
          if (q.action === 'snapshotPhoto') value = snapshots.get(q.token).photos[q.id];
          if (q.action === 'closeSnapshot') snapshots.delete(q.token);
          if (q.action === 'beginImport') { imports.set('import', {}); value = { token: 'import' }; }
          if (q.action === 'stagePhoto') { if (window.failStage) throw Error('模拟文件写入失败'); imports.get(q.token)[q.metadata.id] = { base64: q.base64, type: q.metadata.type }; }
          if (q.action === 'commitImport') { state = q.state; photos = imports.get(q.token); imports.delete(q.token); persist(); }
          if (q.action === 'abortImport') imports.delete(q.token);
          if (q.action === 'estimateStorage') value = { usage: 1024, quota: 102400 };
          return JSON.stringify({ ok: true, value });
        } catch (e) { return JSON.stringify({ ok: false, error: e.message }); }
      },
      platform(json) {
        const q = JSON.parse(json);window.nativeCalls.push(q.action);
        const value = ['pickPhotos','pickMedia'].includes(q.action) ? [{ name: 'sample.png', type: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMwKPr2HwAFBgKYNw0+bwAAAABJRU5ErkJggg==' }] : q.action==='takeVideo'?(window.takeVideoReply||null):null;
        setTimeout(() => window.KFNativeReply(q.id, { ok: true, value }), 5);
      }
    };
  });
  page.on('dialog', dialog => dialog.accept());
  await page.goto('http://localhost:4175');
  await page.locator('[data-mode="rent"]').first().click();
  await page.locator('[data-page="new"]').first().click();
  await page.locator('#new-house [name="name"]').fill('安卓桥测试房源');
  await page.locator('#new-house button[type="submit"], #new-house button:not([type])').last().click();
  await page.getByRole('heading', { name: '安卓桥测试房源' }).waitFor();
  await page.locator('[data-action="choose-photo"]').click();
  await page.locator('[data-photo]').first().waitFor();
  const beforeRecording=await page.evaluate(()=>localStorage.getItem('native-state'));await page.locator('[data-action="take-video"]').click();await page.waitForFunction(()=>!document.querySelector('#app').inert);assert.equal(await page.evaluate(()=>localStorage.getItem('native-state')),beforeRecording,'Cancel recording creates no record');
  await page.evaluate(()=>window.takeVideoReply={token:'recorded-token',name:'现场录像.mp4',type:'video/mp4',size:3});await page.locator('[data-action="take-video"]').click();await page.locator('.video-tile').waitFor();const recorded=await page.evaluate(()=>({state:JSON.parse(localStorage.getItem('native-state')),calls:window.nativeCalls}));assert.equal(recorded.state.photos.filter(p=>p.type==='video/mp4').length,1);assert.ok(recorded.calls.includes('takeVideo'));assert.ok(recorded.calls.includes('putPickedMedia'));assert.ok(recorded.calls.includes('discardPickedMedia'));
  await page.reload();
  await page.getByText('安卓桥测试房源', { exact: true }).first().click();
  await page.locator('[data-photo]').first().waitFor();
  const result = await page.evaluate(async () => {
    const storage = await import('/storage.mjs');
    const before = await storage.loadState();
    const backup = await storage.exportBackup();
    const restored = await storage.importBackup(backup);
    window.failStage = true;
    let failed = false;
    try { await storage.importBackup(backup); } catch (e) { failed = e.message.includes('模拟文件写入失败'); }
    window.failStage = false;
    return { roundtrip: JSON.stringify(restored) === JSON.stringify(before), failed, preserved: JSON.stringify(await storage.loadState()) === JSON.stringify(before), calls: window.nativeCalls };
  });
  assert.equal(result.roundtrip, true); assert.equal(result.failed, true); assert.equal(result.preserved, true);
  for (const action of ['openSnapshot', 'snapshotPhoto', 'closeSnapshot', 'beginImport', 'stagePhoto', 'commitImport', 'abortImport']) assert.ok(result.calls.includes(action), action);
  await page.locator('[data-open-photo]').first().click();
  assert.equal(await page.evaluate(() => window.KFAndroidBack()), true);
  await page.locator('#modal').waitFor({ state: 'hidden' });
  await page.locator('[data-page="settings"]:visible').first().click();
  await page.getByText('数据保存在本机应用内，不上传云端。').waitFor();
  await page.locator('[data-action="export"]').click();
  await page.waitForFunction(() => !document.querySelector('#app').inert);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('native-state')).settings.lastBackupAt), null);
  assert.deepEqual(errors, []);
  console.log('Native JS integration passed (mock host): photos, video recording/cancel/staged commit, ZIP roundtrip, aborted import, back, export cancellation.');
} finally { await browser?.close(); server.kill(); }
