import { isNative, nativeStorage, blobBase64, base64Blob } from './native.mjs';

const DB_NAME = 'kf-note-prototype';
const DB_VERSION = 1;
const STATE_STORE = 'state';
const PHOTO_STORE = 'photos';
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/3gpp']);
const MEDIA_TYPES = new Set([...IMAGE_TYPES, ...VIDEO_TYPES]);
const SECTION_KEYS = new Set(['environment', 'traffic', 'amenities', 'layout', 'whole']);
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

let dbPromise;

function fail(message) {
  throw new TypeError(message);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function string(value) {
  return typeof value === 'string';
}

function nullableString(value) {
  return value === null || string(value);
}

function validDate(value) {
  return string(value) && Number.isFinite(Date.parse(value));
}

function nullableNumber(value, predicate) {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && predicate(value));
}

function safeTree(value, path = 'state') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => safeTree(item, `${path}[${index}]`));
    return;
  }
  if (!object(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(key)) fail(`备份字段名无效：${path}.${key}`);
    safeTree(child, `${path}.${key}`);
  }
}

function requireArray(value, label) {
  if (!Array.isArray(value)) fail(`${label}必须是数组`);
  return value;
}

function requireObject(value, label) {
  if (!object(value)) fail(`${label}格式无效`);
  return value;
}

function requireId(value, label) {
  if (!string(value) || !/^[A-Za-z0-9_-]+$/.test(value)) fail(`${label}缺少有效 ID`);
  return value;
}

function collectIds(items, label) {
  const result = new Set();
  for (const item of requireArray(items, label)) {
    const id = requireId(requireObject(item, label).id, label);
    if (result.has(id)) fail(`${label}存在重复 ID：${id}`);
    result.add(id);
  }
  return result;
}

function sectionKeyValid(key, spaceIds) {
  if (SECTION_KEYS.has(key)) return true;
  const match = /^space:(.+)$/.exec(key);
  return Boolean(match && spaceIds.has(match[1]));
}

