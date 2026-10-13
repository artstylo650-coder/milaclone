'use strict';

import { state, dom, elMap } from '../core/state.js';
import { api, startAction } from '../core/api.js';
import { render, renderCrumbs } from './cards.js';
import { closePalette, closeCtx } from '../ui/menus.js';
import { updateSelectionChrome } from '../ui/boardchrome.js';
import { toast, isCard, autoGrow } from '../core/util.js';
import { requestMinimap } from './minimap.js';

// Selection, inline-edit mode, debounced saves, and deletion.

// Comfy-style: picking a card selects only that card; picking a group frame
// selects the frame plus its members so the whole group moves together.
export function itemIdsWithGroup(id) {
  if (!id) return [];
  const item = state.view.items.find(it => it.id === id);
  if (!item || item.type !== 'group') return [id];
  return [id, ...state.view.items
    .filter(it => it.id !== id && it.data && it.data.groupId === id).map(it => it.id)];
}

export function hasGroupedSelection() {
  return state.view.items.some(it => state.selectedIds.has(it.id) &&
    (it.type === 'group' || (it.data && it.data.groupId)));
}

export function updateMultiActions() {
  const count = state.selectedIds.size;
  if (!domAvailable()) return;
  dom.multiActions.hidden = count < 2;
  // per-card tools only for a single selection; several cards use the bottom bar
  document.body.classList.toggle('multi-selected', count > 1);
  dom.multiCount.textContent = `${count} selecionados`;
  document.getElementById('multiUngroup').hidden = !hasGroupedSelection();
  document.getElementById('multiEnhance').hidden = !state.view.items.some(it => it.type === 'image' && !it.data.enhancedFrom && state.selectedIds.has(it.id));
}

function domAvailable() { return !!document.getElementById('multiActions'); }

export function selectionIds() { return [...state.selectedIds]; }

export function selectMany(ids, { additive = false, primary = null, expandGroups = true } = {}) {
  const next = additive ? new Set(state.selectedIds) : new Set();
  for (const id of ids || []) {
    const expanded = expandGroups ? itemIdsWithGroup(id) : [id];
    expanded.forEach(value => value && next.add(value));
  }
  for (const id of state.selectedIds) if (!next.has(id)) elMap.get(id)?.classList.remove('selected');
  state.selectedIds = next;
  state.selectedId = primary && next.has(primary) ? primary : ([...next].at(-1) || null);
  for (const id of next) elMap.get(id)?.classList.add('selected');
  if (state.editingId && !next.has(state.editingId)) exitEdit();
  closePalette();
  closeCtx();
  updateSelectionChrome();
  updateMultiActions();
  requestMinimap();
}

export function select(id, { toggle = false } = {}) {
  if (!id) { selectMany([]); return; }
  const ids = itemIdsWithGroup(id);
  if (toggle) {
    const next = new Set(state.selectedIds);
    const remove = ids.every(value => next.has(value));
    ids.forEach(value => remove ? next.delete(value) : next.add(value));
    selectMany([...next], { primary: remove ? null : id, expandGroups: false });
    return;
  }
  if (state.selectedIds.has(id) && ids.every(value => state.selectedIds.has(value))) return;
  selectMany(ids, { primary: id, expandGroups: false });
}

// Collapse a multi-selection down to one card (and its members, for a group).
export function selectOnly(id) {
  selectMany(itemIdsWithGroup(id), { primary: id, expandGroups: false });
}

export function deselect() { selectMany([]); if (state.editingId) exitEdit(); }

export function enterEdit(el) {
  if (state.editingId && state.editingId !== el.dataset.id) exitEdit();
  state.editingId = el.dataset.id;
  el.classList.add('editing');
  el.querySelectorAll('[data-edit]').forEach(f => { f.readOnly = false; f.tabIndex = 0; });
  // fields hidden behind a formatted view had no height to grow into
  el.querySelectorAll('textarea[data-edit]').forEach(autoGrow);
}

