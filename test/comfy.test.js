'use strict';

// ComfyUI bridge against fake ComfyUI and RunPod servers: workflow import and
// analysis, prompt/seed/image injection, local and RunPod runs that come back
// as image cards in a group, per-photo batching and failure reporting.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-test-'));
process.env.DATA_DIR = TMP;
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.COMFY_POLL_MS = '20';

const express = require('express');

// Text-to-image (txt2img) and image-to-image (img2img) workflows in API format.
const TXT2IMG = {
  3: { class_type: 'KSampler', inputs: { seed: 1, steps: 20, positive: ['6', 0], negative: ['7', 0], model: ['4', 0], latent_image: ['5', 0] } },
  4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'x.safetensors' } },
  5: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
  6: { class_type: 'CLIPTextEncode', inputs: { text: 'old positive', clip: ['4', 1] } },
  7: { class_type: 'CLIPTextEncode', inputs: { text: 'old negative', clip: ['4', 1] } },
  9: { class_type: 'SaveImage', inputs: { images: ['8', 0] } }
};
const IMG2IMG = Object.assign({}, TXT2IMG, { 10: { class_type: 'LoadImage', inputs: { image: 'placeholder.png' } } });

const { fakeComfy, fakeRunpod, received, ready } = require('./fake-comfy');
let png;

let base, servers = [];
const listen = app => new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); servers.push(s); });

test.before(async () => {
  await ready;
  png = await sharp({ create: { width: 64, height: 96, channels: 3, background: '#a33' } }).png().toBuffer();
  const comfy = await listen(fakeComfy());
  const rp = await listen(fakeRunpod());
  process.env.COMFYUI_URL = 'http://127.0.0.1:' + comfy.address().port;
  process.env.RUNPOD_API_BASE = 'http://127.0.0.1:' + rp.address().port + '/v2';
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use(require('../backend/routes'));
  const s = await listen(app);
  base = 'http://127.0.0.1:' + s.address().port;
});
test.after(async () => {
  for (const s of servers) { s.closeAllConnections(); await new Promise(r => s.close(r)); }
  require('../backend/db').db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const send = (m, p, b) => fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b && JSON.stringify(b) })
  .then(async r => ({ status: r.status, body: await r.json() }));
const get = p => send('GET', p);
const root = async () => (await get('/api/root')).body.rootCanvasId;

async function photo(canvasId, x) {
  const fd = new FormData();
  fd.append('file', new Blob([png], { type: 'image/png' }), 'ref.png');
  const up = await fetch(base + '/api/upload', { method: 'POST', body: fd }).then(r => r.json());
  return (await send('POST', '/api/item', { canvasId, type: 'image', x, y: 0, data: { src: up.src, name: 'ref.png', naturalW: 64, naturalH: 96 } })).body;
}

async function waitFor(itemId, predicate) {
  for (let i = 0; i < 200; i++) {
    const s = (await get('/api/comfy/status/' + itemId)).body;
    if (predicate(s)) return s;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error('timed out waiting for jobs');
}

test('workflow import rejects the editor format and describes API-format files', async () => {
  const bad = await send('POST', '/api/comfy/workflows', { name: 'UI', json: JSON.stringify({ nodes: [], links: [] }) });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /Export \(API\)/);
  assert.equal((await send('POST', '/api/comfy/workflows', { name: 'Broken', json: '{oops' })).status, 400);
  const ok = (await send('POST', '/api/comfy/workflows', { name: 'Retrato', json: JSON.stringify(IMG2IMG) })).body;
  assert.equal(ok.imageInputs, 1);
  assert.equal(ok.hasPrompt, true);
  assert.equal(ok.hasNegative, true);
});

test('prompt, negative, seeds and image names are injected into the right nodes', () => {
  const comfy = require('../backend/comfy');
  const out = comfy.buildPrompt(IMG2IMG, { prompt: 'red uniform', negative: 'blurry', imageNames: ['a.png'] });
  assert.equal(out['6'].inputs.text, 'red uniform');
  assert.equal(out['7'].inputs.text, 'blurry');
  assert.equal(out['10'].inputs.image, 'a.png');
  assert.notEqual(out['3'].inputs.seed, 1);
  assert.equal(IMG2IMG['6'].inputs.text, 'old positive', 'the stored workflow is not mutated');
});

