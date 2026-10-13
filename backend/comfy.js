'use strict';

// ComfyUI bridge. A `comfy` card holds a workflow choice, a prompt, how many
// variations to make and the values of the workflow fields the user chose to
// expose. Cards connected to it with lines are its inputs: photos and groups
// feed the workflow's LoadImage slots (each slot picks its source, or a blank
// image; a group feeds one job per photo), notes become the prompt.
// Running it queues one job per variation (and per photo of a group) on either
// - a local ComfyUI server (POST /upload/image, /prompt, GET /history, /view), or
// - a RunPod Serverless endpoint running worker-comfyui 5.x (/run, /status),
//   where jobs execute in parallel on separate workers.
// Finished images are saved as uploads and placed as image cards inside a
// group frame under the source (or next to the node), each batch stacked below
// the previous one. Any image on the board can also be sent through an
// "enhancer" workflow (an upscaler such as SeedVR2): see enhance(). Progress of
// local jobs comes from ComfyUI's websocket. Jobs live in SQLite and are
// resumed on boot.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { db, stmt, id, rowToItem } = require('./db');

const runpodBase = () => process.env.RUNPOD_API_BASE || 'https://api.runpod.ai/v2';
// A job is given up only when its server has lost it (see local.poll); this is
// just a safety cap, since a big model can take a long time and ComfyUI runs
// queued jobs one after another.
const JOB_TIMEOUT_MS = Number(process.env.COMFY_JOB_TIMEOUT_MS) || 24 * 60 * 60 * 1000;
// failures that mean "we stopped looking", not "the job failed": results may
// still be waiting on the server and can be fetched again
const NON_RECOVERABLE = /^(Erro no ComfyUI|Tarefa do RunPod|Cancelada|O workflow terminou|Interrompida)/;
const recoverable = j => j.status === 'failed' && !!j.remoteId && !NON_RECOVERABLE.test(j.error || '');
const POLL_MS = Number(process.env.COMFY_POLL_MS) || 2000;   // read once at load
const MAX_JOBS_PER_RUN = 64;
// Seeds stay below 2^32: some nodes (SeedVR2) reject anything larger, and every
// sampler accepts it.
const SEED_RANGE = 2 ** 32;
const MAX_INPUT_SIDE = 2048;   // keeps RunPod payloads under its 10 MB limit

db.exec(`
  CREATE TABLE IF NOT EXISTS comfy_workflows (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, json TEXT NOT NULL, createdAt INTEGER
  );
  CREATE TABLE IF NOT EXISTS comfy_jobs (
    id TEXT PRIMARY KEY, itemId TEXT, canvasId TEXT, batchId TEXT, provider TEXT,
    remoteId TEXT, status TEXT, error TEXT, prompt TEXT, createdAt INTEGER, updatedAt INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_comfy_jobs_item ON comfy_jobs(itemId);
`);
// columns added after the first release
for (const sql of [
  'ALTER TABLE comfy_workflows ADD COLUMN exposed TEXT',   // JSON list of field ids shown on cards
  'ALTER TABLE comfy_jobs ADD COLUMN anchorId TEXT',       // card the results are placed under
  'ALTER TABLE comfy_jobs ADD COLUMN originId TEXT',       // photo this job was made from
  'ALTER TABLE comfy_workflows ADD COLUMN scalable TEXT',  // JSON list of size fields the "test size" scale applies to
  'ALTER TABLE comfy_jobs ADD COLUMN kind TEXT'            // 'enhance' for upscaler jobs
]) { try { db.exec(sql); } catch (_) { /* already there */ } }

const q = {
  workflows: db.prepare('SELECT id, name, json, createdAt, exposed, scalable FROM comfy_workflows ORDER BY name'),
  workflow: db.prepare('SELECT * FROM comfy_workflows WHERE id = ?'),
  insertWorkflow: db.prepare('INSERT INTO comfy_workflows (id, name, json, createdAt) VALUES (?, ?, ?, ?)'),
  setExposed: db.prepare('UPDATE comfy_workflows SET exposed = ?, scalable = ? WHERE id = ?'),
  deleteWorkflow: db.prepare('DELETE FROM comfy_workflows WHERE id = ?'),
  insertJob: db.prepare(`INSERT INTO comfy_jobs (id, itemId, canvasId, batchId, provider, remoteId, status, prompt, anchorId, originId, kind, createdAt, updatedAt)
                         VALUES (@id, @itemId, @canvasId, @batchId, @provider, NULL, 'queued', @prompt, @anchorId, @originId, @kind, @now, @now)`),
  setJob: db.prepare('UPDATE comfy_jobs SET status = @status, remoteId = COALESCE(@remoteId, remoteId), error = @error, updatedAt = @now WHERE id = @id'),
  job: db.prepare('SELECT * FROM comfy_jobs WHERE id = ?'),
  jobsForItem: db.prepare('SELECT id, batchId, status, error, remoteId, provider, createdAt, updatedAt FROM comfy_jobs WHERE itemId = ? ORDER BY createdAt DESC LIMIT 200'),
  pending: db.prepare("SELECT * FROM comfy_jobs WHERE status IN ('queued', 'running')"),
  recent: db.prepare("SELECT * FROM comfy_jobs WHERE status = 'failed' AND updatedAt > ?")
};

// ---- settings --------------------------------------------------------------
// Stored in `meta`; RUNPOD_API_KEY / RUNPOD_ENDPOINT_ID / COMFYUI_URL env vars
// win. The API key is never sent back to the browser.

function readSettings() {
  let saved = {};
  try { saved = JSON.parse(stmt.getMeta.get('comfy.settings')?.value || '{}'); } catch (_) {}
  return {
    provider: saved.provider === 'runpod' ? 'runpod' : 'local',
    localUrl: process.env.COMFYUI_URL || saved.localUrl || 'http://127.0.0.1:8188',
    runpodEndpoint: process.env.RUNPOD_ENDPOINT_ID || saved.runpodEndpoint || '',
    runpodKey: process.env.RUNPOD_API_KEY || saved.runpodKey || '',
    localLaunch: saved.localLaunch || ''
  };
}

function publicSettings() {
  const s = readSettings();
  return {
    provider: s.provider, localUrl: s.localUrl, localLaunch: s.localLaunch, runpodEndpoint: s.runpodEndpoint,
    hasRunpodKey: !!s.runpodKey, keyFromEnv: !!process.env.RUNPOD_API_KEY
  };
}

// `trusted`: the request comes from this computer. The file that starts
// ComfyUI is only accepted from there, so nobody else on the network can make
// the server run something.
function saveSettings(body = {}, { trusted = false } = {}) {
  let saved = {};
  try { saved = JSON.parse(stmt.getMeta.get('comfy.settings')?.value || '{}'); } catch (_) {}
  if (body.provider === 'local' || body.provider === 'runpod') saved.provider = body.provider;
  if (typeof body.localUrl === 'string') saved.localUrl = body.localUrl.trim().replace(/\/+$/, '');
  if (typeof body.localLaunch === 'string' && trusted) {
    const file = body.localLaunch.trim().replace(/^"(.*)"$/, '$1');
    if (file && (!path.isAbsolute(file) || !fs.existsSync(file) || fs.statSync(file).isDirectory())) throw httpError('Arquivo de inicialização não encontrado. Informe o caminho completo, por exemplo o run_nvidia_gpu.bat do ComfyUI.');
    if (file) saved.localLaunch = file; else delete saved.localLaunch;
  }
  if (typeof body.runpodEndpoint === 'string') saved.runpodEndpoint = body.runpodEndpoint.trim();
  if (typeof body.runpodKey === 'string' && body.runpodKey.trim()) saved.runpodKey = body.runpodKey.trim();
  if (body.clearRunpodKey) delete saved.runpodKey;
  stmt.setMeta.run('comfy.settings', JSON.stringify(saved));
  return publicSettings();
}

