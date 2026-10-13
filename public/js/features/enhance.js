'use strict';

// Enhancing images ("aprimorar"): any image on the board, one or many, can be
// sent through a workflow chosen as the enhancer (an upscaler such as SeedVR2).
// Entry points: the icon on each image, the right-click menu, the selection bar
// and the app menu. The server (comfy.js enhance()) runs one job per image and
// frames the results under the group the images are in; this module starts the
// run, shows a floating progress bar and offers the options dialog (workflow,
// its fields, test size).

import { state } from '../core/state.js';
import { api } from '../core/api.js';
import { toast } from '../core/util.js';
import { openPanel, closePanel } from '../ui/panel.js';
import { fieldControl, openFieldsPicker, notifyResults, paintProgress, progressBar } from './comfynode.js';

const MAX_BATCH = 64;   // the server's limit per run
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Selected images (a selected group brings its members along); results that
// already came out of the enhancer are left out.
export function selectedImageIds() {
  return state.view.items.filter(it => it.type === 'image' && !it.data.enhancedFrom && state.selectedIds.has(it.id)).map(it => it.id);
}

// The icon on one image acts on the whole selection when that image is part of it.
export function idsForImage(it) {
  const selected = selectedImageIds();
  return selected.length > 1 && selected.includes(it.id) ? selected : [it.id];
}

// Opens the options dialog (workflow, fields, test size, which images). With
// `quick` it runs straight away with the last settings instead.
export async function enhanceImages(ids, { quick = false } = {}) {
  if (!ids.length) { toast('Selecione ao menos uma imagem'); return; }
  if (!quick) { openEnhanceDialog(ids); return; }
  const s = await api.comfy('GET', '/enhance-settings');
  if (s.error) { toast(s.error); return; }
  if (!s.workflowId) { openEnhanceDialog(ids); return; }
  await start(ids);
}

async function start(ids) {
  const r = await api.comfy('POST', '/enhance', { ids });
  if (r.error) { toast(r.error); return; }
  toast(`Aprimorando ${plural(r.jobs, 'imagem', 'imagens')}`);
  track(r.anchorId);
}

// ---- floating progress ------------------------------------------------------

let bar = null, timer = null;

function ensureBar() {
  if (bar) return bar;
  bar = document.createElement('div');
  bar.id = 'enhanceBar';
  bar.hidden = true;
  const title = document.createElement('b');
  title.textContent = 'Aprimorando';
  const progress = progressBar();
  const stop = document.createElement('button');
  stop.type = 'button'; stop.textContent = '✕'; stop.title = 'Cancelar o aprimoramento';
  stop.setAttribute('aria-label', 'Cancelar aprimoramento');
  stop.onclick = async () => {
    const r = await api.comfy('POST', '/cancel/' + bar.dataset.anchor);
    toast(r.error || (r.cancelled ? plural(r.cancelled, 'tarefa cancelada', 'tarefas canceladas') : 'Nada em andamento'));
  };
  bar.append(title, progress, stop);
  document.body.appendChild(bar);
  return bar;
}

function track(anchorId) {
  const box = ensureBar();
  box.dataset.anchor = anchorId;
  box.hidden = false;
  clearTimeout(timer);
  let lastDone = 0;
  const tick = async () => {
    const s = await api.comfy('GET', '/status/' + anchorId).catch(() => null);
    if (!s || s.error) { box.hidden = true; return; }
    paintProgress(box.querySelector('.comfy-progress'), s);
    if (s.done !== lastDone) { lastDone = s.done; notifyResults(); }
    if (s.queued + s.running === 0) {
      box.hidden = true;
      if (s.failed) toast(`${plural(s.failed, 'imagem falhou', 'imagens falharam')}${s.errors[0] ? ': ' + s.errors[0] : ''}`);
      else if (s.done) toast(`${plural(s.done, 'imagem aprimorada', 'imagens aprimoradas')}`);
      return;
    }
    timer = setTimeout(tick, 900);
  };
  tick();
}

// ---- options dialog ---------------------------------------------------------

// Which images a run can cover, for the dialog's picker: the ones asked for,
// every image of their group, every image of the board not enhanced yet.
function scopesFor(ids) {
  const items = state.view.items;
  const byId = new Map(items.map(i => [i.id, i]));
  const cap = list => list.slice(0, MAX_BATCH);
  const out = [{ label: ids.length === 1 ? 'Esta imagem' : 'Imagens selecionadas', ids }];
  const groupIds = new Set(ids.map(id => byId.get(id)).filter(Boolean).map(i => i.data.groupId).filter(Boolean));
  if (groupIds.size === 1) {
    const gid = [...groupIds][0];
    const all = items.filter(i => i.type === 'image' && !i.data.enhancedFrom && i.data.groupId === gid).map(i => i.id);
    if (all.length > ids.length) out.push({ label: `Todas do grupo «${(byId.get(gid)?.data.title) || 'grupo'}»`, ids: cap(all) });
  }
  const board = items.filter(i => i.type === 'image' && !i.data.enhancedFrom && !i.data.enhanced).map(i => i.id);
  if (board.length > ids.length && board.length !== (out[1] && out[1].ids.length)) out.push({ label: 'Todas do board ainda não aprimoradas', ids: cap(board) });
  return out;
}