test('local ComfyUI run: variations come back as image cards inside a group', async () => {
  const canvasId = await root();
  await send('PUT', '/api/comfy/settings', { provider: 'local' });
  assert.match((await send('POST', '/api/comfy/test')).body.detail, /0\.3\.test/);
  const wf = (await send('POST', '/api/comfy/workflows', { name: 'Texto', json: JSON.stringify(TXT2IMG) })).body;
  const node = (await send('POST', '/api/item', { canvasId, type: 'comfy', x: 100, y: 100, w: 320,
    data: { workflowId: wf.id, prompt: 'uniforme azul', runs: 3 } })).body;
  const started = (await send('POST', '/api/comfy/run/' + node.id)).body;
  assert.equal(started.jobs, 3);
  const s = await waitFor(node.id, x => x.done === 3);
  assert.equal(s.failed, 0);
  assert.equal(received.prompts.at(-1)['6'].inputs.text, 'uniforme azul');
  const items = (await get('/api/canvas/' + canvasId)).body.items;
  const group = items.find(i => i.type === 'group' && i.data.comfyNode === node.id);
  assert.ok(group, 'results are framed in a group');
  const images = items.filter(i => i.type === 'image' && i.data.groupId === group.id);
  assert.equal(images.length, 3, 'temp previews are skipped');
  assert.ok(images.every(i => i.x >= group.x && i.x + 260 <= group.x + group.w));
  assert.ok(images[0].data.src.startsWith('/uploads/'));
  assert.ok(fs.existsSync(path.join(process.env.UPLOAD_DIR, path.basename(images[0].data.src))));
});

test('RunPod run: one job per connected photo, inputs sent as base64', async () => {
  const canvasId = await root();
  await send('PUT', '/api/comfy/settings', { provider: 'runpod', runpodEndpoint: 'ep1', runpodKey: 'rp-key' });
  const settings = (await get('/api/comfy/settings')).body;
  assert.equal(settings.hasRunpodKey, true);
  assert.equal(settings.runpodKey, undefined, 'the key never goes back to the browser');
  assert.match((await send('POST', '/api/comfy/test')).body.detail, /2 workers livres/);

  const wf = (await send('POST', '/api/comfy/workflows', { name: 'Img', json: JSON.stringify(IMG2IMG) })).body;
  const node = (await send('POST', '/api/item', { canvasId, type: 'comfy', x: 900, y: 100, w: 320,
    data: { workflowId: wf.id, prompt: 'estampa floral', runs: 1 } })).body;
  const missing = await send('POST', '/api/comfy/run/' + node.id);
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /precisa de 1 foto/);

  for (const x of [0, 300]) {
    const p = await photo(canvasId, x);
    await send('POST', '/api/item', { canvasId, type: 'line', data: { from: p.id, to: node.id } });
  }
  const before = received.runpod.length;
  assert.equal((await send('POST', '/api/comfy/run/' + node.id)).body.jobs, 2);
  const s = await waitFor(node.id, x => x.done + x.failed === 2);
  assert.equal(s.done, 2);
  const sent = received.runpod.slice(before);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].images.length, 1);
  assert.equal(sent[0].workflow['10'].inputs.image, sent[0].images[0].name);
  assert.ok(Buffer.from(sent[0].images[0].image, 'base64').length > 50);
});

test('a failed RunPod job reports its error on the node', async () => {
  const canvasId = await root();
  const wf = (await send('POST', '/api/comfy/workflows', { name: 'Fail', json: JSON.stringify(TXT2IMG) })).body;
  const node = (await send('POST', '/api/item', { canvasId, type: 'comfy', data: { workflowId: wf.id, prompt: 'please fail' } })).body;
  await send('POST', '/api/comfy/run/' + node.id);
  const s = await waitFor(node.id, x => x.failed === 1);
  assert.match(s.errors[0], /CUDA out of memory/);
});

// ---- slots, groups, fields, seeds, notes, stacking, cancel -----------------

// Try-on shaped workflow: a garment slot and a model slot, plus a KSampler with
// fields worth exposing.
const TRYON = Object.assign({}, TXT2IMG, {
  10: { class_type: 'LoadImage', inputs: { image: 'a.png' }, _meta: { title: 'Peça' } },
  11: { class_type: 'LoadImage', inputs: { image: 'b.png' }, _meta: { title: 'Modelo' } }
});

