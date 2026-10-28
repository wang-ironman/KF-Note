import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const server = spawn(process.execPath, ['prototype/server.mjs'], {
  env: { ...process.env, PORT: '4177' }, stdio: 'ignore',
});
let browser;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { ready = (await fetch('http://localhost:4177')).ok; } catch {}
    if (ready) break;
    await delay(100);
  }
  assert.ok(ready, 'test server did not start');
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge' });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = [];
  let acceptConfirmation = true;
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', async dialog => {
    if (dialog.type() === 'confirm') {
      if (acceptConfirmation) await dialog.accept(); else await dialog.dismiss();
    } else await dialog.accept();
  });
  await page.addInitScript(() => {
    let state = JSON.parse(localStorage.getItem('location-test-state') || 'null');
    window.nativeCalls = [];
    window.locationResult = { latitude: 31.2304, longitude: 121.4737, accuracy: 12 };
    window.locationFailure = false;
    const persist = () => localStorage.setItem('location-test-state', JSON.stringify(state));
    window.KFNative = {
      storage(json) {
        const request = JSON.parse(json);
        let value = null;
        if (request.action === 'loadState') value = state;
        if (request.action === 'saveState') { state = request.state; persist(); }
        return JSON.stringify({ ok: true, value });
      },
      platform(json) {
        const request = JSON.parse(json);
        window.nativeCalls.push(request);
        setTimeout(() => {
          if (request.action === 'location' && window.locationFailure) {
            window.KFNativeReply(request.id, { ok: false, error: '定位权限被拒绝' });
          } else {
            const value = request.action === 'location' ? window.locationResult : null;
            window.KFNativeReply(request.id, { ok: true, value });
          }
        }, 5);
      },
    };
  });
  await page.goto('http://localhost:4177');
  await page.locator('[data-mode="rent"]').first().click();
  await page.locator('[data-page="settings"]:visible').first().click();
  await page.locator('[data-action="add-target"]').click();
  let form = page.locator('form[data-form="target"]');
  await form.locator('[name="name"]').fill('测试公司');
  await form.locator('[name="address"]').fill('上海市浦东新区');
  await form.locator('[data-action="target-location"]').click();
  await page.waitForFunction(() => document.querySelector('form[data-form="target"] [name="lat"]')?.value === '31.2304');
  assert.equal(await form.locator('[name="lat"]').inputValue(), '31.2304');
  assert.equal(await form.locator('[name="lng"]').inputValue(), '121.4737');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('location-test-state')).settings.targets.length), 0,
    'location confirmation should fill the form without saving the target');
  await form.locator('button.primary').click();
  let state = await page.evaluate(() => JSON.parse(localStorage.getItem('location-test-state')));
  const targetId = state.settings.targets[0].id;
  assert.deepEqual([state.settings.targets[0].lat, state.settings.targets[0].lng], [31.2304, 121.4737]);

  await page.locator('[data-edit-target]').click();
  form = page.locator('form[data-form="target"]');
  await form.locator('[name="address"]').fill('不应写入的地址');
  await page.evaluate(() => { window.locationResult = { latitude: 35, longitude: 120, accuracy: 7 }; });
  acceptConfirmation = false;
  await form.locator('[data-action="target-location"]').click();
  assert.equal(await form.locator('[name="lat"]').inputValue(), '31.2304', 'cancelled confirmation changed latitude');
  assert.equal(await form.locator('[name="lng"]').inputValue(), '121.4737', 'cancelled confirmation changed longitude');
  acceptConfirmation = true;
  await page.evaluate(() => { window.locationFailure = true; });
  await form.locator('[data-action="target-location"]').click();
  assert.equal(await form.locator('[name="lat"]').inputValue(), '31.2304', 'location denial changed latitude');
  assert.equal(await form.locator('[name="lng"]').inputValue(), '121.4737', 'location denial changed longitude');
  await form.locator('[data-action="close-modal"]').click();
  state = await page.evaluate(() => JSON.parse(localStorage.getItem('location-test-state')));
  assert.equal(state.settings.targets[0].address, '上海市浦东新区', 'cancelled target edit changed saved address');

  await page.locator('[data-page="list"]:visible').first().click();
  await page.locator('[data-page="new"]:visible').first().click();
  const newHouse = page.locator('#new-house');
  await newHouse.locator('[name="name"]').fill('定位房源');
  await page.evaluate(() => { window.locationFailure = false; window.locationResult = { latitude: 30.25, longitude: 120.17, accuracy: 9 }; });
  await newHouse.locator('[data-action="location"]').click();
  await page.waitForFunction(() => document.querySelector('#new-house [name="lat"]')?.value === '30.25');
  assert.equal(await newHouse.locator('[name="lat"]').inputValue(), '30.25');
  assert.equal(await newHouse.locator('[name="lng"]').inputValue(), '120.17');
  await newHouse.locator('button.primary').click();
  await page.getByRole('heading', { name: '定位房源' }).waitFor();
  await page.locator('[data-tab="basic"]').click();
  state = await page.evaluate(() => JSON.parse(localStorage.getItem('location-test-state')));
  let house = state.houses[0];
  assert.deepEqual([house.lat, house.lng], [30.25, 120.17], 'new-house coordinates were not persisted');
  assert.equal(await page.locator('[data-navigate-house]').count(), 1);
  await page.locator('[data-action="location"]').click();
  await page.locator('[data-navigate-house]').waitFor();
  state = await page.evaluate(() => JSON.parse(localStorage.getItem('location-test-state')));
  house = state.houses[0];
  assert.deepEqual([house.lat, house.lng], [30.25, 120.17], 'existing-house location action did not save current position');

  await page.locator('[data-navigate-house]').click();
  await page.waitForFunction(() => window.nativeCalls.some(call => call.action === 'amapNavigate'));
  const navHouse = await page.evaluate(() => window.nativeCalls.find(call => call.action === 'amapNavigate'));
  assert.deepEqual({ latitude: navHouse.latitude, longitude: navHouse.longitude, name: navHouse.name },
    { latitude: 30.25, longitude: 120.17, name: '定位房源' });

  await page.locator('[data-page="settings"]:visible').first().click();
  await page.locator('[data-navigate-target]').click();
  await page.waitForFunction(() => window.nativeCalls.filter(call => call.action === 'amapNavigate').length === 2);
  const navTarget = await page.evaluate(() => window.nativeCalls.filter(call => call.action === 'amapNavigate')[1]);
  assert.deepEqual({ latitude: navTarget.latitude, longitude: navTarget.longitude, name: navTarget.name },
    { latitude: 31.2304, longitude: 121.4737, name: '测试公司' });

  await page.locator('[data-action="add-target"]').click();
  form = page.locator('form[data-form="target"]');
  await form.locator('[name="name"]').fill('无坐标目标');
  await form.locator('button.primary').click();
  const row = page.locator('.target-row').filter({ hasText: '无坐标目标' });
  assert.equal(await row.locator('[data-navigate-target]').count(), 0, 'target without coordinates exposed navigation');
  await page.locator(`[data-edit-target="${targetId}"]`).click();
  form = page.locator('form[data-form="target"]');
  await form.locator('[name="lat"]').fill('');
  await form.locator('[name="lng"]').fill('');
  await form.locator('button.primary').click();
  const cleared = page.locator('.target-row').filter({ hasText: '测试公司' });
  assert.equal(await cleared.locator('[data-navigate-target]').count(), 0, 'clearing coordinates kept navigation enabled');
  await page.reload();
  await page.locator('[data-page="settings"]:visible').first().click();
  await page.locator(`[data-edit-target="${targetId}"]`).click();
  form = page.locator('form[data-form="target"]');
  assert.equal(await form.locator('[name="lat"]').inputValue(), '', 'cleared target coordinates returned after reopening');
  assert.equal(await form.locator('[name="lng"]').inputValue(), '', 'cleared target coordinates returned after reopening');
  await form.locator('[data-action="close-modal"]').click();
  assert.deepEqual(errors, [], `browser runtime errors: ${errors.join('; ')}`);
  console.log('Location browser integration passed: target save/cancel/denial, house creation/basic GPS, and Amap payloads.');
} finally {
  await browser?.close();
  server.kill();
}