// ---- workflows -------------------------------------------------------------

const httpError = (message, status = 400) => Object.assign(new Error(message), { status });
const isLink = v => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string';
const textKeys = ['text', 't5xxl', 'clip_l', 'prompt'];

function parseWorkflow(raw) {
  const wf = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!wf || typeof wf !== 'object' || Array.isArray(wf)) throw httpError('O workflow precisa ser um objeto JSON');
  if (Array.isArray(wf.nodes)) throw httpError('Este é o formato do editor. No ComfyUI use Workflow > Export (API) e importe esse arquivo.');
  const nodes = Object.entries(wf).filter(([, n]) => n && typeof n === 'object' && n.class_type && n.inputs);
  if (!nodes.length) throw httpError('Nenhum nó do ComfyUI encontrado. Exporte o workflow com Workflow > Export (API).');
  return wf;
}

// Follow conditioning links upstream from a sampler input until a node that
// holds prompt text (CLIPTextEncode, CLIPTextEncodeFlux…).
function textNodeFrom(wf, link, seen = new Set()) {
  if (!isLink(link) || seen.has(link[0])) return null;
  seen.add(link[0]);
  const node = wf[link[0]];
  if (!node) return null;
  if (textKeys.some(k => typeof node.inputs[k] === 'string')) return link[0];
  for (const value of Object.values(node.inputs)) {
    const found = textNodeFrom(wf, value, seen);
    if (found) return found;
  }
  return null;
}

function analyze(wf) {
  let positive = null, negative = null;
  for (const node of Object.values(wf)) {
    if (!node || !node.inputs) continue;
    if (!positive && node.inputs.positive) positive = textNodeFrom(wf, node.inputs.positive);
    if (!positive && node.inputs.conditioning && /guider/i.test(node.class_type)) positive = textNodeFrom(wf, node.inputs.conditioning);
    if (!negative && node.inputs.negative) negative = textNodeFrom(wf, node.inputs.negative);
  }
  const textNodes = Object.entries(wf).filter(([, n]) => n && n.inputs && textKeys.some(k => typeof n.inputs[k] === 'string'));
  if (!positive) {
    const pick = textNodes.find(([, n]) => !/neg/i.test(n._meta?.title || '')) || textNodes[0];
    positive = pick ? pick[0] : null;
  }
  if (!negative) {
    const pick = textNodes.find(([key, n]) => key !== positive && /neg/i.test(n._meta?.title || ''));
    negative = pick ? pick[0] : null;
  }
  const loadImages = Object.entries(wf)
    .filter(([, n]) => n && n.class_type === 'LoadImage')
    .map(([key]) => key)
    .sort((a, b) => (Number(a) - Number(b)) || a.localeCompare(b));
  const seeds = Object.entries(wf).flatMap(([key, n]) => ['seed', 'noise_seed']
    .filter(k => n && n.inputs && typeof n.inputs[k] === 'number').map(k => [key, k]));
  const inputs = loadImages.map((key, i) => ({ key, title: (wf[key]._meta && wf[key]._meta.title && wf[key]._meta.title !== 'Load Image') ? wf[key]._meta.title : 'Imagem ' + (i + 1) }));
  return { positive, negative, loadImages, seeds, inputs, kind: kindOf(wf, loadImages, positive), fields: fieldsOf(wf, { positive, negative, seeds }) };
}

// What the workflow does, so the card can fit it: 'generate' (no image input:
// text to image), 'upscale' (images in, no prompt: SeedVR2 and friends) or
// 'edit' (images and a prompt, e.g. Krea/Flux edit and try-on).
function kindOf(wf, loadImages, positive) {
  if (!loadImages.length) return 'generate';
  const classes = Object.values(wf).map(n => (n && n.class_type) || '');
  const encoder = classes.some(c => /TextEncode|Conditioning|CLIPText/i.test(c));
  const upscaler = classes.some(c => /upscal|seedvr|esrgan|supir|swinir|ultimatesd/i.test(c));
  return !positive || (upscaler && !encoder) ? 'upscale' : 'edit';
}

// Every plain value in the workflow (numbers, switches, text, combo choices)
// that the user may choose to show on the card. Prompt text, seeds and image
// loaders are handled on their own, so they are not listed.
function fieldsOf(wf, { positive, negative, seeds }) {
  const seedIds = new Set(seeds.map(([key, name]) => key + '.' + name));
  const out = [];
  for (const [key, node] of Object.entries(wf)) {
    if (!node || !node.inputs || !node.class_type || node.class_type === 'LoadImage') continue;
    for (const [name, value] of Object.entries(node.inputs)) {
      const kind = typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : typeof value === 'string' ? 'text' : null;
      if (!kind || seedIds.has(key + '.' + name)) continue;
      if ((key === positive || key === negative) && textKeys.includes(name)) continue;
      out.push({ id: key + '.' + name, node: key, name, kind, value, classType: node.class_type,
        title: (node._meta && node._meta.title) || node.class_type });
    }
  }
  return out;
}

const exposedOf = row => { try { return JSON.parse(row.exposed || '[]'); } catch (_) { return []; } };

function describe(row) {
  const wf = JSON.parse(row.json);
  const a = analyze(wf);
  return { id: row.id, name: row.name, createdAt: row.createdAt,
    imageInputs: a.loadImages.length, kind: a.kind, hasPrompt: !!a.positive, hasNegative: !!a.negative,
    nodes: Object.keys(wf).length };
}

// Choices and limits of a field, read from a running local ComfyUI (/object_info).
// Without one the card still works: values are edited as plain text/numbers.
const infoCache = new Map();
async function nodeInfo(classType) {
  const hit = infoCache.get(classType);
  if (hit && Date.now() - hit.at < 60000) return hit.info;
  let info = null;
  try {
    const body = await fetchJson(readSettings().localUrl + '/object_info/' + encodeURIComponent(classType), { signal: AbortSignal.timeout(2500) }, 'object_info');
    info = body && body[classType] || null;
  } catch (_) {}
  infoCache.set(classType, { at: Date.now(), info });
  return info;
}

// What a card needs to draw a workflow: image slots, exposable fields (with
// choices when known) and which of them the user chose to show.
async function workflowDetail(wid) {
  const row = q.workflow.get(wid);
  if (!row) throw httpError('Workflow não encontrado', 404);
  const a = analyze(JSON.parse(row.json));
  const fields = await Promise.all(a.fields.map(async f => {
    const info = await nodeInfo(f.classType);
    const spec = info && ((info.input.required || {})[f.name] || (info.input.optional || {})[f.name]);
    if (!spec) return f;
    if (Array.isArray(spec[0])) return { ...f, options: spec[0] };
    const o = spec[1] || {};
    return { ...f, min: o.min, max: o.max, step: o.step };
  }));
  return { ...describe(row), inputs: a.inputs, hasSeed: a.seeds.length > 0, fields, exposed: exposedOf(row),
    scalable: scalableOf(row, fields), suggested: sizeFieldIds(fields) };
}