async function colored(canvasId, x, color, groupId) {
  const buf = await sharp({ create: { width: 64, height: 96, channels: 3, background: color } }).png().toBuffer();
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'image/png' }), color + '.png');
  const up = await fetch(base + '/api/upload', { method: 'POST', body: fd }).then(r => r.json());
  const data = { src: up.src, name: color + '.png', naturalW: 64, naturalH: 96 };
  if (groupId) data.groupId = groupId;
  return (await send('POST', '/api/item', { canvasId, type: 'image', x, y: 0, data })).body;
}
const link = (canvasId, from, to) => send('POST', '/api/item', { canvasId, type: 'line', data: { from, to } });
const redOf = async (b64) => (await sharp(Buffer.from(b64, 'base64')).stats()).channels[0].mean;

async function tryonSetup(extra = {}) {
  const canvasId = await root();
  await send('PUT', '/api/comfy/settings', { provider: 'runpod', runpodEndpoint: 'ep1', runpodKey: 'rp-key' });
  const wf = (await send('POST', '/api/comfy/workflows', { name: 'Try-on ' + Math.random(), json: JSON.stringify(TRYON) })).body;
  const group = (await send('POST', '/api/item', { canvasId, type: 'group', x: 100, y: 2000, w: 700, h: 400, data: { title: 'Camisa Manga Longa' } })).body;
  const garments = [];
  for (const [i, c] of ['#ff0000', '#00ff00', '#0000ff'].entries()) garments.push(await colored(canvasId, 120 + i * 220, c, group.id));
  const model = await colored(canvasId, 900, '#ffff00');
  const node = (await send('POST', '/api/item', { canvasId, type: 'comfy', x: 1000, y: 2000, w: 320,
    data: { workflowId: wf.id, prompt: 'camisa vinho', runs: 1, ...extra } })).body;
  await link(canvasId, group.id, node.id);
  await link(canvasId, model.id, node.id);
  return { canvasId, wf, group, garments, model, node };
}

test('workflows are classified by what they do: generate, edit or upscale', async () => {
  const comfy = require('../backend/comfy');
  assert.equal(comfy.analyze(TXT2IMG).kind, 'generate');
  assert.equal(comfy.analyze(IMG2IMG).kind, 'edit');
  assert.equal(comfy.analyze(UPSCALE).kind, 'upscale', 'a PreviewImage-only upscaler with no prompt');
  const withPrompt = { ...TXT2IMG, 10: { class_type: 'LoadImage', inputs: { image: 'x.png' } }, 12: { class_type: 'SeedVR2VideoUpscaler', inputs: { image: ['10', 0], resolution: 2048 } } };
  delete withPrompt[6]; delete withPrompt[7]; delete withPrompt[3];
  assert.equal(comfy.analyze(withPrompt).kind, 'upscale');
  const listed = (await get('/api/comfy/workflows')).body.workflows;
  assert.ok(listed.every(w => ['generate', 'edit', 'upscale'].includes(w.kind)));
});

test('workflow detail lists slots by title and fields with limits from ComfyUI', async () => {
  await send('PUT', '/api/comfy/settings', { provider: 'local' });
  const { wf } = await tryonSetup();
  const d = (await get('/api/comfy/workflows/' + wf.id)).body;
  assert.deepEqual(d.inputs.map(i => i.title), ['Peça', 'Modelo']);
  const steps = d.fields.find(f => f.id === '3.steps');
  assert.equal(steps.max, 100);
  assert.ok(!d.fields.some(f => f.name === 'seed' || f.name === 'text' || f.node === '10'), 'seed, prompt text and image loaders are not fields');
  assert.deepEqual((await send('PUT', '/api/comfy/workflows/' + wf.id + '/exposed', { exposed: ['3.steps'] })).body.exposed, ['3.steps']);
  assert.deepEqual((await get('/api/comfy/workflows/' + wf.id)).body.exposed, ['3.steps']);
});

