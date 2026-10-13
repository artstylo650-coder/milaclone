'use strict';

import { state } from '../core/state.js';
import { api } from '../core/api.js';
import { lucideEl, refreshIcons, toast } from '../core/util.js';
import { saveData, flushSaves } from '../board/editing.js';
import { openPanel, closePanel, confirmDialog } from '../ui/panel.js';

// The `comfy` card. Pick a workflow, then connect cards to it with lines:
// photos and groups go into the workflow's image slots (each slot can pick its
// source, or a blank image; a group makes one job per photo), notes become the
// prompt. Any value of the workflow can be put on the card (⚙ Campos) and the
// seed can be random, shared by the batch or fixed. The server (comfy.js) runs
// the jobs on local ComfyUI or RunPod and places the results under the source,
// each batch below the previous one. This module draws the card, the fields
// picker and the settings panel.

let workflows = null;          // cached list from /api/comfy/workflows
const details = new Map();     // workflowId -> slots and fields from /api/comfy/workflows/:id
const pollers = new Map();     // itemId -> timer
let onResults = () => {};      // set by main.js: reload the board view

export function setResultsHandler(fn) { onResults = fn; }
export function notifyResults() { onResults(); }

async function loadWorkflows(force = false) {
  if (!workflows || force) workflows = (await api.comfy('GET', '/workflows')).workflows || [];
  return workflows;
}

async function detailOf(workflowId) {
  if (!workflowId) return null;
  if (!details.has(workflowId)) {
    const d = await api.comfy('GET', '/workflows/' + workflowId);
    if (d.error) return null;
    details.set(workflowId, d);
  }
  return details.get(workflowId);
}

function field(tag, cls, attrs = {}) {
  const el = document.createElement(tag);
  el.className = cls;
  el.setAttribute('data-nodrag', '');
  Object.assign(el, attrs);
  return el;
}