// Fields that set an image size. The "test size" of a card or of the enhancer
// scales them down so a sequence can be tried quickly before the real run.
const SIZE_FIELD = /^(width|height|resolution|max_resolution|megapixels|long_side|short_side|target_size|size)$/i;
const sizeFieldIds = fields => fields.filter(f => f.kind === 'number' && SIZE_FIELD.test(f.name)).map(f => f.id);
function scalableOf(row, fields) {
  try { const saved = JSON.parse(row.scalable); if (Array.isArray(saved)) return saved; } catch (_) {}
  return sizeFieldIds(fields);
}

// params with the size fields multiplied by scale (0 < scale < 1). A size of 0
// means "no limit" and is left alone; sizes stay multiples of 16.
function scaledParams(wf, params, scale, ids) {
  const out = { ...(params || {}) };
  if (!(scale > 0 && scale < 1)) return out;
  for (const id of ids || []) {
    const dot = id.lastIndexOf('.');
    const node = wf[id.slice(0, dot)];
    const name = id.slice(dot + 1);
    if (!node || !node.inputs || isLink(node.inputs[name])) continue;
    const base = Number(out[id] !== undefined ? out[id] : node.inputs[name]);
    if (!Number.isFinite(base) || base <= 0) continue;
    out[id] = /megapixels/i.test(name) ? Math.max(0.1, Math.round(base * scale * scale * 100) / 100) : Math.max(64, Math.round(base * scale / 16) * 16);
  }
  return out;
}

function setExposed(wid, list, scalable) {
  const row = q.workflow.get(wid);
  if (!row) throw httpError('Workflow não encontrado', 404);
  const clean = v => (Array.isArray(v) ? v : []).filter(x => typeof x === 'string').slice(0, 200);
  const ids = clean(list);
  const sizes = Array.isArray(scalable) ? clean(scalable) : (row.scalable ? JSON.parse(row.scalable) : null);
  q.setExposed.run(JSON.stringify(ids), sizes ? JSON.stringify(sizes) : null, wid);
  return { exposed: ids, scalable: sizes };
}

function listWorkflows() { return q.workflows.all().map(describe); }

function addWorkflow(name, json) {
  const wf = parseWorkflow(json);
  const row = { id: id('w_'), name: String(name || 'Workflow').slice(0, 80), json: JSON.stringify(wf), createdAt: Date.now() };
  q.insertWorkflow.run(row.id, row.name, row.json, row.createdAt);
  return describe(row);
}

// seed: a number sets every seed field of the workflow to it; null gives each a
// random one. params: { 'nodeId.input': value } overrides chosen fields.
function buildPrompt(wf, { prompt, negative, imageNames, seed = null, params = {} }) {
  const out = JSON.parse(JSON.stringify(wf));
  const a = analyze(out);
  const setText = (key, value) => {
    if (!key || typeof value !== 'string' || !value.trim()) return;
    for (const k of textKeys) if (typeof out[key].inputs[k] === 'string') out[key].inputs[k] = value;
  };
  setText(a.positive, prompt);
  setText(a.negative, negative);
  a.loadImages.forEach((key, i) => { if (imageNames[i]) out[key].inputs.image = imageNames[i]; });
  for (const [id, value] of Object.entries(params || {})) {
    const dot = id.lastIndexOf('.');
    const node = out[id.slice(0, dot)];
    const name = id.slice(dot + 1);
    if (!node || !node.inputs || isLink(node.inputs[name]) || !(name in node.inputs)) continue;
    const current = node.inputs[name];
    if (typeof current === 'number') { if (value !== '' && Number.isFinite(Number(value))) node.inputs[name] = Number(value); }
    else if (typeof current === 'boolean') node.inputs[name] = value === true || value === 'true';
    else if (typeof current === 'string') node.inputs[name] = String(value);
  }
  for (const [key, k] of a.seeds) out[key].inputs[k] = Number.isFinite(seed) ? ((seed % SEED_RANGE) + SEED_RANGE) % SEED_RANGE : crypto.randomInt(0, SEED_RANGE);
  return out;
}

// ---- inputs ----------------------------------------------------------------

function photoOf(row, uploadDir) {
  const photo = rowToItem(row);
  if (photo.type !== 'image' || typeof photo.data.src !== 'string') return null;
  const file = path.join(uploadDir, path.basename(photo.data.src));
  return fs.existsSync(file) ? { id: photo.id, file, name: photo.data.name || path.basename(file), src: photo.data.src, x: photo.x, y: photo.y } : null;
}

// Cards connected to the node by lines (source → node), in the order the lines
// were made. A photo is one source with one photo; a group or column is one
// source with all the photos inside it; a note is prompt text.
function linkedSources(node, uploadDir) {
  const lines = db.prepare(`SELECT * FROM items WHERE canvasId = ? AND type = 'line'
                            AND json_extract(data, '$.to') = ? ORDER BY createdAt, id`).all(node.canvasId, node.id);
  const sources = [], notes = [];
  for (const line of lines.map(rowToItem)) {
    const row = stmt.getItem.get(line.data.from);
    if (!row) continue;
    const item = rowToItem(row);
    if (item.type === 'image') {
      const photo = photoOf(row, uploadDir);
      if (photo) sources.push({ id: item.id, kind: 'single', label: photo.name, photos: [photo] });
    } else if (item.type === 'group' || item.type === 'column') {
      const members = item.type === 'group'
        ? db.prepare(`SELECT * FROM items WHERE canvasId = ? AND type = 'image' AND json_extract(data, '$.groupId') = ?`).all(item.canvasId, item.id)
        : db.prepare(`SELECT * FROM items WHERE type = 'image' AND parentItemId = ?`).all(item.id);
      const photos = members.map(r => photoOf(r, uploadDir)).filter(Boolean).sort((p1, p2) => (p1.x - p2.x) || (p1.y - p2.y));
      sources.push({ id: item.id, kind: 'set', label: item.data.title || (item.type === 'group' ? 'Grupo' : 'Coluna'), photos, item });
    } else if (item.type === 'note') {
      notes.push(noteText(item));
    }
  }
  return { sources, notes: notes.filter(Boolean) };
}

// A translated note keeps its twin: prefer the English text, image models read it best.
function noteText(note) {
  let use = note;
  const partnerId = note.data.translation || note.data.translationOf;
  const partnerRow = partnerId && stmt.getItem.get(partnerId);
  const partner = partnerRow && rowToItem(partnerRow);
  if (partner && partner.type === 'note' && note.data.lang !== 'en' && partner.data.lang === 'en') use = partner;
  const text = String(use.data.body || '').trim() || String(use.data.title || '').trim();
  return text ? { id: note.id, label: String(note.data.title || 'Nota'), lang: use.data.lang || null, text } : null;
}

