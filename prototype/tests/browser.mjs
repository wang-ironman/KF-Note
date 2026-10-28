import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const resultsDir = path.join(root, 'prototype', 'test-results');
const port = 4174;
const baseURL = `http://localhost:${port}`;
const errors = [];

function watchPage(page, name) {
  page.on('pageerror', error => errors.push(`${name}: ${error.stack || error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`${name}: ${message.text()}`);
  });
}

async function waitForServer(server) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`本地测试服务器提前退出，退出码 ${server.exitCode}`);
    try {
      const response = await fetch(baseURL);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error('等待原型测试服务器超时');
}

async function saved(page) {
  await page.locator('#save-state').getByText('已保存到本机').waitFor({ timeout: 5000 });
}

async function createRentHouse(page, name) {
  if (await page.locator('[data-mode="rent"]').count()) await page.locator('[data-mode="rent"]').first().click();
  await page.locator('[data-page="new"]').first().click();
  await page.locator('#new-house [name="name"]').fill(name);
  await page.locator('#new-house button[type="submit"], #new-house button:not([type])').last().click();
  await page.getByRole('heading', { name }).waitFor({ timeout: 5000 });
  await saved(page);
}

async function storageModule(page) {
  return page.evaluate(async () => {
    const [storage, core] = await Promise.all([import('/storage.mjs'), import('/core.mjs')]);
    return { loaded: Boolean(storage.loadState && core.createState) };
  });
}

async function verifyBackupAndRejections(page) {
  const result = await page.evaluate(async () => {
    const storage = await import('/storage.mjs');
    const stateBefore = await storage.loadState();
    const photoId = stateBefore.photos[0]?.id;
    const originalPhoto = photoId ? await storage.getPhoto(photoId) : null;
    const exported = await storage.exportBackup();
    const restored = await storage.importBackup(exported);
    const roundtripPhoto = photoId ? await storage.getPhoto(photoId) : null;
    const roundtripOK = JSON.stringify(restored) === JSON.stringify(stateBefore)
      && (!photoId || (roundtripPhoto?.size === originalPhoto?.size && roundtripPhoto?.type === originalPhoto?.type));

    const core = await import('/core.mjs');
    const subtleDescriptor = Object.getOwnPropertyDescriptor(globalThis.crypto, 'subtle');
    const uuidDescriptor = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID');
    let fallbackOK = false;
    try {
      Object.defineProperty(globalThis.crypto, 'subtle', { configurable: true, value: undefined });
      Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: undefined });
      const first = core.createHouse('rent');
      const second = core.createHouse('rent');
      if (first.id === second.id) throw new Error('关闭 randomUUID 后仍需生成不同 ID');
      const fallbackBackup = await storage.exportBackup();
      const fallbackRestored = await storage.importBackup(fallbackBackup);
      fallbackOK = JSON.stringify(fallbackRestored) === JSON.stringify(stateBefore);
    } finally {
      if (subtleDescriptor) Object.defineProperty(globalThis.crypto, 'subtle', subtleDescriptor);
      else delete globalThis.crypto.subtle;
      if (uuidDescriptor) Object.defineProperty(globalThis.crypto, 'randomUUID', uuidDescriptor);
      else delete globalThis.crypto.randomUUID;
    }

    const savedState = await storage.loadState();
    const zip = await globalThis.JSZip.loadAsync(exported);
    const app = JSON.parse(await zip.file('app.json').async('string'));
    const photos = app.files;
    if (photos.length) {
      const record = photos[0];
      const bytes = new Uint8Array(await zip.file(record.path).async('uint8array'));
      bytes[0] ^= 0xff;
      zip.file(record.path, bytes, { mimeType: app.state.photos.find(photo => photo.id === record.id).type });
    }
    const tampered = await zip.generateAsync({ type: 'blob', mimeType: 'application/zip' });
    let tamperRejected = false;
    try { await storage.importBackup(tampered); } catch { tamperRejected = true; }
    const unchangedAfterTamper = JSON.stringify(await storage.loadState()) === JSON.stringify(savedState);

    const makeInvalid = async mutate => {
      const badZip = await globalThis.JSZip.loadAsync(exported);
      const wrapper = JSON.parse(await badZip.file('app.json').async('string'));
      mutate(wrapper);
      badZip.file('app.json', JSON.stringify(wrapper));
      let rejected = false;
      try { await storage.importBackup(await badZip.generateAsync({ type: 'blob' })); } catch { rejected = true; }
      return rejected && JSON.stringify(await storage.loadState()) === JSON.stringify(savedState);
    };
    const badReferenceRejected = await makeInvalid(wrapper => {
      wrapper.state.houses[0].coverId = 'missing-photo';
    });
    const badVersionRejected = await makeInvalid(wrapper => { wrapper.version = 2; });
    const badTermsRejected = await makeInvalid(wrapper => { wrapper.state.houses[0].terms.furniture = {}; });
    const badPhotoTypeRejected = await makeInvalid(wrapper => { wrapper.state.photos[0].type = 'text/plain'; });
    const badContactRejected = await makeInvalid(wrapper => {
      wrapper.state.houses[0].contacts.push({
        id: 'broken-contact', name: '损坏联系人', phone: 123, role: 'agent', company: '', remark: '',
      });
    });

    const mutable = await storage.loadState();
    const targetId = 'browser-test-target';
    mutable.settings.targets.push({ id: targetId, name: '测试目的地', address: '' });
    mutable.houses[0].visits[0].commutes.push({
      targetId, method: 'walk', minutes: null, source: '未知时长',
    });
    storage.validateState(mutable);
    await storage.saveState(mutable);
    const nullCommuteAccepted = (await storage.loadState()).houses[0].visits[0].commutes.some(
      commute => commute.targetId === targetId && commute.minutes === null,
    );
    return { roundtripOK, tamperRejected, unchangedAfterTamper, badReferenceRejected, badVersionRejected,
      badTermsRejected, badPhotoTypeRejected, badContactRejected, nullCommuteAccepted, fallbackOK };
  });
  assert.deepEqual(result, {
    roundtripOK: true,
    tamperRejected: true,
    unchangedAfterTamper: true,
    badReferenceRejected: true,
    badVersionRejected: true,
    badTermsRejected: true,
    badPhotoTypeRejected: true,
    badContactRejected: true,
    nullCommuteAccepted: true,
    fallbackOK: true,
  });
}

async function main() {
  await mkdir(resultsDir, { recursive: true });
  const server = spawn(process.execPath, ['prototype/server.mjs'], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  server.stdout.setEncoding('utf8').on('data', chunk => { serverOutput += chunk; });
  server.stderr.setEncoding('utf8').on('data', chunk => { serverOutput += chunk; });
  let browser;
  try {
    await waitForServer(server);
    browser = await playwright.chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });

    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.setDefaultNavigationTimeout(10000);
    watchPage(page, 'journal');
    await page.goto(baseURL, { waitUntil: 'networkidle' });
    await page.locator('.hero').waitFor();
    await page.screenshot({ path: path.join(resultsDir, 'screenshot-home.png'), fullPage: true });

    await createRentHouse(page, '浏览器测试·梧桐里');
    const firstVisitId = await page.evaluate(async () => (await (await import('/storage.mjs')).loadState()).houses[0].visits[0].id);
    await page.locator('[data-scope="visit"][data-field="impression"]').fill('旧日记印象');
    await page.locator('[data-scope="note"][data-field="text"]').fill('本次的分区笔记');
    await saved(page);

    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/S2sAAAAASUVORK5CYII=', 'base64');
    await page.locator('#photo-input').setInputFiles({ name: 'tiny.png', mimeType: 'image/png', buffer: png });
    const photo = page.locator('.photo-grid img[data-photo]').first();
    await photo.waitFor({ timeout: 5000 });
    await photo.evaluate(image => image.decode());
    assert.ok(await photo.evaluate(image => image.naturalWidth > 0), '上传照片应能解码显示');
    await saved(page);

    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('.house-title[data-open-house]').filter({ hasText: '浏览器测试·梧桐里' }).click();
    await page.getByRole('heading', { name: '浏览器测试·梧桐里' }).waitFor();
    assert.equal(await page.locator('[data-scope="visit"][data-field="impression"]').inputValue(), '旧日记印象');
    assert.equal(await page.locator('[data-scope="note"][data-field="text"]').inputValue(), '本次的分区笔记');
    await page.locator('.photo-grid img[data-photo]').first().evaluate(image => image.decode());

    await page.locator('[data-action="new-visit"]').click();
    await page.locator('[data-scope="visit"][data-field="at"]').fill('2099-01-01T09:00');
    await saved(page);
    await page.locator('[data-scope="visit"][data-field="impression"]').fill('最新日记印象');
    await page.locator('[data-scope="note"][data-field="text"]').fill('最新分区笔记');
    await saved(page);
    await page.locator('#visit-picker').selectOption(firstVisitId);
    await page.locator('[data-scope="visit"][data-field="at"]').fill('2000-01-01T09:00');
    await saved(page);

    await page.locator('.mobile-nav [data-page="list"]').click();
    await page.locator('[data-page="new"]').click();
    await page.locator('#new-house [name="name"]').fill('浏览器测试·云杉公寓');
    await page.locator('#new-house button[type="submit"], #new-house button:not([type])').last().click();
    await page.getByRole('heading', { name: '浏览器测试·云杉公寓' }).waitFor();
    await saved(page);
    await page.locator('.mobile-nav [data-page="list"]').click();
    const checkboxes = page.locator('input[data-compare]');
    assert.equal(await checkboxes.count(), 2);
    await checkboxes.nth(0).check();
    await saved(page);
    await checkboxes.nth(1).check();
    await saved(page);
    assert.equal(await page.evaluate(async () => (await (await import('/storage.mjs')).loadState()).compare.rent.length), 2,
      '两套房源应保存在比较清单中');
    await page.locator('.mobile-nav [data-page="compare"]').click();
    await page.getByText('最新分区笔记').waitFor();
    assert.equal(await page.getByText('本次的分区笔记', { exact: true }).count(), 0, '旧日记日期改早后不应覆盖较新的记录');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: path.join(resultsDir, 'screenshot-compare.png'), fullPage: true });
    const compareWidth = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    assert.ok(compareWidth.scroll <= compareWidth.client, `1280px 对比页宽度溢出：${JSON.stringify(compareWidth)}`);
    await page.setViewportSize({ width: 390, height: 844 });

    await page.locator('.mobile-nav [data-page="list"]').click();
    await page.locator('.house-title[data-open-house]').filter({ hasText: '浏览器测试·梧桐里' }).click();
    await page.locator('[data-tab="fees"]').click();
    await page.locator('[data-scope="terms"][data-field="pets"]').selectOption('allowed');
    await saved(page);
    const propertyFee = page.locator('details[data-expense]').filter({ hasText: '物业费' }).first();
    await propertyFee.locator('summary').click();
    await propertyFee.locator('select[data-field="status"]').selectOption('known');
    await propertyFee.locator('input[data-field="amount"]').waitFor();
    await propertyFee.locator('input[data-field="amount"]').fill('350');
    await saved(page);
    const selectorsAfterRerender = await page.evaluate(async () => {
      const state = await (await import('/storage.mjs')).loadState();
      return { pets: state.houses.find(house => house.name.includes('梧桐里')).terms.pets,
        expense: state.houses.find(house => house.name.includes('梧桐里')).expenses.find(item => item.name === '物业费') };
    });
    assert.equal(selectorsAfterRerender.pets, 'allowed');
    assert.equal(selectorsAfterRerender.expense.status, 'known');
    assert.equal(selectorsAfterRerender.expense.amount, 350);
    await page.reload({ waitUntil: 'networkidle' });
    await storageModule(page);

    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Service worker 未接管页面')), 5000);
          navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      }
    });
    await context.setOffline(true);
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: '看过的家' }).waitFor();
    await context.setOffline(false);
    assert.equal(await page.locator('.house-card').count(), 2, '离线重载后两套房源应保留');
    const offlinePhoto = page.locator('.house-card img[data-photo]').first();
    await offlinePhoto.evaluate(image => image.decode());
    assert.ok(await offlinePhoto.evaluate(image => image.naturalWidth > 0), '离线重载后照片应能解码显示');
    await page.screenshot({ path: path.join(resultsDir, 'screenshot-mobile.png'), fullPage: true });

    await verifyBackupAndRejections(page);
    await page.setViewportSize({ width: 320, height: 720 });
    const width320 = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    assert.ok(width320.scroll <= width320.client, `320px 页面宽度溢出：${JSON.stringify(width320)}`);
    await page.screenshot({ path: path.join(resultsDir, 'screenshot-320.png'), fullPage: true });
    await context.close();

    const demoContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const demoPage = await demoContext.newPage();
    demoPage.setDefaultTimeout(5000);
    demoPage.setDefaultNavigationTimeout(10000);
    watchPage(demoPage, 'demo');
    await demoPage.goto(baseURL, { waitUntil: 'networkidle' });
    await demoPage.evaluate(async () => {
      const [{ createDemoState }, { validateState }] = await Promise.all([import('/demo.mjs'), import('/storage.mjs')]);
      validateState(createDemoState());
    });
    demoPage.once('dialog', dialog => dialog.accept());
    await demoPage.locator('[data-action="demo"]').click();
    await demoPage.waitForTimeout(250);
    assert.equal(await demoPage.getByRole('heading', { name: '看过的家' }).count(), 1,
      `载入虚构示例后未进入列表：${(await demoPage.locator('#app').innerText()).slice(-600)}`);
    assert.equal(await demoPage.locator('.house-card').count(), 2);
    await demoPage.screenshot({ path: path.join(resultsDir, 'screenshot-list.png'), fullPage: true });
    const width1280 = await demoPage.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    assert.ok(width1280.scroll <= width1280.client, `1280px 页面宽度溢出：${JSON.stringify(width1280)}`);
    await demoContext.close();

    assert.deepEqual(errors, [], `浏览器控制台错误：\n${errors.join('\n')}`);
    await writeFile(path.join(resultsDir, 'browser.json'), JSON.stringify({ ok: true, width320, width1280, screenshots: 5 }, null, 2));
    console.log('Browser integration passed. Screenshots and browser.json saved under prototype/test-results.');
  } finally {
    await browser?.close();
    if (server.exitCode === null) {
      server.kill();
      await Promise.race([new Promise(resolve => server.once('exit', resolve)), delay(3000)]);
    }
    if (serverOutput && server.exitCode !== 0 && server.exitCode !== null) console.error(serverOutput);
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