function option(value, text) {
  const o = document.createElement('option');
  o.value = value; o.textContent = text;
  return o;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Progress bar: finished jobs count whole, running ones by their current step
// (ComfyUI local); without step data (RunPod) the running part is striped.
export function paintProgress(bar, s) {
  if (!bar) return;
  const active = s.queued + s.running;
  bar.hidden = !active;
  if (!active) return;
  bar.classList.toggle('indeterminate', !!s.indeterminate);
  bar.querySelector('i').style.width = Math.round((s.fraction || 0) * 100) + '%';
  const finished = (s.done || 0) + (s.failed || 0) + (s.cancelled || 0);
  bar.querySelector('span').textContent = `${finished}/${s.total}` + (s.step ? ` · passo ${s.step.value}/${s.step.max}` : s.queued && !s.running ? ' · na fila' : '');
}

export function progressBar() {
  const bar = document.createElement('div');
  bar.className = 'comfy-progress';
  bar.hidden = true;
  bar.setAttribute('role', 'progressbar');
  const track = document.createElement('div');
  track.className = 'comfy-progress-track';
  track.appendChild(document.createElement('i'));
  const label = document.createElement('span');
  bar.append(track, label);
  return bar;
}

const RING = 2 * Math.PI * 40;

// The card while jobs run: a ring over the image with finished/total and the
// current step, a Stop button, the status line and the recover button.
function paintStatus(el, s) {
  const line = el.querySelector('.comfy-status');
  const send = el.querySelector('.comfy-send');
  const gen = el.querySelector('.comfy-gen');
  const recover = el.querySelector('.comfy-recover');
  if (recover) recover.hidden = !s || !s.recoverable;
  if (!s) { el.classList.remove('generating'); if (gen) gen.hidden = true; if (send) send.disabled = false; return; }
  const active = s.queued + s.running;
  el.classList.toggle('generating', active > 0);
  if (send) send.disabled = active > 0;
  if (gen) {
    gen.hidden = !active;
    const finished = (s.done || 0) + (s.failed || 0) + (s.cancelled || 0);
    const fg = gen.querySelector('.comfy-ring-fg');
    if (fg) { fg.style.strokeDasharray = String(RING); fg.style.strokeDashoffset = String(RING * (1 - Math.max(0.04, s.fraction || 0))); }
    gen.querySelector('.comfy-gen-count').textContent = `${finished}/${s.total}`;
    gen.querySelector('.comfy-gen-step').textContent = s.step ? `passo ${s.step.value}/${s.step.max}` : s.queued && !s.running ? 'na fila' : '';
    gen.querySelector('.comfy-progress').classList.toggle('indeterminate', !!s.indeterminate);
  }
  if (!line) return;
  if (!s.total) { line.textContent = ''; line.className = 'comfy-status'; return; }
  const parts = [];
  if (active) parts.push(`${active} gerando`);
  if (s.done) parts.push(`${s.done} pronta${s.done > 1 ? 's' : ''}`);
  if (s.failed) parts.push(`${s.failed} com erro`);
  if (s.cancelled) parts.push(`${s.cancelled} cancelada${s.cancelled > 1 ? 's' : ''}`);
  line.textContent = parts.join(' · ') + (s.failed && s.errors[0] ? ' — ' + s.errors[0] : '');
  line.className = 'comfy-status' + (active ? ' busy' : s.failed ? ' error' : ' ok');
  line.title = s.errors.join('\n');
}

function poll(it) {
  if (pollers.has(it.id)) return;
  let lastDone = -1;
  const tick = async () => {
    const s = await api.comfy('GET', '/status/' + it.id).catch(() => null);
    const el = document.querySelector(`.item[data-id="${CSS.escape(it.id)}"]`);
    if (s && el) paintStatus(el, s);
    if (s && lastDone >= 0 && s.done !== lastDone) onResults();
    if (s) lastDone = s.done;
    if (!s || !el || !(s.queued + s.running)) { pollers.delete(it.id); return; }
    pollers.set(it.id, setTimeout(tick, 900));
  };
  pollers.set(it.id, setTimeout(tick, 0));
}

const EMPTY_VIEW = { sets: 0, slots: [], sources: [], notes: [], error: null, prompt: '' };

const QUALITY = [
  { v: 0.25, name: 'Rascunho', sub: '25% · rápido' },
  { v: 0.5, name: 'Prévia', sub: '50%' },
  { v: 0.75, name: 'Quase', sub: '75%' },
  { v: 1, name: 'Final', sub: '100% · tamanho completo' }
];

let providerName = null;   // 'ComfyUI local' or 'RunPod', read once
async function providerLabel() {
  if (!providerName) { const st = await api.comfy('GET', '/settings'); providerName = st.provider === 'runpod' ? 'RunPod' : 'ComfyUI local'; }
  return providerName;
}
export function forgetProvider() { providerName = null; }

// The `comfy` card is its image: the newest result, large. Select it and a bar
// floats underneath with the prompt, quick choices (ratio, quality, images per
// photo, seed) and the round Generate button; everything else lives behind
// "Mais ajustes". While jobs run a ring with the count covers the image.
export function buildComfy(el, it) {
  el.classList.add('comfy');
  const body = document.createElement('div');
  body.className = 'comfy-body';
  el.appendChild(body);
  let cur = { list: [], detail: null, view: EMPTY_VIEW };

  let signature = '';
  let painting = false;

  // Everything under the header is drawn from the workflow's detail and the
  // server's plan (what each slot receives, how many jobs, which notes feed
  // the prompt), so the card always shows what Gerar would do.
  async function paint() {
    if (painting) return;
    painting = true;
    try {
      await flushSaves();
      const [list, detail] = await Promise.all([loadWorkflows().catch(() => []), detailOf(it.data.workflowId)]);
      let view = EMPTY_VIEW;
      if (it.data.workflowId) {
        const planned = await api.comfy('GET', '/plan/' + it.id);
        if (!planned.error || planned.slots) view = planned;
        else view = { ...EMPTY_VIEW, error: planned.error };
      }
      signature = JSON.stringify(view);
      draw(list, detail, view);
    } finally { painting = false; }
  }

  // Open/closed state of a section is view state, not board data: kept in the
  // browser so it does not touch the document or the undo history.
  const uiKey = (name) => `milaclone.comfy.${it.id}.${name}`;
  const isOpen = (name, fallback = false) => { try { const v = localStorage.getItem(uiKey(name)); return v === null ? fallback : v === '1'; } catch (_) { return fallback; } };
  const setOpen = (name, on) => { try { localStorage.setItem(uiKey(name), on ? '1' : '0'); } catch (_) { /* private mode */ } };

  // ---- the bar's chips read their text from the card's data -------------------
  const chipUpdaters = [];
  const updateChips = () => chipUpdaters.forEach(f => f());

  const seedNow = () => ({ fixed: it.data.seedMode === 'fixed', batch: !!it.data.seedBatch || it.data.seedMode === 'batch' });
  const writeSeed = (fixed, batch) => { saveData(it, { seedMode: fixed ? 'fixed' : batch ? 'batch' : 'random', seedBatch: batch }); updateChips(); };
  const runsNow = () => Math.max(1, Math.min(16, Math.round(Number(it.data.runs) || 1)));
  const scaleNow = () => Number(it.data.testScale) || 1;
  const qualityNow = () => QUALITY.find(q => Math.abs(q.v - scaleNow()) < 0.001) || QUALITY[3];
  const dice = () => Math.floor(Math.random() * 2 ** 32);

  function checkbox(label, checked, onChange, { hint = '', aria = label } = {}) {
    const row = document.createElement('label');
    row.className = 'comfy-check';
    const input = field('input', '', { type: 'checkbox', checked });
    input.setAttribute('aria-label', aria);
    input.onchange = () => onChange(input.checked);
    const text = document.createElement('span');
    text.textContent = label;
    row.append(input, text);
    if (hint) { const h = document.createElement('small'); h.textContent = hint; row.appendChild(h); }
    return { row, input };
  }

  // ---- what the card shows ------------------------------------------------------
  // newest result of this card on the board: the last image of its last result frame
  function batchImages() {
    const frames = state.view.items.filter(g => g.type === 'group' && g.data.comfyNode === it.id);
    const last = frames[frames.length - 1];
    return last ? state.view.items.filter(i => i.type === 'image' && i.data.groupId === last.id && !i.data.enhancedFrom) : [];
  }
  const latestImage = () => batchImages().at(-1) || null;

  // which control sets the image proportions: an exposed width+height pair, else an exposed aspect-ratio list
  function ratioSpec(detail) {
    if (!detail) return null;
    const shown = detail.exposed.map(id => detail.fields.find(f => f.id === id)).filter(Boolean);
    for (const f of shown) {
      if (f.name === 'width' && f.kind === 'number') {
        const h = shown.find(x => x.node === f.node && x.name === 'height' && x.kind === 'number');
        if (h) return { kind: 'size', wf: f, hf: h };
      }
    }
    const asp = shown.find(f => f.options && ratioOptions(f));
    return asp ? { kind: 'aspect', f: asp } : null;
  }
  const near = (w, h) => RATIOS.find(([a, b]) => h > 0 && Math.abs(w / h - a / b) < 0.02);
  function ratioText(spec) {
    if (spec.kind === 'aspect') { const c = ratioOptions(spec.f).find(o => o.value === String(valueOf(spec.f))); return c ? c.text : String(valueOf(spec.f)); }
    const w = Number(valueOf(spec.wf)) || 0, h = Number(valueOf(spec.hf)) || 0, n = near(w, h);
    return n ? `${n[0]}:${n[1]}` : `${w}×${h}`;
  }
  function ratioShape(spec, max) {
    if (spec.kind === 'aspect') { const c = ratioOptions(spec.f).find(o => o.value === String(valueOf(spec.f))); return shapeOf(c ? c.w : 1, c ? c.h : 1, max); }
    return shapeOf(Number(valueOf(spec.wf)) || 1, Number(valueOf(spec.hf)) || 1, max);
  }

  // ---- popovers under the bar ---------------------------------------------------
  let pop = null;
  function closePop() {
    if (!pop) return;
    pop.el.remove();
    document.removeEventListener('pointerdown', pop.off, true);
    document.removeEventListener('keydown', pop.key, true);
    pop = null;
  }
  function openPop(anchor, build) {
    const same = pop && pop.anchor === anchor;
    closePop();
    if (same) return;
    const bar = anchor.closest('.comfy-bar');
    const box = document.createElement('div');
    box.className = 'comfy-pop';
    box.setAttribute('data-nodrag', '');
    build(box);
    bar.appendChild(box);
    refreshIcons(box);
    const scale = bar.getBoundingClientRect().width / bar.offsetWidth || 1;
    const left = (anchor.getBoundingClientRect().left - bar.getBoundingClientRect().left) / scale;
    box.style.left = Math.max(0, Math.min(left, bar.offsetWidth - box.offsetWidth)) + 'px';
    const off = (e) => { if (!box.contains(e.target) && !anchor.contains(e.target)) closePop(); };
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePop(); } };
    document.addEventListener('pointerdown', off, true);
    document.addEventListener('keydown', key, true);
    pop = { el: box, anchor, off, key };
  }

  // a chip on the bar: icon or drawing, text, chevron; `paintChip` keeps it current
  function chipBtn(aria, title, paintChip, onOpen) {
    const btn = field('button', 'comfy-chip-btn', { type: 'button', title });
    btn.setAttribute('aria-label', aria);
    const lead = document.createElement('span'); lead.className = 'comfy-chip-lead';
    const text = document.createElement('span');
    btn.append(lead, text, lucideEl('chevron-down'));
    const paint = () => { const r = paintChip(); lead.replaceChildren(r.lead); text.textContent = r.text; btn.classList.toggle('warn', !!r.warn); btn.classList.toggle('accent', !!r.accent); refreshIcons(lead); };
    chipUpdaters.push(paint);
    paint();
    btn.onclick = (e) => { e.stopPropagation(); onOpen(btn); };
    return btn;
  }
  const icon = (name) => lucideEl(name);

  function ratioPop(box, spec) {
    box.classList.add('ratio');
    if (spec.kind === 'aspect') {
      const options = ratioOptions(spec.f);
      const grid = document.createElement('div');
      grid.className = 'comfy-ratio-grid';
      grid.setAttribute('role', 'radiogroup');
      grid.setAttribute('aria-label', `${spec.f.title} · ${spec.f.name}`);
      const buttons = options.map(o => {
        const btn = field('button', 'comfy-ratio tile', { type: 'button', title: o.value });
        btn.setAttribute('role', 'radio');
        btn.setAttribute('aria-label', o.value);
        btn.append(shapeOf(o.w, o.h, 24), Object.assign(document.createElement('span'), { textContent: o.text }));
        btn.onclick = (e) => { e.stopPropagation(); setParam(spec.f, o.value); sync(); };
        grid.appendChild(btn);
        return { btn, o };
      });
      const sync = () => { for (const { btn, o } of buttons) btn.setAttribute('aria-checked', String(String(valueOf(spec.f)) === o.value)); };
      sync();
      box.appendChild(grid);
      return;
    }
    const { wf, hf } = { wf: spec.wf, hf: spec.hf };
    const W = () => Number(valueOf(wf)) || 0, H = () => Number(valueOf(hf)) || 0;
    const snap = (n) => Math.max(16, Math.round(n / 16) * 16);
    const apply = (w, h) => { setParam(wf, snap(w)); setParam(hf, snap(h)); sync(); };
    const grid = document.createElement('div');
    grid.className = 'comfy-ratio-grid';
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', 'Proporção');
    const ratioBtns = RATIOS.map(([a, b]) => {
      const btn = field('button', 'comfy-ratio tile', { type: 'button', title: `Proporção ${a}:${b} (mantém a área)` });
      btn.setAttribute('aria-label', `Proporção ${a}:${b}`);
      btn.append(shapeOf(a, b, 24), Object.assign(document.createElement('span'), { textContent: `${a}:${b}` }));
      btn.onclick = (e) => { e.stopPropagation(); const w = Math.sqrt(((W() * H()) || 1048576) * a / b); apply(w, w * b / a); };
      grid.appendChild(btn);
      return { btn, a, b };
    });
    const sizes = document.createElement('div');
    sizes.className = 'comfy-sizes';
    sizes.setAttribute('role', 'group');
    sizes.setAttribute('aria-label', 'Tamanho base');
    const sizeBtns = [[0.5, '0,5 MP'], [1, '1 MP'], [1.5, '1,5 MP'], [2, '2 MP']].map(([mp, name]) => {
      const btn = field('button', 'comfy-size', { type: 'button', textContent: name, title: `Cerca de ${name}, na mesma proporção` });
      btn.setAttribute('aria-label', 'Tamanho ' + name);
      btn.onclick = (e) => { e.stopPropagation(); const r = (W() / H()) || 1; const w = Math.sqrt(mp * 1e6 * r); apply(w, w / r); };
      sizes.appendChild(btn);
      return { btn, mp };
    });
    const dims = document.createElement('div');
    dims.className = 'comfy-dim-row';
    const num = (f, label) => { const input = fieldControl({ ...f, options: null }, valueOf(f), v => { setParam(f, Math.max(16, Math.round(v))); sync(); }); input.setAttribute('aria-label', label); input.min = 16; input.step = 16; return input; };
    const wIn = num(wf, 'Largura'), hIn = num(hf, 'Altura');
    const swap = field('button', 'comfy-dim-swap', { type: 'button', title: 'Girar: trocar largura e altura' });
    swap.setAttribute('aria-label', 'Girar imagem');
    swap.appendChild(lucideEl('rotate-cw'));
    swap.onclick = (e) => { e.stopPropagation(); apply(H(), W()); };
    const info = document.createElement('small');
    info.className = 'comfy-dim-info';
    dims.append(wIn, Object.assign(document.createElement('span'), { textContent: '×' }), hIn, swap);
    function sync() {
      const w = W(), h = H(), mp = w * h / 1e6;
      wIn.value = w; hIn.value = h;
      info.textContent = `${w} × ${h} · ${mp.toFixed(2).replace('.', ',')} MP`;
      for (const { btn, a, b } of ratioBtns) btn.setAttribute('aria-pressed', String(h > 0 && Math.abs(w / h - a / b) < 0.02));
      for (const { btn, mp: m } of sizeBtns) btn.setAttribute('aria-pressed', String(Math.abs(mp - m) < 0.08 * m));
    }
    sync();
    box.append(grid, sizes, dims, info);
  }

  // the one number an upscaler needs: the short side in pixels, or the factor
  function upscalePrimary(detail) {
    if (!detail) return null;
    const find = (re) => detail.fields.find(f => f.kind === 'number' && re.test(f.name));
    const f = find(/^resolution$/i) || find(/^(scale_by|upscale_by|scale_factor|scale)$/i) || find(/^(target_size|short_side|megapixels)$/i);
    return f ? { f, factor: /scale/i.test(f.name) } : null;
  }

  function resolutionPop(box, up) {
    box.classList.add('res');
    const values = up.factor ? [1.5, 2, 3, 4] : [1080, 1440, 2048, 3072, 4096];
    const grid = document.createElement('div');
    grid.className = 'comfy-res-grid';
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', 'Resolução');
    const buttons = values.map(v => {
      const btn = field('button', 'comfy-size', { type: 'button', title: up.factor ? `Aumentar ${v}×` : `${v} px no lado menor` });
      btn.setAttribute('aria-label', up.factor ? `Escala ${v}` : `Resolução ${v}`);
      btn.append(Object.assign(document.createElement('b'), { textContent: up.factor ? `×${v}` : String(v) }), Object.assign(document.createElement('small'), { textContent: up.factor ? '' : 'px' }));
      btn.onclick = (e) => { e.stopPropagation(); setParam(up.f, v); input.value = v; sync(); updateChips(); };
      grid.appendChild(btn);
      return { btn, v };
    });
    const input = fieldControl({ ...up.f, options: null }, valueOf(up.f), v => { setParam(up.f, v); sync(); updateChips(); });
    input.setAttribute('aria-label', up.factor ? 'Escala' : 'Resolução em pixels');
    const hint = document.createElement('small');
    hint.className = 'comfy-pop-hint';
    hint.textContent = up.factor ? 'Quantas vezes a imagem cresce.' : 'Tamanho do lado menor da imagem final. Valores altos pedem muita memória da placa.';
    const sync = () => { for (const { btn, v } of buttons) btn.setAttribute('aria-pressed', String(Number(valueOf(up.f)) === v)); };
    sync();
    box.append(grid, input, hint);
  }

  function qualityPop(box) {
    box.classList.add('quality');
    const group = document.createElement('div');
    group.className = 'comfy-quality';
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'Tamanho de teste');
    const buttons = QUALITY.map(q => {
      const btn = field('button', 'comfy-q', { type: 'button' });
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-label', `${q.name} ${Math.round(q.v * 100)}%`);
      btn.append(Object.assign(document.createElement('b'), { textContent: q.name }), Object.assign(document.createElement('small'), { textContent: q.sub }));
      btn.onclick = (e) => { e.stopPropagation(); saveData(it, { testScale: q.v }); updateChips(); sync(); };
      group.appendChild(btn);
      return { btn, q };
    });
    const sync = () => { for (const { btn, q } of buttons) btn.setAttribute('aria-checked', String(Math.abs(q.v - scaleNow()) < 0.001)); };
    sync();
    const hint = document.createElement('small');
    hint.className = 'comfy-pop-hint';
    hint.textContent = 'Reduz o tamanho para testar rápido. Volte para Final na versão definitiva.';
    box.append(group, hint);
  }

  function runsPop(box) {
    box.classList.add('runs');
    const row = document.createElement('div');
    row.className = 'comfy-stepper';
    const input = field('input', 'comfy-runs', { type: 'number', min: 1, max: 16, value: runsNow() });
    input.setAttribute('aria-label', 'Variações');
    const set = (n) => { const v = Math.max(1, Math.min(16, Math.round(Number(n) || 1))); input.value = v; saveData(it, { runs: v }); updateChips(); };
    const minus = field('button', '', { type: 'button', textContent: '−', title: 'Menos variações' });
    minus.setAttribute('aria-label', 'Diminuir quantidade');
    const plus = field('button', '', { type: 'button', textContent: '+', title: 'Mais variações' });
    plus.setAttribute('aria-label', 'Aumentar quantidade');
    minus.onclick = (e) => { e.stopPropagation(); set(Number(input.value) - 1); };
    plus.onclick = (e) => { e.stopPropagation(); set(Number(input.value) + 1); };
    input.addEventListener('change', () => set(input.value));
    row.append(minus, input, plus);
    const label = document.createElement('div');
    label.className = 'comfy-pop-text';
    label.innerHTML = '<b>imagens por foto</b><small>mais variações para escolher a melhor</small>';
    box.append(row, label);
  }

  function seedPop(box, detail) {
    box.classList.add('seed');
    const input = field('input', 'comfy-seed', { type: 'number', value: it.data.seed ?? '', placeholder: 'aleatória', disabled: !seedNow().fixed });
    input.setAttribute('aria-label', 'Valor da seed');
    const roll = field('button', 'comfy-dice', { type: 'button', title: 'Sortear outra seed', disabled: !seedNow().fixed });
    roll.setAttribute('aria-label', 'Sortear seed');
    roll.appendChild(lucideEl('dices'));
    let batch = null;
    const fixed = checkbox('Repetir o mesmo resultado', seedNow().fixed, (on) => {
      input.disabled = roll.disabled = !on;
      if (batch) batch.input.disabled = on;
      if (on && it.data.seed == null) { const n = dice(); input.value = n; saveData(it, { seed: n }); }
      writeSeed(on, seedNow().batch);
    }, { aria: 'Fixar seed', hint: 'seed fixa: mesmo workflow, mesma imagem' });
    batch = checkbox('Fotos do grupo combinam entre si', seedNow().batch, (on) => writeSeed(seedNow().fixed, on), { aria: 'Mesma seed no lote', hint: 'a mesma seed em todas as fotos do lote' });
    batch.input.disabled = seedNow().fixed;
    input.addEventListener('change', () => { saveData(it, { seed: input.value === '' ? null : Math.trunc(Number(input.value)) }); updateChips(); });
    roll.onclick = (e) => { e.stopPropagation(); const n = dice(); input.value = n; saveData(it, { seed: n }); updateChips(); };
    const line = document.createElement('div');
    line.className = 'comfy-seedline';
    line.append(input, roll);
    box.append(fixed.row, line, batch.row);
  }

  // ---- everything else: workflow, inputs, negative prompt, workflow fields -------
  function buildAdjust(wrap) {
    const { list, detail, view } = cur;
    wrap.replaceChildren();
    const head = (t) => Object.assign(document.createElement('label'), { textContent: t });

    wrap.appendChild(head('Workflow'));
    const wfRow = document.createElement('div');
    wfRow.className = 'comfy-wfrow';
    const select = field('select', 'comfy-workflow');
    select.setAttribute('aria-label', 'Workflow');
    select.appendChild(option('', list.length ? 'Escolha um workflow…' : 'Importe um workflow nas configurações'));
    for (const wf of list) select.appendChild(option(wf.id, wf.name + (wf.imageInputs ? ` · ${plural(wf.imageInputs, 'foto', 'fotos')} de entrada` : '')));
    select.value = it.data.workflowId || '';
    select.onchange = async () => { saveData(it, { workflowId: select.value || null, slots: {}, params: {} }); await paint(); buildAdjust(wrap); };
    const fieldsBtn = field('button', 'comfy-fields-btn', { type: 'button', title: 'Escolher quais campos do workflow aparecem aqui', disabled: !detail });
    fieldsBtn.setAttribute('aria-label', 'Escolher campos');
    fieldsBtn.appendChild(lucideEl('sliders-horizontal'));
    fieldsBtn.onclick = (e) => { e.stopPropagation(); if (detail) openFieldsPicker(detail, () => { paint().then(() => buildAdjust(wrap)); }); };
    wfRow.append(select, fieldsBtn);
    wrap.appendChild(wfRow);

    if (detail && detail.inputs.length) {
      wrap.appendChild(head('Entradas de imagem'));
      for (const slot of view.slots.length ? view.slots : detail.inputs.map(i => ({ ...i, kind: 'none', choice: '', count: 0 }))) {
        wrap.appendChild(slotRow(slot, view, () => buildAdjust(wrap)));
      }
    }

    if (!detail || detail.kind !== 'upscale') {
      wrap.appendChild(head('Prompt negativo'));
      const negative = field('textarea', 'comfy-negative', { rows: 2, placeholder: 'O que evitar (opcional)', value: it.data.negative || '' });
      negative.setAttribute('aria-label', 'Prompt negativo');
      negative.addEventListener('input', () => saveData(it, { negative: negative.value }));
      wrap.appendChild(negative);
    }
    if (!detail || detail.hasSeed) {
      wrap.appendChild(head('Seed'));
      const seedBox = document.createElement('div');
      seedBox.className = 'comfy-seedbox';
      seedPop(seedBox, detail);
      seedBox.classList.remove('seed');
      wrap.appendChild(seedBox);
    }

    if (detail) {
      const shown = detail.exposed.map(id => detail.fields.find(f => f.id === id)).filter(Boolean);
      if (shown.length) {
        wrap.appendChild(head('Ajustes do workflow'));
        const grid = document.createElement('div');
        grid.className = 'comfy-params';
        const done = new Set();
        for (const f of shown) {
          if (done.has(f.id)) continue;
          const mate = (f.name === 'width' || f.name === 'height') && f.kind === 'number'
            ? shown.find(x => x.node === f.node && x.kind === 'number' && x.name === (f.name === 'width' ? 'height' : 'width')) : null;
          if (mate) {
            done.add(f.id); done.add(mate.id);
            grid.appendChild(sizeRow(f.name === 'width' ? f : mate, f.name === 'width' ? mate : f));
          } else if (f.options && ratioOptions(f)) {
            done.add(f.id);
            grid.appendChild(aspectRow(f));
          } else grid.appendChild(paramRow(f));
        }
        wrap.appendChild(grid);
      } else if (detail) {
        const tip = document.createElement('p');
        tip.className = 'panel-text muted small';
        tip.textContent = 'Use o botão de sliders ao lado do workflow para escolher campos como steps, tamanho ou força do LoRA.';
        wrap.appendChild(tip);
      }
    }
    refreshIcons(wrap);
  }

  function openAdjust() {
    closePop();
    const wrap = document.createElement('div');
    wrap.className = 'comfy-adjust';
    buildAdjust(wrap);
    openPanel({ title: 'Ajustes · ' + (it.data.title || 'ComfyUI'), body: wrap, wide: true,
      actions: [{ label: 'Concluir', primary: true, fn: closePanel }] });
  }

  // ---- drawing the card ---------------------------------------------------------
  function draw(list, detail, view) {
    closePop();
    cur = { list, detail, view };
    body.replaceChildren();
    chipUpdaters.length = 0;
    const last = latestImage();
    // what the workflow does shapes the card: text to image, edit a photo (with a
    // prompt) or upscale (no prompt: the resolution is the choice)
    const kind = (detail && detail.kind) || 'generate';
    const isUpscale = kind === 'upscale';
    const KIND = { generate: ['sparkles', 'Gerar'], edit: ['pencil-line', 'Edição'], upscale: ['zoom-in', 'Upscale'] };
    const originalOf = last && last.data.comfyFrom && state.view.items.find(x => x.id === last.data.comfyFrom && x.type === 'image');
    const originalSrc = originalOf ? '/api/thumb/' + encodeURIComponent(originalOf.id) : (view.slots.find(x => x.thumb) || {}).thumb || null;

    // title row: name, shortcuts
    const top = document.createElement('div');
    top.className = 'comfy-top';
    const name = field('input', 'comfy-name', { type: 'text', value: it.data.title || 'ComfyUI', placeholder: 'Nome do card' });
    name.setAttribute('aria-label', 'Nome do card');
    name.addEventListener('input', () => saveData(it, { title: name.value }));
    const actions = document.createElement('span');
    actions.className = 'comfy-top-actions';
    const iconBtn = (iconName, aria, fn) => {
      const b = field('button', 'comfy-icon-btn', { type: 'button', title: aria });
      b.setAttribute('aria-label', aria);
      b.appendChild(lucideEl(iconName));
      b.onclick = (e) => { e.stopPropagation(); fn(b); };
      return b;
    };
    actions.append(
      iconBtn('wand-sparkles', 'Aprimorar resultados', async () => {
        const ids = batchImages().map(i => i.id);
        if (!ids.length) { toast('Gere imagens primeiro'); return; }
        (await import('./enhance.js')).openEnhanceDialog(ids);
      }),
      iconBtn('download', 'Baixar imagem', () => {
        const img = latestImage();
        if (!img) { toast('Ainda não há imagem para baixar'); return; }
        const a = document.createElement('a');
        a.href = img.data.src; a.download = img.data.name || 'imagem.png';
        document.body.appendChild(a); a.click(); a.remove();
      }),
      iconBtn('ellipsis', 'Mais', async (btn) => {
        const { showMenu } = await import('../ui/menus.js');
        const r = btn.getBoundingClientRect();
        showMenu([
          { label: 'Ajustes e entradas…', fn: openAdjust },
          { label: 'Escolher campos do workflow…', fn: () => { if (cur.detail) openFieldsPicker(cur.detail, () => { paint(); }); else toast('Escolha um workflow primeiro'); } },
          { label: 'Recuperar imagens que não chegaram', fn: recoverNow },
          { sep: true },
          { label: 'Configurações do ComfyUI…', fn: () => openComfySettings() }
        ], r.left, r.bottom + 4);
      })
    );
    if (isUpscale) actions.firstChild.remove();   // the card already is the enhancer
    let compare = null;
    if (kind !== 'generate' && last && originalSrc) {
      compare = field('button', 'comfy-icon-btn comfy-compare', { type: 'button', title: 'Segure para ver a original' });
      compare.setAttribute('aria-label', 'Comparar com a original');
      compare.appendChild(lucideEl('columns-2'));
      actions.prepend(compare);
    }
    const tag = document.createElement('span');
    tag.className = 'comfy-kind';
    tag.dataset.kind = kind;
    tag.textContent = KIND[kind][1];
    tag.hidden = !detail;
    top.append(lucideEl(KIND[kind][0]), name, tag, actions);

    // the image
    const frame = document.createElement('div');
    frame.className = 'comfy-frame';
    const spec = ratioSpec(detail);
    // the frame takes the proportions chosen on the Proporção chip (and follows
    // it as it changes); without one, those of the newest result
    const frameRatio = () => {
      let r = 4 / 5;
      if (spec && !isUpscale) {
        if (spec.kind === 'size') r = (Number(valueOf(spec.wf)) || 4) / (Number(valueOf(spec.hf)) || 5);
        else { const c = ratioOptions(spec.f).find(o => o.value === String(valueOf(spec.f))); if (c) r = c.w / c.h; }
      } else if (last && last.data.naturalW && last.data.naturalH) r = last.data.naturalW / last.data.naturalH;
      return Math.max(0.4, Math.min(2.5, r));
    };
    frame.style.aspectRatio = String(frameRatio());
    chipUpdaters.push(() => { frame.style.aspectRatio = String(frameRatio()); });
    if (last) {
      const img = document.createElement('img');
      img.src = '/api/thumb/' + encodeURIComponent(last.id);
      img.alt = last.data.name || 'Resultado';
      img.draggable = false;
      img.addEventListener('error', () => { if (!img.dataset.fallback) { img.dataset.fallback = '1'; img.src = last.data.src; } });
      frame.appendChild(img);
      frame.addEventListener('dblclick', async () => (await import('../ui/lightbox.js')).openLightbox(last.id));
    } else if (kind !== 'generate' && originalSrc) {
      // nothing generated yet: the photo that will be worked on, faded
      const img = document.createElement('img');
      img.src = originalSrc; img.alt = 'Foto original'; img.draggable = false; img.className = 'comfy-faded';
      frame.appendChild(img);
      const wait = document.createElement('div');
      wait.className = 'comfy-empty over';
      wait.append(lucideEl(isUpscale ? 'zoom-in' : 'wand-sparkles'), Object.assign(document.createElement('span'), { textContent: isUpscale ? 'Aprimorar começa pela original' : 'O resultado aparece aqui' }));
      frame.appendChild(wait);
    } else {
      const empty = document.createElement('div');
      empty.className = 'comfy-empty';
      empty.append(lucideEl(kind === 'generate' ? 'image-plus' : 'link'), Object.assign(document.createElement('span'), { textContent: kind === 'generate' ? 'O resultado aparece aqui' : 'Ligue uma foto ou um grupo com uma seta' }));
      frame.appendChild(empty);
    }
    // holding the compare button shows the original over the result
    let original = null;
    if (compare) {
      original = document.createElement('div');
      original.className = 'comfy-original';
      original.hidden = true;
      const oi = document.createElement('img');
      oi.src = originalSrc; oi.alt = 'Original'; oi.draggable = false;
      original.append(oi, Object.assign(document.createElement('span'), { textContent: 'Original' }));
      const show = (on) => { original.hidden = !on; };
      compare.addEventListener('pointerdown', (e) => { e.stopPropagation(); show(true); });
      for (const ev of ['pointerup', 'pointerleave', 'pointercancel', 'blur']) compare.addEventListener(ev, () => show(false));
      compare.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); show(true); } });
      compare.addEventListener('keyup', () => show(false));
    }
    const count = document.createElement('div');
    count.className = 'comfy-count';
    const countText = () => {
      const n = (view.sets || 0) * (isUpscale ? 1 : runsNow());
      const size = last && last.data.naturalW ? ` · saída ${last.data.naturalW} × ${last.data.naturalH}` : '';
      return view.sets ? `${plural(view.sets, 'foto', 'fotos')} → ${plural(n, 'imagem', 'imagens')}${size}` : 'ligue uma foto com uma seta';
    };
    count.textContent = countText();
    count.hidden = !it.data.workflowId;
    chipUpdaters.push(() => { count.textContent = countText(); });
    const gen = document.createElement('div');
    gen.className = 'comfy-gen';
    gen.hidden = true;
    const ring = document.createElement('div');
    ring.className = 'comfy-progress';
    ring.setAttribute('role', 'progressbar');
    ring.innerHTML = '<svg width="96" height="96" viewBox="0 0 96 96" aria-hidden="true"><circle cx="48" cy="48" r="40" class="comfy-ring-bg"/><circle cx="48" cy="48" r="40" class="comfy-ring-fg" transform="rotate(-90 48 48)"/></svg><b class="comfy-gen-count"></b>';
    const step = document.createElement('div');
    step.className = 'comfy-gen-step';
    const stop = field('button', 'comfy-cancel', { type: 'button', title: 'Cancelar as tarefas em andamento' });
    stop.setAttribute('aria-label', 'Cancelar');
    stop.append(lucideEl('square'), document.createTextNode(' Parar'));
    gen.append(ring, step, stop);
    frame.append(...(original ? [original] : []), count, gen);

    // the bar under the image: prompt, quick choices, generate
    const bar = document.createElement('div');
    bar.className = 'comfy-bar';
    bar.setAttribute('data-nodrag', '');
    // what goes in: the photos wired to the card, summed up in one line
    if (kind !== 'generate') {
      const slots = view.slots;
      const text = (sl, titled) => (titled ? sl.title + ': ' : '') + (sl.kind === 'none' ? 'ligue uma foto' : sl.kind === 'blank' ? 'em branco'
        : sl.kind === 'set' ? `${sl.label} · ${plural(sl.count, 'foto', 'fotos')}` : sl.label);
      const inputs = field('button', 'comfy-inputs-chip', { type: 'button', title: 'Escolher de onde vem cada foto' });
      inputs.setAttribute('aria-label', 'Entradas de imagem');
      const thumbs = document.createElement('span');
      thumbs.className = 'comfy-inputs-thumbs';
      for (const sl of slots.filter(x => x.thumb).slice(0, 3)) { const t = document.createElement('img'); t.src = sl.thumb; t.alt = ''; t.draggable = false; thumbs.appendChild(t); }
      const label = document.createElement('span');
      label.textContent = slots.length ? slots.map(sl => text(sl, slots.length > 1)).join('  +  ') : 'sem entradas de imagem';
      inputs.classList.toggle('warn', slots.some(sl => sl.kind === 'none'));
      inputs.append(thumbs, label, lucideEl('chevron-right'));
      inputs.onclick = (e) => { e.stopPropagation(); openAdjust(); };
      bar.appendChild(inputs);
    }
    if (view.notes.length && !isUpscale) {
      const chip = document.createElement('div');
      chip.className = 'comfy-note';
      const langs = [...new Set(view.notes.map(n => n.lang && n.lang.toUpperCase()).filter(Boolean))].join('/');
      chip.textContent = `Prompt da nota${view.notes.length > 1 ? 's' : ''} ligada${view.notes.length > 1 ? 's' : ''}` + (langs ? ` (${langs})` : '');
      chip.title = view.prompt;
      bar.appendChild(chip);
    }
    const prompt = field('textarea', 'comfy-prompt', { rows: 2, value: it.data.prompt || '',
      placeholder: view.notes.length ? 'Texto extra, depois do prompt da nota' : kind === 'edit' ? 'O que mudar na foto?' : 'Descreva o que a imagem deve mostrar…' });
    prompt.setAttribute('aria-label', 'Prompt');
    const fit = () => { prompt.style.height = 'auto'; prompt.style.height = Math.min(prompt.scrollHeight, 132) + 'px'; };
    prompt.addEventListener('input', () => { saveData(it, { prompt: prompt.value }); fit(); });
    prompt.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send.click(); } });
    if (!isUpscale) bar.appendChild(prompt);   // an upscaler has no prompt

    const chips = document.createElement('div');
    chips.className = 'comfy-chips-row';
    const left = document.createElement('div');
    left.className = 'comfy-chips-left';
    const up = isUpscale ? upscalePrimary(detail) : null;
    if (up) {
      left.appendChild(chipBtn('Resolução', up.factor ? 'Quanto aumentar' : 'Tamanho do lado menor da imagem final',
        () => ({ lead: icon('maximize-2'), text: up.factor ? `×${valueOf(up.f)}` : `${valueOf(up.f)} px`, accent: true }),
        (btn) => openPop(btn, (box) => resolutionPop(box, up))));
    }
    if (spec && !isUpscale) {
      left.appendChild(chipBtn('Proporção', 'Proporção da imagem',
        () => ({ lead: ratioShape(spec, 14), text: ratioText(spec), accent: true }),
        (btn) => openPop(btn, (box) => ratioPop(box, spec))));
    }
    if (detail && detail.scalable.length && !isUpscale) {
      left.appendChild(chipBtn('Qualidade', 'Velocidade ou qualidade: reduz o tamanho para testar rápido',
        () => ({ lead: icon('zap'), text: qualityNow().name, warn: scaleNow() < 1 }),
        (btn) => openPop(btn, qualityPop)));
    }
    if (!isUpscale) {
      left.appendChild(chipBtn('Imagens por foto', 'Quantas imagens gerar por foto',
        () => ({ lead: Object.assign(document.createElement('b'), { textContent: '×' }), text: String(runsNow()) }),
        (btn) => openPop(btn, runsPop)));
    }
    if ((!detail || detail.hasSeed) && !isUpscale) {
      left.appendChild(chipBtn('Seed', 'Repetir o mesmo resultado (seed)',
        () => ({ lead: icon(seedNow().fixed ? 'lock' : 'dices'), text: seedNow().fixed ? String(it.data.seed ?? '—') : seedNow().batch ? 'lote' : 'aleatória' }),
        (btn) => openPop(btn, (box) => seedPop(box, detail))));
    }
    const more = field('button', 'comfy-more', { type: 'button', title: 'Mais ajustes: workflow, entradas, prompt negativo e campos' });
    more.setAttribute('aria-label', 'Mais ajustes');
    more.appendChild(lucideEl('sliders-horizontal'));
    more.onclick = (e) => { e.stopPropagation(); openAdjust(); };
    left.appendChild(more);

    const send = field('button', 'comfy-send', { type: 'button' });
    send.appendChild(lucideEl(isUpscale ? 'zoom-in' : 'arrow-up'));
    const verb = isUpscale ? 'Aprimorar' : 'Gerar';
    const badge = document.createElement('span');
    badge.className = 'comfy-send-badge';
    send.appendChild(badge);
    const syncSend = () => {
      const n = Math.max(1, view.sets || 1) * (isUpscale ? 1 : runsNow());
      badge.textContent = String(n);
      badge.hidden = n < 2;
      send.setAttribute('aria-label', n > 1 ? `${verb} ${n}` : verb);
      send.title = n > 1 ? `${verb} ${n} imagens (Ctrl+Enter)` : `${verb} (Ctrl+Enter)`;
    };
    chipUpdaters.push(syncSend);
    syncSend();
    chips.append(left, send);
    bar.appendChild(chips);

    const foot = document.createElement('div');
    foot.className = 'comfy-foot';
    const status = document.createElement('div');
    status.className = 'comfy-status';
    status.setAttribute('role', 'status');
    const hint = document.createElement('div');
    hint.className = 'comfy-hint';
    const recover = field('button', 'comfy-recover', { type: 'button', hidden: true, textContent: 'Recuperar imagens que não chegaram' });
    recover.title = 'O ComfyUI pode ter terminado estas imagens depois de o Milaclone parar de esperar: busca de novo.';
    recover.onclick = (e) => { e.stopPropagation(); recoverNow(); };
    foot.append(status, recover, hint);
    bar.appendChild(foot);
    if (!it.data.workflowId) { hint.textContent = 'Escolha um workflow em Mais ajustes.'; hint.classList.add('warn'); }
    else if (view.error) { hint.textContent = view.error; hint.classList.add('warn'); }
    else providerLabel().then(p => { if (!hint.textContent) hint.textContent = p; });

    body.append(top, frame, bar);
    refreshIcons(body);
    requestAnimationFrame(fit);

    send.onclick = async (e) => {
      e.stopPropagation();
      closePop();
      send.disabled = true;
      await flushSaves();
      const result = await api.comfy('POST', '/run/' + it.id);
      if (result.error) { send.disabled = false; toast(result.error); paintStatus(el, null); return; }
      toast(`${result.jobs} ${result.jobs > 1 ? 'tarefas iniciadas' : 'tarefa iniciada'}`);
      paintStatus(el, { total: result.jobs, queued: result.jobs, running: 0, done: 0, failed: 0, cancelled: 0, fraction: 0, errors: [] });
      poll(it);
    };
    stop.onclick = async (e) => {
      e.stopPropagation();
      const r = await api.comfy('POST', '/cancel/' + it.id);
      if (r.error) { toast(r.error); return; }
      toast(r.cancelled ? plural(r.cancelled, 'tarefa cancelada', 'tarefas canceladas') : 'Nada em andamento');
      poll(it);
    };
    api.comfy('GET', '/status/' + it.id).then(s => { paintStatus(el, s); if (s && s.queued + s.running) poll(it); }).catch(() => {});
  }

  async function recoverNow() {
    const r = await api.comfy('POST', '/recover/' + it.id);
    toast(r.error || (r.recovering ? plural(r.recovering, 'imagem sendo buscada', 'imagens sendo buscadas') : 'Nada para recuperar'));
    poll(it);
  }

  // one image slot: thumbnail + what feeds it + a picker over the connected cards
  function slotRow(slot, view, after = () => {}) {
    const row = document.createElement('div');
    row.className = 'comfy-slot';
    const thumb = document.createElement('div');
    thumb.className = 'comfy-thumb' + (slot.kind === 'blank' ? ' blank' : slot.kind === 'none' ? ' empty' : '');
    if (slot.thumb) { const img = document.createElement('img'); img.src = slot.thumb; img.alt = ''; thumb.appendChild(img); }
    if (slot.kind === 'set') { const b = document.createElement('b'); b.textContent = '×' + slot.count; thumb.appendChild(b); }
    const main = document.createElement('div');
    main.className = 'comfy-slot-main';
    const name = document.createElement('span');
    name.className = 'comfy-slot-title';
    name.textContent = slot.title;
    const pick = field('select', 'comfy-slot-pick');
    pick.setAttribute('aria-label', 'Entrada: ' + slot.title);
    const current = slot.kind === 'none' ? 'nenhuma ligada' : slot.kind === 'set' ? `${slot.label} · ${plural(slot.count, 'foto', 'fotos')}` : slot.label;
    pick.appendChild(option('', 'Automática — ' + (slot.choice ? 'próxima ligada' : current)));
    for (const src of view.sources) {
      pick.appendChild(option(src.id, src.kind === 'set' ? `Grupo «${src.label}» · ${plural(src.count, 'foto', 'fotos')}` : `Foto · ${src.label}`));
    }
    pick.appendChild(option('blank', 'Em branco (sem imagem)'));
    pick.value = slot.choice || '';
    if (pick.value !== (slot.choice || '')) pick.value = '';
    pick.onchange = async () => {
      const slots = { ...(it.data.slots || {}) };
      if (pick.value) slots[slot.key] = pick.value; else delete slots[slot.key];
      saveData(it, { slots });
      await paint();
      after();
    };
    const sub = document.createElement('small');
    sub.textContent = slot.kind === 'set' ? 'uma tarefa por foto' : slot.kind === 'none' ? 'ligue uma foto ou grupo com uma seta' : '';
    main.append(name, pick, sub);
    row.append(thumb, main);
    return row;
  }

  const valueOf = (f) => { const v = (it.data.params || {})[f.id]; return v !== undefined ? v : f.value; };
  const setParam = (f, v) => { saveData(it, { params: { ...(it.data.params || {}), [f.id]: v } }); updateChips(); };

  // a rectangle drawn at the proportions w:h inside a max × max box
  function shapeOf(w, h, max) {
    const k = max / Math.max(w, h, 1);
    const el = document.createElement('i');
    el.className = 'comfy-shape';
    el.style.width = Math.max(3, Math.round(w * k)) + 'px';
    el.style.height = Math.max(3, Math.round(h * k)) + 'px';
    return el;
  }

  // combo options that start with a ratio ("2:3 (Portrait Photo)", "16:9"): [{ value, w, h, text }]
  function ratioOptions(f) {
    const parsed = f.options.map(o => {
      const m = String(o).match(/^\s*(\d+(?:\.\d+)?)\s*[:x×/]\s*(\d+(?:\.\d+)?)/);
      return m ? { value: String(o), w: Number(m[1]), h: Number(m[2]), text: m[1] + ':' + m[2] } : null;
    });
    return parsed.filter(Boolean).length >= 3 && parsed.every(Boolean) ? parsed : null;
  }

  // A picker folded into one row: its drawing and current value stay visible,
  // the controls open on demand (state kept per card, like the sections).
  function folded(name, titleEl, miniOf, textOf, content) {
    const box = document.createElement('div');
    box.className = 'comfy-dim';
    const head = field('button', 'comfy-dim-head', { type: 'button' });
    const mini = document.createElement('span');
    mini.className = 'comfy-dim-mini';
    mini.setAttribute('aria-hidden', 'true');
    const sum = document.createElement('span');
    sum.className = 'comfy-dim-sum';
    head.append(mini, titleEl, sum, lucideEl('chevron-right'));
    const body = document.createElement('div');
    body.className = 'comfy-dim-body';
    const show = (on) => { box.classList.toggle('open', on); head.setAttribute('aria-expanded', String(on)); body.hidden = !on; };
    head.onclick = (e) => { e.stopPropagation(); const on = !box.classList.contains('open'); setOpen(name, on); show(on); };
    body.append(...content);
    box.append(head, body);
    show(isOpen(name, false));
    return { box, refresh: () => { mini.replaceChildren(miniOf()); sum.textContent = textOf(); } };
  }

  const RATIOS = [[1, 1], [4, 5], [3, 4], [2, 3], [9, 16], [5, 4], [4, 3], [3, 2], [16, 9]];

  // Width and height of an image drawn instead of typed: the frame shows the
  // proportions, ratio buttons keep the current area (so the cost stays the
  // same), size buttons keep the ratio, and the numbers stay editable.
  function sizeRow(wf, hf) {
    const title = document.createElement('span');
    title.className = 'comfy-dim-title';
    const tb = document.createElement('b'); tb.textContent = 'Tamanho da imagem';
    const ts = document.createElement('small'); ts.textContent = wf.title;
    title.append(tb, ts);
    const top = document.createElement('div');
    top.className = 'comfy-dim-top';
    const frame = document.createElement('div');
    frame.className = 'comfy-dim-frame';
    frame.setAttribute('aria-hidden', 'true');
    const fields = document.createElement('div');
    fields.className = 'comfy-dim-fields';
    const num = (f, label) => {
      const input = fieldControl({ ...f, options: null }, valueOf(f), v => { setParam(f, Math.max(16, Math.round(v))); sync(); });
      input.setAttribute('aria-label', label);
      input.min = 16; input.step = 16;
      return input;
    };
    const wIn = num(wf, 'Largura'), hIn = num(hf, 'Altura');
    const times = document.createElement('span'); times.textContent = '×';
    const swap = field('button', 'comfy-dim-swap', { type: 'button', title: 'Girar: trocar largura e altura' });
    swap.setAttribute('aria-label', 'Girar imagem');
    swap.appendChild(lucideEl('rotate-cw'));
    const info = document.createElement('small');
    info.className = 'comfy-dim-info';
    const row1 = document.createElement('div');
    row1.className = 'comfy-dim-row';
    row1.append(wIn, times, hIn, swap);
    fields.append(row1, info);
    top.append(frame, fields);

    const W = () => Number(valueOf(wf)) || 0, H = () => Number(valueOf(hf)) || 0;
    const snap = (n) => Math.max(16, Math.round(n / 16) * 16);
    const apply = (w, h) => { setParam(wf, snap(w)); setParam(hf, snap(h)); sync(); };

    const ratios = document.createElement('div');
    ratios.className = 'comfy-ratios';
    ratios.setAttribute('role', 'group');
    ratios.setAttribute('aria-label', 'Proporção');
    const buttons = RATIOS.map(([a, b]) => {
      const btn = field('button', 'comfy-ratio', { type: 'button', title: `Proporção ${a}:${b} (mantém a área)` });
      btn.setAttribute('aria-label', `Proporção ${a}:${b}`);
      btn.append(shapeOf(a, b, 20), Object.assign(document.createElement('span'), { textContent: `${a}:${b}` }));
      btn.onclick = (e) => {
        e.stopPropagation();
        const area = (W() * H()) || 1048576;
        const w = Math.sqrt(area * a / b);
        apply(w, w * b / a);
      };
      ratios.appendChild(btn);
      return { btn, a, b };
    });

    const sizes = document.createElement('div');
    sizes.className = 'comfy-sizes';
    sizes.setAttribute('role', 'group');
    sizes.setAttribute('aria-label', 'Tamanho base');
    const sizeButtons = [[0.5, '0,5 MP'], [1, '1 MP'], [1.5, '1,5 MP'], [2, '2 MP']].map(([mp, name]) => {
      const btn = field('button', 'comfy-size', { type: 'button', textContent: name, title: `Deixa a imagem com cerca de ${name}, na mesma proporção` });
      btn.setAttribute('aria-label', 'Tamanho ' + name);
      btn.onclick = (e) => {
        e.stopPropagation();
        const r = (W() / H()) || 1;
        const w = Math.sqrt(mp * 1e6 * r);
        apply(w, w / r);
      };
      sizes.appendChild(btn);
      return { btn, mp };
    });

    swap.onclick = (e) => { e.stopPropagation(); apply(H(), W()); };

    const fold = folded('size-' + wf.id, title, () => shapeOf(W(), H(), 18), () => {
      const w = W(), h = H();
      const near = buttons.find(({ a, b }) => h > 0 && Math.abs(w / h - a / b) < 0.02);
      return `${w} × ${h}` + (near ? ` · ${near.a}:${near.b}` : '');
    }, [top, ratios, sizes]);

    function sync() {
      const w = W(), h = H();
      fold.refresh();
      frame.replaceChildren(shapeOf(w, h, 56));
      wIn.value = w; hIn.value = h;
      const mp = w * h / 1e6;
      info.textContent = `${w} × ${h} · ${mp.toFixed(2).replace('.', ',')} MP`;
      for (const { btn, a, b } of buttons) btn.setAttribute('aria-pressed', String(h > 0 && Math.abs(w / h - a / b) < 0.02));
      for (const { btn, mp: m } of sizeButtons) btn.setAttribute('aria-pressed', String(Math.abs(mp - m) < 0.08 * m));
    }
    sync();
    return fold.box;
  }

  // A combo of aspect ratios drawn as buttons, each showing its own proportions.
  function aspectRow(f) {
    const options = ratioOptions(f);
    const title = document.createElement('span');
    title.className = 'comfy-dim-title';
    const tb = document.createElement('b'); tb.textContent = f.name === 'aspect_ratio' ? 'Proporção' : f.name;
    const ts = document.createElement('small'); ts.textContent = f.title;
    title.append(tb, ts);
    const group = document.createElement('div');
    group.className = 'comfy-ratios';
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', `${f.title} · ${f.name}`);
    const buttons = options.map(o => {
      const btn = field('button', 'comfy-ratio', { type: 'button', title: o.value });
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-label', o.value);
      btn.append(shapeOf(o.w, o.h, 20), Object.assign(document.createElement('span'), { textContent: o.text }));
      btn.onclick = (e) => { e.stopPropagation(); setParam(f, o.value); sync(); };
      group.appendChild(btn);
      return { btn, o };
    });
    const current = () => options.find(o => o.value === String(valueOf(f)));
    const fold = folded('aspect-' + f.id, title, () => { const c = current(); return c ? shapeOf(c.w, c.h, 18) : document.createElement('i'); },
      () => String(valueOf(f)), [group]);
    const sync = () => { fold.refresh(); for (const { btn, o } of buttons) btn.setAttribute('aria-checked', String(String(valueOf(f)) === o.value)); };
    sync();
    return fold.box;
  }

  // a workflow value shown on the card: control by type, saved on the card
  function paramRow(f) {
    const row = document.createElement('label');
    row.className = 'comfy-param';
    const name = document.createElement('span');
    const main = document.createElement('b');
    main.textContent = f.name;
    const sub = document.createElement('small');
    sub.textContent = f.title;
    name.append(main, sub);
    name.title = f.id;
    const saved = (it.data.params || {})[f.id];
    const input = fieldControl(f, saved !== undefined ? saved : f.value, v => { saveData(it, { params: { ...(it.data.params || {}), [f.id]: v } }); updateChips(); });
    input.setAttribute('aria-label', `${f.title} · ${f.name}`);
    row.append(name, input);
    return row;
  }

  // cards are redrawn when the cards linked to them change (checked on hover,
  // never while a field of this card is being typed in)
  el.addEventListener('pointerenter', async () => {
    if (painting || !it.data.workflowId || body.contains(document.activeElement)) return;
    const planned = await api.comfy('GET', '/plan/' + it.id).catch(() => null);
    if (planned && JSON.stringify(planned) !== signature && !body.contains(document.activeElement)) paint();
  });
  el._comfyRepaint = paint;
  paint();
}

