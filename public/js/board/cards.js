'use strict';

import { state, dom, elMap } from '../core/state.js';
import { colorVar, lucideEl, refreshIcons, autoGrow, isLocked, isCard, rid, normalizeUrl } from '../core/util.js';
import { select, enterEdit, exitEdit, saveData, deleteItem } from './editing.js';
import { openPalette, openCtx } from '../ui/menus.js';
import { updateSelectionChrome } from '../ui/boardchrome.js';
import { onItemPointerDown, startResize } from './drag.js';
import { openCanvas } from '../main.js';
import { renderConnections, queueConnections, startNodeConnection, startLinkDrag } from './connections.js';
import { openLightbox } from '../ui/lightbox.js';
import { buildComfy } from '../features/comfynode.js';
import { enhanceImages, idsForImage } from '../features/enhance.js';
import { renderMarkdown, applyFormat } from '../core/markdown.js';
import { requestMinimap } from './minimap.js';
import { renderTags, matchesFilter } from './tags.js';

// Rendering of the canvas and every card type. This module owns the DOM for
// items; other modules ask it to (re)render when data changes.

export function childrenOf(id) {
  return state.view.items.filter(it => it.parentItemId === id).sort((a, b) => (a.y || 0) - (b.y || 0));
}

// Lines follow cards whose size changes after render (web fonts, photos
// loading, text growing while typing).
const resized = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => queueConnections()) : null;

export function render() {
  if (resized) resized.disconnect();
  dom.world.innerHTML = '';
  elMap.clear();
  const free = state.view.items.filter(it => !it.parentItemId && it.type !== 'line');
  for (const it of free) {
    const el = renderItem(it);
    dom.world.appendChild(el);
    elMap.set(it.id, el);
  }
  renderConnections();
  requestAnimationFrame(renderConnections);
  requestMinimap();
  dom.hint.style.display = state.view.items.length ? 'none' : 'block';
  refreshIcons(dom.world);
}

export function renderCrumbs() {
  dom.crumbs.innerHTML = '';
  state.view.breadcrumb.forEach((c, i) => {
    if (i > 0) { const s = document.createElement('span'); s.className = 'sep'; s.textContent = '/'; dom.crumbs.appendChild(s); }
    const b = document.createElement('button');
    b.className = 'crumb' + (i === state.view.breadcrumb.length - 1 ? ' current' : '');
    const chip = document.createElement('span'); chip.className = 'chip';
    chip.style.background = colorVar((state.view.canvas && c.id === state.view.canvas.id) ? state.view.canvas.color : 'slate');
    b.appendChild(chip);
    const t = document.createElement('span'); t.textContent = c.title; b.appendChild(t);
    if (i !== state.view.breadcrumb.length - 1) b.onclick = () => openCanvas(c.id);
    dom.crumbs.appendChild(b);
  });
}

export function makeField(tag, cls, value, placeholder) {
  const f = document.createElement(tag === 'area' ? 'textarea' : 'input');
  if (tag === 'area') f.rows = 1;
  f.className = cls; f.value = value || ''; f.placeholder = placeholder || '';
  f.setAttribute('data-edit', '');
  f.readOnly = true; f.tabIndex = -1;
  if (tag === 'area') { f.addEventListener('input', () => autoGrow(f)); }
  return f;
}