test('a group feeds one job per photo; the other slot stays the same', async () => {
  const { node } = await tryonSetup();
  const view = (await get('/api/comfy/plan/' + node.id)).body;
  assert.equal(view.error, null);
  assert.equal(view.sets, 3);
  // slots default to the sources in the order they were linked
  assert.deepEqual(view.slots.map(s => [s.title, s.kind, s.count]), [['Peça', 'set', 3], ['Modelo', 'single', 1]]);
  const before = received.runpod.length;
  assert.equal((await send('POST', '/api/comfy/run/' + node.id)).body.jobs, 3);
  await waitFor(node.id, x => x.done === 3);
  const sent = received.runpod.slice(before);
  assert.equal(sent.length, 3);
  const garmentReds = await Promise.all(sent.map(s => redOf(s.images[0].image)));
  assert.equal(garmentReds.filter(r => r > 200).length, 1, 'each photo of the group is used once');
  assert.equal(new Set(await Promise.all(sent.map(async s => Math.round(await redOf(s.images[1].image))))).size, 1, 'the model is the same in every job');
  assert.equal(sent[0].workflow['10'].inputs.image, sent[0].images[0].name);
  assert.equal(sent[0].workflow['11'].inputs.image, sent[0].images[1].name);
});

test('a slot can take a chosen source or a blank image', async () => {
  const { node, group, model, canvasId } = await tryonSetup();
  // swap: model photo into the first slot, the group into the second
  await send('PATCH', '/api/item/' + node.id, { data: { slots: { 10: model.id, 11: group.id } } });
  const view = (await get('/api/comfy/plan/' + node.id)).body;
  assert.deepEqual(view.slots.map(s => [s.kind, s.count]), [['single', 1], ['set', 3]]);
  // no model at all: a blank image goes in its place
  await send('PATCH', '/api/item/' + node.id, { data: { slots: { 10: group.id, 11: 'blank' } } });
  const before = received.runpod.length;
  assert.equal((await send('POST', '/api/comfy/run/' + node.id)).body.jobs, 3);
  await waitFor(node.id, x => x.done === 3);
  const sent = received.runpod.slice(before);
  assert.ok((await redOf(sent[0].images[1].image)) > 250, 'blank is white');
  // two groups with different sizes cannot be paired
  const other = (await send('POST', '/api/item', { canvasId, type: 'group', x: 100, y: 3000, w: 400, h: 300, data: { title: 'Outro' } })).body;
  await colored(canvasId, 120, '#123456', other.id);
  await link(canvasId, other.id, node.id);
  await send('PATCH', '/api/item/' + node.id, { data: { slots: { 10: group.id, 11: other.id } } });
  const bad = await send('POST', '/api/comfy/run/' + node.id);
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /quantidades diferentes/);
});

test('exposed fields override the workflow; seeds follow the chosen mode', async () => {
  const { node } = await tryonSetup({ params: { '3.steps': '35', '99.nope': '1', '5.width': 768 }, seedMode: 'batch', runs: 2 });
  let before = received.runpod.length;
  await send('POST', '/api/comfy/run/' + node.id);
  await waitFor(node.id, x => x.done === 6);
  let sent = received.runpod.slice(before);
  assert.ok(sent.every(s => s.workflow['3'].inputs.steps === 35 && s.workflow['5'].inputs.width === 768));
  const seeds = sent.map(s => s.workflow['3'].inputs.seed);
  assert.equal(new Set(seeds).size, 2, 'variations differ, photos of the same variation share a seed');
  assert.ok(seeds.every(x => x >= 0 && x < 2 ** 32), 'seeds fit nodes that cap at 2^32 (SeedVR2)');

  await send('PATCH', '/api/item/' + node.id, { data: { seedMode: 'fixed', seed: 777, runs: 1 } });
  before = received.runpod.length;
  await send('POST', '/api/comfy/run/' + node.id);
  await waitFor(node.id, x => x.done === 3);
  sent = received.runpod.slice(before);
  assert.deepEqual(sent.map(s => s.workflow['3'].inputs.seed), [777, 777, 777]);

  await send('PATCH', '/api/item/' + node.id, { data: { seedMode: 'random' } });
  before = received.runpod.length;
  await send('POST', '/api/comfy/run/' + node.id);
  await waitFor(node.id, x => x.done === 3);
  assert.equal(new Set(received.runpod.slice(before).map(s => s.workflow['3'].inputs.seed)).size, 3);
});

