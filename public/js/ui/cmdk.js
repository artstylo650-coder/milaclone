'use strict';

import { state, dom } from '../core/state.js';
import { api } from '../core/api.js';
import { lucideEl, refreshIcons } from '../core/util.js';
import { createAt, defaultsFor } from '../board/create.js';
import { select } from '../board/editing.js';
import { centerOn, screenToWorld } from '../board/viewport.js';
import { openCanvas } from '../main.js';

// Command palette. Ctrl+K searches every board and runs app commands;
// double-clicking empty canvas opens it in "add" mode to drop a card there,
// like a node editor's quick-add search. Other modules register commands.

const commands = [];
const addables = [
  { type: 'note', label: 'Nota', icon: 'sticky-note', keywords: 'note texto' },
  { type: 'todo', label: 'Lista de tarefas', icon: 'list-checks', keywords: 'to-do todo tarefas checklist' },
  { type: 'link', label: 'Link', icon: 'link', keywords: 'url web site' },
  { type: 'board', label: 'Board', icon: 'layout-grid', keywords: 'pasta quadro' },
  { type: 'column', label: 'Coluna', icon: 'columns-3', keywords: 'column lista' },
  { type: 'comment', label: 'Comentário', icon: 'message-circle', keywords: 'comment comentario' },
  { type: 'group', label: 'Moldura de grupo', icon: 'frame', keywords: 'group grupo moldura' },
  { type: 'comfy', label: 'Node ComfyUI', icon: 'sparkles', keywords: 'ai ia generate gerar runpod workflow imagem' }
];

export function registerCommand(cmd) { commands.push(cmd); }
export function registerAddable(entry) { addables.push(entry); }

let root = null;

export function isCommandOpen() { return !!root; }

export function closeCommand() {
  if (!root) return;
  root.remove();
  root = null;
}

const fold = v => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const matches = (q, ...texts) => { const t = fold(texts.join(' ')); return fold(q).split(/\s+/).every(w => t.includes(w)); };

const TYPE_ICONS = { note: 'sticky-note', todo: 'list-checks', link: 'link', image: 'image', file: 'file-text', comment: 'message-circle', node: 'workflow', board: 'layout-grid' };

async function revealResult(result) {
  if (!state.view.canvas || state.view.canvas.id !== result.canvasId) await openCanvas(result.canvasId);
  if (result.kind !== 'item') return;
  const it = state.view.items.find(x => x.id === result.id);
  if (!it) return;
  const host = it.parentItemId ? state.view.items.find(x => x.id === it.parentItemId) || it : it;
  centerOn(host.x + (host.w || 240) / 2, host.y + 80);
  select(it.id);
}