// What a run of this node would do, without doing it: which source feeds each
// image slot, how many jobs (one per photo of a group) and where results go.
// `error` explains why it cannot run yet. Also feeds the card's own display.
function plan(itemId, uploadDir) {
  const row = stmt.getItem.get(itemId);
  if (!row) throw httpError('Node não encontrado', 404);
  const node = rowToItem(row);
  if (node.type !== 'comfy') throw httpError('Este card não é um node do ComfyUI');
  const wfRow = node.data.workflowId && q.workflow.get(node.data.workflowId);
  const out = { sets: 0, slots: [], sources: [], notes: [], error: null, node, wf: null, jobs: [], anchor: null, prompt: '' };
  const linked = linkedSources(node, uploadDir);
  out.sources = linked.sources.map(src => ({ id: src.id, kind: src.kind, label: src.label, count: src.photos.length }));
  out.notes = linked.notes.map(({ id, label, lang }) => ({ id, label, lang }));
  out.prompt = [linked.notes.map(n => n.text).join('\n\n'), String(node.data.prompt || '')].filter(t => t.trim()).join('\n\n');
  if (!wfRow) { out.error = 'Escolha um workflow antes (importe um nas configurações do ComfyUI)'; return out; }
  out.wf = JSON.parse(wfRow.json);
  const a = analyze(out.wf);
  out.scalable = scalableOf(wfRow, a.fields);

  // each slot: an explicit choice, or the next source nobody chose (a workflow
  // with a single image slot takes every unchosen source as one batch)
  const chosen = node.data.slots || {};
  const assign = {};
  const used = new Set();
  for (const input of a.inputs) {
    const c = chosen[input.key];
    if (c === 'blank') assign[input.key] = { kind: 'blank', label: 'Em branco', photos: [] };
    else if (c) {
      const src = linked.sources.find(x => x.id === c);
      if (src) { assign[input.key] = src; used.add(src.id); }
    }
  }
  const free = linked.sources.filter(x => !used.has(x.id));
  const auto = a.inputs.filter(i => !assign[i.key]);
  if (a.inputs.length === 1 && auto.length === 1) {
    const photos = free.flatMap(x => x.photos);
    if (photos.length) assign[auto[0].key] = { kind: 'set', label: free.length > 1 ? free.length + ' fontes' : free[0].label, photos, auto: true, anchor: free[0] };
  } else {
    for (const input of auto) { const src = free.shift(); if (src) assign[input.key] = { ...src, auto: true }; }
  }
  out.slots = a.inputs.map(i => {
    const src = assign[i.key];
    return { key: i.key, title: i.title, choice: chosen[i.key] || '',
      kind: src ? src.kind : 'none', label: src ? src.label : '', count: src ? src.photos.length : 0,
      thumb: src && src.photos[0] ? src.photos[0].src : null };
  });

  const missing = a.inputs.filter(i => !assign[i.key]);
  if (missing.length) {
    const need = a.inputs.length;
    out.error = `Este workflow precisa de ${need} foto${need === 1 ? '' : 's'}. Ligue cada foto ao node com uma seta${need > 1 ? ' e escolha a de cada entrada' : ''}.`;
    return out;
  }
  const order = a.inputs.map(i => assign[i.key]);
  const sets = order.filter(x => x.kind === 'set');
  const emptySet = sets.find(x => !x.photos.length);
  if (emptySet) { out.error = `O grupo "${emptySet.label}" não tem fotos.`; return out; }
  const counts = [...new Set(sets.map(x => x.photos.length))];
  if (counts.length > 1) { out.error = `Os grupos ligados têm quantidades diferentes de fotos (${counts.join(' e ')}).`; return out; }
  out.sets = counts[0] || 1;
  const iterating = sets[0];
  for (let n = 0; n < out.sets; n++) {
    const set = order.map(src => (src.kind === 'blank' ? { blank: true, name: 'branco.png' } : src.kind === 'set' ? src.photos[n] : src.photos[0]));
    out.jobs.push({ set, originId: iterating ? iterating.photos[n].id : (set.find(x => !x.blank) || {}).id || null });
  }
  // results go under the first group fed, else under the first photo; with
  // neither, next to the node
  const anchorSrc = order.find(x => x.kind === 'set' && x.item) || order.find(x => x.kind === 'single') || (order.find(x => x.anchor) || {}).anchor;
  out.anchor = anchorSrc ? anchorSrc.id : null;
  return out;
}

// What the card shows: no workflow JSON, no file paths.
function planView(itemId, uploadDir) {
  const p = plan(itemId, uploadDir);
  return { sets: p.sets, slots: p.slots, sources: p.sources, notes: p.notes, error: p.error, prompt: p.prompt };
}

const blankImage = () => sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#ffffff' } }).png().toBuffer();

async function inputBuffer(file) {
  return sharp(file).rotate()
    .resize({ width: MAX_INPUT_SIDE, height: MAX_INPUT_SIDE, fit: 'inside', withoutEnlargement: true })
    .png().toBuffer();
}

// ---- providers -------------------------------------------------------------

async function fetchJson(url, options = {}, what = 'request') {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_) {}
  if (!response.ok) throw new Error(`${what} falhou (${response.status}): ${(body && (body.error?.message || body.error || body.message)) || text.slice(0, 200)}`);
  return body;
}

const lostPolls = new Map();   // promptId -> polls in a row where ComfyUI knew nothing of it

