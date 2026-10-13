'use strict';

import { state, dom, COLORS, BOARD_ICONS } from '../core/state.js';
import { api } from '../core/api.js';
import { colorVar, lucideEl, refreshIcons, isLocked, isCard } from '../core/util.js';
import { refreshItem, COLUMN_LAYOUTS, setColumnLayout } from '../board/cards.js';
import {
  select, renameSelected, deleteSelected, groupSelected, ungroupSelected, selectMany, hasGroupedSelection
} from '../board/editing.js';
import { copyToSystem, pasteClipboard, duplicateSelected, toggleLock } from '../board/clipboard.js';
import { createAt, defaultsFor } from '../board/create.js';
import { screenToWorld, fitToItems } from '../board/viewport.js';
import { undo, redo } from '../board/history.js';
import { openLightbox } from './lightbox.js';
import { editTags } from '../board/tags.js';
import { translateNote } from '../features/translate.js';
import { enhanceImages, openEnhanceDialog } from '../features/enhance.js';

// The floating color/icon palette and the right-click context menu.

// mode: 'color' | 'icon' | 'auto' (auto = colors, plus icons for boards — legacy badge path)
export function openPalette(it, anchor, mode = 'auto') {
  while (dom.palette.firstChild) dom.palette.removeChild(dom.palette.firstChild);
  const showColor = mode === 'color' || mode === 'auto';
  const showIcon = mode === 'icon' || (mode === 'auto' && it.type === 'board');
  dom.palette.className = 'open' + (showIcon ? ' board-palette' : '') + (mode === 'icon' ? ' icon-only' : '');

  if (showColor) {
    COLORS.forEach(c => {
      const sw = document.createElement('div'); sw.className = 'sw' + ((it.color || it._childColor) === c ? ' sel' : '');
      sw.style.background = colorVar(c);
      sw.onclick = () => { it.color = c; if (it.type === 'board') it._childColor = c; api.patch(it.id, { color: c }); refreshItem(it); closePalette(); };
      dom.palette.appendChild(sw);
    });
  }

  if (showIcon) {
    if (showColor) {
      const sep = document.createElement('div'); sep.className = 'pal-sep'; dom.palette.appendChild(sep);
    }
    const grid = document.createElement('div'); grid.className = 'icon-grid';
    const current = it._childIcon || 'layout-grid';
    BOARD_ICONS.forEach(name => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'icon-pick' + (name === current ? ' sel' : '');
      btn.title = name;
      btn.appendChild(lucideEl(name));
      btn.onclick = () => {
        it._childIcon = name;
        api.patch(it.id, { data: { icon: name } });
        refreshItem(it);
        closePalette();
      };
      grid.appendChild(btn);
    });
    dom.palette.appendChild(grid);
  }

  const r = anchor.getBoundingClientRect();
  const w = showIcon ? 290 : 230;
  let left = Math.min(r.left, window.innerWidth - w - 8);
  let top = r.bottom + 8;
  if (top + 220 > window.innerHeight) top = Math.max(8, r.top - 228);
  dom.palette.style.left = Math.max(8, left) + 'px';
  dom.palette.style.top = top + 'px';
  refreshIcons(dom.palette);
}

export function closePalette() {
  dom.palette.classList.remove('open', 'board-palette', 'icon-only');
  while (dom.palette.firstChild) dom.palette.removeChild(dom.palette.firstChild);
}

const modKey = () => /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

export function showMenu(rows, clientX, clientY) {
  dom.ctxmenu.innerHTML = '';
  rows.forEach(r => {
    if (r.sep) { const s = document.createElement('div'); s.className = 'ctx-sep'; dom.ctxmenu.appendChild(s); return; }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ctx-item' + (r.danger ? ' danger' : '');
    if (r.disabled) b.disabled = true;
    const lab = document.createElement('span'); lab.textContent = (r.checked ? '✓ ' : '') + r.label; b.appendChild(lab);
    if (r.hint) { const k = document.createElement('kbd'); k.textContent = r.hint; b.appendChild(k); }
    b.onclick = () => { closeCtx(); r.fn(); };
    dom.ctxmenu.appendChild(b);
  });
  dom.ctxmenu.classList.add('open');
  const mw = 220, mh = dom.ctxmenu.offsetHeight || 280;
  let left = clientX, top = clientY;
  if (left + mw > window.innerWidth) left = window.innerWidth - mw - 8;
  if (top + mh > window.innerHeight) top = window.innerHeight - mh - 8;
  dom.ctxmenu.style.left = Math.max(8, left) + 'px';
  dom.ctxmenu.style.top = Math.max(8, top) + 'px';
}