// Other modules react when a card leaves edit mode (e.g. note translation).
const editEndListeners = [];
export function onEditEnd(fn) { editEndListeners.push(fn); }

export function exitEdit() {
  if (!state.editingId) return;
  const id = state.editingId;
  const el = elMap.get(id);
  if (el) { el.classList.remove('editing'); el.querySelectorAll('[data-edit]').forEach(f => { f.readOnly = true; f.tabIndex = -1; f.blur(); }); }
  state.editingId = null;
  const it = state.view.items.find(x => x.id === id);
  if (it) editEndListeners.forEach(fn => fn(it));
}

export function renameSelected() {
  if (!state.selectedId) return;
  const el = elMap.get(state.selectedId);
  if (!el || !el.querySelector('[data-edit]')) return;
  enterEdit(el);
  // focus synchronously so keystrokes right after the rename shortcut land in
  // the field instead of falling through to the document
  const f = el.querySelector('[data-edit]');
  if (f) { f.focus(); if (f.select) f.select(); }
}

const saveTimers = new Map();
const pendingData = new Map();
export function saveData(it, patch) {
  Object.assign(it.data, patch);
  if (it.type === 'board' && patch.title != null) it._childTitle = patch.title;
  if (it.type === 'board' && patch.icon != null) it._childIcon = patch.icon;
  clearTimeout(saveTimers.get(it.id));
  pendingData.set(it.id, Object.assign({}, pendingData.get(it.id), patch));
  saveTimers.set(it.id, setTimeout(() => {
    const data = pendingData.get(it.id);
    pendingData.delete(it.id);
    saveTimers.delete(it.id);
    // consecutive edits of one card within a few seconds undo together
    const done = startAction('edit:' + it.id);
    api.patch(it.id, { data });
    done();
    if (it.type === 'board' && data.title != null) renderCrumbs();
  }, 400));
}

// Send every debounced edit now, e.g. before the view is re-fetched.
export async function flushSaves() {
  const writes = [...pendingData].map(([id, data]) => {
    clearTimeout(saveTimers.get(id));
    saveTimers.delete(id);
    const done = startAction('edit:' + id);
    const write = api.patch(id, { data });
    done();
    return write;
  });
  pendingData.clear();
  await Promise.all(writes);
}

// The server frees the members of a deleted group frame; mirror that locally.
function releaseMembers(groupIds) {
  for (const item of state.view.items) {
    if (item.type !== 'group' && item.data && groupIds.has(item.data.groupId)) {
      item.data = Object.assign({}, item.data, { groupId: null });
    }
  }
}

// One undo step for the whole action, however many requests it takes.
export async function deleteItem(id) {
  const done = startAction();
  try { return await deleteItemNow(id); } finally { done(); }
}
async function deleteItemNow(id) {
  await api.remove(id);
  releaseMembers(new Set([id]));
  state.view.items = state.view.items.filter(x => x.parentItemId !== id && x.id !== id);
  state.selectedIds.delete(id);
  if (state.selectedId === id) state.selectedId = null;
  closeCtx();
  render();
  updateSelectionChrome();
  updateMultiActions();
}

// One undo step for the whole action, however many requests it takes.
export async function deleteSelected() {
  const done = startAction();
  try { return await deleteSelectedNow(); } finally { done(); }
}
async function deleteSelectedNow() {
  const ids = selectionIds();
  if (!ids.length) return;
  await Promise.all(ids.map(id => api.remove(id)));
  const removed = new Set(ids);
  state.view.items = state.view.items.filter(item => !removed.has(item.id) && !removed.has(item.parentItemId));
  releaseMembers(removed);
  state.selectedIds = new Set();
  state.selectedId = null;
  closeCtx();
  render();
  updateSelectionChrome();
  updateMultiActions();
  toast(ids.length === 1 ? '1 item excluído' : `${ids.length} itens excluídos`);
}

