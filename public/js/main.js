'use strict';

// Entry point of the browser app: boots the modules, owns navigation
// (openCanvas / reloadView), global keyboard and pointer handlers, the
// clipboard events, the live-update stream and the command list.

import { state, dom } from './core/state.js';
import { api, clientId } from './core/api.js';
import { refreshIcons, toast } from './core/util.js';
import { loadCam, applyCam, initViewport, fitToItems, zoomBy } from './board/viewport.js';
import { render, renderCrumbs } from './board/cards.js';
import {
  deselect, renameSelected, deleteSelected, exitEdit, selectMany,
  groupSelected, ungroupSelected, initMultiSelection
} from './board/editing.js';
import { closePalette, closeCtx } from './ui/menus.js';
import { copySelected, duplicateSelected, armPasteFallback } from './board/clipboard.js';
import { arm, disarm, initTools } from './board/tools.js';
import { initMobile, updateMobileChrome } from './ui/mobile.js';
import { initBoardChrome, updateSelectionChrome } from './ui/boardchrome.js';
import { initQuickNotes, isQuickNotesOpen } from './features/quicknotes.js';
import { initHistory, undo, redo } from './board/history.js';
import { isPanelOpen } from './ui/panel.js';
import { initAppMenu, openTrash, addAppMenuItem } from './ui/appmenu.js';
import { initTheme, openAppearance } from './ui/theme.js';
import { initTranslate, openTranslateSettings } from './features/translate.js';
import { initEnhance, openEnhanceDialog } from './features/enhance.js';
import { openAbout, checkInBackground } from './ui/update.js';
import { openComfySettings, setResultsHandler } from './features/comfynode.js';
import { initMinimap, minimapEnabled, toggleMinimap } from './board/minimap.js';
import { initTags, applyFilter } from './board/tags.js';
import { exportPng, exportPdf, exportLabel } from './ui/export.js';
import { initArrange, nudge, toggleSnap, snapEnabled, GRID, align, distribute, tidy } from './board/arrange.js';
import { isLightboxOpen } from './ui/lightbox.js';
import { initCommand, openCommand, isCommandOpen, registerCommand } from './ui/cmdk.js';

// Entry point: canvas loading/navigation, global keyboard + pointer handling,
// and boot. Wiring for the viewport and toolbar lives in their own modules and
// is activated here.

export async function openCanvas(id) {
  state.view = await api.canvas(id);
  if (state.view.error) { if (id !== state.rootCanvasId) return openCanvas(state.rootCanvasId); toast('Board não encontrado'); return; }
  state.cam = loadCam(id);
  state.selectedId = null; state.selectedIds = new Set(); state.editingId = null;
  state.filter = null;
  if (document.getElementById('multiActions')) document.getElementById('multiActions').hidden = true;
  closeCtx();
  renderCrumbs();
  updateMobileChrome();
  updateSelectionChrome();
  render();
  applyFilter();
  applyCam();
  if (location.hash.slice(1) !== id) { history.replaceState(null, '', '#' + id); }
}

// Server-Sent Events: another tab or device changed a board; refresh the one
// on screen (see events.js).
function connectLive() {
  if (typeof EventSource === 'undefined') return;
  const source = new EventSource('/api/events?client=' + encodeURIComponent(clientId));
  source.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch (_) { return; }
    if (msg.from === clientId || !state.view.canvas) return;
    if (msg.canvasIds === 'all') { location.reload(); return; }
    if (msg.canvasIds.includes(state.view.canvas.id)) reloadView();
  };
}

// Re-fetch the open board after changes made elsewhere (ComfyUI results,
// another device) without losing the camera, selection or a field in use.
let reloadQueued = false;
export async function reloadView() {
  if (!state.view.canvas) return;
  const typingInBoard = document.activeElement && dom.world.contains(document.activeElement) &&
    /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) && !document.activeElement.readOnly;
  if (state.editingId || state.drag || isPanelOpen() || typingInBoard) { if (!reloadQueued) { reloadQueued = true; setTimeout(() => { reloadQueued = false; reloadView(); }, 1500); } return; }
  const fresh = await api.canvas(state.view.canvas.id);
  if (fresh.error) return;
  state.view = fresh;
  const alive = new Set(fresh.items.map(it => it.id));
  state.selectedIds = new Set([...state.selectedIds].filter(id => alive.has(id)));
  if (!alive.has(state.selectedId)) state.selectedId = null;
  renderCrumbs();
  render();
}