// Control for one workflow field, by type: choices, switch, number with the
// limits ComfyUI reports, or text. `set` receives the new value.
export function fieldControl(f, value, set) {
  let input;
  if (f.options) {
    input = field('select', 'comfy-param-input');
    for (const o of f.options) input.appendChild(option(String(o), String(o)));
    if (!f.options.map(String).includes(String(value))) input.appendChild(option(String(value), String(value)));
    input.value = String(value);
    input.onchange = () => set(input.value);
  } else if (f.kind === 'boolean') {
    input = field('input', 'comfy-param-input', { type: 'checkbox', checked: !!value });
    input.onchange = () => set(input.checked);
  } else if (f.kind === 'number') {
    input = field('input', 'comfy-param-input', { type: 'number', value });
    if (f.min != null) input.min = f.min;
    if (f.max != null) input.max = f.max;
    if (f.step != null) input.step = f.step;
    input.addEventListener('change', () => { if (input.value !== '') set(Number(input.value)); });
  } else {
    const long = String(value).length > 60 || String(value).includes('\n');
    input = field(long ? 'textarea' : 'input', 'comfy-param-input', long ? { rows: 2, value } : { type: 'text', value });
    input.addEventListener('input', () => set(input.value));
  }
  return input;
}

// Choose which fields of a workflow appear on its cards (kept per workflow).
export function openFieldsPicker(detail, onSaved = () => {}) {
  const wrap = document.createElement('div');
  wrap.className = 'comfy-picker';
  const intro = document.createElement('p');
  intro.className = 'panel-text muted small';
  intro.textContent = 'Marque o que você quer ajustar direto no card (steps, tamanho, LoRA, força…). O resto fica como está no workflow. Em "teste", marque os campos de tamanho que o "Tamanho (teste)" deve reduzir. Vale para todos os cards que usam este workflow.';
  const search = document.createElement('input');
  search.type = 'search'; search.placeholder = 'Filtrar campos…'; search.setAttribute('aria-label', 'Filtrar campos');
  const list = document.createElement('div');
  list.className = 'comfy-picker-list';
  const chosen = new Set(detail.exposed);
  const sizes = new Set(detail.scalable);
  const groups = new Map();
  for (const f of detail.fields) {
    if (!groups.has(f.node)) groups.set(f.node, { title: f.title, fields: [] });
    groups.get(f.node).fields.push(f);
  }
  for (const [node, g] of groups) {
    const box = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = `${g.title} (#${node})`;
    box.appendChild(legend);
    for (const f of g.fields) {
      const lab = document.createElement('label');
      lab.dataset.search = `${g.title} ${f.name} ${f.value}`.toLowerCase();
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = chosen.has(f.id);
      cb.onchange = () => { if (cb.checked) chosen.add(f.id); else chosen.delete(f.id); };
      const text = document.createElement('span');
      text.textContent = f.name;
      const val = document.createElement('small');
      val.textContent = String(f.value).slice(0, 40);
      lab.append(cb, text, val);
      if (f.kind === 'number') {
        const size = document.createElement('label');
        size.className = 'comfy-picker-size';
        size.title = 'Reduzir este campo no modo de teste';
        const sb = document.createElement('input');
        sb.type = 'checkbox'; sb.checked = sizes.has(f.id);
        sb.onchange = () => { if (sb.checked) sizes.add(f.id); else sizes.delete(f.id); };
        size.append(sb, document.createTextNode('teste'));
        lab.appendChild(size);
      }
      box.appendChild(lab);
    }
    list.appendChild(box);
  }
  if (!groups.size) list.textContent = 'Este workflow não tem campos simples para ajustar.';
  search.oninput = () => {
    const term = search.value.trim().toLowerCase();
    list.querySelectorAll('label[data-search]').forEach(l => { l.hidden = !!term && !l.dataset.search.includes(term); });
    list.querySelectorAll('fieldset').forEach(fs => { fs.hidden = ![...fs.querySelectorAll('label[data-search]')].some(l => !l.hidden); });
  };
  wrap.append(intro, search, list);
  openPanel({
    title: `Campos · ${detail.name}`, body: wrap, wide: true,
    actions: [{ label: 'Cancelar', fn: closePanel }, { label: 'Salvar', primary: true, fn: async () => {
      const r = await api.comfy('PUT', `/workflows/${detail.id}/exposed`, { exposed: [...chosen], scalable: [...sizes] });
      if (r.error) { toast(r.error); return; }
      details.delete(detail.id);
      closePanel();
      document.querySelectorAll('.item.comfy').forEach(e => e._comfyRepaint && e._comfyRepaint());
      onSaved();
    } }]
  });
}