// One undo step for the whole action, however many requests it takes.
export async function groupSelected() {
  const done = startAction();
  try { return await groupSelectedNow(); } finally { done(); }
}
async function groupSelectedNow() {
  const items = state.view.items.filter(item => state.selectedIds.has(item.id) &&
    isCard(item) && !item.parentItemId);
  if (items.length < 2) return;
  closeCtx();
  // Frames whose members all move into the new group would be left empty.
  const formerIds = new Set(items.map(item => item.data && item.data.groupId).filter(Boolean));
  const stale = state.view.items.filter(group => group.type === 'group' && formerIds.has(group.id) &&
    state.view.items.every(item => item.type === 'group' || item.data?.groupId !== group.id || items.includes(item)));
  const padding = 20;
  const titleHeight = 30;
  const left = Math.min(...items.map(item => item.x));
  const top = Math.min(...items.map(item => item.y));
  const right = Math.max(...items.map(item => item.x + (item.w || 240)));
  const bottom = Math.max(...items.map(item => {
    const el = elMap.get(item.id);
    return item.y + (el ? el.offsetHeight : (item.h || 160));
  }));
  const group = await api.create({
    canvasId: state.view.canvas.id,
    type: 'group',
    x: left - padding,
    y: top - padding - titleHeight,
    w: Math.max(140, right - left + padding * 2),
    h: Math.max(80, bottom - top + padding * 2 + titleHeight),
    color: 'blue',
    data: { title: 'Grupo' }
  });
  group.z = 0;
  group.data = Object.assign({}, group.data, { groupId: group.id });
  await Promise.all([
    api.patch(group.id, { z: 0, data: { groupId: group.id } }),
    ...items.map(item => {
      item.data = Object.assign({}, item.data, { groupId: group.id });
      return api.patch(item.id, { data: { groupId: group.id } });
    }),
    ...stale.map(old => api.remove(old.id))
  ]);
  const staleIds = new Set(stale.map(old => old.id));
  state.view.items = state.view.items.filter(item => !staleIds.has(item.id));
  state.view.items.push(group);
  render();
  select(group.id);
  toast(`${items.length} itens agrupados`);
  updateMultiActions();
}

// Selected frames are dissolved (their cards stay). With no frame selected,
// the selected cards just leave their groups and the frames stay put.
// One undo step for the whole action, however many requests it takes.
export async function ungroupSelected() {
  const done = startAction();
  try { return await ungroupSelectedNow(); } finally { done(); }
}
async function ungroupSelectedNow() {
  closeCtx();
  const groups = state.view.items.filter(item => item.type === 'group' && state.selectedIds.has(item.id));
  if (groups.length) {
    const groupIds = new Set(groups.map(group => group.id));
    const items = state.view.items.filter(item => item.type !== 'group' && groupIds.has(item.data?.groupId));
    await Promise.all(groups.map(group => api.remove(group.id)));
    state.view.items = state.view.items.filter(item => !groupIds.has(item.id));
    releaseMembers(groupIds);
    render();
    selectMany(items.map(item => item.id), { primary: items.at(-1)?.id || null, expandGroups: false });
    toast(items.length === 1 ? '1 item desagrupado' : `${items.length} itens desagrupados`);
    return;
  }
  const items = state.view.items.filter(item => state.selectedIds.has(item.id) && item.data?.groupId);
  if (!items.length) return;
  items.forEach(item => { item.data = Object.assign({}, item.data, { groupId: null }); });
  await api.patchMany(items.map(item => ({ id: item.id, data: { groupId: null } })));
  updateMultiActions();
  toast(items.length === 1 ? '1 item saiu do grupo' : `${items.length} itens saíram dos grupos`);
}

export function initMultiSelection() {
  if (!domAvailable()) return;
  document.getElementById('multiGroup').onclick = groupSelected;
  document.getElementById('multiUngroup').onclick = ungroupSelected;
  document.getElementById('multiDelete').onclick = deleteSelected;
  updateMultiActions();
}