const local = {
  async submit(settings, workflow, images) {
    followProgress(settings);
    const names = [];
    for (const img of images) {
      const fd = new FormData();
      fd.append('image', new Blob([img.buffer], { type: 'image/png' }), img.name);
      fd.append('overwrite', 'true');
      const up = await fetchJson(settings.localUrl + '/upload/image', { method: 'POST', body: fd }, 'ComfyUI upload');
      names.push(up.subfolder ? `${up.subfolder}/${up.name}` : up.name);
    }
    const body = await fetchJson(settings.localUrl + '/prompt', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow(names), client_id: 'milaclone' })
    }, 'ComfyUI /prompt');
    if (body.node_errors && Object.keys(body.node_errors).length) throw new Error('O ComfyUI recusou o workflow: ' + JSON.stringify(body.node_errors).slice(0, 300));
    return body.prompt_id;
  },
  // null while running; [{ buffer, filename }] when done
  async poll(settings, remoteId) {
    const history = await fetchJson(settings.localUrl + '/history/' + encodeURIComponent(remoteId), {}, 'ComfyUI /history');
    const entry = history && history[remoteId];
    if (!entry) {
      // not finished: either still in ComfyUI's queue (it runs jobs one at a
      // time, so later ones wait their turn) or it is gone
      const queue = await fetchJson(settings.localUrl + '/queue', {}, 'ComfyUI /queue');
      const known = [...(queue.queue_running || []), ...(queue.queue_pending || [])].some(e => e[1] === remoteId);
      if (known) { lostPolls.delete(remoteId); return null; }
      const n = (lostPolls.get(remoteId) || 0) + 1;
      lostPolls.set(remoteId, n);
      if (n >= 5) { lostPolls.delete(remoteId); throw Object.assign(new Error('O ComfyUI não tem mais esta tarefa (foi reiniciado ou o histórico foi limpo).'), { final: true }); }
      return null;
    }
    if (entry.status && entry.status.status_str === 'error') {
      const msg = (entry.status.messages || []).find(m => m[0] === 'execution_error');
      throw Object.assign(new Error('Erro no ComfyUI: ' + (msg ? (msg[1].exception_message || '').trim() : 'a execução falhou')), { final: true });
    }
    if (entry.status && entry.status.completed === false) return null;
    // saved images; workflows that only end in a Preview node (common in
    // upscalers) have nothing else, so their temporary images are the result
    const all = Object.values(entry.outputs || {}).flatMap(output => output.images || []);
    const saved = all.filter(img => img.type !== 'temp');
    const files = [];
    for (const img of saved.length ? saved : all) {
      const url = `${settings.localUrl}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || '')}&type=${encodeURIComponent(img.type || 'output')}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error('Não foi possível baixar ' + img.filename);
      files.push({ buffer: Buffer.from(await response.arrayBuffer()), filename: img.filename });
    }
    return files;
  }
};

const runpod = {
  headers(settings) {
    if (!settings.runpodKey || !settings.runpodEndpoint) throw httpError('Informe o ID do endpoint e a chave da API do RunPod nas configurações do ComfyUI');
    return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + settings.runpodKey };
  },
  async submit(settings, workflow, images) {
    const names = images.map((img, i) => `milaclone_${Date.now()}_${i}.png`);
    const payload = JSON.stringify({ input: {
      workflow: workflow(names),
      images: images.map((img, i) => ({ name: names[i], image: img.buffer.toString('base64') }))
    } });
    if (payload.length > 10 * 1024 * 1024) throw new Error('As fotos de entrada passam do limite do RunPod /run (10 MB). Use menos fotos ou fotos menores.');
    const body = await fetchJson(`${runpodBase()}/${encodeURIComponent(settings.runpodEndpoint)}/run`,
      { method: 'POST', headers: this.headers(settings), body: payload }, 'RunPod /run');
    if (!body || !body.id) throw new Error('O RunPod não devolveu o id da tarefa');
    return body.id;
  },
  async poll(settings, remoteId) {
    const body = await fetchJson(`${runpodBase()}/${encodeURIComponent(settings.runpodEndpoint)}/status/${encodeURIComponent(remoteId)}`,
      { headers: this.headers(settings) }, 'RunPod /status');
    if (['IN_QUEUE', 'IN_PROGRESS'].includes(body.status)) return null;
    if (body.status !== 'COMPLETED') throw Object.assign(new Error(`Tarefa do RunPod ${String(body.status).toLowerCase()}: ${body.error || ''}`.trim()), { final: true });
    const images = (body.output && body.output.images) || [];
    if (!images.length && body.output && typeof body.output.message === 'string') {
      throw Object.assign(new Error('Este endpoint usa worker-comfyui anterior à 5.0; atualize a imagem do worker.'), { final: true });
    }
    const files = [];
    for (const img of images) {
      if (img.type === 's3_url') {
        const response = await fetch(img.data);
        if (!response.ok) throw new Error('Não foi possível baixar ' + img.filename);
        files.push({ buffer: Buffer.from(await response.arrayBuffer()), filename: img.filename });
      } else {
        files.push({ buffer: Buffer.from(String(img.data).replace(/^data:[^,]+,/, ''), 'base64'), filename: img.filename });
      }
    }
    return files;
  }
};

// ---- progress --------------------------------------------------------------
// ComfyUI reports step progress of each prompt on its websocket. We listen
// while jobs are being watched; RunPod does not report steps, so only job
// counts move there.

const stepProgress = new Map();   // promptId -> { value, max }
let socket = null;

function onSocketMessage(raw) {
  if (typeof raw !== 'string') return;
  let message;
  try { message = JSON.parse(raw); } catch (_) { return; }
  const d = message.data || {};
  if (!d.prompt_id) return;
  if (message.type === 'progress' && d.max > 0) stepProgress.set(d.prompt_id, { value: d.value, max: d.max });
  else if (['execution_success', 'execution_error', 'execution_interrupted'].includes(message.type)) stepProgress.delete(d.prompt_id);
}

function followProgress(settings) {
  if (settings.provider !== 'local' || typeof WebSocket === 'undefined') return;
  if (socket && socket.readyState <= 1) return;
  try {
    socket = new WebSocket(settings.localUrl.replace(/^http/, 'ws') + '/ws?clientId=milaclone');
    socket.onmessage = e => onSocketMessage(e.data);
    socket.onclose = () => { socket = null; };
    socket.onerror = () => {};
  } catch (_) { socket = null; }
}

function stopFollowing() {
  if (watching.size === 0 && socket) { try { socket.close(); } catch (_) {} socket = null; }
}

// stop a job: drop it from the queue and, if it is the one running, interrupt it
local.cancel = async (settings, remoteId) => {
  const queue = await fetchJson(settings.localUrl + '/queue', {}, 'ComfyUI /queue');
  const running = (queue.queue_running || []).some(e => e[1] === remoteId);
  await fetchJson(settings.localUrl + '/queue', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delete: [remoteId] })
  }, 'ComfyUI /queue').catch(() => {});
  if (running) await fetch(settings.localUrl + '/interrupt', { method: 'POST' });
};
runpod.cancel = async (settings, remoteId) => {
  await fetch(`${runpodBase()}/${encodeURIComponent(settings.runpodEndpoint)}/cancel/${encodeURIComponent(remoteId)}`,
    { method: 'POST', headers: runpod.headers(settings) });
};

const providers = { local, runpod };

// ---- turning a local ComfyUI on ----------------------------------------------
// With a start file set (⋯ → Configurar ComfyUI, e.g. run_nvidia_gpu.bat), a run
// that finds ComfyUI off starts it and waits until it answers; ComfyUI opens in
// its own window so its log stays visible.

const LAUNCH_WAIT_MS = Number(process.env.COMFY_LAUNCH_WAIT_MS) || 3 * 60 * 1000;
let launching = null;

async function localUp(url) {
  try { await fetchJson(url + '/system_stats', { signal: AbortSignal.timeout(2500) }, 'ComfyUI'); return true; } catch (_) { return false; }
}

async function startLocal() {
  const s = readSettings();
  if (await localUp(s.localUrl)) return { ok: true, already: true };
  if (!s.localLaunch) throw httpError(`O ComfyUI não responde em ${s.localUrl}. Ligue-o, ou informe o arquivo de inicialização em Configurar ComfyUI para o Milaclone ligar sozinho.`, 409);
  if (!fs.existsSync(s.localLaunch)) throw httpError('Arquivo de inicialização não encontrado: ' + s.localLaunch, 409);
  if (!launching) {
    launching = (async () => {
      const dir = path.dirname(s.localLaunch);
      const opts = { cwd: dir, detached: true, stdio: 'ignore', windowsHide: process.env.COMFY_LAUNCH_HIDE === '1' };
      const child = process.platform === 'win32' && /\.(bat|cmd)$/i.test(s.localLaunch)
        ? require('child_process').spawn('cmd.exe', ['/d', '/c', s.localLaunch], opts)
        : require('child_process').spawn(s.localLaunch, [], opts);
      child.on('error', () => {});
      child.unref();
      const until = Date.now() + LAUNCH_WAIT_MS;
      while (Date.now() < until) {
        if (await localUp(s.localUrl)) return;
        await new Promise(r => setTimeout(r, 1000));
      }
      throw httpError('O ComfyUI foi iniciado mas ainda não respondeu. Veja a janela dele e tente de novo.', 504);
    })().finally(() => { launching = null; });
  }
  await launching;
  return { ok: true, started: true };
}

async function testConnection() {
  const s = readSettings();
  if (s.provider === 'local') {
    const stats = await fetchJson(s.localUrl + '/system_stats', {}, 'ComfyUI');
    return { ok: true, detail: 'ComfyUI ' + (stats?.system?.comfyui_version || 'acessível') };
  }
  const body = await fetchJson(`${runpodBase()}/${encodeURIComponent(s.runpodEndpoint)}/health`, { headers: runpod.headers(s) }, 'RunPod');
  const w = body && body.workers || {};
  return { ok: true, detail: `Endpoint RunPod pronto · ${w.idle || 0} workers livres, ${w.running || 0} trabalhando` };
}

// ---- results ---------------------------------------------------------------

let onChange = () => {};
function setChangeListener(fn) { onChange = fn; }

const CELL = 280, COLS = 4, PAD = 20, TITLE = 30;

// Rough size of a card on the board (cards grow in the browser, so heights of
// text cards are estimates). Cards inside columns and lines take no room.
const GUESS_H = { note: 320, todo: 240, link: 130, board: 170, comment: 90, file: 90, column: 420, comfy: 470, node: 120 };
function boxOf(row) {
  const it = rowToItem(row);
  const w = it.w || (it.type === 'image' ? 260 : 240);
  const h = it.type === 'image' ? Math.round(w * (it.data.naturalH || 1) / (it.data.naturalW || 1)) : (it.h || GUESS_H[it.type] || 200);
  return { id: it.id, x: it.x, y: it.y, w, h };
}

// Room a batch of results needs: the frame is laid out in columns like
// placeResults does, so reserve its final size up front instead of letting it
// grow over its neighbours later.
function reservedSize(count, aspect) {
  const cols = Math.min(COLS, Math.max(2, count));
  const rows = Math.ceil(count / cols);
  return { w: cols * CELL + PAD, h: TITLE + PAD + rows * (Math.round(260 * aspect) + 16) + PAD };
}

const overlaps = (r, o, gap = 24) => r.x < o.x + o.w + gap && r.x + r.w + gap > o.x && r.y < o.y + o.h + gap && r.y + r.h + gap > o.y;

// The frame that holds one batch of results. Preferred spot: under the card
// the job was made from (later batches stack below earlier ones so the best
// can be picked); if that is taken by other cards, to its right; failing that,
// below everything on the board, tied back to the source by a dashed line.
// With no source it sits next to the node.
function resultGroup(node, job, size) {
  const items = db.prepare(`SELECT * FROM items WHERE canvasId = ? AND type = 'group'
                            AND json_extract(data, '$.comfyBatch') = ?`).all(node.canvasId, job.batchId).map(rowToItem);
  if (items.length) return items[0];
  const anchorRow = job.anchorId && stmt.getItem.get(job.anchorId);
  const anchor = anchorRow && anchorRow.canvasId === node.canvasId ? rowToItem(anchorRow) : null;
  const anchorBox = anchorRow ? boxOf(anchorRow) : null;
  const taken = db.prepare(`SELECT * FROM items WHERE canvasId = ? AND parentItemId IS NULL AND type NOT IN ('line')`)
    .all(node.canvasId).filter(r => r.id !== job.anchorId).map(boxOf);
  const free = (x, y) => !taken.some(o => overlaps({ x, y, w: size.w, h: size.h }, o));

  const earlier = db.prepare(`SELECT * FROM items WHERE canvasId = ? AND type = 'group'
                              AND json_extract(data, '$.comfyNode') IS NOT NULL`).all(node.canvasId).map(rowToItem)
    .filter(g => anchor ? g.data.comfyAnchor === anchor.id : (g.data.comfyNode === node.id && !g.data.comfyAnchor));
  const belowEarlier = y => earlier.reduce((m, g) => Math.max(m, g.y + g.h + 40), y);

  let x, y, linked = false;
  if (anchor) {
    const wide = anchor.type === 'group' ? Math.max(size.w, anchor.w) : size.w;
    size = { ...size, w: wide };
    const below = { x: anchorBox.x, y: belowEarlier(anchorBox.y + anchorBox.h + 40) };
    const right = { x: anchorBox.x + anchorBox.w + 40, y: belowEarlier(anchorBox.y) };
    const pick = [below, right].find(c => free(c.x, c.y));
    if (pick) ({ x, y } = pick);
    else { x = anchorBox.x; y = belowEarlier(Math.max(0, ...taken.map(o => o.y + o.h)) + 60); linked = true; }
  } else {
    x = Math.round(node.x + (node.w || 300) + 80); y = belowEarlier(Math.round(node.y));
    if (!free(x, y)) { y = belowEarlier(Math.max(0, ...taken.map(o => o.y + o.h)) + 60); }
  }
  const group = {
    id: id('i_'), canvasId: node.canvasId, parentItemId: null, type: 'group',
    x: Math.round(x), y: Math.round(y),
    w: size.w, h: size.h, z: 0, color: 'purple',
    data: { title: 'ComfyUI · ' + (String(job.prompt || '').trim().slice(0, 48) || 'resultados'), comfyBatch: job.batchId, comfyNode: node.id, comfyAnchor: anchor ? anchor.id : null },
    createdAt: Date.now()
  };
  stmt.insertItem.run({ ...group, data: JSON.stringify(group.data) });
  if (linked) {
    // far from its source: a dashed line shows where the results came from
    stmt.insertItem.run({ id: id('i_'), canvasId: node.canvasId, parentItemId: null, type: 'line', x: 0, y: 0, w: 0, h: null, z: 0, color: null,
      data: JSON.stringify({ from: anchor.id, to: group.id, arrow: 'end', dashed: true, label: job.kind === 'enhance' ? 'aprimorada' : 'resultados' }), createdAt: Date.now() });
  }
  return group;
}

async function placeResults(job, files, uploadDir) {
  const nodeRow = stmt.getItem.get(job.itemId);
  const canvasId = nodeRow ? nodeRow.canvasId : job.canvasId;
  if (!stmt.getCanvas.get(canvasId)) return;
  const node = nodeRow ? rowToItem(nodeRow) : { id: job.itemId, canvasId, x: 0, y: 0, w: 300 };
  const saved = [];
  for (const f of files) {
    const ext = (path.extname(f.filename) || '.png').toLowerCase();
    const filename = Date.now() + '-' + crypto.randomBytes(5).toString('hex') + ext;
    fs.writeFileSync(path.join(uploadDir, filename), f.buffer);
    let meta = {};
    try { meta = await sharp(f.buffer).metadata(); } catch (_) {}
    saved.push({ filename, name: f.filename, w: meta.width || 1, h: meta.height || 1 });
  }
  const batchSize = db.prepare('SELECT COUNT(*) AS n FROM comfy_jobs WHERE batchId = ?').get(job.batchId).n;
  const size = reservedSize(Math.max(batchSize, saved.length), saved[0] ? saved[0].h / saved[0].w : 1);
  db.transaction(() => {
    const group = resultGroup(node, job, size);
    const members = db.prepare(`SELECT * FROM items WHERE canvasId = ? AND type = 'image'
                                AND json_extract(data, '$.groupId') = ?`).all(canvasId, group.id).map(rowToItem);
    const heights = Array(COLS).fill(group.y + TITLE + PAD);
    for (const m of members) {
      const col = Math.max(0, Math.min(COLS - 1, Math.round((m.x - group.x - PAD) / CELL)));
      heights[col] = Math.max(heights[col], m.y + Math.round(260 * (m.data.naturalH || 1) / (m.data.naturalW || 1)) + 16);
    }
    let z = (stmt.maxZ.get().m || 0) + 1;
    for (const img of saved) {
      const col = heights.indexOf(Math.min(...heights));
      const h = Math.round(260 * img.h / img.w);
      const item = { id: id('i_'), canvasId, parentItemId: null, type: 'image',
        x: group.x + PAD + col * CELL, y: heights[col], w: 260, h: null, z: z++, color: null,
        data: JSON.stringify({ src: '/uploads/' + img.filename, name: img.name, naturalW: img.w, naturalH: img.h,
          groupId: group.id, comfyJob: job.id, comfyFrom: job.originId || null,
          ...(job.kind === 'enhance' ? { enhancedFrom: job.originId } : {}), prompt: job.prompt || '' }), createdAt: Date.now() };
      stmt.insertItem.run(item);
      if (job.kind === 'enhance' && job.originId) {
        const origin = stmt.getItem.get(job.originId);
        if (origin) {
          const o = rowToItem(origin);
          o.data = { ...o.data, enhanced: item.id };
          stmt.updateItem.run({ ...o, data: JSON.stringify(o.data) });
        }
      }
      heights[col] += h + 16;
      members.push({ ...item, data: JSON.parse(item.data) });
    }
    const usedCols = Math.min(COLS, Math.max(2, members.length));
    const fresh = rowToItem(stmt.getItem.get(group.id));
    fresh.w = Math.max(fresh.w, usedCols * CELL + PAD);
    fresh.h = Math.max(fresh.h, Math.max(...heights) - group.y + PAD);
    stmt.updateItem.run({ ...fresh, data: JSON.stringify(fresh.data) });
  })();
  onChange([canvasId]);
}

// ---- job loop --------------------------------------------------------------

const watching = new Set();

function setJob(jobId, status, error = null, remoteId = null) {
  q.setJob.run({ id: jobId, status, error, remoteId, now: Date.now() });
}

async function watch(jobId, uploadDir) {
  if (watching.has(jobId)) return;
  watching.add(jobId);
  try {
    const job = q.job.get(jobId);
    const settings = readSettings();
    const provider = providers[job.provider];
    let networkErrors = 0;
    while (Date.now() - job.createdAt < JOB_TIMEOUT_MS) {
      if (q.job.get(jobId).status === 'cancelled') return;
      let files;
      try {
        files = await provider.poll(settings, job.remoteId);
        networkErrors = 0;
      } catch (err) {
        // the job itself failed: stop; a flaky connection: retry a few times
        if (err.final || ++networkErrors >= 5) { setJob(jobId, 'failed', err.message); return; }
        await new Promise(r => setTimeout(r, POLL_MS * 2));
        continue;
      }
      if (files) {
        if (q.job.get(jobId).status === 'cancelled') return;
        if (!files.length) { setJob(jobId, 'failed', 'O workflow terminou sem salvar nenhuma imagem (adicione um nó SaveImage).'); return; }
        await placeResults(job, files, uploadDir);
        setJob(jobId, 'done');
        return;
      }
      if (q.job.get(jobId).status === 'queued') setJob(jobId, 'running');
      await new Promise(r => setTimeout(r, POLL_MS));
    }
    setJob(jobId, 'failed', 'Tempo esgotado');
  } finally {
    watching.delete(jobId);
    try { stepProgress.delete((q.job.get(jobId) || {}).remoteId); } catch (_) { /* database already closed (shutdown) */ }
    stopFollowing();
  }
}

// Submits queued jobs one after another in the background; inputs are encoded
// once per photo set, not once per variation.
function dispatch(jobs, { wf, prompt, negative, params, settings, uploadDir }) {
  (async () => {
    const encoded = new Map();
    for (const { job, set, seed } of jobs) {
      try {
        if (q.job.get(job.id).status === 'cancelled') continue;
        if (settings.provider === 'local') await startLocal();
        const key = set.map(x => (x.blank ? 'blank' : x.id)).join(',');
        if (!encoded.has(key)) {
          encoded.set(key, await Promise.all(set.map(async x => (x.blank
            ? { name: x.name, buffer: await blankImage() }
            : { name: x.name, buffer: await inputBuffer(x.file) }))));
        }
        const remoteId = await providers[settings.provider].submit(settings,
          names => buildPrompt(wf, { prompt, negative, imageNames: names, seed, params }),
          encoded.get(key));
        if (q.job.get(job.id).status === 'cancelled') { providers[settings.provider].cancel(settings, remoteId).catch(() => {}); continue; }
        setJob(job.id, 'running', null, remoteId);
        watch(job.id, uploadDir);
      } catch (err) {
        setJob(job.id, 'failed', err.message);
      }
    }
  })();
}

// Validates synchronously, queues the jobs, then submits them in the background.
function run(itemId, uploadDir) {
  const p = plan(itemId, uploadDir);
  if (p.error) throw httpError(p.error);
  const { node, wf } = p;
  const settings = readSettings();
  if (settings.provider === 'runpod') runpod.headers(settings);
  const runs = Math.max(1, Math.min(16, Number(node.data.runs) || 1));
  const total = p.jobs.length * runs;
  if (total > MAX_JOBS_PER_RUN) throw httpError(`Isso iniciaria ${total} tarefas; o limite é ${MAX_JOBS_PER_RUN} por vez.`);

  // seeds: random each time, one per batch (variation n of every photo shares
  // it, so the pictures of a set match), or the number the user typed
  const mode = node.data.seedMode;
  const typed = node.data.seed === '' || node.data.seed == null ? NaN : Math.trunc(Number(node.data.seed));
  const seedBase = mode === 'fixed' && Number.isFinite(typed) ? typed : mode === 'batch' ? crypto.randomInt(0, SEED_RANGE) : null;
  const given = node.data.params && typeof node.data.params === 'object' ? node.data.params : {};
  const params = scaledParams(wf, given, Number(node.data.testScale) || 1, p.scalable);
  const negative = String(node.data.negative || '');

  const batchId = id('b_');
  const jobs = [];
  for (const planned of p.jobs) {
    for (let v = 0; v < runs; v++) {
      const job = { id: id('j_'), itemId: node.id, canvasId: node.canvasId, batchId, provider: settings.provider,
        prompt: p.prompt, anchorId: p.anchor, originId: planned.originId, kind: null, now: Date.now() };
      q.insertJob.run(job);
      jobs.push({ job, set: planned.set, seed: seedBase == null ? null : seedBase + v });
    }
  }
  dispatch(jobs, { wf, prompt: p.prompt, negative, params, settings, uploadDir });
  return { batchId, jobs: total };
}

// ---- enhancer --------------------------------------------------------------
// One workflow (an upscaler such as SeedVR2) is chosen as the enhancer; any
// image on the board can be sent through it. Its settings live in `meta`.

function readEnhance() {
  let saved = {};
  try { saved = JSON.parse(stmt.getMeta.get('comfy.enhance')?.value || '{}'); } catch (_) {}
  return {
    workflowId: saved.workflowId && q.workflow.get(saved.workflowId) ? saved.workflowId : null,
    params: saved.params && typeof saved.params === 'object' ? saved.params : {},
    testScale: [0.25, 0.5, 0.75].includes(saved.testScale) ? saved.testScale : 1
  };
}

async function enhanceView() {
  const s = readEnhance();
  return { ...s, detail: s.workflowId ? await workflowDetail(s.workflowId) : null };
}

function saveEnhance(body = {}) {
  const s = readEnhance();
  if ('workflowId' in body) {
    if (body.workflowId && !q.workflow.get(body.workflowId)) throw httpError('Workflow não encontrado', 404);
    s.workflowId = body.workflowId || null;
  }
  if (body.params && typeof body.params === 'object') s.params = body.params;
  if ('testScale' in body) s.testScale = Number(body.testScale);
  stmt.setMeta.run('comfy.enhance', JSON.stringify(s));
  return readEnhance();
}

// Send images through the enhancer: one job per image, results framed under
// the group the images are in (or under the first image), marked on the
// original so the board shows it was enhanced.
function enhance(ids, uploadDir) {
  const s = readEnhance();
  const wfRow = s.workflowId && q.workflow.get(s.workflowId);
  if (!wfRow) throw httpError('Escolha o workflow aprimorador antes (⋯ → Configurar ComfyUI ou o botão Aprimorar…)');
  const wf = JSON.parse(wfRow.json);
  const a = analyze(wf);
  if (a.inputs.length !== 1) throw httpError(`O workflow aprimorador precisa ter uma única entrada de imagem (este tem ${a.inputs.length}).`);
  const rows = [...new Set(Array.isArray(ids) ? ids : [])].map(id => stmt.getItem.get(id)).filter(Boolean);
  const photos = rows.map(r => photoOf(r, uploadDir)).filter(Boolean);
  if (!photos.length) throw httpError('Selecione ao menos uma imagem.');
  if (photos.length > MAX_JOBS_PER_RUN) throw httpError(`Isso iniciaria ${photos.length} tarefas; o limite é ${MAX_JOBS_PER_RUN} por vez.`);
  const settings = readSettings();
  if (settings.provider === 'runpod') runpod.headers(settings);

  const first = rowToItem(rows.find(r => r.id === photos[0].id));
  const groupIds = new Set(rows.map(r => rowToItem(r).data.groupId).filter(Boolean));
  const groupRow = groupIds.size === 1 ? stmt.getItem.get([...groupIds][0]) : null;
  const anchor = groupRow && groupRow.type === 'group' ? rowToItem(groupRow) : first;

  const params = scaledParams(wf, s.params, s.testScale, scalableOf(wfRow, analyze(wf).fields));
  const batchId = id('b_');
  const jobs = photos.map(photo => {
    const job = { id: id('j_'), itemId: anchor.id, canvasId: anchor.canvasId, batchId, provider: settings.provider,
      prompt: 'Aprimoramento', anchorId: anchor.id, originId: photo.id, kind: 'enhance', now: Date.now() };
    q.insertJob.run(job);
    return { job, set: [photo], seed: null };
  });
  dispatch(jobs, { wf, prompt: '', negative: '', params, settings, uploadDir });
  return { batchId, jobs: jobs.length, anchorId: anchor.id };
}

// How far a batch is: finished jobs count whole, running local ones by their
// current step. `indeterminate` when a running job reports no steps (RunPod).
function progressOf(batch) {
  if (!batch.length) return { fraction: 0, indeterminate: false };
  let sum = 0, unknown = false, step = null;
  for (const j of batch) {
    if (['done', 'failed', 'cancelled'].includes(j.status)) sum += 1;
    else if (j.status === 'running') {
      const sp = j.remoteId && stepProgress.get(j.remoteId);
      if (sp) { sum += Math.min(0.99, sp.value / sp.max); step = step || sp; } else unknown = true;
    }
  }
  return { fraction: Math.min(1, sum / batch.length), indeterminate: unknown, step };
}

function status(itemId) {
  const jobs = q.jobsForItem.all(itemId);
  const latest = jobs[0] && jobs[0].batchId;
  const batch = jobs.filter(j => j.batchId === latest);
  const count = s => batch.filter(j => j.status === s).length;
  return {
    batchId: latest || null,
    total: batch.length, queued: count('queued'), running: count('running'), done: count('done'), failed: count('failed'),
    cancelled: count('cancelled'), recoverable: batch.filter(recoverable).length, ...progressOf(batch),
    errors: [...new Set(batch.filter(j => j.error && j.status === 'failed').map(j => j.error))].slice(0, 3)
  };
}

// Stop what is still queued or running in the node's latest batch.
async function cancel(itemId) {
  const jobs = q.jobsForItem.all(itemId);
  const latest = jobs[0] && jobs[0].batchId;
  const live = jobs.filter(j => j.batchId === latest && (j.status === 'queued' || j.status === 'running'));
  const settings = readSettings();
  for (const j of live) {
    const full = q.job.get(j.id);
    setJob(j.id, 'cancelled', 'Cancelada');
    if (full.remoteId) { try { await providers[full.provider].cancel(settings, full.remoteId); } catch (_) { /* already gone */ } }
  }
  return { cancelled: live.length };
}

function resume(uploadDir) {
  for (const job of q.pending.all()) {
    if (job.remoteId) watch(job.id, uploadDir);
    else setJob(job.id, 'failed', 'Interrompida por reinício do servidor antes do envio');
  }
  // jobs given up on while their images were still coming (e.g. the old 30
  // minute limit): look for them again
  for (const job of q.recent.all(Date.now() - 24 * 60 * 60 * 1000)) {
    if (recoverable(job)) { setJob(job.id, 'running', null, null); watch(job.id, uploadDir); }
  }
}

// Fetch again the results of jobs the Milaclone stopped waiting for.
function recover(itemId, uploadDir) {
  const jobs = q.jobsForItem.all(itemId).filter(recoverable);
  for (const j of jobs) {
    q.setJob.run({ id: j.id, status: 'running', error: null, remoteId: null, now: Date.now() });
    watch(j.id, uploadDir);
  }
  return { recovering: jobs.length };
}

module.exports = {
  publicSettings, saveSettings, listWorkflows, addWorkflow, testConnection, workflowDetail, setExposed, planView, cancel,
  enhance, enhanceView, saveEnhance, recover, startLocal, _onSocketMessage: onSocketMessage,
  removeWorkflow: wid => q.deleteWorkflow.run(wid).changes > 0,
  run, status, resume, setChangeListener, analyze, buildPrompt
};
