import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const server = spawn(process.execPath, ['prototype/server.mjs'], {
  env: { ...process.env, PORT: '4180' }, stdio: 'ignore',
});
let browser;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { ready = (await fetch('http://localhost:4180')).ok; } catch {}
    if (ready) break;
    await delay(100);
  }
  assert.ok(ready, 'test server did not start');
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge' });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:4180');

  const result = await page.evaluate(async () => {
    const core = await import('/core.mjs');
    const storage = await import('/storage.mjs');
    const state = core.createState();
    const source = core.createHouse('rent', { name: '原始房源' }, '2026-10-01T00:00:00.000Z');
    const room = source.spaces[0];
    source.visits[0].notes[`space:${room.id}`] = { text: '安静房间', updatedAt: '2026-10-02T00:00:00.000Z' };
    state.houses.push(source);
    const originalPhoto = {
      id: 'photo-original', houseId: source.id, visitId: source.visits[0].id,
      sectionKey: `space:${room.id}`, filename: 'room.png', type: 'image/png',
      size: 4, caption: '采光', createdAt: '2026-10-02T00:00:00.000Z',
    };
    const originalVideo = {
      id: 'video-original', houseId: source.id, visitId: source.visits[0].id,
      sectionKey: 'whole', filename: 'walkthrough.mp4', type: 'video/mp4',
      size: 5, caption: '整屋视频', createdAt: '2026-10-02T00:00:00.000Z',
    };
    source.coverId = originalPhoto.id;
    state.photos.push(originalPhoto, originalVideo);
    const original = structuredClone(state);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const videoBytes = new Uint8Array([5, 6, 7, 8, 9]);
    await storage.putPhoto(state, originalPhoto, new Blob([bytes], { type: 'image/png' }));
    await storage.putPhoto(state, originalVideo, new Blob([videoBytes], { type: 'video/mp4' }));

    const duplicate = core.duplicateHouse(state, source.id, '2026-10-03T00:00:00.000Z');
    const candidate = structuredClone(state);
    candidate.houses.push(duplicate.house);
    candidate.photos.push(...duplicate.photos);
    await storage.copyPhotos(candidate, duplicate.pairs);
    const copyPhotoId = duplicate.photos.find(photo => photo.type === 'image/png').id;
    const copyVideoId = duplicate.photos.find(photo => photo.type === 'video/mp4').id;
    const copiedBlob = await storage.getPhoto(copyPhotoId);
    const copiedBytes = [...new Uint8Array(await copiedBlob.arrayBuffer())];
    const copiedVideoBlob = await storage.getPhoto(copyVideoId);
    const copiedVideoBytes = [...new Uint8Array(await copiedVideoBlob.arrayBuffer())];
    const savedCopy = (await storage.loadState()).houses.find(house => house.id === duplicate.house.id);
    const mappedNote = savedCopy.visits[0].notes[`space:${savedCopy.spaces[0].id}`].text;
    const afterDelete = await storage.loadState();
    afterDelete.houses = afterDelete.houses.filter(house => house.id !== source.id);
    afterDelete.photos = afterDelete.photos.filter(photo => ![originalPhoto.id, originalVideo.id].includes(photo.id));
    await storage.deletePhotos(afterDelete, [originalPhoto.id, originalVideo.id]);
    const originalAfterDelete = await storage.getPhoto(originalPhoto.id);
    const originalVideoAfterDelete = await storage.getPhoto(originalVideo.id);
    const copyAfterDelete = await storage.getPhoto(copyPhotoId);
    const copyVideoAfterDelete = await storage.getPhoto(copyVideoId);
    const backup = await storage.exportBackup();
    const restored = await storage.importBackup(backup);
    const restoredBlob = await storage.getPhoto(copyPhotoId);
    const restoredVideoBlob = await storage.getPhoto(copyVideoId);

    let failedCopyRejected = false;
    let failedStateUnchanged = false;
    const beforeFailure = await storage.loadState();
    const missingHouse = core.createHouse('buy', { name: '缺失原图' });
    const missingPhoto = {
      id: 'photo-missing-source', houseId: missingHouse.id, visitId: null,
      sectionKey: 'environment', filename: 'missing.png', type: 'image/png',
      size: 4, caption: '', createdAt: '2026-10-04T00:00:00.000Z',
    };
    beforeFailure.houses.push(missingHouse);
    beforeFailure.photos.push(missingPhoto);
    await storage.saveState(beforeFailure);
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('kf-note-prototype', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const tx = request.result.transaction('photos', 'readwrite');
        tx.objectStore('photos').delete(missingPhoto.id);
        tx.oncomplete = () => { request.result.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
    const missingDuplicate = core.duplicateHouse(beforeFailure, missingHouse.id);
    const failedCandidate = structuredClone(beforeFailure);
    failedCandidate.houses.push(missingDuplicate.house);
    failedCandidate.photos.push(...missingDuplicate.photos);
    try { await storage.copyPhotos(failedCandidate, missingDuplicate.pairs); }
    catch { failedCopyRejected = true; }
    failedStateUnchanged = JSON.stringify(await storage.loadState()) === JSON.stringify(beforeFailure);

    const noPhotoHouse = core.createHouse('buy', { name: '无图房源' });
    beforeFailure.houses.push(noPhotoHouse);
    const noPhotoDuplicate = core.duplicateHouse(beforeFailure, noPhotoHouse.id);
    const emptyCandidate = structuredClone(beforeFailure);
    emptyCandidate.houses.push(noPhotoDuplicate.house);
    await storage.copyPhotos(emptyCandidate, noPhotoDuplicate.pairs);

    return {
      originalUnchanged: JSON.stringify(state) === JSON.stringify(original),
      sourceAndCopyDistinct: source.id !== duplicate.house.id && source.spaces[0].id !== duplicate.house.spaces[0].id,
      mappedNote,
      copyMetadata: duplicate.photos[0],
      sourcePhoto: originalPhoto,
      copiedBytes,
      copiedVideoBytes,
      restoredBytes: [...new Uint8Array(await restoredBlob.arrayBuffer())],
      restoredVideoBytes: [...new Uint8Array(await restoredVideoBlob.arrayBuffer())],
      backupHouseCount: restored.houses.length,
      originalDeleted: originalAfterDelete === null && originalVideoAfterDelete === null,
      deletedSourceStillCopied: copyAfterDelete !== null,
      deletedSourceVideoStillCopied: copyVideoAfterDelete !== null,
      copiedVideoCanBeCover: (() => { const copyHouse = restored.houses.find(house => house.id === duplicate.house.id); copyHouse.coverId = copyVideoId; try { storage.validateState(restored); return true; } catch { return false; } })(),
      failedCopyRejected,
      failedStateUnchanged,
      noPhotoMappings: noPhotoDuplicate.pairs.length === 0 && noPhotoDuplicate.photos.length === 0,
    };
  });

  assert.equal(result.originalUnchanged, true, 'duplicateHouse must not mutate its input');
  assert.equal(result.sourceAndCopyDistinct, true, 'owned IDs must be remapped');
  assert.equal(result.mappedNote, '安静房间', 'space-scoped notes must be remapped');
  assert.equal(result.copyMetadata.houseId !== result.sourcePhoto.houseId, true);
  assert.equal(result.copyMetadata.visitId !== result.sourcePhoto.visitId, true);
  assert.deepEqual(result.copiedBytes, [1, 2, 3, 4]);
  assert.deepEqual(result.copiedVideoBytes, [5, 6, 7, 8, 9]);
  assert.deepEqual(result.restoredBytes, [1, 2, 3, 4]);
  assert.deepEqual(result.restoredVideoBytes, [5, 6, 7, 8, 9]);
  assert.equal(result.backupHouseCount, 1);
  assert.equal(result.originalDeleted, true);
  assert.equal(result.deletedSourceStillCopied, true, 'deleting original must leave shared file accessible through duplicate metadata');
  assert.equal(result.deletedSourceVideoStillCopied, true, 'deleting original video must leave the duplicate video accessible');
  assert.equal(result.copiedVideoCanBeCover, false, 'video metadata must not be accepted as a house cover');
  assert.equal(result.failedCopyRejected, true, 'missing original blob should reject the clone');
  assert.equal(result.failedStateUnchanged, true, 'failed copy should preserve saved state');
  assert.equal(result.noPhotoMappings, true);
  assert.deepEqual(errors, [], `browser runtime errors: ${errors.join('; ')}`);
  await context.close();
  console.log('Duplicate browser integration passed: remapping, atomic IndexedDB copy/rollback, delete isolation and ZIP roundtrip.');
} finally {
  await browser?.close();
  server.kill();
}