export function validateState(state) {
  requireObject(state, 'state');
  safeTree(state);
  if (state.version !== 1) fail('备份数据版本不受支持');
  const settings = requireObject(state.settings, 'settings');
  if (settings.mode !== null && !['buy', 'rent'].includes(settings.mode)) fail('使用模式无效');
  if (!nullableString(settings.lastBackupAt)) fail('备份时间格式无效');
  const targets = collectIds(settings.targets, '通勤目标');
  for (const target of settings.targets) {
    if (!string(target.name)) fail('通勤目标名称无效');
    for (const field of ['lat', 'lng']) {
      if (Object.hasOwn(target, field) && !nullableNumber(target[field], value => value >= (field === 'lat' ? -90 : -180) && value <= (field === 'lat' ? 90 : 180))) {
        fail('通勤目标坐标无效');
      }
    }
    if ((Object.hasOwn(target, 'lat') && !Object.hasOwn(target, 'lng'))
      || (Object.hasOwn(target, 'lng') && !Object.hasOwn(target, 'lat'))
      || (target.lat === null) !== (target.lng === null)) fail('通勤目标坐标必须成对填写');
  }

  const houses = requireArray(state.houses, '房屋');
  const houseIds = collectIds(houses, '房屋');
  const visitsByHouse = new Map();
  const spacesByHouse = new Map();
  const entityIds = new Set();
  const addUnique = (ids, label) => {
    for (const id of ids) {
      if (entityIds.has(id)) fail(`${label} ID 与其他记录重复：${id}`);
      entityIds.add(id);
    }
  };
  addUnique(houseIds, '房屋');

  for (const house of houses) {
    requireObject(house, '房屋');
    if (!['buy', 'rent'].includes(house.mode)) fail(`房屋 ${house.id} 的买租类型无效`);
    if (!string(house.name)) fail(`房屋 ${house.id} 的名称无效`);
    if (Object.hasOwn(house, 'sourceLink') && !string(house.sourceLink)) fail(`房屋 ${house.id} 的链接或分享口令无效`);
    const spaces = requireArray(house.spaces, `房屋 ${house.id} 的空间`);
    const spaceIds = collectIds(spaces, `房屋 ${house.id} 的空间`);
    for (const space of spaces) {
      if (!string(space.type) || !string(space.name)) fail(`房屋 ${house.id} 的空间信息无效`);
    }
    addUnique(spaceIds, '空间');
    spacesByHouse.set(house.id, spaceIds);

    const visits = requireArray(house.visits, `房屋 ${house.id} 的看房记录`);
    const visitIds = collectIds(visits, `房屋 ${house.id} 的看房记录`);
    addUnique(visitIds, '看房记录');
    visitsByHouse.set(house.id, visitIds);
    for (const visit of visits) {
      if (![visit.at, visit.createdAt, visit.updatedAt].every(validDate)) {
        fail(`看房记录 ${visit.id} 的时间无效`);
      }
      if (![visit.impression, visit.pros, visit.cons].every(string)) fail(`看房记录 ${visit.id} 的文字内容无效`);
      const notes = requireObject(visit.notes, `看房记录 ${visit.id} 的笔记`);
      for (const [key, note] of Object.entries(notes)) {
        if (!sectionKeyValid(key, spaceIds)) fail(`看房记录 ${visit.id} 引用了不存在的空间`);
        requireObject(note, `看房记录 ${visit.id} 的笔记`);
        if (!string(note.text) || !string(note.updatedAt)) fail(`看房记录 ${visit.id} 的笔记内容无效`);
      }
      const commuteKeys = new Set();
      for (const commute of requireArray(visit.commutes, `看房记录 ${visit.id} 的通勤信息`)) {
        requireObject(commute, `看房记录 ${visit.id} 的通勤信息`);
        if (!targets.has(commute.targetId)) fail(`看房记录 ${visit.id} 引用了不存在的通勤目标`);
        if (!string(commute.method) || !string(commute.source)
          || !(commute.minutes === null || (typeof commute.minutes === 'number'
            && Number.isFinite(commute.minutes) && commute.minutes >= 0))) {
          fail(`看房记录 ${visit.id} 的通勤信息无效`);
        }
        const commuteKey = JSON.stringify([commute.targetId, commute.method]);
        if (commuteKeys.has(commuteKey)) fail(`看房记录 ${visit.id} 存在重复的通勤方式`);
        commuteKeys.add(commuteKey);
      }
    }

    const expenses = requireArray(house.expenses, `房屋 ${house.id} 的费用`);
    const expenseIds = collectIds(expenses, `房屋 ${house.id} 的费用`);
    addUnique(expenseIds, '费用');
    for (const expense of expenses) {
      if (!string(expense.name) || !string(expense.category)
        || !['unknown', 'known', 'included', 'free'].includes(expense.status)
        || !['unknown', 'self', 'other'].includes(expense.payer)
        || !['month', 'quarter', 'year', 'season', 'once'].includes(expense.period)
        || !['flat', 'sqm'].includes(expense.unit)
        || !nullableNumber(expense.amount, amount => amount >= 0)
        || !nullableNumber(expense.billingArea, area => area > 0)
        || (Object.hasOwn(expense, 'seasonAnnual') && typeof expense.seasonAnnual !== 'boolean')) {
        fail(`费用 ${expense.id} 的状态、周期或金额字段无效`);
      }
    }
    const contactIds = collectIds(house.contacts, `房屋 ${house.id} 的联系人`);
    addUnique(contactIds, '联系人');
    for (const contact of house.contacts) {
      if (!string(contact.name) || !string(contact.phone)
        || !['agent', 'owner', 'other'].includes(contact.role)
        || !string(contact.company) || !string(contact.remark)) fail(`联系人 ${contact.id} 的信息无效`);
    }
    if (!nullableNumber(house.price, price => price >= 0)
      || !nullableNumber(house.area, area => area > 0)
      || ['lat', 'lng'].some(field => Object.hasOwn(house, field)
        && !nullableNumber(house[field], value => value >= (field === 'lat' ? -90 : -180) && value <= (field === 'lat' ? 90 : 180)))) {
      fail(`房屋 ${house.id} 的价格、面积或坐标无效`);
    }
    if (![house.createdAt, house.updatedAt].every(validDate)) fail(`房屋 ${house.id} 的时间无效`);
    const utilities = requireArray(house.utilities, `房屋 ${house.id} 的水电信息`);
    const utilityTypes = new Set();
    for (const utility of utilities) {
      requireObject(utility, `房屋 ${house.id} 的水电信息`);
      if (!['water', 'electricity', 'gas'].includes(utility.type) || utilityTypes.has(utility.type)
        || !nullableNumber(utility.rate, rate => rate >= 0)
        || !['unknown', 'civil', 'commercial'].includes(utility.pricing)
        || !['unknown', 'self', 'landlord', 'included'].includes(utility.payment)
        || !string(utility.source)) fail(`房屋 ${house.id} 的水电信息无效`);
      utilityTypes.add(utility.type);
    }
    const terms = requireObject(house.terms, `房屋 ${house.id} 的租赁条件`);
    const sourceFields = ['source', 'heatingSource', 'furnitureSource', 'petsSource', 'rentSource'];
    if (!['unknown', 'central', 'self', 'ac', 'other'].includes(terms.heating)
      || !['unknown', 'none', 'partial', 'full'].includes(terms.furnitureStatus)
      || !Array.isArray(terms.furniture) || !terms.furniture.every(string)
      || !['unknown', 'allowed', 'not-allowed', 'conditional'].includes(terms.pets)
      || !string(terms.petConditions) || !string(terms.payment) || !string(terms.lease)
      || (Object.hasOwn(terms, 'furnitureNotes') && !string(terms.furnitureNotes))
      || !nullableNumber(terms.deposit, deposit => deposit >= 0)
      || !['amount', 'months'].includes(terms.depositUnit)
      || sourceFields.some(field => Object.hasOwn(terms, field) && !string(terms[field]))) {
      fail(`房屋 ${house.id} 的居住约定无效`);
    }
    const ownership = requireObject(house.ownership, `房屋 ${house.id} 的产权信息`);
    if (!nullableNumber(ownership.builtYear, Number.isFinite)
      || !nullableNumber(ownership.years, Number.isFinite)
      || !nullableNumber(ownership.startYear, Number.isFinite)
      || !['unknown', 'commodity', 'reform', 'affordable', 'commercial', 'other'].includes(ownership.nature)
      || !['unknown', 'yes', 'two', 'less'].includes(ownership.held)
      || !['unknown', 'yes', 'no'].includes(ownership.sole)
      || !string(ownership.source)) fail(`房屋 ${house.id} 的产权信息无效`);
    if (!nullableString(house.coverId) || !nullableString(house.planId)) fail(`房屋 ${house.id} 的照片引用无效`);
  }

  const photos = requireArray(state.photos, '照片');
  const photoIds = collectIds(photos, '照片');
  addUnique(photoIds, '照片');
  const photoById = new Map();
  for (const photo of photos) {
    if (!houseIds.has(photo.houseId)) fail(`照片 ${photo.id} 引用了不存在的房屋`);
    if (!nullableString(photo.visitId)) fail(`照片 ${photo.id} 的看房记录引用无效`);
    if (photo.visitId !== null && !visitsByHouse.get(photo.houseId).has(photo.visitId)) {
      fail(`照片 ${photo.id} 引用了不存在的看房记录`);
    }
    if (!string(photo.sectionKey) || !sectionKeyValid(photo.sectionKey, spacesByHouse.get(photo.houseId))) {
      fail(`照片 ${photo.id} 的区域引用无效`);
    }
    if (!string(photo.filename) || !string(photo.type) || !MEDIA_TYPES.has(photo.type)
      || !Number.isSafeInteger(photo.size) || photo.size < 0 || !string(photo.caption)
      || !string(photo.createdAt)) fail(`照片 ${photo.id} 的信息无效`);
    photoById.set(photo.id, photo);
  }
  for (const house of houses) {
    for (const field of ['coverId', 'planId']) {
      const id = house[field];
      if (id !== null && (!photoById.has(id) || photoById.get(id).houseId !== house.id
        || !IMAGE_TYPES.has(photoById.get(id).type))) {
        fail(`房屋 ${house.id} 的${field === 'coverId' ? '封面' : '户型图'}引用无效`);
      }
    }
  }

  const compare = requireObject(state.compare, '比较清单');
  for (const mode of ['buy', 'rent']) {
    const ids = requireArray(compare[mode], `${mode} 比较清单`);
    if (ids.length > 4) fail(`${mode} 比较清单最多保留 4 套房屋`);
    const seen = new Set();
    for (const id of ids) {
      if (!houseIds.has(id) || houses.find(house => house.id === id)?.mode !== mode) {
        fail(`${mode} 比较清单引用了不存在或类型不匹配的房屋`);
      }
      if (seen.has(id)) fail(`${mode} 比较清单存在重复房屋`);
      seen.add(id);
    }
  }
  return state;
}

