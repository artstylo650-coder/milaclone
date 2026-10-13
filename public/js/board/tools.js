'use strict';

import { state, dom, elMap } from '../core/state.js';
import { api, startAction } from '../core/api.js';
import { toast, imageSize } from '../core/util.js';
import { screenToWorld, applyCam, viewportCenterWorld } from './viewport.js';
import { createAt, defaultsFor } from './create.js';
import { select, deselect, selectMany } from './editing.js';
import { render } from './cards.js';
import { groupAtRect } from './groups.js';
import { isClipboardMarker, pasteClipboard, cancelPasteFallback } from './clipboard.js';
import { openCanvasCtx } from '../ui/menus.js';

// Toolbar arming, canvas panning + placing new cards, and file/image uploads.

const CELL_W = 288;
const MAX_COLUMNS = 4;

async function mapLimit(values, limit, task) {
  const results = new Array(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next++;
      results[index] = await task(values[index], index);
    }
  }
  const workers = Array.from({ length: Math.min(limit, values.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function dimensionsFor(file) {
  if (!file.type.startsWith('image/')) return null;
  const objectUrl = URL.createObjectURL(file);
  try { return await imageSize(objectUrl); }
  finally { URL.revokeObjectURL(objectUrl); }
}

async function createUploadedCard(file, position, dimensions, canvasId) {
  const uploaded = await api.upload(file);
  if (uploaded.error) throw new Error(uploaded.error);

  if (file.type.startsWith('image/')) {
    return api.create({
      canvasId, type: 'image',
      x: position.x, y: position.y, w: 260,
      data: {
        src: uploaded.src, name: uploaded.name,
        naturalW: dimensions && dimensions.w, naturalH: dimensions && dimensions.h,
        groupId: position.groupId
      }
    });
  }

  return api.create({
    canvasId, type: 'file',
    x: position.x, y: position.y, w: 220,
    data: { src: uploaded.src, name: uploaded.name, mime: uploaded.mime || file.type, groupId: position.groupId }
  });
}

// One undo step for the whole import, however many files it takes.
export async function importFiles(fileList, origin = viewportCenterWorld()) {
  const done = startAction();
  try { return await importFilesNow(fileList, origin); } finally { done(); }
}
async function importFilesNow(fileList, origin) {
  const files = Array.from(fileList || []).filter(file => file && file.size >= 0);
  if (!files.length || !state.view.canvas) return [];

  const canvasId = origin.canvasId || state.view.canvas.id;
  // Capture destination before async preparation/upload; navigation must not
  // associate old-canvas cards with groups on the newly opened canvas.
  const destination = canvasId === state.view.canvas.id
    ? (origin.groupId ? state.view.items.find(it => it.id === origin.groupId && it.type === 'group') : groupAtRect(origin.x, origin.y))
    : null;
  const group = destination ? { ...destination } : null;
  const appendY = group ? Math.max(group.y + 50, ...state.view.items
    .filter(it => it.id !== group.id && it.data?.groupId === group.id)
    .map(it => it.y + (elMap.get(it.id)?.offsetHeight || it.h || 160) + 24)) : origin.y - 90;
  toast(`Preparando ${files.length} ${files.length === 1 ? 'item' : 'itens'}…`);
  const dimensions = await mapLimit(files, 4, async file => {
    try { return await dimensionsFor(file); }
    catch (_) { return file.type.startsWith('image/') ? { w: 1, h: 1 } : null; }
  });

  const cols = Math.min(MAX_COLUMNS, Math.ceil(Math.sqrt(files.length)));
  const startX = group ? group.x + 20 : origin.x - cols * CELL_W / 2;
  const columnHeights = Array(cols).fill(appendY);
  const positions = files.map((file, i) => {
    const width = file.type.startsWith('image/') ? 260 : 220;
    const height = dimensions[i] ? 260 * dimensions[i].h / dimensions[i].w : 86;
    const col = i % cols;
    const position = {
      x: Math.round(startX + col * CELL_W + (CELL_W - width) / 2),
      y: Math.round(columnHeights[col]),
      groupId: group ? group.id : null,
      width, height
    };
    columnHeights[col] += height + 24;
    return position;
  });

  let completed = 0;
  let failed = 0;
  const results = await mapLimit(files, 3, async (file, i) => {
    try {
      const item = await createUploadedCard(file, positions[i], dimensions[i], canvasId);
      if (!item || item.error) { failed++; return null; }
      return item;
    } catch (_) {
      failed++;
      return null;
    } finally {
      completed++;
      toast(`Enviando ${completed} de ${files.length}…`);
    }
  });
  const created = results.filter(Boolean);

  if (group && created.length) {
    const used = positions.filter((_, i) => results[i]);
    const size = {
      w: Math.ceil(Math.max(group.w, ...used.map(p => p.x + p.width + 20 - group.x))),
      h: Math.ceil(Math.max(group.h, ...used.map(p => p.y + p.height + 20 - group.y)))
    };
    await api.patch(group.id, size);
    if (state.view.canvas?.id === canvasId) {
      const current = state.view.items.find(it => it.id === group.id);
      if (current) Object.assign(current, size);
    }
  }

  if (state.view.canvas && state.view.canvas.id === canvasId) {
    state.view.items.push(...created);
    render();
    if (created.length) select(created[created.length - 1].id);
  }
  const label = created.length === 1 ? 'item adicionado' : 'itens adicionados';
  toast(`${created.length} ${label}${failed ? `, ${failed} com erro` : ''}`);
  return created;
}

export function chooseFiles(tool) {
  disarm();
  const center = viewportCenterWorld();
  center.canvasId = state.view.canvas?.id;
  const selectedGroups = state.view.items.filter(it => it.type === 'group' && state.selectedIds.has(it.id));
  if (selectedGroups.length === 1) center.groupId = selectedGroups[0].id;
  if (tool === 'image') {
    state.pendingImageWorld = center;
    dom.fileInput.click();
  } else {
    state.pendingUploadWorld = center;
    dom.uploadInput.click();
  }
}

export function arm(tool, btn) {
  disarm();
  state.armed = tool; dom.stage.classList.add('armed');
  btn.classList.add('armed');
  toast('Clique no canvas para colocar o card');
}

export function disarm() {
  state.armed = null; dom.stage.classList.remove('armed');
  document.querySelectorAll('.tool.armed, .mtool.armed').forEach(b => b.classList.remove('armed'));
}

function startPan(e) {
  e.preventDefault();
  state.pan = { sx: e.clientX, sy: e.clientY, cx: state.cam.x, cy: state.cam.y };
  dom.stage.classList.add('panning');
  const move = (ev) => {
    if (state.pinching || !state.pan) return;
    state.cam.x = state.pan.cx + (ev.clientX - state.pan.sx);
    state.cam.y = state.pan.cy + (ev.clientY - state.pan.sy);
    applyCam();
  };
  const up = () => {
    state.pan = null;
    dom.stage.classList.remove('panning');
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

function startMarquee(e) {
  e.preventDefault();   // no native text selection while sweeping
  const sel = window.getSelection && window.getSelection();
  if (sel && sel.type === 'Range') sel.removeAllRanges();
  // preventDefault also stops the focus change: leave any field on the board
  if (document.activeElement && dom.world.contains(document.activeElement)) document.activeElement.blur();
  const stageRect = dom.stage.getBoundingClientRect();
  const startX = e.clientX;
  const startY = e.clientY;
  let moved = false;
  const move = (ev) => {
    const left = Math.min(startX, ev.clientX);
    const top = Math.min(startY, ev.clientY);
    const width = Math.abs(ev.clientX - startX);
    const height = Math.abs(ev.clientY - startY);
    if (!moved && Math.hypot(width, height) < 4) return;
    moved = true;
    dom.selectionBox.hidden = false;
    dom.selectionBox.style.left = (left - stageRect.left) + 'px';
    dom.selectionBox.style.top = (top - stageRect.top) + 'px';
    dom.selectionBox.style.width = width + 'px';
    dom.selectionBox.style.height = height + 'px';
  };
  const up = (ev) => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    dom.selectionBox.hidden = true;
    if (!moved) {
      if (!e.shiftKey) deselect();
      return;
    }
    const selection = {
      left: Math.min(startX, ev.clientX), right: Math.max(startX, ev.clientX),
      top: Math.min(startY, ev.clientY), bottom: Math.max(startY, ev.clientY)
    };
    const ids = [...dom.world.children]
      .filter(el => el.classList && el.classList.contains('item'))
      .filter(el => {
        const r = el.getBoundingClientRect();
        // Cards are picked by touching the box; a group frame only when the
        // box encloses it, so sweeping across a frame doesn't grab the group.
        if (el.classList.contains('type-group')) {
          return r.left >= selection.left && r.right <= selection.right &&
            r.top >= selection.top && r.bottom <= selection.bottom;
        }
        return r.right >= selection.left && r.left <= selection.right &&
          r.bottom >= selection.top && r.top <= selection.bottom;
      })
      .map(el => el.dataset.id);
    selectMany(ids, { additive: e.shiftKey, primary: ids.at(-1) || null });
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

// Wire up the rail buttons, canvas pan/place, and the upload inputs. Called once at boot.
export function initTools() {
  document.querySelectorAll('#railCreate .tool').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.tool;
      if (t === 'image' || t === 'upload') { chooseFiles(t); return; }
      if (state.armed === t) { disarm(); return; }
      arm(t, btn);
    });
  });

  dom.stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    if (state.pinching) return;
    if (state.armed && e.button === 0 && !state.spacePanning) {
      const w = screenToWorld(e.clientX, e.clientY);
      const t = state.armed; disarm();
      if (t === 'image') { state.pendingImageWorld = w; dom.fileInput.click(); }
      else if (t === 'upload') { state.pendingUploadWorld = w; dom.uploadInput.click(); }
      else createAt(t, w.x - defaultsFor(t).w / 2, w.y - 20);
      return;
    }
    const wantsPan = e.button === 1 || e.pointerType === 'touch' || state.spacePanning;
    if (wantsPan) startPan(e);
    else startMarquee(e);
  });

  // Cards stop their own contextmenu event, so this only sees empty canvas.
  dom.stage.addEventListener('contextmenu', openCanvasCtx);

  dom.fileInput.addEventListener('change', async () => {
    const files = Array.from(dom.fileInput.files); dom.fileInput.value = '';
    await importFiles(files, state.pendingImageWorld || viewportCenterWorld());
    state.pendingImageWorld = null;
  });

  dom.uploadInput.addEventListener('change', async () => {
    const files = Array.from(dom.uploadInput.files); dom.uploadInput.value = '';
    await importFiles(files, state.pendingUploadWorld || viewportCenterWorld());
    state.pendingUploadWorld = null;
  });

  dom.stage.addEventListener('dragover', (e) => {
    if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    dom.stage.classList.add('file-drop');
  });
  dom.stage.addEventListener('dragleave', (e) => {
    if (!dom.stage.contains(e.relatedTarget)) dom.stage.classList.remove('file-drop');
  });
  dom.stage.addEventListener('drop', async (e) => {
    const files = Array.from(e.dataTransfer?.files || []);
    if (!files.length) return;
    e.preventDefault();
    dom.stage.classList.remove('file-drop');
    await importFiles(files, screenToWorld(e.clientX, e.clientY));
  });

  document.addEventListener('paste', async (e) => {
    const active = document.activeElement;
    const typing = active && (active.isContentEditable || (/^(INPUT|TEXTAREA)$/.test(active.tagName) && !active.readOnly));
    if (typing || !state.view.canvas) return;
    cancelPasteFallback();

    const files = Array.from(e.clipboardData?.files || []);
    if (files.length) {
      e.preventDefault();
      await importFiles(files, viewportCenterWorld());
      return;
    }

    // Whatever was copied last wins: our own marker means board cards, any
    // other text came from outside and becomes a note or link.
    const text = (e.clipboardData?.getData('text/plain') || '').trim();
    if (isClipboardMarker(text) || (!text && state.clipboard)) {
      e.preventDefault();
      await pasteClipboard();
      return;
    }
    if (!text) return;
    e.preventDefault();
    const origin = viewportCenterWorld();
    const isUrl = /^(https?:\/\/|www\.)\S+$/i.test(text);
    const item = await api.create({
      canvasId: state.view.canvas.id,
      type: isUrl ? 'link' : 'note',
      x: Math.round(origin.x - 120), y: Math.round(origin.y - 50), w: 240,
      color: isUrl ? 'blue' : null,
      data: isUrl ? { url: text, title: text } : { title: '', body: text }
    });
    if (!item.error) {
      state.view.items.push(item);
      render();
      select(item.id);
      toast(isUrl ? 'Link adicionado' : 'Nota adicionada');
    }
  });
}