// ---- settings panel --------------------------------------------------------

export function forgetDetails() { details.clear(); }

export async function openComfySettings() {
  const [settings, list] = await Promise.all([api.comfy('GET', '/settings'), loadWorkflows(true)]);
  const wrap = document.createElement('div');
  wrap.className = 'comfy-settings';
  wrap.innerHTML = `
    <label>Executar workflows em</label>
    <div class="seg">
      <label><input type="radio" name="provider" value="local"> ComfyUI local</label>
      <label><input type="radio" name="provider" value="runpod"> RunPod Serverless</label>
    </div>
    <div data-show="local">
      <label for="cfLocal">Endereço do ComfyUI</label>
      <input id="cfLocal" type="url" placeholder="http://127.0.0.1:8188">
      <div data-launch>
        <label for="cfLaunch">Arquivo para ligar o ComfyUI (opcional)</label>
        <input id="cfLaunch" type="text" placeholder="D:ComfyUIComfyUI_windows_portableun_nvidia_gpu.bat">
        <p class="panel-text muted small">Com isso o Milaclone liga o ComfyUI sozinho quando você clica em Gerar e ele está desligado (abre numa janela própria). Só funciona no computador onde o ComfyUI está.</p>
        <div class="cf-test"><button type="button" class="panel-btn small" id="cfLaunchNow">Ligar agora</button><span id="cfLaunchResult"></span></div>
      </div>
    </div>
    <div data-show="runpod">
      <label for="cfEndpoint">ID do endpoint</label>
      <input id="cfEndpoint" type="text" placeholder="ex.: abc123xyz">
      <label for="cfKey">Chave da API</label>
      <input id="cfKey" type="password" autocomplete="off">
      <p class="panel-text muted small">Use um endpoint com <b>worker-comfyui 5.x</b>. Cada variação vira uma tarefa própria, então vários workers geram em paralelo. A chave fica só neste servidor.</p>
    </div>
    <div class="cf-test"><button type="button" class="panel-btn small" id="cfTest">Testar conexão</button><span id="cfTestResult"></span></div>
    <h3>Workflows</h3>
    <p class="panel-text muted small">No ComfyUI, abra o workflow e use <b>Workflow → Export (API)</b>. Prompt, prompt negativo, seeds e entradas LoadImage são preenchidos automaticamente.</p>
    <div class="cf-list" id="cfList"></div>
    <div class="cf-import">
      <input type="text" id="cfName" placeholder="Nome, ex.: Retrato img2img">
      <button type="button" class="panel-btn small" id="cfImport">Importar JSON…</button>
    </div>`;
  const $ = sel => wrap.querySelector(sel);
  wrap.querySelectorAll('input[name=provider]').forEach(r => { r.checked = r.value === settings.provider; });
  $('#cfLocal').value = settings.localUrl || '';
  $('#cfLaunch').value = settings.localLaunch || '';
  wrap.querySelector('[data-launch]').hidden = !settings.canLaunch;
  $('#cfEndpoint').value = settings.runpodEndpoint || '';
  $('#cfKey').placeholder = settings.hasRunpodKey ? 'Salva — digite para trocar' : 'rpa_…';
  if (settings.keyFromEnv) { $('#cfKey').disabled = true; $('#cfKey').placeholder = 'Definida por RUNPOD_API_KEY no servidor'; }
  const sync = () => {
    const p = wrap.querySelector('input[name=provider]:checked')?.value || 'local';
    wrap.querySelectorAll('[data-show]').forEach(d => { d.hidden = d.dataset.show !== p; });
  };
  wrap.querySelectorAll('input[name=provider]').forEach(r => r.addEventListener('change', sync));
  sync();

  const collect = () => ({
    provider: wrap.querySelector('input[name=provider]:checked')?.value || 'local',
    localUrl: $('#cfLocal').value, localLaunch: $('#cfLaunch').value, runpodEndpoint: $('#cfEndpoint').value, runpodKey: $('#cfKey').value
  });
  $('#cfTest').onclick = async () => {
    $('#cfTestResult').textContent = 'Testando…';
    await api.comfy('PUT', '/settings', collect());
    const r = await api.comfy('POST', '/test');
    $('#cfTestResult').textContent = r.error ? '✗ ' + r.error : '✓ ' + r.detail;
    $('#cfTestResult').className = r.error ? 'bad' : 'good';
  };

  $('#cfLaunchNow').onclick = async () => {
    const out = $('#cfLaunchResult');
    out.className = '';
    out.textContent = 'Ligando… pode levar um minuto';
    const saved = await api.comfy('PUT', '/settings', collect());
    if (saved.error) { out.textContent = '✗ ' + saved.error; out.className = 'bad'; return; }
    const r = await api.comfy('POST', '/launch');
    out.textContent = r.error ? '✗ ' + r.error : r.already ? '✓ O ComfyUI já está ligado' : '✓ ComfyUI ligado';
    out.className = r.error ? 'bad' : 'good';
  };

  const paintList = (rows) => {
    const box = $('#cfList');
    box.innerHTML = '';
    if (!rows.length) { box.innerHTML = '<p class="panel-text muted small">Nenhum workflow ainda.</p>'; return; }
    for (const wf of rows) {
      const row = document.createElement('div');
      row.className = 'cf-wf';
      const name = document.createElement('span');
      name.textContent = wf.name;
      const meta = document.createElement('small');
      meta.textContent = [wf.imageInputs ? `${wf.imageInputs} foto${wf.imageInputs > 1 ? 's' : ''} de entrada` : 'texto para imagem',
        wf.hasPrompt ? 'prompt' : 'sem nó de prompt', `${wf.nodes} nodes`].join(' · ');
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'panel-btn small danger'; del.textContent = 'Remover';
      del.onclick = async () => {
        if (!await confirmDialog(`Remover o workflow "${wf.name}"?`, { confirm: 'Remover', danger: true })) { openComfySettings(); return; }
        await api.comfy('DELETE', '/workflows/' + wf.id);
        await loadWorkflows(true);
        openComfySettings();
      };
      row.append(name, meta, del);
      box.appendChild(row);
    }
  };
  paintList(list);

  $('#cfImport').onclick = () => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json,application/json';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      const name = $('#cfName').value.trim() || file.name.replace(/\.json$/i, '');
      const r = await api.comfy('POST', '/workflows', { name, json: await file.text() });
      if (r.error) { toast(r.error); return; }
      $('#cfName').value = '';
      paintList(await loadWorkflows(true));
      toast('Workflow importado');
    };
    input.click();
  };

  openPanel({
    title: 'ComfyUI', body: wrap, wide: true,
    onClose: () => { refreshComfyCards(); },
    actions: [{ label: 'Salvar', primary: true, fn: async () => {
      const r = await api.comfy('PUT', '/settings', collect());
      if (r.error) { toast(r.error); return; }
      forgetProvider();
      toast('Configurações do ComfyUI salvas');
      closePanel();
    } }]
  });
  refreshIcons(wrap);
}

// Workflow lists on cards follow the settings panel.
function refreshComfyCards() {
  details.clear();
  loadWorkflows(true).then(() => {
    document.querySelectorAll('.item.comfy').forEach(e => e._comfyRepaint && e._comfyRepaint());
  }).catch(() => {});
}