function openDatabase() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STATE_STORE)) db.createObjectStore(STATE_STORE);
        if (!db.objectStoreNames.contains(PHOTO_STORE)) db.createObjectStore(PHOTO_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(storageError(request.error));
      request.onblocked = () => reject(new Error('本地数据库正在被其他页面占用，请关闭其他原型页面后重试'));
    });
  }
  return dbPromise;
}

function storageError(error) {
  if (error?.name === 'QuotaExceededError') return new Error('本地存储空间不足，请删除部分照片后重试', { cause: error });
  if (error instanceof Error && (error.message.startsWith('备份') || error.message.startsWith('本地'))) return error;
  return new Error(`本地存储操作失败：${error?.message || '未知错误'}`, { cause: error });
}

function clone(value) {
  return structuredClone(value);
}

export async function loadState() {
  if (isNative()) return nativeStorage('loadState');
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STATE_STORE, 'readonly');
    const request = tx.objectStore(STATE_STORE).get('current');
    let result = null;
    request.onsuccess = () => { result = request.result === undefined ? null : clone(request.result); };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(storageError(tx.error || request.error));
    tx.onabort = () => reject(storageError(tx.error || request.error));
  });
}

export async function saveState(state) {
  validateState(state);
  if (isNative()) return nativeStorage('saveState', { state });
  const db = await openDatabase();
  await transaction(db, [STATE_STORE], tx => tx.objectStore(STATE_STORE).put(clone(state), 'current'));
}