test('a linked note is the prompt, English twin first, card prompt added after', async () => {
  const { node, canvasId } = await tryonSetup({ prompt: 'estúdio, fundo cinza' });
  const pt = (await send('POST', '/api/item', { canvasId, type: 'note', x: 0, y: 0, w: 240, data: { title: 'Prompt', body: 'camisa vinho de manga longa', lang: 'pt' } })).body;
  const en = (await send('POST', '/api/item', { canvasId, type: 'note', x: 300, y: 0, w: 240, data: { title: 'Prompt', body: 'long sleeve burgundy shirt', lang: 'en', translationOf: pt.id } })).body;
  await send('PATCH', '/api/item/' + pt.id, { data: { translation: en.id } });
  await link(canvasId, pt.id, node.id);
  const view = (await get('/api/comfy/plan/' + node.id)).body;
  assert.equal(view.notes.length, 1);
  assert.equal(view.prompt, 'long sleeve burgundy shirt\n\nestúdio, fundo cinza');
  const before = received.runpod.length;
  await send('POST', '/api/comfy/run/' + node.id);
  await waitFor(node.id, x => x.done === 3);
  assert.equal(received.runpod[before].workflow['6'].inputs.text, 'long sleeve burgundy shirt\n\nestúdio, fundo cinza');
});

test('results sit under the source group and later batches stack below', async () => {
  const { node, group, canvasId } = await tryonSetup();
  await send('POST', '/api/comfy/run/' + node.id);
  const first = await waitFor(node.id, x => x.done === 3);
  await send('POST', '/api/comfy/run/' + node.id);
  await waitFor(node.id, x => x.done === 3 && x.batchId !== first.batchId);
  const items = (await get('/api/canvas/' + canvasId)).body.items;
  const frames = items.filter(i => i.type === 'group' && i.data.comfyNode === node.id).sort((a, b) => a.y - b.y);
  assert.equal(frames.length, 2);
  assert.ok(frames.every(f => f.data.comfyAnchor === group.id && f.x === group.x), 'under the source group, left edges aligned');
  assert.ok(frames[0].y >= group.y + group.h, 'first batch is under the source');
  assert.ok(frames[1].y >= frames[0].y + frames[0].h, 'second batch stacks below the first');
  const imgs = items.filter(i => i.type === 'image' && i.data.groupId === frames[0].id);
  assert.equal(imgs.length, 3);
  assert.ok(imgs.every(i => i.data.comfyFrom), 'each result remembers the photo it came from');
});

test('cancelling stops the running jobs of the latest batch', async () => {
  const { node } = await tryonSetup({ prompt: 'please wait' });
  await send('POST', '/api/comfy/run/' + node.id);
  await waitFor(node.id, x => x.running === 3);
  const before = received.cancelled.length;
  assert.equal((await send('POST', '/api/comfy/cancel/' + node.id)).body.cancelled, 3);
  const s = (await get('/api/comfy/status/' + node.id)).body;
  assert.equal(s.cancelled, 3);
  assert.equal(s.failed, 0);
  assert.equal(received.cancelled.length - before, 3, 'RunPod was told to cancel each job');
  await new Promise(r => setTimeout(r, 120));   // let the cancelled watchers notice and stop
});

// ---- preview-only workflows, test size, enhancer, progress -----------------

// An upscaler that ends in a Preview node (nothing is saved to disk).
const UPSCALE = {
  10: { class_type: 'LoadImage', inputs: { image: 'x.png' } },
  12: { class_type: 'SeedVR2VideoUpscaler', inputs: { image: ['10', 0], seed: 5, resolution: 4096, max_resolution: 0, batch_size: 5 } },
  6: { class_type: 'PreviewImage', inputs: { images: ['12', 0] } }
};

test('a workflow that only ends in a Preview node still returns its images', async () => {
  const canvasId = await root();
  await send('PUT', '/api/comfy/settings', { provider: 'local' });
  const wf = (await send('POST', '/api/comfy/workflows', { name: 'Preview only', json: JSON.stringify(UPSCALE) })).body;
  const node = (await send('POST', '/api/item', { canvasId, type: 'comfy', x: 100, y: 5000, w: 320, data: { workflowId: wf.id } })).body;
  const p = await photo(canvasId, 0);
  await link(canvasId, p.id, node.id);
  await send('POST', '/api/comfy/run/' + node.id);
  const s = await waitFor(node.id, x => x.done + x.failed === 1);
  assert.equal(s.done, 1, s.errors[0]);
});

