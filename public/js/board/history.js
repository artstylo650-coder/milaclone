'use strict';

import { state } from '../core/state.js';
import { api, onWrite } from '../core/api.js';
import { toast } from '../core/util.js';
import { saveCam } from './viewport.js';
import { flushSaves, exitEdit } from './editing.js';
import { openCanvas } from '../main.js';

// Undo / redo. The server journals every change (history.js at the root), so
// the client only asks it to step back or forward and then reloads the board
// the change happened on.

let busy = false;

export async function refreshHistoryButtons(status) {
  const s = status || await api.history().catch(() => null);
  if (!s) return;
  const undoBtn = document.getElementById('undoBtn');
  const redoBtn = document.getElementById('redoBtn');
  if (undoBtn) undoBtn.disabled = !s.canUndo;
  if (redoBtn) redoBtn.disabled = !s.canRedo;
}

async function step(direction) {
  if (busy) return;
  busy = true;
  try {
    exitEdit();
    await flushSaves();
    const result = await api.history(direction);
    refreshHistoryButtons(result);
    if (!result.ok) { toast(direction === 'undo' ? 'Nada para desfazer' : 'Nada para refazer'); return; }
    // Stay on this board if the change touched it; otherwise go to the board
    // where it happened so the result is visible.
    const current = state.view.canvas && state.view.canvas.id;
    const target = result.canvasIds.includes(current) ? current : result.canvasIds[0] || current;
    saveCam();
    await openCanvas(target);
    toast(direction === 'undo' ? 'Desfeito' : 'Refeito');
  } finally {
    busy = false;
  }
}

export const undo = () => step('undo');
export const redo = () => step('redo');

export function initHistory() {
  document.getElementById('undoBtn').onclick = undo;
  document.getElementById('redoBtn').onclick = redo;
  // Any write may change what can be undone; keep the buttons honest.
  let pending = 0;
  onWrite(() => {
    clearTimeout(pending);
    pending = setTimeout(() => refreshHistoryButtons(), 250);
  });
  refreshHistoryButtons();
}
