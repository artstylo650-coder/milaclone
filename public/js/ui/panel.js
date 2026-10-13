'use strict';

import { refreshIcons } from '../core/util.js';

// A centered modal panel (trash, settings, confirmations). While one is open
// it owns the keyboard: main.js checks isPanelOpen() before its shortcuts.

let current = null;

export function isPanelOpen() { return !!current; }

export function closePanel() {
  if (!current) return;
  const { root, onClose } = current;
  current = null;
  root.remove();
  if (onClose) onClose();
}

// body: an Element; actions: [{ label, primary?, danger?, fn }] for the footer.
export function openPanel({ title, body, actions = [], onClose, wide = false }) {
  closePanel();
  const root = document.createElement('div');
  root.className = 'panel-backdrop';
  root.addEventListener('pointerdown', (e) => { if (e.target === root) closePanel(); });
  const box = document.createElement('div');
  box.className = 'panel' + (wide ? ' wide' : '');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', title);
  const head = document.createElement('div');
  head.className = 'panel-head';
  const h = document.createElement('h2'); h.textContent = title;
  const x = document.createElement('button');
  x.type = 'button'; x.className = 'panel-x'; x.setAttribute('aria-label', 'Fechar'); x.textContent = '×';
  x.onclick = closePanel;
  head.append(h, x);
  const content = document.createElement('div');
  content.className = 'panel-body';
  content.appendChild(body);
  box.append(head, content);
  if (actions.length) {
    const foot = document.createElement('div');
    foot.className = 'panel-foot';
    for (const a of actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'panel-btn' + (a.primary ? ' primary' : '') + (a.danger ? ' danger' : '');
      b.textContent = a.label;
      b.onclick = () => a.fn(b);
      foot.appendChild(b);
    }
    box.appendChild(foot);
  }
  root.appendChild(box);
  document.body.appendChild(root);
  current = { root, onClose };
  refreshIcons(root);
  const focusable = box.querySelector('input, textarea, select, .panel-btn.primary');
  (focusable || x).focus();
  return { root, box, content };
}

export function confirmDialog(message, { confirm = 'Continuar', danger = false } = {}) {
  return new Promise(resolve => {
    let answered = false;
    const p = document.createElement('p');
    p.className = 'panel-text';
    p.textContent = message;
    openPanel({
      title: 'Tem certeza?', body: p,
      onClose: () => { if (!answered) resolve(false); },
      actions: [
        { label: 'Cancelar', fn: () => closePanel() },
        { label: confirm, primary: !danger, danger, fn: () => { answered = true; closePanel(); resolve(true); } }
      ]
    });
  });
}

document.addEventListener('keydown', (e) => {
  if (current && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closePanel(); }
}, true);
