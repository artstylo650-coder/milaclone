'use strict';

import { state, dom, elMap } from '../core/state.js';
import { api, startAction } from '../core/api.js';
import { isCard, isLocked, toast } from '../core/util.js';
import { queueConnections } from './connections.js';
import { showMenu } from '../ui/menus.js';

// Layout tools for the selection: align, distribute, tidy into a grid, nudge
// with the arrow keys, and an optional snap-to-grid used while dragging.

export const GRID = 22;   // matches the dotted canvas background

export function snapEnabled() {
  try { return localStorage.getItem('snapToGrid') === '1'; } catch (_) { return false; }
}
export function toggleSnap() {
  const next = !snapEnabled();
  try { localStorage.setItem('snapToGrid', next ? '1' : '0'); } catch (_) {}
  toast(next ? 'Grade magnética ligada' : 'Grade magnética desligada');
  return next;
}
export const snap = v => Math.round(v / GRID) * GRID;

// Movable cards in the selection with their rendered size.
function boxes() {
  return state.view.items
    .filter(it => state.selectedIds.has(it.id) && isCard(it) && !it.parentItemId && !isLocked(it))
    .map(it => {
      const el = elMap.get(it.id);
      return { it, el, x: it.x, y: it.y, w: el ? el.offsetWidth : (it.w || 240), h: el ? el.offsetHeight : (it.h || 120) };
    });
}

async function commit(list) {
  const moved = list.filter(b => Math.round(b.x) !== b.it.x || Math.round(b.y) !== b.it.y);
  if (!moved.length) return;
  for (const b of moved) {
    b.it.x = Math.round(b.x); b.it.y = Math.round(b.y);
    if (b.el) { b.el.style.left = b.it.x + 'px'; b.el.style.top = b.it.y + 'px'; }
  }
  queueConnections();
  const done = startAction();
  try { await api.patchMany(moved.map(b => ({ id: b.it.id, x: b.it.x, y: b.it.y }))); } finally { done(); }
}

export function align(kind) {
  const list = boxes();
  if (list.length < 2) return;
  const left = Math.min(...list.map(b => b.x)), right = Math.max(...list.map(b => b.x + b.w));
  const top = Math.min(...list.map(b => b.y)), bottom = Math.max(...list.map(b => b.y + b.h));
  for (const b of list) {
    if (kind === 'left') b.x = left;
    if (kind === 'right') b.x = right - b.w;
    if (kind === 'center') b.x = (left + right) / 2 - b.w / 2;
    if (kind === 'top') b.y = top;
    if (kind === 'bottom') b.y = bottom - b.h;
    if (kind === 'middle') b.y = (top + bottom) / 2 - b.h / 2;
  }
  return commit(list);
}

// Equal gaps between neighbours; the outermost cards stay where they are.
export function distribute(axis) {
  const list = boxes();
  if (list.length < 3) { toast('Selecione pelo menos 3 cards para distribuir'); return; }
  const pos = axis === 'h' ? 'x' : 'y', size = axis === 'h' ? 'w' : 'h';
  list.sort((a, b) => a[pos] - b[pos]);
  const span = list.at(-1)[pos] + list.at(-1)[size] - list[0][pos];
  const gap = (span - list.reduce((sum, b) => sum + b[size], 0)) / (list.length - 1);
  let cursor = list[0][pos];
  for (const b of list) { b[pos] = cursor; cursor += b[size] + gap; }
  return commit(list);
}

// Reading-order grid starting at the selection's top-left corner.
export function tidy() {
  const list = boxes();
  if (list.length < 2) return;
  list.sort((a, b) => (Math.round(a.y / 80) - Math.round(b.y / 80)) || (a.x - b.x));
  const cols = Math.ceil(Math.sqrt(list.length));
  const cellW = Math.max(...list.map(b => b.w)) + 24;
  const left = Math.min(...list.map(b => b.x)), top = Math.min(...list.map(b => b.y));
  let y = top;
  for (let r = 0; r < list.length; r += cols) {
    const row = list.slice(r, r + cols);
    row.forEach((b, i) => { b.x = left + i * cellW; b.y = y; });
    y += Math.max(...row.map(b => b.h)) + 24;
  }
  return commit(list);
}

let nudgeTimer = 0;
const nudgeQueue = new Map();
export function nudge(dx, dy) {
  const list = boxes();
  if (!list.length) return false;
  for (const b of list) {
    b.it.x = Math.round(b.it.x + dx); b.it.y = Math.round(b.it.y + dy);
    if (b.el) { b.el.style.left = b.it.x + 'px'; b.el.style.top = b.it.y + 'px'; }
    nudgeQueue.set(b.it.id, { id: b.it.id, x: b.it.x, y: b.it.y });
  }
  queueConnections();
  clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(() => {
    const updates = [...nudgeQueue.values()];
    nudgeQueue.clear();
    // a burst of arrow presses is one undo step
    const done = startAction('nudge:' + updates.map(u => u.id).sort().join(','));
    api.patchMany(updates);
    done();
  }, 350);
  return true;
}

export function openAlignMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  showMenu([
    { label: 'Alinhar à esquerda', fn: () => align('left') },
    { label: 'Centralizar na horizontal', fn: () => align('center') },
    { label: 'Alinhar à direita', fn: () => align('right') },
    { sep: true },
    { label: 'Alinhar no topo', fn: () => align('top') },
    { label: 'Centralizar na vertical', fn: () => align('middle') },
    { label: 'Alinhar na base', fn: () => align('bottom') },
    { sep: true },
    { label: 'Distribuir na horizontal', fn: () => distribute('h') },
    { label: 'Distribuir na vertical', fn: () => distribute('v') },
    { label: 'Organizar em grade', fn: () => tidy() }
  ], r.left, r.top - 330);
}

export function initArrange() {
  const btn = document.getElementById('multiAlign');
  if (btn) btn.onclick = (e) => { e.stopPropagation(); openAlignMenu(btn); };
  if (dom.stage) dom.stage.classList.toggle('snap-grid', snapEnabled());
}
