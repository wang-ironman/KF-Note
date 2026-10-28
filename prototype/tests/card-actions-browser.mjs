import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const port = 4177;
const baseURL = `http://localhost:${port}`;
const server = spawn(process.execPath, ['prototype/server.mjs'], {
  cwd: root,
  env: { ...process.env, PORT: String(port) },
  stdio: 'ignore',
});

let browser;
try {
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (server.exitCode !== null) throw new Error(`Prototype server exited with ${server.exitCode}`);
    try { if ((await fetch(baseURL)).ok) { ready = true; break; } } catch {}
    await delay(100);
  }
  assert.ok(ready, 'prototype server should become ready');

  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(baseURL, { waitUntil: 'networkidle' });

  const seeded = await page.evaluate(async () => {
    const [{ createState, createHouse }, storage] = await Promise.all([
      import('/core.mjs'), import('/storage.mjs'),
    ]);
    const now = '2026-10-10T09:00:00.000Z';
    const state = createState();
    state.settings.mode = 'rent';
    const keep = createHouse('rent', { name: '操作回归·保留房源' }, now);
    const remove = createHouse('rent', { name: '操作回归·待删除房源' }, now);
    keep.id = 'actions-keep';
    remove.id = 'actions-remove';
    state.houses = [keep, remove];
    state.compare.rent = [keep.id, remove.id];

    const makePhoto = (house, id, filename) => {
      const photo = {
        id, houseId: house.id, visitId: house.visits[0].id, sectionKey: 'whole',
        filename, type: 'image/png', size: 0, caption: '', createdAt: now,
      };
      house.coverId = id;
      house.planId = id;
      return photo;
    };
    const keepPhoto = makePhoto(keep, 'actions-photo-keep', 'keep.png');
    const removePhoto = makePhoto(remove, 'actions-photo-remove', 'remove.png');
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMwKPr2HwAFBgKYNw0+bwAAAABJRU5ErkJggg=='), char => char.charCodeAt(0));
    const blob = new Blob([png], { type: 'image/png' });
    keepPhoto.size = blob.size;
    removePhoto.size = blob.size;
    state.photos = [keepPhoto, removePhoto];
    await storage.putPhoto(state, keepPhoto, blob);
    await storage.putPhoto(state, removePhoto, blob);
    return { keepId: keep.id, removeId: remove.id, keepPhotoId: keepPhoto.id, removePhotoId: removePhoto.id };
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: '看过的家' }).waitFor();
  assert.equal(await page.locator('.house-card').count(), 2, 'fixture has two houses');

  const card = id => page.locator(`article.house-card[data-open-house="${id}"]`);
  const modalOpen = () => page.locator('#modal').evaluate(element => element.open);
  const saved = async () => page.locator('#save-state').getByText('已保存到本机').waitFor();
  const loadState = () => page.evaluate(async () => (await import('/storage.mjs')).loadState());

  async function returnToListIfNeeded() {
    if (await page.locator('.house-card').count() === 0) {
      await page.locator('.mobile-nav [data-page="list"]').click();
      await card(seeded.keepId).waitFor();
    }
  }

  async function openActions(id) {
    const target = card(id).locator('.house-title');
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    assert.ok(box, 'house title is visible for long press');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(600);
    assert.equal(await modalOpen(), true, 'long press opens card actions');
    await page.mouse.up();
    await page.getByRole('button', { name: '修改状态', exact: true }).waitFor();
    await page.getByRole('button', { name: '删除房源', exact: true }).waitFor();
  }

  // Moving more than the drag threshold cancels the long press.
  {
    const box = await card(seeded.keepId).locator('.house-title').boundingBox();
    assert.ok(box);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 24, y + 2, { steps: 2 });
    await page.waitForTimeout(600);
    assert.equal(await modalOpen(), false, 'pointer movement cancels long press');
    await page.mouse.up();
    await returnToListIfNeeded();
  }

  // A pointer cancellation also clears the pending long press.
  {
    const box = await card(seeded.keepId).locator('.house-title').boundingBox();
    assert.ok(box);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.evaluate(({ clientX, clientY }) => document.dispatchEvent(new PointerEvent('pointercancel', {
      bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'mouse', clientX, clientY,
    })), { clientX: x, clientY: y });
    await page.waitForTimeout(600);
    assert.equal(await modalOpen(), false, 'pointercancel cancels long press');
    await page.mouse.up();
    await returnToListIfNeeded();
  }

  // A normal short click keeps its original navigation behavior.
  await card(seeded.keepId).locator('.house-title').click();
  await page.getByRole('heading', { name: '操作回归·保留房源' }).waitFor();
  assert.equal(await page.locator('#modal').evaluate(element => element.open), false, 'short click does not open actions');
  await page.locator('.mobile-nav [data-page="list"]').click();
  await card(seeded.keepId).waitFor();

  await openActions(seeded.keepId);
  await page.locator('[data-action="close-modal"]').click();
  await card(seeded.keepId).waitFor();

  async function setConclusion(conclusion) {
    const current = (await loadState()).houses.find(house => house.id === seeded.keepId).conclusion;
    if (current === 'excluded') await page.locator('.excluded-list summary').click();
    await card(seeded.keepId).locator('[data-house-status]').click();
    await page.locator(`[data-set-conclusion="${conclusion}"][data-id="${seeded.keepId}"]`).click();
    await saved();
    assert.equal((await loadState()).houses.find(house => house.id === seeded.keepId).conclusion, conclusion);
  }

  await card(seeded.keepId).locator('[data-house-status]').click();
  await page.locator(`[data-set-conclusion="favorite"][data-id="${seeded.keepId}"]`).click();
  await saved();
  assert.equal((await loadState()).houses.find(house => house.id === seeded.keepId).conclusion, 'favorite');
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: '看过的家' }).waitFor();
  assert.match(await card(seeded.keepId).locator('[data-house-status]').innerText(), /心仪/,
    'favorite status survives page reload');
  await setConclusion('excluded');
  await setConclusion('consider');
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal((await loadState()).houses.find(house => house.id === seeded.keepId).conclusion, 'consider',
    'consider status persists after reopening');

  // Canceling deletion leaves the full state and both photo blobs untouched.
  const beforeCancel = await loadState();
  await openActions(seeded.removeId);
  await page.getByRole('button', { name: '删除房源', exact: true }).click();
  await page.locator(`[data-confirm-delete-house="${seeded.removeId}"]`).waitFor();
  await page.locator('[data-action="close-modal"]').click();
  await saved();
  assert.deepEqual(await loadState(), beforeCancel, 'cancelled deletion does not change state');
  assert.ok(await page.evaluate(async id => Boolean(await (await import('/storage.mjs')).getPhoto(id)), seeded.keepPhotoId));
  assert.ok(await page.evaluate(async id => Boolean(await (await import('/storage.mjs')).getPhoto(id)), seeded.removePhotoId));

  await openActions(seeded.removeId);
  await page.getByRole('button', { name: '删除房源', exact: true }).click();
  await page.locator(`[data-confirm-delete-house="${seeded.removeId}"]`).click();
  await saved();
  await page.waitForFunction(id => !document.querySelector(`[data-open-house="${id}"]`), seeded.removeId);
  let state = await loadState();
  assert.deepEqual(state.houses.map(house => house.id), [seeded.keepId], 'confirmed deletion keeps the other house');
  assert.deepEqual(state.photos.map(photo => photo.id), [seeded.keepPhotoId], 'confirmed deletion removes linked photo metadata');
  assert.deepEqual(state.compare.rent, [seeded.keepId], 'confirmed deletion removes the compare reference');
  assert.equal(await page.evaluate(async id => Boolean(await (await import('/storage.mjs')).getPhoto(id)), seeded.keepPhotoId), true,
    'remaining house photo blob is retained');
  assert.equal(await page.evaluate(async id => Boolean(await (await import('/storage.mjs')).getPhoto(id)), seeded.removePhotoId), false,
    'deleted house photo blob is removed');

  await page.reload({ waitUntil: 'networkidle' });
  state = await loadState();
  assert.deepEqual(state.houses.map(house => house.id), [seeded.keepId], 'deletion persists after reopening');
  assert.deepEqual(state.photos.map(photo => photo.id), [seeded.keepPhotoId]);
  assert.deepEqual(state.compare.rent, [seeded.keepId]);
  assert.deepEqual(errors, [], `browser page errors: ${errors.join('\n')}`);
  await context.close();
  console.log('Card actions browser regression passed: long press, movement/cancel, short click, status persistence, and safe house deletion.');
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    server.kill();
    await Promise.race([new Promise(resolve => server.once('exit', resolve)), delay(3000)]);
  }
}
