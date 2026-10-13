'use strict';

// Requests sent while an action is open carry its X-Undo-Key, so the server
// folds them into one undo step (e.g. "group 5 cards" = create + 5 patches).
let actionKey = null;
export function startAction(key = 'action:' + Math.random().toString(36).slice(2)) {
  const previous = actionKey;
  actionKey = key;
  return () => { if (actionKey === key) actionKey = previous; };
}

const writeListeners = [];
export function onWrite(fn) { writeListeners.push(fn); }

// Undo history is kept per browser tab.
export const clientId = (() => {
  const fresh = Math.random().toString(36).slice(2) + Date.now().toString(36);
  try {
    const saved = sessionStorage.getItem('undoClient');
    if (saved) return saved;
    sessionStorage.setItem('undoClient', fresh);
  } catch (_) {}
  return fresh;
})();

async function send(method, url, body) {
  const headers = { 'Content-Type': 'application/json', 'X-Client-Id': clientId };
  if (actionKey) headers['X-Undo-Key'] = actionKey;
  const response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  writeListeners.forEach(fn => fn());
  return response;
}

// Thin wrappers over the JSON endpoints exposed by the Node backend.
export const api = {
  async root() { return (await fetch('/api/root')).json(); },
  async canvas(id) { return (await fetch('/api/canvas/' + id)).json(); },
  async todos() { return (await fetch('/api/todos')).json(); },
  async patchCanvas(id, body) { return (await send('PATCH', '/api/canvas/' + id, body)).json(); },
  async create(body) { return (await send('POST', '/api/item', body)).json(); },
  async patch(id, body) { return (await send('PATCH', '/api/item/' + id, body)).json(); },
  async patchMany(updates) { return (await send('PATCH', '/api/items', { updates })).json(); },
  async transfer(body) {
    const response = await send('POST', '/api/transfer', body);
    const result = await response.json().catch(() => ({}));
    return response.ok ? result : { error: result.error || 'transfer failed' };
  },
  async remove(id) { return (await send('DELETE', '/api/item/' + id)).json(); },
  async history(direction) {
    const headers = { 'X-Client-Id': clientId };
    if (!direction) return (await fetch('/api/history', { headers })).json();
    return (await fetch('/api/history/' + direction, { method: 'POST', headers })).json();
  },
  async search(q) { return (await fetch('/api/search?q=' + encodeURIComponent(q))).json(); },
  // ComfyUI bridge: method + path under /api/comfy; errors come back as { error }
  async comfy(method, path, body) {
    const response = method === 'GET' ? await fetch('/api/comfy' + path) : await send(method, '/api/comfy' + path, body);
    const result = await response.json().catch(() => ({}));
    return response.ok ? result : { error: result.error || 'ComfyUI request failed' };
  },
  // note translation; errors come back as { error }
  async translate(body) {
    const response = await send('POST', '/api/translate', body);
    const result = await response.json().catch(() => ({}));
    if (response.status === 404) return { error: 'O servidor está desatualizado: feche a janela do Milaclone e abra de novo.' };
    return response.ok ? result : { error: result.error || 'Falha na tradução' };
  },
  async translateSettings(body) {
    if (!body) return (await fetch('/api/translate/settings')).json();
    return (await send('PUT', '/api/translate/settings', body)).json();
  },
  async trash() { return (await fetch('/api/trash')).json(); },
  async restoreTrash(id) {
    const response = await send('POST', '/api/trash/' + id + '/restore');
    const result = await response.json().catch(() => ({}));
    return response.ok ? result : { error: result.error || 'restore failed' };
  },
  async purgeTrash(id) { return (await send('DELETE', '/api/trash' + (id ? '/' + id : ''))).json(); },
  async restoreBackup(file) {
    const fd = new FormData(); fd.append('file', file);
    const response = await fetch('/api/backup/restore', { method: 'POST', body: fd });
    const result = await response.json().catch(() => ({}));
    return response.ok ? result : { error: result.error || 'restore failed' };
  },
  async upload(file) {
    const fd = new FormData(); fd.append('file', file);
    const response = await fetch('/api/upload', { method:'POST', body:fd });
    const body = await response.json().catch(() => ({}));
    return response.ok ? body : { error: body.error || 'upload failed' };
  }
};