export function renderItem(it) {
  const el = document.createElement('div');
  el.className = 'item type-' + it.type;
  el.dataset.id = it.id;
  if (state.selectedIds.has(it.id) || it.id === state.selectedId) el.classList.add('selected');
  if (isLocked(it)) el.classList.add('locked');
  if (state.clipboard && state.clipboard.cut && state.clipboard.ids.includes(it.id)) el.classList.add('cut-pending');
  if (!matchesFilter(it)) el.classList.add('filtered-out');
  if (!it.parentItemId) {
    el.style.left = it.x + 'px'; el.style.top = it.y + 'px';
    el.style.width = (it.w || 240) + 'px';
    if (it.h != null) el.style.height = it.h + 'px';
    el.style.zIndex = it.type === 'group' ? 0 : (it.z || 1);
  } else {
    el.classList.add('in-column');
  }

  if (it.type === 'note') buildNote(el, it);
  else if (it.type === 'todo') buildTodo(el, it);
  else if (it.type === 'link') buildLink(el, it);
  else if (it.type === 'image') buildImage(el, it);
  else if (it.type === 'file') buildFile(el, it);
  else if (it.type === 'comment') buildComment(el, it);
  else if (it.type === 'board') buildBoard(el, it);
  else if (it.type === 'group') buildGroup(el, it);
  else if (it.type === 'node') buildNode(el, it);
  else if (it.type === 'comfy') buildComfy(el, it);
  else if (it.type === 'column') buildColumn(el, it);

  // Boards use the rail / mobile footer for color·icon·rename·delete.
  // Other cards keep the floating properties badge.
  if (it.type !== 'board') {
    const tools = document.createElement('div');
    tools.className = 'card-tools';
    const colorBtn = document.createElement('div');
    colorBtn.className = 'swatch';
    colorBtn.style.setProperty('--swatch', colorVar(it.color || 'slate'));
    colorBtn.title = 'Cor';
    colorBtn.setAttribute('data-nodrag', '');
    colorBtn.onclick = (e) => { e.stopPropagation(); openPalette(it, colorBtn, 'color'); };
    const delBtn = document.createElement('button');
    delBtn.setAttribute('data-nodrag', '');
    delBtn.appendChild(lucideEl('trash-2'));
    delBtn.title = it.type === 'group' ? 'Remover a moldura e manter os cards' : 'Excluir';
    delBtn.onclick = (e) => { e.stopPropagation(); deleteItem(it.id); };
    tools.appendChild(colorBtn); tools.appendChild(delBtn);
    if (isLocked(it)) {
      const lockBadge = document.createElement('span');
      lockBadge.className = 'lock-badge';
      lockBadge.appendChild(lucideEl('lock'));
      lockBadge.title = 'Posição travada';
      tools.appendChild(lockBadge);
    }
    el.appendChild(tools);
  } else if (isLocked(it)) {
    const lockBadge = document.createElement('span');
    lockBadge.className = 'lock-badge board-lock';
    lockBadge.appendChild(lucideEl('lock'));
    lockBadge.title = 'Posição travada';
    el.appendChild(lockBadge);
  }

  if (!it.parentItemId && !isLocked(it)) {
    const rz = document.createElement('div'); rz.className = 'resize'; rz.setAttribute('data-nodrag', '');
    rz.addEventListener('pointerdown', (e) => startResize(e, it, el));
    el.appendChild(rz);
  }

  renderTags(el, it);

  // drag this dot onto another card to connect the two with a line
  if (isCard(it) && it.type !== 'node') {
    const handle = document.createElement('div');
    handle.className = 'link-handle';
    handle.title = 'Arraste até outro card para ligar';
    handle.setAttribute('data-nodrag', '');
    handle.addEventListener('pointerdown', (e) => startLinkDrag(e, it));
    el.appendChild(handle);
  }

  if (resized && it.type !== 'group') resized.observe(el);
  el.addEventListener('pointerdown', (e) => onItemPointerDown(e, it, el));
  el.addEventListener('contextmenu', (e) => openCtx(e, it));
  return el;
}

