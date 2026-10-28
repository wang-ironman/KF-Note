// The Android host exposes this bridge only to bundled app pages.
export const isNative = () => typeof globalThis.KFNative?.storage === 'function';

export function nativeStorage(action, fields = {}) {
  const result = JSON.parse(globalThis.KFNative.storage(JSON.stringify({ action, ...fields })));
  if (!result.ok) throw new Error(result.error || '本地存储操作失败');
  return result.value;
}

let sequence = 0;
const replies = new Map();
export function nativePlatform(action, fields = {}) {
  globalThis.KFNativeReply = (id, result) => {
    const callback = replies.get(String(id));
    if (!callback) return;
    replies.delete(String(id));
    if (result.ok) callback.resolve(result.value);
    else callback.reject(new Error(result.error || '系统操作失败'));
  };
  return new Promise((resolve, reject) => {
    const id = String(++sequence);
    replies.set(id, { resolve, reject });
    try { globalThis.KFNative.platform(JSON.stringify({ id, action, ...fields })); }
    catch (error) { replies.delete(id); reject(error); }
  });
}

export async function blobBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 32768) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 32768)));
  return btoa(chunks.join(''));
}

export function base64Blob(value) {
  if (!value) return null;
  const bytes = Uint8Array.from(atob(value.base64), c => c.charCodeAt(0));
  return new Blob([bytes], { type: value.type || 'application/zip' });
}

export function nativeFile(value) {
  return new File([base64Blob(value)], value.name || '照片.jpg', { type: value.type || 'application/zip' });
}
