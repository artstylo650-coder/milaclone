'use strict';

import { state, dom, elMap, COLORS } from '../core/state.js';
import { api, startAction } from '../core/api.js';
import { colorVar, isCard, toast } from '../core/util.js';
import { showMenu } from '../ui/menus.js';
import { openPanel, closePanel } from '../ui/panel.js';
import { render } from './cards.js';

// Tags on any card (data.tags) and a board filter that dims every card not
// matching the chosen tag or color. Tags are also searchable as #tag (Ctrl+K).

const clean = t => String(t).trim().replace(/^#/, '').replace(/\s+/g, '-').toLowerCase().slice(0, 40);

export function tagsOf(it) { return Array.isArray(it.data && it.data.tags) ? it.data.tags : []; }

function boardTags() {
  const counts = new Map();
  for (const it of state.view.items) for (const t of tagsOf(it)) counts.set(t, (counts.get(t) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function renderTags(el, it) {
  const tags = tagsOf(it);
  if (!tags.length || !isCard(it)) return;
  const box = document.createElement('div');
  box.className = 'card-tags';
  for (const t of tags) {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.textContent = '#' + t;
    box.appendChild(chip);
  }
  el.appendChild(box);
}

export function editTags(ids) {
  const items = state.view.items.filter(it => ids.includes(it.id) && isCard(it));
  if (!items.length) return;
  const single = items.length === 1;
  const wrap = document.createElement('div');
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'ex.: aprovado, cliente-x, referencia';
  input.value = single ? tagsOf(items[0]).join(', ') : '';
  input.setAttribute('aria-label', 'Tags');
  const hint = document.createElement('p');
  hint.className = 'panel-text muted small';
  hint.textContent = single ? 'Separe as tags com vírgulas.' : `As tags digitadas serão adicionadas aos ${items.length} cards selecionados.`;
  wrap.append(input, hint);
  const existing = boardTags();
  if (existing.length) {
    const chips = document.createElement('div');
    chips.className = 'tag-suggest';
    for (const [t] of existing.slice(0, 24)) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'tag-chip'; b.textContent = '#' + t;
      b.onclick = () => {
        const list = input.value.split(',').map(clean).filter(Boolean);
        if (!list.includes(t)) input.value = [...list, t].join(', ');
        input.focus();
      };
      chips.appendChild(b);
    }
    wrap.appendChild(chips);
  }
  const save = async () => {
    const typed = [...new Set(input.value.split(',').map(clean).filter(Boolean))];
    closePanel();
    const done = startAction();
    try {
      await Promise.all(items.map(it => {
        const tags = single ? typed : [...new Set([...tagsOf(it), ...typed])];
        it.data = Object.assign({}, it.data, { tags });
        return api.patch(it.id, { data: { tags } });
      }));
    } finally { done(); }
    render();
    toast(single ? 'Tags salvas' : `Tags adicionadas a ${items.length} cards`);
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  openPanel({ title: single ? 'Tags' : `Tags de ${items.length} cards`, body: wrap,
    actions: [{ label: 'Cancelar', fn: closePanel }, { label: 'Salvar', primary: true, fn: save }] });
}

// ---- filter ----------------------------------------------------------------

export function matchesFilter(it) {
  const f = state.filter;
  if (!f || !isCard(it)) return true;
  if (f.kind === 'tag') return tagsOf(it).includes(f.value);
  if (f.kind === 'color') return (it.color || it._childColor) === f.value;
  return true;
}

export function applyFilter() {
  for (const it of state.view.items) {
    const el = elMap.get(it.id);
    if (el && el.classList) el.classList.toggle('filtered-out', !matchesFilter(it));
  }
  const btn = document.getElementById('filterBtn');
  if (!btn) return;
  const label = btn.querySelector('span');
  const f = state.filter;
  btn.classList.toggle('active', !!f);
  label.textContent = !f ? 'Filtrar' : f.kind === 'tag' ? '#' + f.value : f.value;
}

export function setFilter(filter) {
  state.filter = filter;
  applyFilter();
  if (filter) {
    const n = state.view.items.filter(it => isCard(it) && matchesFilter(it)).length;
    toast(n === 1 ? '1 card encontrado' : `${n} cards encontrados`);
  }
}

function openFilterMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  const tags = boardTags();
  const colors = COLORS.filter(c => state.view.items.some(it => isCard(it) && (it.color || it._childColor) === c));
  const rows = [{ label: 'Mostrar todos os cards', checked: !state.filter, fn: () => setFilter(null) }];
  if (tags.length) {
    rows.push({ sep: true });
    for (const [t, n] of tags) rows.push({ label: `#${t}`, hint: String(n), checked: state.filter?.kind === 'tag' && state.filter.value === t, fn: () => setFilter({ kind: 'tag', value: t }) });
  }
  if (colors.length) {
    rows.push({ sep: true });
    for (const c of colors) rows.push({ label: c[0].toUpperCase() + c.slice(1), swatch: colorVar(c), checked: state.filter?.kind === 'color' && state.filter.value === c, fn: () => setFilter({ kind: 'color', value: c }) });
  }
  if (rows.length === 1) rows.push({ label: 'Adicione tags pelo clique direito num card', disabled: true, fn: () => {} });
  showMenu(rows, r.left, r.bottom + 6);
}

export function initTags() {
  const btn = document.getElementById('filterBtn');
  if (btn) btn.onclick = (e) => { e.stopPropagation(); openFilterMenu(btn); };
  if (dom.stage) applyFilter();
}