export async function putPhoto(state, metadata, blob) {
  validateState(state);
  requireObject(metadata, '照片');
  const storedMetadata = state.photos.find(photo => photo.id === metadata.id);
  if (!storedMetadata) fail('保存状态中缺少这张照片的元数据');
  validateBlob(storedMetadata, blob);
  if (isNative()) return nativeStorage('putPhoto', { state, metadata, base64: await blobBase64(blob) });
  const db = await openDatabase();
  await transaction(db, [STATE_STORE, PHOTO_STORE], tx => {
    tx.objectStore(STATE_STORE).put(clone(state), 'current');
    tx.objectStore(PHOTO_STORE).put(blob, metadata.id);
  });
}

export async function putPickedMedia(state, metadata, token) {
  validateState(state);
  requireObject(metadata, '媒体');
  requireId(token, '暂存媒体');
  const stored = state.photos.find(photo => photo.id === metadata.id);
  if (!stored || stored.type !== metadata.type || stored.size !== metadata.size
    || stored.filename !== metadata.filename || !MEDIA_TYPES.has(stored.type)) {
    fail('保存状态中缺少这项媒体记录');
  }
  if (!isNative()) fail('当前环境不支持直接读取系统媒体暂存文件');
  return nativeStorage('putPickedMedia', { state, metadata: stored, token });
}

export async function discardPickedMedia(tokens) {
  if (!Array.isArray(tokens)) fail('待清理媒体编号必须是数组');
  if (!isNative() || tokens.length === 0) return;
  for (const token of tokens) requireId(token, '暂存媒体');
  return nativeStorage('discardPickedMedia', { tokens });
}

