'use strict';

import { state, elMap } from '../core/state.js';
import { api, startAction } from '../core/api.js';
import { isLocked, isCard, toast, rid } from '../core/util.js';
import { render, refreshItem } from './cards.js';
import { selectMany, selectionIds, flushSaves } from './editing.js';
import { closeCtx } from '../ui/menus.js';
import { viewportCenterWorld } from './viewport.js';

// Copy / cut / paste / duplicate for the whole selection, and position locking.
// The server copies or moves the selection atomically (POST /api/transfer):
// copies remap the full subtree (column cards, group members, nested boards),
// cut + paste moves the original cards, so nothing is deleted on the way.

const MARKER = 'milaclone-clipboard:';
let pasteFallback = 0;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Text written to the system clipboard on copy. A later paste carrying it means
// "paste the board clipboard"; any other text came from outside the app.
export function isClipboardMarker(text) { return typeof text === 'string' && text.startsWith(MARKER); }

function markCut() {
  document.querySelectorAll('.item.cut-pending').forEach(el => el.classList.remove('cut-pending'));
  if (!state.clipboard || !state.clipboard.cut) return;
  for (const id of state.clipboard.ids) elMap.get(id)?.classList.add('cut-pending');
}

export function copySelected(cut) {
  const ids = selectionIds();
  if (!ids.length || !state.view.canvas) return '';
  state.clipboard = { ids, cut: !!cut, canvasId: state.view.canvas.id, token: rid() };
  markCut();
  toast((cut ? 'Recortado: ' : 'Copiado: ') + plural(ids.length, 'item', 'itens'));
  closeCtx();
  return MARKER + state.clipboard.token;
}

// Context-menu copy has no clipboard event to write into; best effort only.
export function copyToSystem(cut) {
  const marker = copySelected(cut);
  if (marker && navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(marker).catch(() => {});
}

async function reloadView() {
  const fresh = await api.canvas(state.view.canvas.id);
  if (!fresh.error) { state.view = fresh; render(); }
}

async function transfer(body) {
  await flushSaves();
  const result = await api.transfer(body);
  if (result.error) { toast(result.error); return null; }
  await reloadView();
  selectMany(result.ids, { expandGroups: false });
  return result.ids;
}

export async function pasteClipboard(wx, wy) {
  const clip = state.clipboard;
  if (!clip || !state.view.canvas) return;
  closeCtx();
  let x = wx, y = wy;
  // Copies on the same board land next to the originals; anything else lands
  // in the middle of the current view.
  if (x == null && (clip.cut || clip.canvasId !== state.view.canvas.id)) ({ x, y } = viewportCenterWorld());
  const ids = await transfer({ ids: clip.ids, canvasId: state.view.canvas.id, x, y, move: clip.cut });
  if (!ids) return;
  if (clip.cut) state.clipboard = null;
  markCut();
  toast(clip.cut ? 'Movido para cá' : 'Colado');
}

export async function duplicateSelected() {
  const ids = selectionIds();
  if (!ids.length) return;
  closeCtx();
  if (await transfer({ ids, canvasId: state.view.canvas.id })) toast('Duplicado');
}

// Keyboard paste normally arrives as a `paste` event (handled in tools.js). If
// the browser fires none, fall back to the board clipboard.
export function armPasteFallback() {
  clearTimeout(pasteFallback);
  pasteFallback = setTimeout(() => { if (state.clipboard) pasteClipboard(); }, 60);
}
export function cancelPasteFallback() { clearTimeout(pasteFallback); }

// One undo step for the whole action, however many requests it takes.
export async function toggleLock() {
  const done = startAction();
  try { return await toggleLockNow(); } finally { done(); }
}
async function toggleLockNow() {
  const items = state.view.items.filter(it => state.selectedIds.has(it.id) && isCard(it));
  if (!items.length) return;
  const primary = items.find(it => it.id === state.selectedId) || items[0];
  const locked = !isLocked(primary);
  await Promise.all(items.map(it => {
    it.data = Object.assign({}, it.data, { locked });
    return api.patch(it.id, { data: { locked } });
  }));
  items.forEach(refreshItem);
  toast(locked ? 'Posição travada' : 'Posição destravada');
  closeCtx();
}