document.addEventListener('keydown', (e) => {
  // Quick notes, panels, the viewer and the palette own the keyboard while open
  if (isQuickNotesOpen() || isPanelOpen() || isLightboxOpen() || isCommandOpen()) return;
  const ae = document.activeElement;
  const typing = ae && (ae.isContentEditable || (/^(INPUT|TEXTAREA)$/.test(ae.tagName) && !ae.readOnly));
  // first Escape leaves a field but keeps the card selected; the next one deselects
  if (e.key === 'Escape') {
    disarm(); closePalette(); closeCtx();
    if (state.editingId) { exitEdit(); if (typing) ae.blur(); return; }
    deselect();
  }
  if (typing) return;   // inside a field, Ctrl+Z stays the browser's text undo
  const mod = e.metaKey || e.ctrlKey;
  if ((mod && e.key.toLowerCase() === 'k') || (!mod && e.key === '/')) { e.preventDefault(); openCommand(); return; }
  if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  // Copy/cut/paste go through the browser clipboard events below, so the
  // system clipboard always holds whatever was copied last, here or elsewhere.
  if (mod && (e.key.toLowerCase() === 'c' || e.key.toLowerCase() === 'x')) {
    const cut = e.key.toLowerCase() === 'x';
    clearTimeout(clipboardKey);
    clipboardKey = setTimeout(() => copySelected(cut), 60);
    return;
  }
  if (mod && e.key.toLowerCase() === 'v') { armPasteFallback(); return; }
  if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelected(); return; }
  if (mod && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    selectMany(state.view.items.filter(item => !item.parentItemId).map(item => item.id));
    return;
  }
  if (mod && e.key.toLowerCase() === 'g') {
    e.preventDefault();
    if (e.shiftKey) ungroupSelected(); else groupSelected();
    return;
  }
  if (!mod && e.key.startsWith('Arrow') && state.selectedIds.size) {
    const step = snapEnabled() ? GRID : (e.shiftKey ? 10 : 1);
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (d && nudge(d[0], d[1])) { e.preventDefault(); return; }
  }
  if (!mod && e.key.toLowerCase() === 'f') { e.preventDefault(); fitToItems(); return; }
  if (e.key === 'Enter' && state.selectedId && !mod) { e.preventDefault(); renameSelected(); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedIds.size) { e.preventDefault(); deleteSelected(); }
  const map = { n: 'note', l: 'link', t: 'todo', b: 'board', c: 'column', m: 'comment' };
  if (map[e.key.toLowerCase()] && !mod) {
    const btn = document.querySelector(`.tool[data-tool="${map[e.key.toLowerCase()]}"]`);
    if (btn) arm(map[e.key.toLowerCase()], btn);
  }
});

// Browsers that fire no copy event without a text selection still copy via
// the timer armed on keydown.
let clipboardKey = 0;
function onClipboardCopy(e, cut) {
  clearTimeout(clipboardKey);
  if (isQuickNotesOpen() || !state.selectedIds.size) return;
  const ae = document.activeElement;
  if (ae && (ae.isContentEditable || (/^(INPUT|TEXTAREA)$/.test(ae.tagName) && !ae.readOnly))) return;
  if (String(window.getSelection() || '')) return;   // let real text copies through
  const marker = copySelected(cut);
  if (!marker || !e.clipboardData) return;
  e.clipboardData.setData('text/plain', marker);
  e.preventDefault();
}
document.addEventListener('copy', (e) => onClipboardCopy(e, false));
document.addEventListener('cut', (e) => onClipboardCopy(e, true));

document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat) return;
  const ae = document.activeElement;
  const typing = ae && (ae.isContentEditable || (/^(INPUT|TEXTAREA)$/.test(ae.tagName) && !ae.readOnly));
  if (typing || isQuickNotesOpen() || isPanelOpen()) return;
  e.preventDefault();
  state.spacePanning = true;
  document.getElementById('stage').classList.add('pan-ready');
});
document.addEventListener('keyup', (e) => {
  if (e.code !== 'Space') return;
  state.spacePanning = false;
  document.getElementById('stage').classList.remove('pan-ready');
});
window.addEventListener('blur', () => {
  state.spacePanning = false;
  document.getElementById('stage').classList.remove('pan-ready');
});