function buildNote(el, it) {
  el.classList.add('note');
  if (it.color) { const a = document.createElement('div'); a.className = 'accent'; a.style.background = colorVar(it.color); el.appendChild(a); }
  const t = makeField('area', 'ntitle', it.data.title, 'Título');
  const b = makeField('area', 'nbody', it.data.body, 'Escreva uma nota…');
  // Outside edit mode the body shows as formatted Markdown; the raw text
  // comes back when the note is edited.
  const view = document.createElement('div');
  view.className = 'nbody-view md';
  const paint = () => {
    view.innerHTML = renderMarkdown(b.value);
    el.classList.toggle('has-md', !!b.value.trim());
  };
  paint();
  t.addEventListener('input', () => saveData(it, { title: t.value }));
  b.addEventListener('input', () => { saveData(it, { body: b.value }); paint(); });
  // the title is one line: Enter (or ↓ at its end) moves on to the body, and
  // ↑ at the start of the body comes back
  const focusAt = (field, at) => { field.focus(); field.setSelectionRange(at, at); autoGrow(field); };
  t.addEventListener('keydown', (e) => {
    const atEnd = t.selectionStart === t.value.length;
    if ((e.key === 'Enter' && !e.shiftKey) || (e.key === 'ArrowDown' && atEnd) || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault();
      focusAt(b, e.key === 'Enter' ? 0 : b.value.length);
    }
  });
  b.addEventListener('keydown', (e) => {
    if ((e.key === 'ArrowUp' && b.selectionStart === 0 && b.selectionEnd === 0) || (e.key === 'Tab' && e.shiftKey)) {
      e.preventDefault();
      focusAt(t, t.value.length);
    }
  });
  b.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); applyFormat(b, 'bold'); }
    if (mod && e.key.toLowerCase() === 'i') { e.preventDefault(); applyFormat(b, 'italic'); }
  });
  const bar = document.createElement('div');
  bar.className = 'fmt-bar';
  bar.setAttribute('data-nodrag', '');
  for (const [kind, label, title] of [['bold', 'N', 'Negrito (Ctrl+B)'], ['italic', 'I', 'Itálico (Ctrl+I)'], ['strike', 'S', 'Tachado'],
    ['heading', 'T', 'Título'], ['list', '•', 'Lista'], ['check', '☐', 'Lista de tarefas'], ['link', '🔗', 'Link']]) {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.textContent = label; btn.title = title; btn.className = 'fmt-' + kind;
    btn.setAttribute('aria-label', title);
    btn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); applyFormat(b, kind); autoGrow(b); });
    bar.appendChild(btn);
  }
  // language badge on notes that have a translated twin
  if (it.data.lang && (it.data.translation || it.data.translationOf)) {
    const badge = document.createElement('span');
    badge.className = 'lang-badge';
    badge.textContent = it.data.lang.toUpperCase();
    badge.title = it.data.lang === 'en' ? 'Inglês' : 'Português';
    el.appendChild(badge);
  }
  el.append(t, b, view, bar);
  requestAnimationFrame(() => { autoGrow(t); autoGrow(b); });
}

function buildComment(el, it) {
  el.classList.add('comment');
  const mark = document.createElement('div');
  mark.className = 'cmark';
  mark.appendChild(lucideEl('message-circle'));
  el.appendChild(mark);
  const b = makeField('area', 'cbody', it.data.body, 'Escreva um comentário…');
  b.addEventListener('input', () => saveData(it, { body: b.value }));
  el.appendChild(b);
  requestAnimationFrame(() => autoGrow(b));
}

function buildTodo(el, it) {
  el.classList.add('todo');
  const title = makeField('input', 'ttitle', it.data.title, 'Tarefas');
  title.addEventListener('input', () => saveData(it, { title: title.value }));
  el.appendChild(title);
  const list = document.createElement('div'); list.className = 'tasks';
  el.appendChild(list);
  const tasks = it.data.tasks || [];
  const renderTasks = () => {
    list.innerHTML = '';
    tasks.forEach((task) => {
      const row = document.createElement('div'); row.className = 'task' + (task.done ? ' done' : '');
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!task.done; cb.setAttribute('data-nodrag', '');
      cb.onclick = (e) => { e.stopPropagation(); task.done = cb.checked; row.classList.toggle('done', task.done); saveData(it, { tasks }); };
      const tx = makeField('area', 'txt', task.text, 'Item da lista');
      tx.addEventListener('input', () => { task.text = tx.value; saveData(it, { tasks }); });
      tx.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); const ni = { id: rid(), text: '', done: false }; tasks.splice(tasks.indexOf(task) + 1, 0, ni); saveData(it, { tasks }); renderTasks(); enterEdit(el); list.querySelectorAll('.txt')[tasks.indexOf(ni)].focus(); }
        if (e.key === 'Backspace' && tx.value === '' && tasks.length > 1) { e.preventDefault(); tasks.splice(tasks.indexOf(task), 1); saveData(it, { tasks }); renderTasks(); }
      });
      const del = document.createElement('button'); del.className = 'del'; del.textContent = '×'; del.setAttribute('data-nodrag', '');
      del.onclick = (e) => { e.stopPropagation(); tasks.splice(tasks.indexOf(task), 1); saveData(it, { tasks }); renderTasks(); };
      row.appendChild(cb); row.appendChild(tx); row.appendChild(del);
      list.appendChild(row);
      requestAnimationFrame(() => autoGrow(tx));
    });
  };
  renderTasks();
  const add = document.createElement('button'); add.className = 'add'; add.setAttribute('data-nodrag', '');
  add.textContent = '+ Adicionar item';
  add.onclick = (e) => { e.stopPropagation(); tasks.push({ id: rid(), text: '', done: false }); saveData(it, { tasks }); renderTasks(); enterEdit(el); const f = list.querySelectorAll('.txt'); f[f.length - 1].focus(); };
  el.appendChild(add);
}