test('test size scales the size fields of a card down, keeping multiples of 16', async () => {
  const canvasId = await root();
  await send('PUT', '/api/comfy/settings', { provider: 'local' });
  const wf = (await send('POST', '/api/comfy/workflows', { name: 'Sizes', json: JSON.stringify(UPSCALE) })).body;
  const d = (await get('/api/comfy/workflows/' + wf.id)).body;
  assert.deepEqual(d.suggested.sort(), ['12.max_resolution', '12.resolution']);
  const node = (await send('POST', '/api/item', { canvasId, type: 'comfy', x: 100, y: 5200, w: 320,
    data: { workflowId: wf.id, testScale: 0.25 } })).body;
  const p = await photo(canvasId, 0);
  await link(canvasId, p.id, node.id);
  const before = received.prompts.length;
  await send('POST', '/api/comfy/run/' + node.id);
  await waitFor(node.id, x => x.done === 1);
  const sent = received.prompts[before]['12'].inputs;
  assert.equal(sent.resolution, 1024);
  assert.equal(sent.max_resolution, 0, 'zero means no limit and is left alone');
  assert.equal(sent.batch_size, 5, 'other fields are untouched');
  // the user can narrow which fields the scale applies to
  await send('PUT', '/api/comfy/workflows/' + wf.id + '/exposed', { exposed: [], scalable: [] });
  await send('POST', '/api/comfy/run/' + node.id);
  await waitFor(node.id, x => x.done === 1);
  assert.equal(received.prompts.at(-1)['12'].inputs.resolution, 4096);
});

test('the enhancer sends chosen images through its workflow and marks the originals', async () => {
  const canvasId = await root();
  await send('PUT', '/api/comfy/settings', { provider: 'local' });
  const noWf = await send('POST', '/api/comfy/enhance', { ids: ['x'] });
  assert.equal(noWf.status, 400);
  assert.match(noWf.body.error, /workflow aprimorador/);

  const wf = (await send('POST', '/api/comfy/workflows', { name: 'Aprimorador', json: JSON.stringify(UPSCALE) })).body;
  const saved = (await send('PUT', '/api/comfy/enhance-settings', { workflowId: wf.id, params: { '12.resolution': 3000 }, testScale: 0.5 })).body;
  assert.equal(saved.workflowId, wf.id);
  assert.equal((await get('/api/comfy/enhance-settings')).body.detail.name, 'Aprimorador');

  const group = (await send('POST', '/api/item', { canvasId, type: 'group', x: 100, y: 6000, w: 700, h: 400, data: { title: 'Resultados' } })).body;
  const imgs = [await colored(canvasId, 120, '#ff0000', group.id), await colored(canvasId, 340, '#00ff00', group.id)];
  const before = received.prompts.length;
  const started = (await send('POST', '/api/comfy/enhance', { ids: imgs.map(i => i.id) })).body;
  assert.equal(started.jobs, 2);
  assert.equal(started.anchorId, group.id);
  const s = await waitFor(group.id, x => x.done === 2);
  assert.equal(s.failed, 0, s.errors[0]);
  assert.ok(received.prompts.slice(before).every(w => w['12'].inputs.resolution === 1504), '3000 × 50% in multiples of 16');

  const items = (await get('/api/canvas/' + canvasId)).body.items;
  const frame = items.find(i => i.type === 'group' && i.data.comfyAnchor === group.id);
  assert.ok(frame && frame.y >= group.y + group.h, 'results are framed under the group');
  const results = items.filter(i => i.type === 'image' && i.data.groupId === frame.id);
  assert.equal(results.length, 2);
  assert.ok(results.every(r => imgs.some(o => o.id === r.data.enhancedFrom)));
  for (const o of imgs) assert.ok(items.find(i => i.id === o.id).data.enhanced, 'the original knows it was enhanced');
});