export async function copyPhotos(state, pairs) {
  validateState(state);
  if (!Array.isArray(pairs)) fail('照片复制映射必须是数组');
  const seen = new Set();
  const copies = pairs.map(pair => {
    requireObject(pair, '照片复制映射');
    const from = requireId(pair.from, '原照片');
    const to = requireId(pair.to, '新照片');
    if (from === to || seen.has(to)) fail('照片复制映射无效');
    seen.add(to);
    const source = state.photos.find(photo => photo.id === from);
    const target = state.photos.find(photo => photo.id === to);
    if (!source || !target || source.type !== target.type || source.size !== target.size) {
      fail('房源副本的照片元数据无效');
    }
    return { from, to, target };
  });
  if (isNative()) return nativeStorage('copyPhotos', { state, pairs });
  const db = await openDatabase();
  await new Promise((resolve, reject) => {
    let tx;
    let failure;
    try {
      tx = db.transaction([STATE_STORE, PHOTO_STORE], 'readwrite');
      const photoStore = tx.objectStore(PHOTO_STORE);
      tx.objectStore(STATE_STORE).put(clone(state), 'current');
      for (const { from, to, target } of copies) {
        const request = photoStore.get(from);
        request.onsuccess = () => {
          const blob = request.result;
          if (blob === undefined) {
            failure = new Error(`原照片文件缺失，无法复制：${from}`);
            tx.abort();
            return;
          }
          try {
            validateBlob(target, blob);
            photoStore.put(blob, to);
          } catch (error) {
            failure = error;
            tx.abort();
          }
        };
      }
    } catch (error) {
      try { tx?.abort(); } catch {}
      reject(storageError(error));
      return;
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(storageError(failure || tx.error));
    tx.onabort = () => reject(storageError(failure || tx.error));
  });
}

export async function getPhoto(id) {
  if (isNative()) return base64Blob(nativeStorage('getPhoto', { id }));
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PHOTO_STORE, 'readonly');
    const request = tx.objectStore(PHOTO_STORE).get(id);
    let result = null;
    request.onsuccess = () => { result = request.result ?? null; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(storageError(tx.error || request.error));
    tx.onabort = () => reject(storageError(tx.error || request.error));
  });
}

export async function deletePhotos(state, ids) {
  validateState(state);
  if (!Array.isArray(ids)) fail('待删除照片 ID 必须是数组');
  if (isNative()) return nativeStorage('deletePhotos', { state, ids });
  const db = await openDatabase();
  await transaction(db, [STATE_STORE, PHOTO_STORE], tx => {
    tx.objectStore(STATE_STORE).put(clone(state), 'current');
    const store = tx.objectStore(PHOTO_STORE);
    for (const id of ids) store.delete(id);
  });
}

export async function exportBackup() {
  if (isNative()) {
    const snapshot = nativeStorage('openSnapshot');
    try {
      const files = new Map();
      for (const photo of snapshot.state.photos) files.set(photo.id, base64Blob(nativeStorage('snapshotPhoto', { token: snapshot.token, id: photo.id })));
      return await zipSnapshot({ state: snapshot.state, files });
    } finally { nativeStorage('closeSnapshot', { token: snapshot.token }); }
  }
  const db = await openDatabase();
  const snapshot = await new Promise((resolve, reject) => {
    const tx = db.transaction([STATE_STORE, PHOTO_STORE], 'readonly');
    const stateRequest = tx.objectStore(STATE_STORE).get('current');
    let state;
    const files = new Map();
    let missing = false;
    stateRequest.onsuccess = () => {
      if (stateRequest.result === undefined) {
        missing = true;
        return;
      }
      state = clone(stateRequest.result);
      for (const photo of state.photos ?? []) {
        const request = tx.objectStore(PHOTO_STORE).get(photo.id);
        request.onsuccess = () => files.set(photo.id, request.result ?? null);
      }
    };
    tx.oncomplete = () => {
      if (missing) reject(new Error('没有可备份的数据'));
      else if ([...files.values()].some(blob => blob === null)) reject(new Error('本地照片文件缺失，无法生成完整备份'));
      else resolve({ state, files });
    };
    tx.onerror = () => reject(storageError(tx.error || stateRequest.error));
    tx.onabort = () => reject(storageError(tx.error || stateRequest.error));
  });
  return zipSnapshot(snapshot);
}

async function zipSnapshot(snapshot) {
  validateState(snapshot.state);
  const zip = getZip();
  const records = [];
  for (const photo of snapshot.state.photos) {
    const blob = snapshot.files.get(photo.id);
    validateBlob(photo, blob);
    const path = `photos/${photo.id}`;
    const bytes = await blob.arrayBuffer();
    records.push({ id: photo.id, path, size: blob.size, sha256: await sha256(bytes) });
    zip.file(path, blob, { mimeType: photo.type });
  }
  zip.file('app.json', JSON.stringify({ format: 'kf-note-backup', version: 1, state: snapshot.state, files: records }));
  return zip.generateAsync({ type: 'blob', mimeType: 'application/zip' });
}

