'use strict';

import { api } from '../core/api.js';
import { toast, lucideEl } from '../core/util.js';
import { showMenu } from './menus.js';
import { openPanel, closePanel, confirmDialog } from './panel.js';
import { openCanvas } from '../main.js';

// The top-bar "⋯" menu: app-level actions that don't belong to one card.
// Other modules add entries with addAppMenuItem (export, ComfyUI settings…).

const extraItems = [];
export function addAppMenuItem(item) { extraItems.push(item); }

function appMenuRows() {
  return [
    { label: 'Lixeira', fn: openTrash },
    { sep: true },
    { label: 'Baixar backup', fn: downloadBackup },
    { label: 'Restaurar backup…', fn: chooseRestore },
    ...(extraItems.length ? [{ sep: true }, ...extraItems] : [])
  ];
}

export function openAppMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  showMenu(appMenuRows(), r.right - 220, r.bottom + 6);
}

// ---- Trash -----------------------------------------------------------------

const TYPE_ICONS = {
  note: 'sticky-note', todo: 'list-checks', link: 'link', image: 'image', file: 'file-text',
  board: 'layout-grid', column: 'columns-3', comment: 'message-circle', line: 'spline', node: 'workflow'
};

function when(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export async function openTrash() {
  const list = document.createElement('div');
  list.className = 'trash-list';
  const { entries = [] } = await api.trash();
  const render = (rows) => {
    list.innerHTML = '';
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'panel-text muted';
      empty.textContent = 'A lixeira está vazia. Itens excluídos ficam aqui por 30 dias.';
      list.appendChild(empty);
      return;
    }
    for (const entry of rows) {
      const row = document.createElement('div');
      row.className = 'trash-row';
      row.dataset.id = entry.id;
      const icon = document.createElement('span');
      icon.className = 'trash-icon';
      icon.appendChild(lucideEl(TYPE_ICONS[entry.type] || 'square'));
      const text = document.createElement('div');
      text.className = 'trash-text';
      const name = document.createElement('strong');
      name.textContent = entry.label || 'Sem título';
      const meta = document.createElement('span');
      meta.textContent = `${entry.canvasTitle ? 'De ' + entry.canvasTitle + ' · ' : ''}${when(entry.deletedAt)}`;
      text.append(name, meta);
      const restore = document.createElement('button');
      restore.type = 'button'; restore.className = 'panel-btn small'; restore.textContent = 'Restaurar';
      restore.onclick = async () => {
        const result = await api.restoreTrash(entry.id);
        if (result.error) { toast(result.error); return; }
        closePanel();
        await openCanvas(result.canvasId);
        toast('Restaurado');
      };
      const purge = document.createElement('button');
      purge.type = 'button'; purge.className = 'panel-btn small danger'; purge.textContent = 'Excluir de vez';
      purge.onclick = async () => {
        if (!await confirmDialog(`Excluir "${name.textContent}" de vez? Não dá para desfazer.`, { confirm: 'Excluir de vez', danger: true })) { openTrash(); return; }
        await api.purgeTrash(entry.id);
        openTrash();
      };
      row.append(icon, text, restore, purge);
      list.appendChild(row);
    }
  };
  render(entries);
  openPanel({
    title: 'Lixeira', body: list, wide: true,
    actions: entries.length ? [{
      label: 'Esvaziar lixeira', danger: true,
      fn: async () => {
        if (!await confirmDialog(`Excluir de vez os ${entries.length} itens da lixeira?`, { confirm: 'Esvaziar lixeira', danger: true })) { openTrash(); return; }
        await api.purgeTrash();
        openTrash();
      }
    }] : []
  });
}

// ---- Backup ----------------------------------------------------------------

function downloadBackup() {
  const a = document.createElement('a');
  a.href = '/api/backup/export';
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast('Preparando o backup…');
}

function chooseRestore() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.gz,.tgz,application/gzip';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    const ok = await confirmDialog(
      `Restaurar "${file.name}"? Todos os boards serão substituídos pelo conteúdo do backup. ` +
      'Antes disso, uma cópia dos dados atuais é salva na pasta de backups.',
      { confirm: 'Restaurar backup', danger: true });
    if (!ok) return;
    toast('Restaurando…');
    const result = await api.restoreBackup(file);
    if (result.error) { toast(result.error); return; }
    toast(`${result.items} cards restaurados`);
    location.hash = '';
    location.reload();
  };
  input.click();
}

export function initAppMenu() {
  const btn = document.getElementById('appMenuBtn');
  btn.addEventListener('click', (e) => { e.stopPropagation(); openAppMenu(btn); });
}

