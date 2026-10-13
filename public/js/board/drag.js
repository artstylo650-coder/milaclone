'use strict';

import { state, dom } from '../core/state.js';
import { api, startAction } from '../core/api.js';
import { isLocked, caretIndexAt } from '../core/util.js';
import { screenToWorld } from './viewport.js';
import { select, selectOnly, itemIdsWithGroup, enterEdit, updateMultiActions } from './editing.js';
import { render } from './cards.js';
import { queueConnections } from './connections.js';
import { groupAtRect } from './groups.js';
import { snapEnabled, snap } from './arrange.js';

// Dragging cards (free-move + in/out of columns) and resizing.

export function onItemPointerDown(e, it, el) {
  if (e.button !== 0) return;
  if (state.armed) return;
  if (state.spacePanning) return;
  if (e.target.closest('[data-nodrag]')) { e.stopPropagation(); return; }
  // inside a field being edited the pointer belongs to the text (caret, drag
  // to select): keep it from reaching the stage, which would start a marquee
  if (el.classList.contains('editing') && e.target.closest('[data-edit]')) { e.stopPropagation(); return; }
  e.stopPropagation();
  clearNativeSelection();
  const selectionGesture = e.shiftKey;
  if (selectionGesture) {
    select(it.id, { toggle: true });
    if (!state.selectedIds.has(it.id)) return;
  } else if (!state.selectedIds.has(it.id)) {
    select(it.id);
  }
  if (isLocked(it)) return;

  const start = { sx: e.clientX, sy: e.clientY };
  const fromColumn = !!it.parentItemId;
  let moved = false;
  const rect = el.getBoundingClientRect();
  const startWorld = screenToWorld(rect.left, rect.top);
  const groupStarts = !fromColumn && state.selectedIds.size > 1
    ? state.view.items
      .filter(item => state.selectedIds.has(item.id) && !item.parentItemId && !isLocked(item))
      .map(item => ({ item, el: dom.world.querySelector(`[data-id="${item.id}"]`), x: item.x, y: item.y }))
      .filter(entry => entry.el)
    : [];
  state.drag = { it, el, start, startWorld, fromColumn, moved: false, dropCol: null, groupStarts, dx: 0, dy: 0 };
  el.setPointerCapture(e.pointerId);

  const move = (ev) => {
    const dx = ev.clientX - start.sx, dy = ev.clientY - start.sy;
    if (!moved && Math.hypot(dx, dy) < 6) return;
    if (!moved) {
      moved = true; state.drag.moved = true;
      if (groupStarts.length > 1) groupStarts.forEach(entry => entry.el.classList.add('dragging'));
      else el.classList.add('dragging');
      if (fromColumn) {
        dom.world.appendChild(el);
        el.classList.remove('in-column');
        el.style.width = (it.w || 240) + 'px';
        el.style.zIndex = 99999;
      }
    }
    // snap the grabbed card to the grid (Alt drags freely); the rest follow it
    const snapping = snapEnabled() && !ev.altKey;
    let wx = startWorld.x + dx / state.cam.scale;
    let wy = startWorld.y + dy / state.cam.scale;
    if (snapping) { wx = snap(wx); wy = snap(wy); }
    if (groupStarts.length > 1) {
      state.drag.dx = snapping ? snap(it.x + dx / state.cam.scale) - it.x : dx / state.cam.scale;
      state.drag.dy = snapping ? snap(it.y + dy / state.cam.scale) - it.y : dy / state.cam.scale;
      groupStarts.forEach(entry => {
        entry.el.style.left = (entry.x + state.drag.dx) + 'px';
        entry.el.style.top = (entry.y + state.drag.dy) + 'px';
      });
      queueConnections();
    } else {
      el.style.left = wx + 'px'; el.style.top = wy + 'px';
      queueConnections();
      highlightColumn(ev, it);
    }
  };

  const up = (ev) => {
    el.releasePointerCapture(e.pointerId);
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    if (state.drag.groupStarts.length > 1) state.drag.groupStarts.forEach(entry => entry.el.classList.remove('dragging'));
    else el.classList.remove('dragging');
    if (!moved) {
      // A plain click inside a multi-selection narrows it to the clicked card.
      if (!selectionGesture && state.selectedIds.size > itemIdsWithGroup(it.id).length) selectOnly(it.id);
      // the pointerdown target is the field that was clicked (pointerup is
      // retargeted to the card by the pointer capture)
      if (!selectionGesture && it.type !== 'board' && it.type !== 'group') maybeEdit(el, e);
      state.drag = null; return;
    }
    finishDrag(ev);
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

// Drop any page text selection left by Shift+clicks outside an edited field.
function clearNativeSelection() {
  const sel = window.getSelection && window.getSelection();
  if (sel && sel.type === 'Range') sel.removeAllRanges();
}

// Fields are inert (pointer-events: none) until the card is in edit mode, so
// the click never lands on them: find the field under the pointer by geometry.
function fieldAt(el, x, y) {
  let best = null, bestDist = Infinity;
  for (const f of el.querySelectorAll('[data-edit]')) {
    const r = f.getBoundingClientRect();
    if (!r.width || !r.height) continue;   // hidden (e.g. a body shown as Markdown)
    const dx = Math.max(r.left - x, 0, x - r.right), dy = Math.max(r.top - y, 0, y - r.bottom);
    const d = Math.hypot(dx, dy);
    if (d < bestDist) { best = f; bestDist = d; }
  }
  return bestDist <= 24 ? best : null;
}

function maybeEdit(el, ev) {
  if (!el.querySelector('[data-edit]')) return;
  if (el.classList.contains('editing')) return;
  // clicking a note's formatted body edits the body, not the title
  const fromView = ev.target.closest('.nbody-view') && el.querySelector('.nbody');
  const field = fromView || fieldAt(el, ev.clientX, ev.clientY);
  // the caret goes where the user clicked (measured before edit mode changes the layout)
  const caret = field && !fromView && field.setSelectionRange ? caretIndexAt(field, ev.clientX, ev.clientY, state.cam.scale) : null;
  enterEdit(el);
  const f = field || el.querySelector('[data-edit]');
  requestAnimationFrame(() => {
    if (!f) return;
    f.focus();
    const at = caret != null ? caret : f.value.length;
    if (f.setSelectionRange) f.setSelectionRange(at, at);
  });
}

function columnBodyUnder(clientX, clientY, excludeId) {
  const bodies = dom.world.querySelectorAll('.col-body');
  for (const b of bodies) {
    if (b.dataset.colbody === excludeId) continue;
    const r = b.getBoundingClientRect();
    if (clientX >= r.left - 6 && clientX <= r.right + 6 && clientY >= r.top - 6 && clientY <= r.bottom + 30) return b;
  }
  return null;
}

function highlightColumn(ev, it) {
  dom.world.querySelectorAll('.column.drop-target').forEach(c => c.classList.remove('drop-target'));
  if (it.type === 'column') { state.drag.dropCol = null; return; }
  const body = columnBodyUnder(ev.clientX, ev.clientY, it.id);
  state.drag.dropCol = body ? body.dataset.colbody : null;
  if (body) body.closest('.column').classList.add('drop-target');
}

async function finishDrag(ev) {
  const { it, el } = state.drag;
  dom.world.querySelectorAll('.column.drop-target').forEach(c => c.classList.remove('drop-target'));
  if (state.drag.groupStarts.length > 1) {
    const starts = state.drag.groupStarts;
    for (const entry of starts) {
      entry.item.x = Math.round(entry.x + state.drag.dx);
      entry.item.y = Math.round(entry.y + state.drag.dy);
    }
    // Cards travelling with their own frame keep it; every other card joins
    // whichever group it was dropped in (or none), like a single drag.
    const movingGroups = new Set(starts.filter(entry => entry.item.type === 'group').map(entry => entry.item.id));
    const updates = starts.map(entry => {
      const { item } = entry;
      const update = { id: item.id, x: item.x, y: item.y };
      if (item.type === 'group' || movingGroups.has(item.data?.groupId)) return update;
      const target = groupAtRect(item.x, item.y, entry.el.offsetWidth, entry.el.offsetHeight, item.id);
      const groupId = target ? target.id : null;
      if (groupId !== (item.data?.groupId || null)) {
        item.data = Object.assign({}, item.data, { groupId });
        update.data = { groupId };
      }
      return update;
    });
    await api.patchMany(updates);
    updateMultiActions();
    state.drag = null;
    return;
  }
  if (state.drag.dropCol) {
    const order = insertOrder(state.drag.dropCol, ev.clientX, ev.clientY, it.id);
    it.parentItemId = state.drag.dropCol;
    it.y = order;
    const sibs = state.view.items.filter(k => k.parentItemId === state.drag.dropCol).sort((a, b) => a.y - b.y);
    sibs.forEach((s, i) => s.y = i);
    const done = startAction();
    try {
      await api.patch(it.id, { parentItemId: it.parentItemId, canvasId: state.view.canvas.id });
      await api.patchMany(sibs.map(s => ({ id: s.id, y: s.y })));
    } finally { done(); }
    render();
  } else {
    const wx = Math.round(parseFloat(el.style.left));
    const wy = Math.round(parseFloat(el.style.top));
    const wasChild = state.drag.fromColumn;
    const previousGroupId = it.data && it.data.groupId || null;
    const targetGroup = it.type === 'group' ? null : groupAtRect(wx, wy, el.offsetWidth, el.offsetHeight, it.id);
    const groupId = it.type === 'group' ? it.id : (targetGroup ? targetGroup.id : null);
    it.x = wx; it.y = wy; it.parentItemId = null;
    it.data = Object.assign({}, it.data, { groupId });
    await api.patch(it.id, { x: wx, y: wy, parentItemId: null, data: { groupId } });
    if (wasChild) render();
    if (groupId !== previousGroupId) updateMultiActions();
  }
  state.drag = null;
}

// Index the dropped card takes among the column's cards, in reading order.
function insertOrder(colId, clientX, clientY, selfId) {
  const body = dom.world.querySelector(`[data-colbody="${colId}"]`);
  const stacked = body && body.closest('.column').classList.contains('layout-stack');
  const rows = [...body.querySelectorAll(':scope > .item')].filter(r => r.dataset.id !== selfId);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i].getBoundingClientRect();
    if (stacked ? clientY < r.top + r.height / 2
      : clientY < r.top || (clientY <= r.bottom && clientX < r.left + r.width / 2)) return i;
  }
  return rows.length;
}

export function startResize(e, it, el) {
  e.preventDefault(); e.stopPropagation();
  const startX = e.clientX, startY = e.clientY;
  const startW = it.w || el.offsetWidth, startH = it.h || el.offsetHeight;
  el.setPointerCapture(e.pointerId);
  const move = (ev) => {
    let w = startW + (ev.clientX - startX) / state.cam.scale;
    w = Math.max(120, Math.min(900, w));
    el.style.width = w + 'px'; it.w = Math.round(w);
    // a side-by-side column sizes its cards from its width
    if (it.type === 'column') el.style.setProperty('--col-card-w', Math.max(120, w - 26) + 'px');
    queueConnections();
    if (it.type === 'group' || it.type === 'board') {
      let h = startH + (ev.clientY - startY) / state.cam.scale;
      h = Math.max(80, Math.min(1200, h));
      el.style.height = h + 'px'; it.h = Math.round(h);
      el.classList.toggle('sized', it.type === 'board');
    }
  };
  const up = () => {
    el.releasePointerCapture(e.pointerId);
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    const sized = it.type === 'group' || it.type === 'board';
    api.patch(it.id, sized ? { w: it.w, h: it.h } : { w: it.w });
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}