test('local progress follows ComfyUI websocket messages and shows in the batch status', async () => {
  const canvasId = await root();
  await send('PUT', '/api/comfy/settings', { provider: 'local' });
  const wf = (await send('POST', '/api/comfy/workflows', { name: 'Slow', json: JSON.stringify(TXT2IMG) })).body;
  const node = (await send('POST', '/api/item', { canvasId, type: 'comfy', data: { workflowId: wf.id, prompt: 'please wait', runs: 2 } })).body;
  await send('POST', '/api/comfy/run/' + node.id);
  await waitFor(node.id, x => x.running === 2);
  const comfy = require('../backend/comfy');
  assert.equal((await get('/api/comfy/status/' + node.id)).body.indeterminate, true, 'no steps known yet');
  const ids = received.prompts.length;
  comfy._onSocketMessage(JSON.stringify({ type: 'progress', data: { value: 5, max: 10, prompt_id: 'p' + (ids - 2) } }));
  comfy._onSocketMessage(JSON.stringify({ type: 'progress', data: { value: 10, max: 10, prompt_id: 'p' + (ids - 1) } }));
  const s = (await get('/api/comfy/status/' + node.id)).body;
  assert.equal(s.indeterminate, false);
  assert.ok(Math.abs(s.fraction - (0.5 + 0.99) / 2) < 0.01, 'half of the first job, nearly all of the second: ' + s.fraction);
  assert.deepEqual(s.step && [s.step.value, s.step.max], [5, 10]);
  await send('POST', '/api/comfy/cancel/' + node.id);
  assert.equal((await get('/api/comfy/status/' + node.id)).body.fraction, 1, 'cancelled jobs count as finished');
  await new Promise(r => setTimeout(r, 120));
});

test('results never land on top of other cards: below, else beside, else under everything with a line back', async () => {
  const canvasId = await root();
  await send('PUT', '/api/comfy/settings', { provider: 'local' });
  const wf = (await send('POST', '/api/comfy/workflows', { name: 'Aprimorador 2', json: JSON.stringify(UPSCALE) })).body;
  await send('PUT', '/api/comfy/enhance-settings', { workflowId: wf.id, params: {}, testScale: 1 });
  const note = (x, y) => send('POST', '/api/item', { canvasId, type: 'note', x, y, w: 240, data: { title: 'n', body: 'x' } });
  const boxes = items => items.filter(i => i.type !== 'line' && !i.parentItemId);
  const overlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  // free space below: it goes right under the image
  const free = await colored(canvasId, 100, '#aa0000');
  await send('PATCH', '/api/item/' + free.id, { x: 100, y: 8000, w: 260 });
  await send('POST', '/api/comfy/enhance', { ids: [free.id] });
  await waitFor(free.id, x => x.done === 1);
  let items = (await get('/api/canvas/' + canvasId)).body.items;
  const under = items.find(i => i.type === 'group' && i.data.comfyAnchor === free.id);
  assert.equal(under.x, 100);
  assert.ok(under.y >= 8000 + 390);

  // cards below and beside: it goes under everything and is tied back by a line
  const boxed = await colored(canvasId, 100, '#00aa00');
  await send('PATCH', '/api/item/' + boxed.id, { x: 100, y: 9000, w: 260 });
  await note(100, 9500);
  await note(420, 9000);
  await note(420, 9400);
  await send('POST', '/api/comfy/enhance', { ids: [boxed.id] });
  await waitFor(boxed.id, x => x.done === 1);
  items = (await get('/api/canvas/' + canvasId)).body.items;
  const far = items.find(i => i.type === 'group' && i.data.comfyAnchor === boxed.id);
  const others = boxes(items).filter(i => i.id !== far.id && i.data.groupId !== far.id);
  assert.ok(others.every(o => !overlap(far, { ...o, w: o.w || 240, h: o.h || 300 }) || o.id === boxed.id), 'does not cover another card');
  assert.ok(far.y > 9500, 'under the cards that were in the way');
  const line = items.find(i => i.type === 'line' && i.data.from === boxed.id && i.data.to === far.id);
  assert.ok(line && line.data.dashed, 'a dashed line leads back to the source');
});

// ---- long queues, recovery, turning ComfyUI on -------------------------------

test('a job waiting in ComfyUI\'s queue is never given up on; one ComfyUI lost is', async () => {
  const canvasId = await root();
  await send('PUT', '/api/comfy/settings', { provider: 'local' });
  const wf = (await send('POST', '/api/comfy/workflows', { name: 'Fila', json: JSON.stringify(TXT2IMG) })).body;
  const waits = (await send('POST', '/api/item', { canvasId, type: 'comfy', data: { workflowId: wf.id, prompt: 'please wait' } })).body;
  await send('POST', '/api/comfy/run/' + waits.id);
  await waitFor(waits.id, x => x.running === 1);
  await new Promise(r => setTimeout(r, 400));   // many polls later it is still waiting, not failed
  const still = (await get('/api/comfy/status/' + waits.id)).body;
  assert.equal(still.running, 1);
  assert.equal(still.failed, 0);
  await send('POST', '/api/comfy/cancel/' + waits.id);

  const vanishes = (await send('POST', '/api/item', { canvasId, type: 'comfy', data: { workflowId: wf.id, prompt: 'please vanish' } })).body;
  await send('POST', '/api/comfy/run/' + vanishes.id);
  const s = await waitFor(vanishes.id, x => x.failed === 1);
  assert.match(s.errors[0], /não tem mais esta tarefa/);
  assert.equal(s.recoverable, 1, 'it may still be fetched later');
});