export function openCtx(e, it) {
  e.preventDefault();
  e.stopPropagation();
  // Right-clicking inside the current selection acts on all of it.
  if (!state.selectedIds.has(it.id)) select(it.id);
  else closePalette();
  const count = state.selectedIds.size;
  const many = count > 1;
  const locked = isLocked(it);
  const mod = modKey();
  const cards = state.view.items.filter(item => state.selectedIds.has(item.id) && isCard(item) && !item.parentItemId);
  const rows = [
    { label: 'Recortar', hint: mod + 'X', fn: () => copyToSystem(true) },
    { label: 'Copiar', hint: mod + 'C', fn: () => copyToSystem(false) },
    { label: 'Colar', hint: mod + 'V', fn: () => pasteClipboard(), disabled: !state.clipboard },
    { label: 'Duplicar', hint: mod + 'D', fn: () => duplicateSelected() },
    { sep: true }
  ];
  if (cards.length > 1) rows.push({ label: 'Agrupar', hint: mod + 'G', fn: () => groupSelected() });
  const imageIds = state.view.items.filter(item => item.type === 'image' && !item.data.enhancedFrom && state.selectedIds.has(item.id)).map(item => item.id);
  if (imageIds.length) {
    rows.push({ label: imageIds.length > 1 ? `Aprimorar ${imageIds.length} imagens…` : 'Aprimorar…', fn: () => openEnhanceDialog(imageIds) });
    rows.push({ label: 'Aprimorar com os últimos ajustes', fn: () => enhanceImages(imageIds, { quick: true }) });
  }
  if (hasGroupedSelection()) rows.push({ label: it.type === 'group' ? 'Desagrupar' : 'Tirar do grupo', hint: mod + '⇧G', fn: () => ungroupSelected() });
  if (!many && it.type === 'note') rows.unshift({ label: it.data.translation || it.data.translationOf ? 'Atualizar tradução' : 'Traduzir (PT ⇄ EN)', fn: () => translateNote(it) }, { sep: true });
  if (!many && it.type === 'image') rows.unshift({ label: 'Ver em tamanho real', hint: 'Duplo clique', fn: () => openLightbox(it.id) }, { sep: true });
  if (cards.length || isCard(it)) rows.push({ label: many ? 'Adicionar tags…' : 'Tags…', fn: () => editTags([...state.selectedIds]) });
  if (!many && it.type === 'column') {
    for (const [key, l] of Object.entries(COLUMN_LAYOUTS)) rows.push({ label: 'Layout: ' + l.label, checked: (it.data.layout || 'stack') === key, fn: () => setColumnLayout(it, key) });
  }
  if (!many) rows.push({ label: 'Renomear', hint: 'Enter', fn: () => renameSelected() });
  if (it.type !== 'group') rows.push({ label: locked ? 'Destravar posição' : 'Travar posição', fn: () => toggleLock() });
  rows.push({ sep: true });
  rows.push({ label: many ? `Mover ${count} itens para a lixeira` : 'Mover para a lixeira', hint: 'Delete', danger: true, fn: () => deleteSelected() });
  showMenu(rows, e.clientX, e.clientY);
}

const CANVAS_ADD = [['note', 'nota'], ['todo', 'lista de tarefas'], ['link', 'link'], ['board', 'board'], ['column', 'coluna'], ['comment', 'comentário']];

// Right-click on empty canvas: paste or add a card right there.
export function openCanvasCtx(e) {
  e.preventDefault();
  if (!state.view.canvas) return;
  const w = screenToWorld(e.clientX, e.clientY);
  const mod = modKey();
  const rows = [
    { label: 'Desfazer', hint: mod + 'Z', fn: () => undo(), disabled: document.getElementById('undoBtn')?.disabled },
    { label: 'Refazer', hint: mod + '⇧Z', fn: () => redo(), disabled: document.getElementById('redoBtn')?.disabled },
    { sep: true },
    { label: 'Colar aqui', hint: mod + 'V', fn: () => pasteClipboard(w.x, w.y), disabled: !state.clipboard },
    { sep: true },
    ...CANVAS_ADD.map(([type, label]) => ({ label: 'Adicionar ' + label, fn: () => createAt(type, w.x - defaultsFor(type).w / 2, w.y - 20) })),
    { sep: true },
    { label: 'Selecionar tudo', hint: mod + 'A', fn: () => selectMany(state.view.items.filter(item => !item.parentItemId).map(item => item.id)) },
    { label: 'Ajustar à tela', hint: 'F', fn: () => fitToItems() }
  ];
  showMenu(rows, e.clientX, e.clientY);
}

export function closeCtx() { dom.ctxmenu.classList.remove('open'); dom.ctxmenu.innerHTML = ''; }