export async function importBackup(file) {
  if (!(file instanceof Blob)) fail('请选择有效的备份文件');
  let zip;
  try {
    zip = await getZip().loadAsync(file);
  } catch (error) {
    throw new Error(`备份文件无法读取：${error?.message || 'ZIP 格式无效'}`, { cause: error });
  }
  const appFile = zip.file('app.json');
  if (!appFile) fail('备份缺少 app.json');
  let wrapper;
  try {
    wrapper = JSON.parse(await appFile.async('string'));
  } catch (error) {
    throw new Error('备份清单格式无效', { cause: error });
  }
  requireObject(wrapper, '备份清单');
  if (wrapper.format !== 'kf-note-backup' || wrapper.version !== 1) fail('备份格式或版本不受支持');
  validateState(wrapper.state);
  const records = requireArray(wrapper.files, '备份照片清单');
  if (records.length !== wrapper.state.photos.length) fail('备份照片清单不完整');
  const recordById = new Map();
  const staged = new Map();
  for (const record of records) {
    requireObject(record, '备份照片记录');
    const id = requireId(record.id, '备份照片');
    const metadata = wrapper.state.photos.find(photo => photo.id === id);
    if (!metadata || recordById.has(id) || record.path !== `photos/${id}`
      || record.size !== metadata.size || !string(record.sha256) || !/^[a-f0-9]{64}$/i.test(record.sha256)) {
      fail(`备份照片 ${id} 的清单信息无效`);
    }
    const entry = zip.file(record.path);
    if (!entry || entry.dir) fail(`备份缺少照片文件：${id}`);
    const bytes = await entry.async('uint8array');
    if (bytes.byteLength !== metadata.size) fail(`照片 ${id} 的文件大小与记录不符`);
    const blob = new Blob([bytes], { type: metadata.type });
    validateBlob(metadata, blob);
    const digest = await sha256(await blob.arrayBuffer());
    if (digest.toLowerCase() !== record.sha256.toLowerCase()) fail(`照片文件校验失败：${id}`);
    recordById.set(id, record);
    staged.set(id, blob);
  }

  if (isNative()) {
    const { token } = nativeStorage('beginImport');
    try {
      for (const metadata of wrapper.state.photos) nativeStorage('stagePhoto', { token, metadata, base64: await blobBase64(staged.get(metadata.id)) });
      nativeStorage('commitImport', { token, state: wrapper.state });
    } catch (error) {
      try { nativeStorage('abortImport', { token }); } catch {}
      throw error;
    }
    return clone(wrapper.state);
  }
  const db = await openDatabase();
  await transaction(db, [STATE_STORE, PHOTO_STORE], tx => {
    const photos = tx.objectStore(PHOTO_STORE);
    photos.clear();
    for (const [id, blob] of staged) photos.put(blob, id);
    tx.objectStore(STATE_STORE).put(clone(wrapper.state), 'current');
  });
  return clone(wrapper.state);
}

export async function estimateStorage() {
  if (isNative()) return nativeStorage('estimateStorage');
  if (!navigator.storage?.estimate) return { usage: null, quota: null };
  const { usage = null, quota = null } = await navigator.storage.estimate();
  return { usage, quota };
}

export async function getThumbnail(id) {
  if (!isNative()) return getPhoto(id);
  try { return base64Blob(nativeStorage('getPhoto', { id, thumbnail: true })); }
  catch { return getPhoto(id); } // Older Android image decoders may not support AVIF.
}

function validateBlob(metadata, blob) {
  if (!(blob instanceof Blob) || !MEDIA_TYPES.has(metadata.type) || blob.type !== metadata.type
    || blob.size !== metadata.size) fail(`照片 ${metadata.id ?? ''} 的文件大小或格式与记录不符`);
}

function getZip() {
  if (!globalThis.JSZip) throw new Error('ZIP 备份组件未加载，请刷新页面后重试');
  return new globalThis.JSZip();
}

async function sha256(buffer) {
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }
  if (typeof globalThis.sha256 === 'function') return globalThis.sha256(buffer);
  throw new Error('当前环境不支持照片校验，请确保已加载本地 SHA-256 组件');
}

function transaction(db, stores, queueRequests) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(stores, 'readwrite');
      queueRequests(tx);
    } catch (error) {
      try { tx?.abort(); } catch {}
      reject(storageError(error));
      return;
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(storageError(tx.error));
    tx.onabort = () => reject(storageError(tx.error));
  });
}