function buildLink(el, it) {
  el.classList.add('link');
  const bar = document.createElement('div'); bar.className = 'lbar'; bar.style.background = colorVar(it.color || 'blue'); el.appendChild(bar);
  const body = document.createElement('div'); body.className = 'lbody';
  const title = makeField('input', 'ltitle', it.data.title, 'Título do link');
  const url = makeField('input', 'lurl', it.data.url, 'https://…');
  title.addEventListener('input', () => saveData(it, { title: title.value }));
  url.addEventListener('input', () => { saveData(it, { url: url.value }); open.href = normalizeUrl(url.value); });
  const open = document.createElement('a'); open.className = 'open'; open.target = '_blank'; open.rel = 'noopener'; open.textContent = 'Abrir ↗';
  open.href = normalizeUrl(it.data.url || '#'); open.setAttribute('data-nodrag', '');
  body.appendChild(title); body.appendChild(url); body.appendChild(open); el.appendChild(body);
}

function buildImage(el, it) {
  el.classList.add('image');
  const img = document.createElement('img');
  img.src = '/api/thumb/' + encodeURIComponent(it.id); img.alt = it.data.name || '';
  // Old/external image cards cannot be thumbnailed by the local server.
  img.addEventListener('error', () => {
    if (img.dataset.fallback) return;
    img.dataset.fallback = '1';
    img.src = it.data.src;
  });
  img.loading = 'lazy'; img.decoding = 'async'; img.fetchPriority = 'low';
  if (it.data.naturalW && it.data.naturalH) el.style.aspectRatio = it.data.naturalW + ' / ' + it.data.naturalH;
  el.appendChild(img);
  el.addEventListener('dblclick', () => openLightbox(it.id));
  if (it.data.enhancedFrom) {
    // result of an enhancement: just a badge
    const badge = document.createElement('span');
    badge.className = 'enhance-badge';
    badge.textContent = 'Aprimorada';
    el.appendChild(badge);
  } else {
    // enhance icon: always visible on generated images, on hover for the rest;
    // clicking acts on the whole selection when this image is part of it
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'enhance-btn' + (it.data.comfyJob ? ' always' : '') + (it.data.enhanced ? ' done' : '');
    btn.setAttribute('data-nodrag', '');
    btn.setAttribute('aria-label', it.data.enhanced ? 'Imagem aprimorada' : 'Aprimorar imagem');
    btn.title = (it.data.enhanced ? 'Já aprimorada. ' : '') + 'Aprimorar (upscale) — ajustes e lote. Shift: direto, com os últimos ajustes';
    btn.appendChild(lucideEl(it.data.enhanced ? 'check' : 'wand-sparkles'));
    btn.onclick = (e) => { e.stopPropagation(); enhanceImages(idsForImage(it), { quick: e.shiftKey }); };
    el.appendChild(btn);
  }
}

function buildFile(el, it) {
  el.classList.add('file');
  const icon = document.createElement('div'); icon.className = 'ficon';
  icon.appendChild(lucideEl('file-text'));
  const name = document.createElement('div'); name.className = 'fname';
  name.textContent = it.data.name || 'Arquivo';
  name.title = it.data.name || '';
  const open = document.createElement('a'); open.className = 'fopen'; open.setAttribute('data-nodrag', '');
  open.href = it.data.src || '#'; open.target = '_blank'; open.rel = 'noopener'; open.download = it.data.name || '';
  open.textContent = 'Abrir ↗';
  el.appendChild(icon); el.appendChild(name); el.appendChild(open);
}