document.addEventListener('pointerdown', (e) => {
  if (isQuickNotesOpen()) return;
  if (!e.target.closest('#palette') && !e.target.closest('.swatch')) closePalette();
  if (!e.target.closest('#ctxmenu') && !e.target.closest('.item')) closeCtx();
  if (state.editingId && !e.target.closest('.item')) exitEdit();
}, true);

window.addEventListener('hashchange', () => {
  const id = location.hash.slice(1);
  if (id && (!state.view.canvas || id !== state.view.canvas.id)) openCanvas(id);
});

initViewport();
initMobile();
initBoardChrome();
initMultiSelection();
initQuickNotes();
initTools();
initHistory();
initTheme();
initAppMenu();
addAppMenuItem({ label: 'Aparência…', fn: () => openAppearance() });
addAppMenuItem({ label: 'Tradução…', fn: () => openTranslateSettings() });
initTranslate();
initEnhance();
addAppMenuItem({ label: 'Aprimorador (upscale)…', fn: () => openEnhanceDialog([]) });
addAppMenuItem({ label: 'Sobre o Milaclone…', fn: () => openAbout() });
setTimeout(checkInBackground, 6000);
initCommand();
initArrange();
initMinimap();
initTags();
addAppMenuItem({ get label() { return exportLabel('PNG'); }, fn: () => exportPng() });
addAppMenuItem({ get label() { return exportLabel('PDF'); }, fn: () => exportPdf() });
addAppMenuItem({ label: 'Mostrar minimapa', get checked() { return minimapEnabled(); }, fn: () => toggleMinimap() });
addAppMenuItem({ label: 'Grade magnética', get checked() { return snapEnabled(); }, fn: () => toggleSnap() });
connectLive();
addAppMenuItem({ label: 'Configurar ComfyUI…', fn: () => openComfySettings() });
setResultsHandler(() => reloadView());
[
  { label: 'Ajustar o board à tela', icon: 'maximize', hint: 'F', keywords: 'zoom ajustar', run: () => fitToItems() },
  { label: 'Aumentar zoom', icon: 'zoom-in', keywords: 'aumentar', run: () => zoomBy(1.2) },
  { label: 'Diminuir zoom', icon: 'zoom-out', keywords: 'diminuir', run: () => zoomBy(1 / 1.2) },
  { label: 'Desfazer', icon: 'undo-2', hint: 'Ctrl Z', keywords: 'desfazer', run: () => undo() },
  { label: 'Refazer', icon: 'redo-2', hint: 'Ctrl ⇧ Z', keywords: 'refazer', run: () => redo() },
  { label: 'Selecionar tudo', icon: 'box-select', hint: 'Ctrl A', keywords: 'selecionar tudo', run: () => selectMany(state.view.items.filter(it => !it.parentItemId).map(it => it.id)) },
  { label: 'Abrir a lixeira', icon: 'trash-2', keywords: 'lixeira restore restaurar', run: () => openTrash() },
  { label: 'Baixar backup', icon: 'download', keywords: 'export exportar copia', run: () => { location.href = '/api/backup/export'; } },
  { label: 'Ligar/desligar grade magnética', icon: 'grid-3x3', keywords: 'grade magnetica snap', run: () => toggleSnap() },
  { label: 'Alinhar à esquerda', icon: 'align-start-vertical', keywords: 'alinhar esquerda', run: () => align('left') },
  { label: 'Alinhar no topo', icon: 'align-start-horizontal', keywords: 'alinhar topo', run: () => align('top') },
  { label: 'Distribuir na horizontal', icon: 'align-horizontal-space-around', keywords: 'distribuir', run: () => distribute('h') },
  { label: 'Organizar a seleção em grade', icon: 'layout-grid', keywords: 'organizar arrumar grade', run: () => tidy() },
  { label: 'Exportar como imagem PNG', icon: 'image-down', keywords: 'exportar imagem png prancha', run: () => exportPng() },
  { label: 'Exportar como PDF', icon: 'file-down', keywords: 'exportar pdf prancha aprovacao', run: () => exportPdf() },
  { label: 'Configurações do ComfyUI', icon: 'sparkles', keywords: 'runpod workflow ai ia', run: () => openComfySettings() },
  { label: 'Ir para o início', icon: 'house', keywords: 'inicio root', run: () => openCanvas(state.rootCanvasId) }
].forEach(registerCommand);

(async function boot() {
  refreshIcons();
  const r = await api.root();
  state.rootCanvasId = r.rootCanvasId;
  const startId = location.hash.slice(1) || state.rootCanvasId;
  await openCanvas(startId);
})();
