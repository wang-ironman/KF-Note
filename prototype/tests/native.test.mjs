import test from 'node:test';
import assert from 'node:assert/strict';
import { isNative, nativeStorage, nativePlatform, blobBase64, base64Blob } from '../native.mjs';
import { createState, createHouse, duplicateHouse } from '../core.mjs';
import { copyPhotos, putPickedMedia, discardPickedMedia, saveState, loadState, getPhoto, getThumbnail, deletePhotos } from '../storage.mjs';

test('native adapter preserves binary bytes and propagates storage errors', async () => {
  const blob = new Blob([new Uint8Array([0, 255, 128, 13, 10])], { type: 'image/png' });
  const base64 = await blobBase64(blob);
  assert.deepEqual(new Uint8Array(await base64Blob({ base64, type: blob.type }).arrayBuffer()), new Uint8Array(await blob.arrayBuffer()));
  globalThis.KFNative = { storage: () => JSON.stringify({ ok: false, error: '磁盘空间不足' }) };
  try { assert.equal(isNative(), true); assert.throws(() => nativeStorage('saveState'), /磁盘空间不足/); }
  finally { delete globalThis.KFNative; }
});

test('Android storage route validates states before native writes and requests thumbnails separately', async () => {
  const requests = [];
  let state;
  globalThis.KFNative = { storage: json => {
    const request = JSON.parse(json); requests.push(request);
    if (request.action === 'saveState' || request.action === 'deletePhotos') state = request.state;
    return JSON.stringify({ ok: true, value: request.action === 'loadState' ? state : null });
  } };
  try {
    const initial = createState();
    await saveState(initial);
    assert.deepEqual(await loadState(), initial);
    await assert.rejects(saveState({ version: 1 }), /settings/);
    assert.equal(requests.filter(r => r.action === 'saveState').length, 1);
    await getPhoto('a'); await getThumbnail('a'); await deletePhotos(initial, ['a']);
    assert.deepEqual(requests.filter(r => r.action === 'getPhoto'), [{ action: 'getPhoto', id: 'a' }, { action: 'getPhoto', id: 'a', thumbnail: true }]);
  } finally { delete globalThis.KFNative; }
});

test('copyPhotos forwards a validated complete clone to the native atomic-copy action', async () => {
  const requests = [];
  globalThis.KFNative = { storage: json => {
    requests.push(JSON.parse(json));
    return JSON.stringify({ ok: true, value: null });
  } };
  try {
    const state = createState();
    const house = createHouse('rent', { name: '原房源' });
    state.houses.push(house);
    state.photos.push({
      id: 'photo-source', houseId: house.id, visitId: null, sectionKey: 'environment',
      filename: 'room.png', type: 'image/png', size: 4, caption: '', createdAt: new Date().toISOString(),
    });
    const copy = duplicateHouse(state, house.id);
    const next = structuredClone(state);
    next.houses.push(copy.house);
    next.photos.push(...copy.photos);
    await copyPhotos(next, copy.pairs);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].action, 'copyPhotos');
    assert.equal(requests[0].pairs.length, 1);
    assert.equal(requests[0].pairs[0].from, 'photo-source');
    assert.notEqual(requests[0].pairs[0].to, 'photo-source');
    assert.deepEqual(requests[0].state.houses.map(item => item.name), ['原房源', '原房源（副本）']);
  } finally { delete globalThis.KFNative; }
});

test('picked media persistence uses staged tokens and explicit cleanup actions', async () => {
  const requests = [];
  globalThis.KFNative = { storage: json => {
    requests.push(JSON.parse(json));
    return JSON.stringify({ ok: true, value: null });
  } };
  try {
    const state = createState();
    const house = createHouse('rent', { name: '视频房源' });
    state.houses.push(house);
    const metadata = {
      id: 'video-picked', houseId: house.id, visitId: null, sectionKey: 'whole',
      filename: 'walkthrough.mp4', type: 'video/mp4', size: 3, caption: '', createdAt: new Date().toISOString(),
    };
    state.photos.push(metadata);
    await putPickedMedia(state, metadata, 'pick-token');
    await discardPickedMedia(['pick-token']);
    assert.deepEqual(requests.map(request => request.action), ['putPickedMedia', 'discardPickedMedia']);
    assert.equal(requests[0].token, 'pick-token');
    assert.equal(requests[0].metadata.type, 'video/mp4');
    assert.deepEqual(requests[1].tokens, ['pick-token']);
  } finally { delete globalThis.KFNative; }
});

test('platform replies distinguish cancellation from failure and match callback IDs', async () => {
  const requests = [];
  globalThis.KFNative = { platform: json => requests.push(JSON.parse(json)) };
  try {
    const first = nativePlatform('pickPhotos');
    const second = nativePlatform('location');
    globalThis.KFNativeReply(requests[1].id, { ok: false, error: '未获得定位权限' });
    globalThis.KFNativeReply(requests[0].id, { ok: true, value: null });
    assert.equal(await first, null);
    await assert.rejects(second, /未获得定位权限/);
  } finally { delete globalThis.KFNative; delete globalThis.KFNativeReply; }
});