function buildBoard(el, it) {
  el.classList.add('board');
  if (it.h != null) el.classList.add('sized');
  const tile = document.createElement('div'); tile.className = 'tile';
  tile.style.background = colorVar(it.color || it._childColor || 'slate');
  if (it._childPreview) {
    tile.classList.add('preview');
    const img = document.createElement('img');
    img.src = it._childPreview;
    img.draggable = false;   // dragging the cover must move the card, not export the photo
    img.alt = '';
    img.loading = 'lazy'; img.decoding = 'async'; img.fetchPriority = 'low';
    tile.appendChild(img);
  } else {
    tile.appendChild(lucideEl(it._childIcon || 'layout-grid'));
  }
  el.appendChild(tile);
  const title = makeField('input', 'btitle', it._childTitle || 'Board sem nome', 'Nome do board');
  title.setAttribute('data-nodrag', '');
  title.addEventListener('input', () => saveData(it, { title: title.value }));
  title.addEventListener('click', (e) => {
    e.stopPropagation();
    // A touch double-tap opens the board on pointerup; don't fall through into rename.
    if (el.dataset.suppressTitleClick) { delete el.dataset.suppressTitleClick; return; }
    if (!state.selectedIds.has(it.id)) { select(it.id); return; }
    enterEdit(el); title.focus(); title.select();
  });
  el.appendChild(title);
  const meta = document.createElement('div'); meta.className = 'bmeta';
  const n = it._childCount || 0; meta.textContent = n + (n === 1 ? ' card' : ' cards');
  el.appendChild(meta);
  bindBoardOpen(el, it);
}

function buildGroup(el, it) {
  el.classList.add('group');
  el.style.setProperty('--group-color', colorVar(it.color || 'blue'));
  const title = makeField('input', 'group-title', it.data.title || 'Grupo', 'Nome do grupo');
  title.addEventListener('input', () => saveData(it, { title: title.value }));
  title.addEventListener('click', (e) => e.stopPropagation());
  title.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    enterEdit(el); title.focus(); title.select();
  });
  el.appendChild(title);
}

function buildNode(el, it) {
  el.classList.add('node');
  const head = document.createElement('div'); head.className = 'node-head';
  head.style.background = colorVar(it.color || 'purple');
  const title = makeField('input', 'node-title', it.data.title || 'Node', 'Nome do node');
  title.addEventListener('input', () => saveData(it, { title: title.value }));
  head.appendChild(title); el.appendChild(head);

  const body = document.createElement('div'); body.className = 'node-body';
  const inputs = Array.isArray(it.data.inputs) && it.data.inputs.length ? it.data.inputs : ['input'];
  const outputs = Array.isArray(it.data.outputs) && it.data.outputs.length ? it.data.outputs : ['output'];
  const rows = Math.max(inputs.length, outputs.length);
  for (let i = 0; i < rows; i++) {
    const row = document.createElement('div'); row.className = 'node-row';
    const input = document.createElement('div'); input.className = 'node-slot node-input';
    if (inputs[i]) {
      const port = document.createElement('span');
      port.className = 'node-port input'; port.dataset.nodeId = it.id; port.dataset.slot = String(i);
      port.setAttribute('data-nodrag', ''); input.appendChild(port);
      const label = document.createElement('span'); label.textContent = inputs[i]; input.appendChild(label);
    }
    const output = document.createElement('div'); output.className = 'node-slot node-output';
    if (outputs[i]) {
      const label = document.createElement('span'); label.textContent = outputs[i]; output.appendChild(label);
      const port = document.createElement('span');
      port.className = 'node-port output'; port.dataset.nodeId = it.id; port.dataset.slot = String(i);
      port.setAttribute('data-nodrag', '');
      port.addEventListener('pointerdown', e => startNodeConnection(e, it, port));
      output.appendChild(port);
    }
    row.appendChild(input); row.appendChild(output); body.appendChild(row);
  }
  el.appendChild(body);
}