test('jobs given up on can be recovered: their images are fetched again', async () => {
  const canvasId = await root();
  await send('PUT', '/api/comfy/settings', { provider: 'local' });
  const wf = (await send('POST', '/api/comfy/workflows', { name: 'Recupera', json: JSON.stringify(TXT2IMG) })).body;
  const node = (await send('POST', '/api/item', { canvasId, type: 'comfy', data: { workflowId: wf.id, prompt: 'azul' } })).body;
  await send('POST', '/api/comfy/run/' + node.id);
  await waitFor(node.id, x => x.done === 1);
  const { db } = require('../backend/db');
  const images = async () => (await get('/api/canvas/' + canvasId)).body.items.filter(i => i.type === 'image' && i.data.comfyJob).length;
  const before = await images();
  // the old behaviour: a long queue made the job time out although ComfyUI finished it
  db.prepare("UPDATE comfy_jobs SET status = 'failed', error = 'Tempo esgotado' WHERE itemId = ?").run(node.id);
  const failed = (await get('/api/comfy/status/' + node.id)).body;
  assert.equal(failed.failed, 1);
  assert.equal(failed.recoverable, 1);
  assert.equal((await send('POST', '/api/comfy/recover/' + node.id)).body.recovering, 1);
  const s = await waitFor(node.id, x => x.done === 1);
  assert.equal(s.recoverable, 0);
  assert.equal(await images(), before + 1, 'the image appears on the board');
  // real failures are not retried
  db.prepare("UPDATE comfy_jobs SET status = 'failed', error = 'Erro no ComfyUI: out of memory' WHERE itemId = ?").run(node.id);
  assert.equal((await send('POST', '/api/comfy/recover/' + node.id)).body.recovering, 0);
});

test('ComfyUI can be started from a configured file, from this computer only', async () => {
  const comfyUrl = process.env.COMFYUI_URL;
  delete process.env.COMFYUI_URL;               // let the saved address win for this test
  process.env.COMFY_LAUNCH_HIDE = '1';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-'));
  const net = require('net');
  const port = await new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  fs.writeFileSync(path.join(dir, 'fake-comfy.js'),
    `require('http').createServer((q, r) => r.end('{"system":{"comfyui_version":"launched"}}')).listen(${port}, '127.0.0.1');\nsetTimeout(() => process.exit(0), 6000);\n`);
  const launcher = path.join(dir, process.platform === 'win32' ? 'start.cmd' : 'start.sh');
  fs.writeFileSync(launcher, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${path.join(dir, 'fake-comfy.js')}"\r\n`
    : `#!/bin/sh\n"${process.execPath}" "${path.join(dir, 'fake-comfy.js')}"\n`, { mode: 0o755 });
  try {
    await send('PUT', '/api/comfy/settings', { provider: 'local', localUrl: 'http://127.0.0.1:' + port });
    const noFile = await send('POST', '/api/comfy/launch');
    assert.equal(noFile.status, 409);
    assert.match(noFile.body.error, /não responde/);
    assert.equal((await send('PUT', '/api/comfy/settings', { localLaunch: path.join(dir, 'missing.bat') })).status, 400, 'a file that does not exist is refused');
    const saved = (await send('PUT', '/api/comfy/settings', { localLaunch: launcher })).body;
    assert.equal(saved.localLaunch, launcher);
    assert.equal(saved.canLaunch, true);
    const started = await send('POST', '/api/comfy/launch');
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.started, true);
    assert.equal((await send('POST', '/api/comfy/launch')).body.already, true);
    assert.match((await send('POST', '/api/comfy/test')).body.detail, /launched/);
  } finally {
    await send('PUT', '/api/comfy/settings', { localLaunch: '', localUrl: comfyUrl });
    process.env.COMFYUI_URL = comfyUrl;
    delete process.env.COMFY_LAUNCH_HIDE;
  }
});
