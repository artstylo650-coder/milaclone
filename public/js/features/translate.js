'use strict';

// Translated twin notes. A note can have a twin in the other language
// (Portuguese ⇄ English) placed to its right and joined by a line. Editing
// either one and leaving the field re-translates it into the other, so a
// prompt written in Portuguese always has its English version ready, and a
// pasted English prompt gets its Portuguese reading. Automatic for notes whose
// title mentions "prompt" (configurable in ⋯ → Tradução); any note can be
// translated from its right-click menu. The server does the translation with
// a free service, no AI and no account (backend/translate.js).

import { state, dom, elMap } from '../core/state.js';
import { api, startAction } from '../core/api.js';
import { toast, refreshIcons } from '../core/util.js';
import { refreshItem, renderItem } from '../board/cards.js';
import { onEditEnd, flushSaves } from '../board/editing.js';
import { createLine, renderConnections } from '../board/connections.js';
import { openPanel, closePanel } from '../ui/panel.js';

let settings = null;
const busy = new Set();

async function loadSettings(force = false) {
  if (!settings || force) settings = await api.translateSettings();
  return settings;
}

const textOf = it => JSON.stringify([it.data.title || '', it.data.body || '']);
const partnerOf = it => {
  const id = it.data.translation || it.data.translationOf;
  return id ? state.view.items.find(x => x.id === id && x.type === 'note') : null;
};

function wantsAuto(it, mode) {
  if (mode === 'off' || it.type !== 'note') return false;
  if (!(it.data.body || '').trim()) return false;
  if (mode === 'all') return true;
  return /prompt/i.test(it.data.title || '') || !!partnerOf(it);
}

function setBusy(it, on) {
  const el = elMap.get(it.id);
  if (el) el.classList.toggle('translating', on);
}

// Create or refresh the twin of a note. `quiet` skips the success toast.
export async function translateNote(it, { quiet = false } = {}) {
  if (!it || it.type !== 'note' || busy.has(it.id)) return;
  const key = textOf(it);
  // automatic runs skip a note whose text has not changed since the last sync
  if (quiet && it.data.pairText === key && partnerOf(it)) return;
  busy.add(it.id);
  setBusy(it, true);
  try {
    await flushSaves();
    const result = await api.translate({ title: it.data.title || '', body: it.data.body || '' });
    if (result.error) { toast(result.error); return; }
    const done = startAction();
    try {
      const twinData = { title: result.title, body: result.body, lang: result.targetLanguage, pairText: JSON.stringify([result.title, result.body]) };
      const sourceData = { lang: result.sourceLanguage === 'other' ? null : result.sourceLanguage, pairText: key };
      let twin = partnerOf(it);
      if (twin) {
        twin.data = Object.assign({}, twin.data, twinData);
        await api.patch(twin.id, { data: twinData });
        it.data = Object.assign({}, it.data, sourceData);
        await api.patch(it.id, { data: sourceData });
        refreshItem(twin);
      } else {
        const el = elMap.get(it.id);
        twin = await api.create({
          canvasId: it.canvasId, type: 'note', color: it.color || null,
          x: Math.round(it.x + (el ? el.offsetWidth : it.w || 240) + 70), y: it.y, w: it.w || 240,
          data: Object.assign({ translationOf: it.id }, twinData)
        });
        if (twin.error) { toast('Não foi possível criar a tradução'); return; }
        state.view.items.push(twin);
        it.data = Object.assign({}, it.data, sourceData, { translation: twin.id });
        await api.patch(it.id, { data: { ...sourceData, translation: twin.id } });
        // add just the new card: a full re-render would steal focus from a field in use
        const twinEl = renderItem(twin);
        dom.world.appendChild(twinEl);
        elMap.set(twin.id, twinEl);
        refreshIcons(twinEl);
        const line = await createLine(it.id, twin.id);
        if (line) {
          const label = (result.targetLanguage || '').toUpperCase();
          line.data = Object.assign({}, line.data, { label, dashed: true });
          await api.patch(line.id, { data: { label, dashed: true } });
          renderConnections();
        }
      }
      refreshItem(it);
    } finally { done(); }
    if (!quiet) toast(result.targetLanguage === 'en' ? 'Traduzido para inglês' : 'Traduzido para português');
  } finally {
    busy.delete(it.id);
    setBusy(it, false);
  }
}

// ---- settings --------------------------------------------------------------

export async function openTranslateSettings() {
  const s = await loadSettings(true);
  const wrap = document.createElement('div');
  wrap.className = 'translate-settings';
  wrap.innerHTML = `
    <p class="panel-text">Notas ganham um card gêmeo no outro idioma (português ⇄ inglês), ligado por uma seta.
      Editar qualquer um dos dois atualiza o outro, mantendo a mesma estrutura do texto.</p>
    <label for="trAuto">Traduzir automaticamente</label>
    <select id="trAuto">
      <option value="prompts">Notas com “prompt” no título</option>
      <option value="all">Todas as notas</option>
      <option value="off">Só quando eu pedir (clique direito → Traduzir)</option>
    </select>
    <label for="trEmail">Seu e-mail (opcional)</label>
    <input id="trEmail" type="email" autocomplete="email" placeholder="voce@exemplo.com">
    <p class="panel-text muted small">Usa o tradutor gratuito MyMemory, sem IA e sem cadastro, linha por linha.
      O limite grátis é de uns 5.000 caracteres por dia; com um e-mail sobe para uns 50.000.</p>`;
  const $ = sel => wrap.querySelector(sel);
  $('#trAuto').value = s.auto;
  $('#trEmail').value = s.email || '';
  openPanel({
    title: 'Tradução', body: wrap,
    actions: [{ label: 'Salvar', primary: true, fn: async () => {
      const saved = await api.translateSettings({ auto: $('#trAuto').value, email: $('#trEmail').value });
      if (saved.error) { toast(saved.error); return; }
      settings = saved;
      toast('Tradução configurada');
      closePanel();
    } }]
  });
}

export function initTranslate() {
  onEditEnd(async (it) => {
    if (it.type !== 'note') return;
    const s = await loadSettings().catch(() => null);
    if (!s || !wantsAuto(it, s.auto)) return;
    translateNote(it, { quiet: true });
  });
}