// Desktop mouse gets a real dblclick; mobile Safari/WebKit does not synthesize
// one from a double-tap, so we also detect a second quick, unmoved pointerup.
function bindBoardOpen(el, it) {
  let lastTap = -Infinity, lastX = 0, lastY = 0;
  const open = () => {
    exitEdit();
    openCanvas(it.data.childCanvasId);
  };
  el.addEventListener('dblclick', (e) => {
    if (el.classList.contains('editing') && e.target.closest('[data-edit]')) return;
    open();
  });
  el.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'mouse') return;          // mouse keeps using dblclick
    if (state.drag && state.drag.moved) return;      // was a drag, not a tap
    if (state.drag && state.drag.it && state.drag.it.id !== it.id) return;
    const now = performance.now();
    if (now - lastTap < 350 && Math.hypot(e.clientX - lastX, e.clientY - lastY) < 28) {
      lastTap = -Infinity;
      el.dataset.suppressTitleClick = '1';
      open();
      return;
    }
    lastTap = now; lastX = e.clientX; lastY = e.clientY;
  });
}

function buildColumn(el, it) {
  el.classList.add('column');
  const head = document.createElement('div'); head.className = 'col-head';
  const chip = document.createElement('div'); chip.className = 'col-chip'; chip.style.background = colorVar(it.color || 'slate');
  const title = makeField('input', 'col-title', it.data.title, 'Coluna');
  title.addEventListener('input', () => saveData(it, { title: title.value }));
  // vertical stack (default), side by side, or a grid that fills the width
  const layout = COLUMN_LAYOUTS[it.data.layout] ? it.data.layout : 'stack';
  el.classList.add('layout-' + layout);
  el.style.setProperty('--col-card-w', Math.max(120, (it.w || 240) - 26) + 'px');
  const toggle = document.createElement('button');
  toggle.type = 'button'; toggle.className = 'col-layout'; toggle.setAttribute('data-nodrag', '');
  const next = COLUMN_LAYOUTS[layout].next;
  toggle.title = 'Layout: ' + COLUMN_LAYOUTS[layout].label + ' — clique para ' + COLUMN_LAYOUTS[next].label.toLowerCase();
  toggle.setAttribute('aria-label', toggle.title);
  toggle.appendChild(lucideEl(COLUMN_LAYOUTS[layout].icon));
  toggle.onclick = (e) => { e.stopPropagation(); setColumnLayout(it, next); };
  head.appendChild(chip); head.appendChild(title); head.appendChild(toggle); el.appendChild(head);
  const body = document.createElement('div'); body.className = 'col-body'; body.dataset.colbody = it.id; el.appendChild(body);
  const kids = childrenOf(it.id);
  if (!kids.length) { const e = document.createElement('div'); e.className = 'col-empty'; e.textContent = 'Arraste cards para cá'; body.appendChild(e); }
  for (const k of kids) { const ke = renderItem(k); body.appendChild(ke); elMap.set(k.id, ke); }
}

export const COLUMN_LAYOUTS = {
  stack: { label: 'Vertical', icon: 'rows-3', next: 'row' },
  row: { label: 'Lado a lado', icon: 'columns-3', next: 'grid' },
  grid: { label: 'Grade', icon: 'layout-grid', next: 'stack' }
};

export function setColumnLayout(it, layout) {
  saveData(it, { layout });
  refreshItem(it);
  renderConnections();
}

export function refreshItem(it) {
  if (it.type === 'line') { renderConnections(); return; }
  const old = elMap.get(it.id);
  if (!old) return;
  const fresh = renderItem(it);
  old.replaceWith(fresh);
  elMap.set(it.id, fresh);
  refreshIcons(fresh);
  if (it.type === 'column') {
    for (const k of childrenOf(it.id)) {
      const ke = fresh.querySelector(`[data-id="${k.id}"]`);
      if (ke) elMap.set(k.id, ke);
    }
  }
  if (it.type === 'board' && it.id === state.selectedId) updateSelectionChrome();
  renderConnections();
}
