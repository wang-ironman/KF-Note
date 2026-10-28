// Run only against the disposable KF Note emulator, via its forwarded WebView port.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFile, mkdir } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.connectOverCDP(process.env.ANDROID_CDP_URL || 'http://localhost:9222', { noDefaults: true });
const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith('https://app.kfnote.local/'));
assert.ok(page, 'The disposable emulator must have KF Note open');
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const fixturePNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMwKPr2HwAFBgKYNw0+bwAAAABJRU5ErkJggg==';
async function state() {
  return page.evaluate(() => {
    const result = JSON.parse(window.KFNative.storage(JSON.stringify({ action: 'loadState' })));
    if (!result.ok) throw Error(result.error);
    return result.value;
  });
}
async function installSystemFixtures() {
  await page.evaluate(base64 => {
    const bridge = window.KFNative;
    window.confirm = () => true;
    window.KFNative = {
      storage(json) { return bridge.storage(json); },
      platform(json) {
        const q = JSON.parse(json);
        let value;
        if (['pickPhotos','pickMedia'].includes(q.action)) value = [{ name: 'android-test.png', type: 'image/png', base64 }];
        else if (q.action === 'exportBackup') { window.androidTestBackup = q.base64; value = { saved: true }; }
        else if (q.action === 'importBackup') value = { name: 'android-test.zip', base64: window.androidTestBackup };
        else { bridge.platform(json); return; }
        setTimeout(() => window.KFNativeReply(q.id, { ok: true, value }), 10);
      }
    };
  }, fixturePNG);
}
async function saved() { await page.locator('#save-state').getByText('已保存到本机').waitFor(); }
async function createHouse(name) {
  await page.locator('[data-page="list"]:visible').first().click();
  await page.locator('[data-page="new"]:visible').first().click();
  await page.locator('#new-house [name="name"]').fill(name);
  await page.locator('#new-house [name="price"]').fill('2200');
  await page.locator('#new-house [name="area"]').fill('65');
  await page.locator('#new-house button[type="submit"], #new-house button:not([type])').last().click();
  await page.getByRole('heading', { name }).waitFor(); await saved();
}
try {
  await page.locator('[data-mode="rent"]:visible').first().waitFor();
  assert.equal((await state()).houses.length, 0, 'Use a fresh disposable emulator only');
  await page.locator('[data-mode="rent"]:visible').first().click();
  await installSystemFixtures();
  await createHouse('安卓测试房源 A');
  await page.locator('[data-action="choose-photo"]').click();
  await page.waitForFunction(() => document.querySelector('[data-photo]')?.naturalWidth > 0);
  await page.locator('[data-scope="note"][data-field="text"]').fill('整屋采光好，厨房需要确认。');
  await saved();
  const original = await state();
  assert.equal(original.photos.length, 1);
  const photo = await page.evaluate(id => JSON.parse(window.KFNative.storage(JSON.stringify({ action: 'getPhoto', id }))).value, original.photos[0].id);
  assert.equal(photo.base64, fixturePNG, 'Native files must preserve the original PNG');
  await page.reload();
  await page.getByText('安卓测试房源 A', { exact: true }).first().click();
  await page.waitForFunction(() => document.querySelector('[data-photo]')?.naturalWidth > 0);
  await page.locator('[data-open-photo]').first().click();
  await page.waitForFunction(() => document.querySelector('.modal-photo')?.naturalWidth === 1);
  assert.equal(await page.evaluate(() => window.KFAndroidBack()), true);
  await page.locator('#modal').waitFor({ state: 'hidden' });
  await installSystemFixtures();
  await createHouse('安卓测试房源 B');
  await page.locator('[data-page="list"]:visible').first().click();
  for (const box of await page.locator('input[data-compare]').all()) await box.check();
  assert.equal((await state()).compare.rent.length, 2);
  await page.locator('[data-page="compare"]:visible').first().click();
  await page.getByText('安卓测试房源 A', { exact: true }).first().waitFor();
  await page.getByText('安卓测试房源 B', { exact: true }).first().waitFor();
  await page.locator('[data-page="settings"]:visible').first().click();
  await page.locator('[data-action="export"]').click();
  await page.waitForFunction(() => !document.querySelector('#app').inert && !!window.androidTestBackup);
  await saved();
  assert.ok((await state()).settings.lastBackupAt);
  await page.locator('[data-page="list"]:visible').first().click();
  await page.getByText('安卓测试房源 A', { exact: true }).first().click();
  await page.locator('[data-tab="basic"]').click();
  await page.locator('[data-scope="house"][data-field="name"]').fill('安卓测试房源 已修改');
  await saved();
  await page.locator('[data-page="settings"]:visible').first().click();
  await page.locator('[data-action="import"]').click();
  await page.waitForFunction(() => !document.querySelector('#app').inert);
  await page.getByText('安卓测试房源 A', { exact: true }).first().waitFor();
  const restored = await state();
  assert.equal(restored.houses.length, 2); assert.equal(restored.photos.length, 1);
  assert.equal(restored.houses[0].visits[0].notes.whole.text, '整屋采光好，厨房需要确认。');
  assert.equal(restored.compare.rent.length, 2);
  assert.deepEqual(errors, []);
  await mkdir('prototype/test-results', { recursive: true });
  await writeFile('prototype/test-results/android-ui.json', JSON.stringify({ result: 'PASS', backingStore: 'real Android SQLite and photo files', systemPicker: 'fixture replies', checks: ['create/edit', 'original photo and thumbnail', 'WebView reload', 'comparison', 'ZIP export/import'], errors }, null, 2));
  console.log('Android WebView UI integration passed with real native storage (system picker fixtures).');
} finally { await browser.close(); }