// mode 'search' (Ctrl+K) or 'add' (double-click at world point `at`).
export function openCommand({ mode = 'search', at = null } = {}) {
  closeCommand();
  root = document.createElement('div');
  root.className = 'cmdk-backdrop';
  root.addEventListener('pointerdown', (e) => { if (e.target === root) closeCommand(); });
  const box = document.createElement('div');
  box.className = 'cmdk';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', mode === 'add' ? 'Adicionar card' : 'Busca e comandos');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'cmdk-input';
  input.placeholder = mode === 'add' ? 'Adicionar aqui… (nota, tarefas, board…)' : 'Buscar em todos os boards ou digitar um comando…';
  input.setAttribute('aria-label', input.placeholder);
  const list = document.createElement('div');
  list.className = 'cmdk-list';
  list.setAttribute('role', 'listbox');
  box.append(input, list);
  root.appendChild(box);
  document.body.appendChild(root);
  input.focus();

  let rows = [];
  let active = 0;
  let searchSeq = 0;

  const paint = () => {
    list.innerHTML = '';
    rows.forEach((row, i) => {
      if (row.section) {
        const h = document.createElement('div'); h.className = 'cmdk-section'; h.textContent = row.section;
        list.appendChild(h);
        return;
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cmdk-row' + (i === active ? ' active' : '');
      b.setAttribute('role', 'option');
      const icon = document.createElement('span'); icon.className = 'cmdk-icon'; icon.appendChild(lucideEl(row.icon || 'circle'));
      const text = document.createElement('span'); text.className = 'cmdk-text';
      const title = document.createElement('strong'); title.textContent = row.label;
      text.appendChild(title);
      if (row.detail) { const d = document.createElement('span'); d.textContent = row.detail; text.appendChild(d); }
      b.append(icon, text);
      if (row.hint) { const k = document.createElement('kbd'); k.textContent = row.hint; b.appendChild(k); }
      b.onmouseenter = () => { active = i; [...list.querySelectorAll('.cmdk-row')].forEach(el => el.classList.toggle('active', el === b)); };
      b.onclick = () => run(row);
      list.appendChild(b);
    });
    refreshIcons(list);
    list.querySelector('.cmdk-row.active')?.scrollIntoView({ block: 'nearest' });
  };

  const run = async (row) => {
    closeCommand();
    await row.run();
  };

  const selectable = () => rows.map((r, i) => r.section ? -1 : i).filter(i => i >= 0);

  const update = async () => {
    const q = input.value.trim();
    if (mode === 'add') {
      const point = at || screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
      rows = addables.filter(a => !q || matches(q, a.label, a.keywords || '')).map(a => ({
        label: a.label, icon: a.icon, detail: a.detail,
        run: () => a.run ? a.run(point) : createAt(a.type, point.x - defaultsFor(a.type).w / 2, point.y - 20)
      }));
      active = selectable()[0] ?? 0;
      paint();
      return;
    }
    const cmdRows = commands.filter(c => !q || matches(q, c.label, c.keywords || '')).map(c => ({ ...c }));
    rows = [];
    if (cmdRows.length) rows.push({ section: 'Comandos' }, ...cmdRows.slice(0, q ? 6 : 12));
    active = selectable()[0] ?? 0;
    paint();
    if (!q) return;
    const seq = ++searchSeq;
    const { results = [] } = await api.search(q);
    if (seq !== searchSeq || !root) return;
    const found = results.map(r => ({
      label: r.title || 'Sem título', icon: r.kind === 'board' ? 'layout-grid' : (TYPE_ICONS[r.type] || 'square'),
      detail: r.kind === 'board' ? (r.where ? 'Board em ' + r.where : 'Board') : (r.where ? 'Em ' + r.where : ''),
      run: () => revealResult(r)
    }));
    rows = [];
    if (found.length) rows.push({ section: 'Nos seus boards' }, ...found);
    if (cmdRows.length) rows.push({ section: 'Comandos' }, ...cmdRows.slice(0, 6));
    if (!rows.length) rows.push({ section: 'Nada encontrado' });
    active = selectable()[0] ?? 0;
    paint();
  };

  let timer = 0;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    // add mode filters a local list: do it now so Enter right after typing picks the match
    if (mode === 'add') update(); else timer = setTimeout(update, 140);
  });
  input.addEventListener('keydown', (e) => {
    const ids = selectable();
    const pos = ids.indexOf(active);
    if (e.key === 'ArrowDown') { e.preventDefault(); active = ids[Math.min(ids.length - 1, pos + 1)] ?? active; paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = ids[Math.max(0, pos - 1)] ?? active; paint(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (rows[active] && !rows[active].section) run(rows[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); closeCommand(); }
  });
  update();
}

export function initCommand() {
  // Double-click on empty canvas: quick add at that spot.
  dom.stage.addEventListener('dblclick', (e) => {
    if (e.target.closest('.item, .line-hit') || state.armed) return;
    openCommand({ mode: 'add', at: screenToWorld(e.clientX, e.clientY) });
  });
  const btn = document.getElementById('searchBtn');
  if (btn) btn.onclick = () => openCommand();
}