export async function openEnhanceDialog(ids = []) {
  const [s, list] = await Promise.all([api.comfy('GET', '/enhance-settings'), api.comfy('GET', '/workflows')]);
  if (s.error) { toast(s.error); return; }
  const workflows = list.workflows || [];
  const wrap = document.createElement('div');
  wrap.className = 'enhance-dialog';
  const scopes = ids.length ? scopesFor(ids) : [];
  let chosenIds = ids;
  const intro = document.createElement('p');
  intro.className = 'panel-text muted small';
  intro.textContent = 'O aprimorador é um workflow de uma única imagem de entrada (por exemplo SeedVR2). Cada imagem escolhida passa por ele e o resultado aparece embaixo do grupo.';
  wrap.appendChild(intro);
  let applyLabel = () => {};
  if (scopes.length > 1) {
    const label = document.createElement('label'); label.textContent = 'Quais imagens';
    const pick = document.createElement('select');
    pick.setAttribute('aria-label', 'Quais imagens');
    scopes.forEach((sc, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = `${sc.label} (${sc.ids.length}${sc.ids.length >= MAX_BATCH ? ', no máx.' : ''})`;
      pick.appendChild(o);
    });
    pick.onchange = () => { chosenIds = scopes[Number(pick.value)].ids; applyLabel(); };
    wrap.append(label, pick);
  }

  const wfLabel = document.createElement('label'); wfLabel.textContent = 'Workflow aprimorador';
  const select = document.createElement('select');
  select.setAttribute('aria-label', 'Workflow aprimorador');
  const none = document.createElement('option'); none.value = ''; none.textContent = 'Escolha um workflow…';
  select.appendChild(none);
  for (const wf of workflows) {
    const o = document.createElement('option');
    o.value = wf.id;
    o.disabled = wf.imageInputs !== 1;
    o.textContent = wf.name + (wf.imageInputs === 1 ? '' : ` (${wf.imageInputs} entradas de imagem)`);
    select.appendChild(o);
  }
  select.value = s.workflowId || '';
  select.onchange = async () => {
    await api.comfy('PUT', '/enhance-settings', { workflowId: select.value || null, params: {} });
    openEnhanceDialog(ids);
  };
  wrap.append(wfLabel, select);

  const params = { ...s.params };
  const detail = s.detail;
  let testScale = s.testScale;
  if (detail) {
    const shown = (detail.exposed.length ? detail.exposed : detail.suggested).map(id => detail.fields.find(f => f.id === id)).filter(Boolean);
    const grid = document.createElement('div');
    grid.className = 'comfy-params';
    for (const f of shown) {
      const row = document.createElement('label');
      row.className = 'comfy-param';
      const name = document.createElement('span');
      name.textContent = `${f.title} · ${f.name}`;
      const value = params[f.id] !== undefined ? params[f.id] : f.value;
      const input = fieldControl(f, value, v => { params[f.id] = v; });
      input.setAttribute('aria-label', name.textContent);
      row.append(name, input);
      grid.appendChild(row);
    }
    if (!shown.length) grid.textContent = 'Nenhum campo escolhido. Use “Escolher campos…” para ajustar valores do workflow.';
    const fieldsBtn = document.createElement('button');
    fieldsBtn.type = 'button'; fieldsBtn.className = 'panel-btn small'; fieldsBtn.textContent = 'Escolher campos…';
    fieldsBtn.onclick = () => openFieldsPicker(detail, () => openEnhanceDialog(ids));
    const scaleLabel = document.createElement('label');
    scaleLabel.className = 'comfy-row comfy-size';
    const scaleText = document.createElement('span'); scaleText.textContent = 'Tamanho (teste)';
    const scale = document.createElement('select');
    scale.setAttribute('aria-label', 'Tamanho de teste');
    for (const [v, t] of [['1', 'Normal'], ['0.75', '75%'], ['0.5', '50%'], ['0.25', '25%']]) {
      const o = document.createElement('option'); o.value = v; o.textContent = t; scale.appendChild(o);
    }
    scale.value = String(testScale);
    scale.onchange = () => { testScale = Number(scale.value); };
    scale.title = 'Reduz os campos de tamanho do workflow para testar rápido; deixe em Normal na versão final.';
    scaleLabel.append(scaleText, scale);
    wrap.append(grid, scaleLabel, fieldsBtn);
  }

  const save = async () => {
    const r = await api.comfy('PUT', '/enhance-settings', { workflowId: select.value || null, params, testScale });
    if (r.error) { toast(r.error); return false; }
    return true;
  };
  const labelFor = () => (chosenIds.length ? `Aprimorar ${plural(chosenIds.length, 'imagem', 'imagens')}` : 'Salvar');
  openPanel({
    title: 'Aprimorar imagens', body: wrap, wide: true,
    actions: [
      { label: 'Cancelar', fn: closePanel },
      { label: labelFor(), primary: true, fn: async () => {
        if (!select.value) { toast('Escolha o workflow aprimorador'); return; }
        if (!await save()) return;
        closePanel();
        if (chosenIds.length) await start(chosenIds); else toast('Aprimorador configurado');
      } }
    ]
  });
  // the confirm button names how many images it will do
  applyLabel = () => {
    const primary = document.querySelector('.panel .panel-btn.primary, .panel button.primary');
    if (primary) primary.textContent = labelFor();
  };
}

export function initEnhance() {
  const button = document.getElementById('multiEnhance');
  if (button) button.onclick = () => enhanceImages(selectedImageIds());
}
