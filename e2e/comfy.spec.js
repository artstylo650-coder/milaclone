'use strict';

// ComfyUI card end to end against a fake ComfyUI server: configure it from the
// settings panel, import an API-format workflow, place the node, run two
// variations and get the images back on the board inside a group; then a
// try-on shaped workflow with image slots, a group source, a blank slot, a
// field on the card, stacked results and a note as the prompt.
// Serial: the ComfyUI settings are global to the app server under test.

const { test, expect } = require('@playwright/test');
const { freshCanvas, place } = require('./helpers');
const sharp = require('sharp');
const { fakeComfy, received, ready } = require('../test/fake-comfy');

const WORKFLOW = {
  3: { class_type: 'KSampler', inputs: { seed: 1, positive: ['6', 0], negative: ['7', 0] } },
  6: { class_type: 'CLIPTextEncode', inputs: { text: 'a', clip: ['4', 1] } },
  7: { class_type: 'CLIPTextEncode', inputs: { text: 'b', clip: ['4', 1] } },
  9: { class_type: 'SaveImage', inputs: { images: ['8', 0] } }
};

test.describe.configure({ mode: 'serial' });

const TRYON = {
  3: { class_type: 'KSampler', inputs: { seed: 1, steps: 20, positive: ['6', 0], negative: ['7', 0] }, _meta: { title: 'Amostrador' } },
  6: { class_type: 'CLIPTextEncode', inputs: { text: 'a', clip: ['4', 1] } },
  7: { class_type: 'CLIPTextEncode', inputs: { text: 'b', clip: ['4', 1] } },
  9: { class_type: 'SaveImage', inputs: { images: ['8', 0] } },
  10: { class_type: 'LoadImage', inputs: { image: 'a.png' }, _meta: { title: 'Peça' } },
  11: { class_type: 'LoadImage', inputs: { image: 'b.png' }, _meta: { title: 'Modelo' } }
};

let server;
test.beforeAll(async () => {
  await ready;
  server = await new Promise(r => { const s = fakeComfy().listen(0, '127.0.0.1', () => r(s)); });
});
test.afterAll(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });

// The card is its image; the bar with the prompt floats under it while it is
// selected, quick choices open as popovers, the rest lives in "Mais ajustes".
const frameOf = (node) => node.locator('.comfy-frame');
const select = (node) => frameOf(node).click();
const adjust = async (page, node) => { await node.getByRole('button', { name: 'Mais ajustes' }).click(); return page.locator('.panel'); };
const done = (panel) => panel.getByRole('button', { name: 'Concluir' }).click();
const runsTo = async (node, n) => {
  await node.getByRole('button', { name: 'Imagens por foto' }).click();
  await node.getByLabel('Variações').fill(String(n));
  await node.getByLabel('Variações').blur();
  await node.getByRole('button', { name: 'Imagens por foto' }).click();   // closes the popover
};

test('configure ComfyUI, run a node and get the images back in a group', async ({ page }) => {
  await freshCanvas(page);
  await page.locator('#appMenuBtn').click();
  await page.locator('#ctxmenu .ctx-item', { hasText: 'Configurar ComfyUI' }).click();
  const panel = page.locator('.panel');
  await panel.getByLabel('ComfyUI local').check();
  await panel.locator('#cfLocal').fill('http://127.0.0.1:' + server.address().port);
  await panel.getByRole('button', { name: 'Testar conexão' }).click();
  await expect(panel.locator('#cfTestResult')).toContainText('✓ ComfyUI 0.3.test');
  await panel.locator('#cfName').fill('Retrato e2e');
  const chooser = page.waitForEvent('filechooser');
  await panel.getByRole('button', { name: 'Importar JSON…' }).click();
  await (await chooser).setFiles({ name: 'wf.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(WORKFLOW)) });
  await expect(panel.locator('.cf-wf', { hasText: 'Retrato e2e' })).toContainText('texto para imagem');
  await panel.getByRole('button', { name: 'Salvar' }).click();
  await expect(panel).toHaveCount(0);

  await place(page, 'comfy', 400, 300);
  const node = page.locator('.item.comfy');
  const ajustes = await adjust(page, node);
  await ajustes.getByLabel('Workflow').selectOption({ label: 'Retrato e2e' });
  await done(ajustes);
  await node.getByLabel('Prompt', { exact: true }).fill('camisa polo azul marinho');
  await runsTo(node, 2);
  await node.getByRole('button', { name: 'Gerar 2' }).click();
  await expect(node.locator('.comfy-status')).toContainText('2 prontas', { timeout: 15000 });
  const images = page.locator('.item.type-image');
  await expect(images).toHaveCount(2);
  await expect(page.locator('.item.type-group .group-title')).toHaveValue(/camisa polo azul/);
  // the newest result is the card's picture
  await expect(node.locator('.comfy-frame > img')).toHaveCount(1);
  await page.waitForTimeout(1200);   // edits are saved a moment after typing
  await page.reload();
  await expect(images).toHaveCount(2);
  const again = page.locator('.item.comfy');
  await select(again);
  await expect(again.getByLabel('Prompt', { exact: true })).toHaveValue('camisa polo azul marinho');
});

// a garment group (three photos), a model photo and a card wired to both
async function seed(page, canvasId, png) {
  return page.evaluate(async ({ canvasId, png, port, workflow }) => {
    const post = (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
    await fetch('/api/comfy/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'local', localUrl: 'http://127.0.0.1:' + port }) });
    const wf = await post('/api/comfy/workflows', { name: 'Provador', json: JSON.stringify(workflow) });
    const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0));
    const upload = async (name) => {
      const fd = new FormData();
      fd.append('file', new Blob([bytes], { type: 'image/png' }), name);
      return (await fetch('/api/upload', { method: 'POST', body: fd })).json();
    };
    const group = await post('/api/item', { canvasId, type: 'group', x: 40, y: 60, w: 700, h: 300, data: { title: 'Camisa Manga Longa' } });
    const photo = async (x, groupId, name) => {
      const up = await upload(name);
      return post('/api/item', { canvasId, type: 'image', x, y: groupId ? 100 : 420, w: 200, data: { src: up.src, name, naturalW: 64, naturalH: 96, ...(groupId ? { groupId } : {}) } });
    };
    for (let i = 0; i < 3; i++) await photo(60 + i * 220, group.id, 'peca' + i + '.png');
    const model = await photo(60, null, 'modelo.png');
    const node = await post('/api/item', { canvasId, type: 'comfy', x: 780, y: 60, w: 340, data: { title: 'ComfyUI', workflowId: wf.id, runs: 1 } });
    for (const from of [group.id, model.id]) await post('/api/item', { canvasId, type: 'line', data: { from, to: node.id } });
    return { groupId: group.id, nodeId: node.id };
  }, { canvasId, png, port: server.address().port, workflow: TRYON });
}

test('a group feeds one job per photo, a slot can be blank, a field goes on the card, results stack under the group', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  await page.locator('#minimap').evaluate(el => { el.style.display = 'none'; });
  const png = (await sharp({ create: { width: 64, height: 96, channels: 3, background: '#a33' } }).png().toBuffer()).toString('base64');
  const { groupId, nodeId } = await seed(page, canvasId, png);
  await page.reload();
  await page.locator('#minimap').evaluate(el => { el.style.display = 'none'; });

  const node = page.locator(`.item.comfy[data-id="${nodeId}"]`);
  // the bar is only there while the card is selected
  await expect(node.locator('.comfy-bar')).toBeHidden();
  await select(node);
  await expect(node.getByRole('button', { name: 'Gerar 3' })).toBeVisible();
  await expect(node.locator('.comfy-count')).toContainText('3 fotos → 3 imagens');

  // inputs: a group of three for the first slot, the model for the second; the model can be left blank
  const ajustes = await adjust(page, node);
  const slots = ajustes.locator('.comfy-slot');
  await expect(slots).toHaveCount(2);
  await expect(slots.nth(0)).toContainText('Peça');
  await expect(slots.nth(0).locator('.comfy-thumb b')).toHaveText('×3');
  await expect(slots.nth(1)).toContainText('Modelo');
  await slots.nth(1).getByLabel('Entrada: Modelo').selectOption('blank');
  await expect(slots.nth(1).locator('.comfy-thumb.blank')).toBeVisible();

  // put the sampler's steps among the adjustments
  await ajustes.getByRole('button', { name: 'Escolher campos' }).click();
  const picker = page.locator('.panel');
  await expect(picker).toContainText('Amostrador');
  await picker.getByLabel('Filtrar campos').fill('steps');
  await picker.locator('label[data-search]', { hasText: 'steps' }).getByRole('checkbox').first().check();
  await picker.getByRole('button', { name: 'Salvar' }).click();
  const again = await adjust(page, node);
  const steps = again.getByLabel('Amostrador · steps');
  await expect(steps).toHaveValue('20');
  await steps.fill('33');
  await steps.blur();
  await done(again);

  // a fixed seed, from the Seed chip
  await node.getByRole('button', { name: 'Seed', exact: true }).click();
  await node.getByLabel('Fixar seed').check();
  await node.getByLabel('Valor da seed').fill('4242');
  await node.getByLabel('Valor da seed').blur();
  await node.getByRole('button', { name: 'Seed', exact: true }).click();
  await expect(node.getByRole('radiogroup', { name: 'Tamanho de teste' })).toHaveCount(0);
  await expect(node.getByRole('button', { name: 'Qualidade' })).toHaveCount(0);   // this workflow has no size fields to scale

  const before = received.prompts.length;
  await node.getByRole('button', { name: 'Gerar 3' }).click();
  await expect(node.locator('.comfy-status')).toContainText('3 prontas', { timeout: 20000 });
  const sent = received.prompts.slice(before);
  expect(sent).toHaveLength(3);
  expect(sent.every(p => p['3'].inputs.steps === 33 && p['3'].inputs.seed === 4242)).toBe(true);

  // 3 garments + the model + 3 results, in a frame under the source group
  await expect(page.locator('.item.type-image')).toHaveCount(7);
  const frames = await page.evaluate(async (canvasId) => (await (await fetch('/api/canvas/' + canvasId)).json()).items
    .filter(i => i.type === 'group').map(g => ({ id: g.id, y: g.y, h: g.h, x: g.x, anchor: g.data.comfyAnchor })), canvasId);
  const result = frames.find(f => f.anchor === groupId);
  const source = frames.find(f => f.id === groupId);
  expect(result.x).toBe(source.x);
  expect(result.y).toBeGreaterThanOrEqual(source.y + source.h);

  // a second run stacks another frame below the first
  await select(page.locator(`.item.comfy[data-id="${nodeId}"]`));
  await page.locator(`.item.comfy[data-id="${nodeId}"]`).getByRole('button', { name: 'Gerar 3' }).click();
  await expect(page.locator('.item.type-image')).toHaveCount(10, { timeout: 20000 });
  const stacked = await page.evaluate(async (canvasId) => (await (await fetch('/api/canvas/' + canvasId)).json()).items
    .filter(i => i.type === 'group' && i.data.comfyAnchor).map(g => ({ y: g.y, h: g.h })).sort((a, b) => a.y - b.y), canvasId);
  expect(stacked).toHaveLength(2);
  expect(stacked[1].y).toBeGreaterThanOrEqual(stacked[0].y + stacked[0].h);
});

test('a note linked to the card becomes its prompt', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  const png = (await sharp({ create: { width: 64, height: 96, channels: 3, background: '#a33' } }).png().toBuffer()).toString('base64');
  const { nodeId } = await seed(page, canvasId, png);
  await page.evaluate(async ({ canvasId, nodeId }) => {
    const post = (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
    const note = await post('/api/item', { canvasId, type: 'note', x: 780, y: -300, w: 240, data: { title: 'Prompt', body: 'burgundy long sleeve shirt', lang: 'en' } });
    await post('/api/item', { canvasId, type: 'line', data: { from: note.id, to: nodeId } });
  }, { canvasId, nodeId });
  await page.reload();
  await page.locator('#minimap').evaluate(el => { el.style.display = 'none'; });
  const node = page.locator(`.item.comfy[data-id="${nodeId}"]`);
  await select(node);
  await expect(node.locator('.comfy-note')).toContainText('Prompt da nota ligada (EN)');
  const before = received.prompts.length;
  await node.getByRole('button', { name: 'Gerar 3' }).click();
  await expect(node.locator('.comfy-status')).toContainText('3 prontas', { timeout: 20000 });
  expect(received.prompts[before]['6'].inputs.text).toBe('burgundy long sleeve shirt');
});

// an upscaler that ends in a Preview node (nothing saved to disk), with a size field
const UPSCALE = {
  10: { class_type: 'LoadImage', inputs: { image: 'x.png' } },
  12: { class_type: 'SeedVR2VideoUpscaler', inputs: { image: ['10', 0], seed: 5, resolution: 4096 } },
  6: { class_type: 'PreviewImage', inputs: { images: ['12', 0] } }
};

test('the enhance icon sends images through the upscaler, shows progress and marks the originals', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  const png = (await sharp({ create: { width: 64, height: 96, channels: 3, background: '#38a' } }).png().toBuffer()).toString('base64');
  const ids = await page.evaluate(async ({ canvasId, png, port, workflow }) => {
    const send = (method, path, body) => fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
    await send('PUT', '/api/comfy/settings', { provider: 'local', localUrl: 'http://127.0.0.1:' + port });
    const wf = await send('POST', '/api/comfy/workflows', { name: 'Upscale SeedVR2', json: JSON.stringify(workflow) });
    await send('PUT', '/api/comfy/enhance-settings', { workflowId: wf.id, params: {}, testScale: 0.25 });
    const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0));
    const group = await send('POST', '/api/item', { canvasId, type: 'group', x: 60, y: 60, w: 560, h: 300, data: { title: 'Resultados' } });
    const out = [];
    for (let i = 0; i < 2; i++) {
      const fd = new FormData();
      fd.append('file', new Blob([bytes], { type: 'image/png' }), 'r' + i + '.png');
      const up = await (await fetch('/api/upload', { method: 'POST', body: fd })).json();
      out.push((await send('POST', '/api/item', { canvasId, type: 'image', x: 80 + i * 250, y: 110, w: 220,
        data: { src: up.src, name: 'r' + i + '.png', naturalW: 64, naturalH: 96, groupId: group.id, comfyJob: 'j' + i } })).id);
    }
    return out;
  }, { canvasId, png, port: server.address().port, workflow: UPSCALE });
  await page.reload();

  // generated images carry the icon without hovering; it opens the options
  const first = page.locator(`.item.image[data-id="${ids[0]}"]`);
  await expect(first.locator('.enhance-btn')).toBeVisible();
  const before = received.prompts.length;
  await first.locator('.enhance-btn').click();
  const dialog = page.locator('.panel');
  await expect(dialog).toContainText('Aprimorar imagens');
  await expect(dialog.getByLabel('Workflow aprimorador')).toHaveValue(/.+/);
  await expect(dialog.getByLabel('Tamanho de teste')).toHaveValue('0.25');
  await expect(dialog.getByRole('button', { name: 'Aprimorar 1 imagem' })).toBeVisible();

  // the same dialog covers a whole group at once
  await dialog.getByLabel('Quais imagens').selectOption({ label: 'Todas do grupo «Resultados» (2)' });
  await dialog.getByRole('button', { name: 'Aprimorar 2 imagens' }).click();
  await expect(page.locator('.item.image .enhance-badge')).toHaveCount(2, { timeout: 20000 });
  await expect(first.locator('.enhance-btn.done')).toHaveCount(1);
  expect(received.prompts.length - before).toBe(2);
  expect(received.prompts[before]['12'].inputs.resolution).toBe(1024);   // 4096 at the 25% test size
  await expect(page.locator('#enhanceBar')).toBeHidden();

  // the selection bar opens it for the selected images
  await page.keyboard.press('Control+a');
  await page.locator('#multiEnhance').click();
  await expect(dialog.getByRole('button', { name: 'Aprimorar 2 imagens' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Aprimorar 2 imagens' }).click();
  await expect(page.locator('.item.image .enhance-badge')).toHaveCount(4, { timeout: 20000 });

  // Shift-click skips the dialog and reuses the last settings
  await page.keyboard.press('Escape');
  await first.locator('.enhance-btn').click({ modifiers: ['Shift'] });
  await expect(page.locator('.item.image .enhance-badge')).toHaveCount(5, { timeout: 20000 });
});

test('the progress ring shows while jobs run and cancel stops them', async ({ page }) => {
  await freshCanvas(page);
  await page.locator('#minimap').evaluate(el => { el.style.display = 'none'; });
  await place(page, 'comfy', 300, 200);
  const node = page.locator('.item.comfy');
  await page.evaluate(async (port) => {
    await fetch('/api/comfy/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'local', localUrl: 'http://127.0.0.1:' + port }) });
  }, server.address().port);
  const wfId = await page.evaluate(async (workflow) => (await (await fetch('/api/comfy/workflows', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Lento', json: JSON.stringify(workflow) })
  })).json()).id, WORKFLOW);
  await page.reload();
  await select(node);
  const ajustes = await adjust(page, node);
  await ajustes.getByLabel('Workflow').selectOption(wfId);
  await done(ajustes);
  await node.getByLabel('Prompt', { exact: true }).fill('please wait');
  await runsTo(node, 2);
  await node.getByRole('button', { name: 'Gerar 2' }).click();
  const ring = node.locator('.comfy-progress');
  await expect(ring).toBeVisible();
  await expect(ring).toContainText('0/2');
  await expect(node.locator('.comfy-send')).toBeDisabled();
  await node.getByRole('button', { name: 'Cancelar' }).click();
  await expect(node.locator('.comfy-status')).toContainText('2 canceladas', { timeout: 10000 });
  await expect(ring).toBeHidden();
  await expect(node.locator('.comfy-send')).toBeEnabled();
});

// an edit workflow: a photo and a prompt in, with a size field to scale
const EDIT = {
  3: { class_type: 'KSampler', inputs: { seed: 1, positive: ['6', 0], negative: ['7', 0] } },
  6: { class_type: 'CLIPTextEncode', inputs: { text: 'a', clip: ['4', 1] } },
  7: { class_type: 'CLIPTextEncode', inputs: { text: 'b', clip: ['4', 1] } },
  9: { class_type: 'SaveImage', inputs: { images: ['8', 0] } },
  10: { class_type: 'LoadImage', inputs: { image: 'x.png' } },
  12: { class_type: 'ImageScale', inputs: { image: ['10', 0], width: 2048, height: 2048 } }
};

test('the card is its picture; quick choices are chips with popovers; the rest is behind Mais ajustes', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  await page.locator('#minimap').evaluate(el => { el.style.display = 'none'; });
  const png = (await sharp({ create: { width: 64, height: 96, channels: 3, background: '#38a' } }).png().toBuffer()).toString('base64');
  const nodeId = await page.evaluate(async ({ canvasId, png, port, workflow }) => {
    const send = (method, path, body) => fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
    await send('PUT', '/api/comfy/settings', { provider: 'local', localUrl: 'http://127.0.0.1:' + port });
    const wf = await send('POST', '/api/comfy/workflows', { name: 'Editar foto', json: JSON.stringify(workflow) });
    const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0));
    const fd = new FormData();
    fd.append('file', new Blob([bytes], { type: 'image/png' }), 'a.png');
    const up = await (await fetch('/api/upload', { method: 'POST', body: fd })).json();
    const photo = await send('POST', '/api/item', { canvasId, type: 'image', x: 40, y: 80, w: 200, data: { src: up.src, name: 'a.png', naturalW: 64, naturalH: 96 } });
    const node = await send('POST', '/api/item', { canvasId, type: 'comfy', x: 320, y: 60, w: 340, data: { title: 'Trocar fundo', workflowId: wf.id } });
    await send('POST', '/api/item', { canvasId, type: 'line', data: { from: photo.id, to: node.id } });
    return node.id;
  }, { canvasId, png, port: server.address().port, workflow: EDIT });
  await page.reload();
  await page.locator('#minimap').evaluate(el => { el.style.display = 'none'; });
  const node = page.locator(`.item.comfy[data-id="${nodeId}"]`);

  // the card itself: a name, shortcuts and the picture area
  await expect(node.getByLabel('Nome do card')).toHaveValue('Trocar fundo');
  await expect(node.locator('.comfy-frame')).toBeVisible();
  await expect(node.locator('.comfy-kind')).toHaveText('Edição');
  await expect(node.locator('.comfy-bar')).toBeHidden();
  await select(node);
  await expect(node.locator('.comfy-bar')).toBeVisible();
  await expect(node.getByLabel('Prompt', { exact: true })).toBeVisible();
  await expect(node.getByLabel('Prompt', { exact: true })).toHaveAttribute('placeholder', 'O que mudar na foto?');
  await expect(node.getByRole('button', { name: 'Entradas de imagem' })).toContainText('a.png');
  for (const name of ['Qualidade', 'Imagens por foto', 'Seed', 'Mais ajustes', 'Gerar']) {
    await expect(node.getByRole('button', { name, exact: true })).toBeVisible();
  }
  // clicking empty canvas puts the bar away again
  await page.mouse.click(900, 700);
  await expect(node.locator('.comfy-bar')).toBeHidden();
  await select(node);

  // seed: a fixed seed wakes the field with a number, the dice rolls another, the batch option yields to it
  const seedChip = node.getByRole('button', { name: 'Seed', exact: true });
  await expect(seedChip).toContainText('aleatória');
  await seedChip.click();
  await expect(node.getByLabel('Valor da seed')).toBeDisabled();
  await node.getByLabel('Fixar seed').check();
  await expect(node.getByLabel('Valor da seed')).toBeEnabled();
  const first = await node.getByLabel('Valor da seed').inputValue();
  expect(first).toMatch(/^[0-9]+$/);
  await node.getByRole('button', { name: 'Sortear seed' }).click();
  await expect(node.getByLabel('Valor da seed')).not.toHaveValue(first);
  await expect(node.getByLabel('Mesma seed no lote')).toBeDisabled();
  await node.getByLabel('Fixar seed').uncheck();
  await expect(node.getByLabel('Mesma seed no lote')).toBeEnabled();
  await node.getByLabel('Mesma seed no lote').check();
  await expect(seedChip).toContainText('lote');
  await node.getByLabel('Fixar seed').check();
  await expect(seedChip).toContainText(/^\s*[0-9]+/);
  await seedChip.click();   // close

  // quality: four levels; anything below Final is amber and shows in the chip
  const quality = node.getByRole('button', { name: 'Qualidade', exact: true });
  await expect(quality).toContainText('Final');
  await quality.click();
  await expect(node.getByRole('radiogroup', { name: 'Tamanho de teste' })).toBeVisible();
  await node.getByRole('radio', { name: 'Prévia 50%' }).click();
  await expect(quality).toContainText('Prévia');
  await expect(quality).toHaveClass(/warn/);
  await quality.click();

  // images per photo: a stepper, and the send button shows the count
  await expect(node.getByRole('button', { name: 'Gerar', exact: true })).toBeVisible();
  await node.getByRole('button', { name: 'Imagens por foto' }).click();
  await node.getByRole('button', { name: 'Aumentar quantidade' }).click();
  await expect(node.getByRole('button', { name: 'Gerar 2' })).toBeVisible();
  await node.getByRole('button', { name: 'Imagens por foto' }).click();

  // everything else sits behind Mais ajustes
  await expect(node.getByLabel('Prompt negativo')).toHaveCount(0);
  const ajustes = await adjust(page, node);
  await expect(ajustes.getByLabel('Workflow')).toHaveValue(/.+/);
  await expect(ajustes.getByLabel('Entrada: Imagem 1')).toBeVisible();
  await expect(ajustes.getByLabel('Prompt negativo')).toBeVisible();
  await done(ajustes);

  // choices survive a reload
  await page.waitForTimeout(1500);
  await page.reload();
  await page.locator('#minimap').evaluate(el => { el.style.display = 'none'; });
  const back = page.locator(`.item.comfy[data-id="${nodeId}"]`);
  await select(back);
  await expect(back.getByRole('button', { name: 'Qualidade', exact: true })).toContainText('Prévia');
  await expect(back.getByRole('button', { name: 'Gerar 2' })).toBeVisible();

  const before = received.prompts.length;
  await back.getByRole('button', { name: 'Gerar 2' }).click();
  await expect(back.locator('.comfy-status')).toContainText('2 prontas', { timeout: 20000 });
  expect(received.prompts.slice(before).every(p => p['12'].inputs.width === 1024)).toBe(true);   // 2048 at 50%
});

test('proportions are drawn: ratio chip with a popover, size buttons, and aspect-ratio lists as shapes', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  await page.locator('#minimap').evaluate(el => { el.style.display = 'none'; });
  const workflow = {
    3: { class_type: 'KSampler', inputs: { seed: 1, positive: ['6', 0], negative: ['7', 0] } },
    5: { class_type: 'EmptyLatentImage', inputs: { width: 1280, height: 720, batch_size: 1 }, _meta: { title: 'Empty Latent Image' } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: 'a', clip: ['4', 1] } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: 'b', clip: ['4', 1] } },
    9: { class_type: 'SaveImage', inputs: { images: ['8', 0] } },
    13: { class_type: 'ResolutionSelector', inputs: { aspect_ratio: '2:3 (Portrait Photo)' }, _meta: { title: 'Resolution Selector' } }
  };
  const nodeId = await page.evaluate(async ({ canvasId, port, workflow }) => {
    const send = (method, path, body) => fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
    await send('PUT', '/api/comfy/settings', { provider: 'local', localUrl: 'http://127.0.0.1:' + port });
    const wf = await send('POST', '/api/comfy/workflows', { name: 'Tamanhos', json: JSON.stringify(workflow) });
    await send('PUT', '/api/comfy/workflows/' + wf.id + '/exposed', { exposed: ['5.width', '5.height', '13.aspect_ratio'] });
    return (await send('POST', '/api/item', { canvasId, type: 'comfy', x: 300, y: 40, w: 340, data: { title: 'ComfyUI', workflowId: wf.id, prompt: 'x' } })).id;
  }, { canvasId, port: server.address().port, workflow });
  await page.reload();
  await page.locator('#minimap').evaluate(el => { el.style.display = 'none'; });
  const node = page.locator(`.item.comfy[data-id="${nodeId}"]`);
  await select(node);

  // 1280 × 720 is 16:9: the chip says so and its popover marks it
  const chip = node.getByRole('button', { name: 'Proporção', exact: true });
  await expect(chip).toContainText('16:9');
  await chip.click();
  const pop = node.locator('.comfy-pop');
  await expect(pop.getByRole('button', { name: 'Proporção 16:9' })).toHaveAttribute('aria-pressed', 'true');
  await expect(pop.getByRole('button', { name: 'Tamanho 1 MP' })).toHaveAttribute('aria-pressed', 'true');

  // the card's picture area has the chosen proportions and follows the choice
  const shape = async () => { const b = await node.locator('.comfy-frame').boundingBox(); return b.width / b.height; };
  await expect.poll(shape).toBeGreaterThan(1.7);   // 16:9
  // a ratio keeps the area; the numbers follow in multiples of 16
  await pop.getByRole('button', { name: 'Proporção 2:3' }).click();
  await expect.poll(shape).toBeLessThan(0.7);       // now portrait, 2:3
  await expect.poll(shape).toBeGreaterThan(0.62);
  const w = Number(await pop.getByLabel('Largura').inputValue()), h = Number(await pop.getByLabel('Altura').inputValue());
  expect(w % 16).toBe(0); expect(h % 16).toBe(0);
  expect(Math.abs(w / h - 2 / 3)).toBeLessThan(0.02);
  expect(Math.abs(w * h - 1280 * 720) / (1280 * 720)).toBeLessThan(0.05);
  await expect(chip).toContainText('2:3');

  // rotate swaps them; a size button keeps the proportion
  await pop.getByRole('button', { name: 'Girar imagem' }).click();
  expect(Number(await pop.getByLabel('Largura').inputValue())).toBe(h);
  await pop.getByRole('button', { name: 'Tamanho 2 MP' }).click();
  const w2 = Number(await pop.getByLabel('Largura').inputValue()), h2 = Number(await pop.getByLabel('Altura').inputValue());
  expect(Math.abs(w2 * h2 - 2e6) / 2e6).toBeLessThan(0.05);
  expect(Math.abs(w2 / h2 - h / w)).toBeLessThan(0.03);
  await chip.click();

  // the aspect-ratio list is drawn as shapes too, in the adjustments panel
  const ajustes = await adjust(page, node);
  const aspectHead = ajustes.locator('.comfy-dim-head').nth(1);
  await expect(aspectHead).toContainText('2:3 (Portrait Photo)');
  await aspectHead.click();
  const aspect = ajustes.getByRole('radiogroup', { name: 'Resolution Selector · aspect_ratio' });
  await aspect.getByRole('radio', { name: '16:9 (Widescreen)' }).click();
  await expect(aspectHead).toContainText('16:9 (Widescreen)');
  await done(ajustes);

  // what is drawn is what runs
  const before = received.prompts.length;
  await page.waitForTimeout(1200);
  await node.getByRole('button', { name: 'Gerar', exact: true }).click();
  await expect(node.locator('.comfy-status')).toContainText('1 pronta', { timeout: 20000 });
  const sent = received.prompts[before];
  expect(sent['5'].inputs.width).toBe(w2);
  expect(sent['5'].inputs.height).toBe(h2);
  expect(sent['13'].inputs.aspect_ratio).toBe('16:9 (Widescreen)');
});

test('an upscaler card has no prompt: the resolution is the choice, and the original can be compared', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  await page.locator('#minimap').evaluate(el => { el.style.display = 'none'; });
  const png = (await sharp({ create: { width: 64, height: 96, channels: 3, background: '#38a' } }).png().toBuffer()).toString('base64');
  const nodeId = await page.evaluate(async ({ canvasId, png, port, workflow }) => {
    const send = (method, path, body) => fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
    await send('PUT', '/api/comfy/settings', { provider: 'local', localUrl: 'http://127.0.0.1:' + port });
    const wf = await send('POST', '/api/comfy/workflows', { name: 'SeedVR2', json: JSON.stringify(workflow) });
    const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0));
    const fd = new FormData();
    fd.append('file', new Blob([bytes], { type: 'image/png' }), 'a.png');
    const up = await (await fetch('/api/upload', { method: 'POST', body: fd })).json();
    const photo = await send('POST', '/api/item', { canvasId, type: 'image', x: 40, y: 80, w: 200, data: { src: up.src, name: 'a.png', naturalW: 64, naturalH: 96 } });
    const node = await send('POST', '/api/item', { canvasId, type: 'comfy', x: 320, y: 60, w: 340, data: { title: 'Upscale', workflowId: wf.id } });
    await send('POST', '/api/item', { canvasId, type: 'line', data: { from: photo.id, to: node.id } });
    return node.id;
  }, { canvasId, png, port: server.address().port, workflow: UPSCALE });
  await page.reload();
  await page.locator('#minimap').evaluate(el => { el.style.display = 'none'; });
  const node = page.locator(`.item.comfy[data-id="${nodeId}"]`);
  await expect(node.locator('.comfy-kind')).toHaveText('Upscale');
  // before any result the card shows the original, faded
  await expect(node.locator('.comfy-frame > img.comfy-faded')).toHaveCount(1);
  await select(node);

  // no prompt, no variations, no seed chip; the resolution leads
  await expect(node.getByLabel('Prompt', { exact: true })).toHaveCount(0);
  for (const name of ['Imagens por foto', 'Seed', 'Qualidade', 'Proporção']) await expect(node.getByRole('button', { name, exact: true })).toHaveCount(0);
  const res = node.getByRole('button', { name: 'Resolução', exact: true });
  await expect(res).toContainText('4096 px');
  await expect(node.getByRole('button', { name: 'Aprimorar', exact: true })).toBeVisible();
  await expect(node.getByRole('button', { name: 'Entradas de imagem' })).toContainText('a.png');
  await res.click();
  await node.getByRole('button', { name: 'Resolução 2048' }).click();
  await expect(res).toContainText('2048 px');
  await res.click();

  // the seed and the inputs still exist, in Mais ajustes; there is no negative prompt
  const ajustes = await adjust(page, node);
  await expect(ajustes.getByLabel('Fixar seed')).toBeVisible();
  await expect(ajustes.getByLabel('Prompt negativo')).toHaveCount(0);
  await done(ajustes);

  const before = received.prompts.length;
  await node.getByRole('button', { name: 'Aprimorar', exact: true }).click();
  await expect(node.locator('.comfy-status')).toContainText('1 pronta', { timeout: 20000 });
  expect(received.prompts[before]['12'].inputs.resolution).toBe(2048);
  // the result is the card's picture; holding the compare button shows the original
  await expect(node.locator('.comfy-frame > img:not(.comfy-faded)')).toHaveCount(1);
  const compare = node.getByRole('button', { name: 'Comparar com a original' });
  await expect(compare).toBeVisible();
  await expect(node.locator('.comfy-original')).toBeHidden();
  const box = await compare.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(node.locator('.comfy-original')).toBeVisible();
  await page.mouse.up();
  await expect(node.locator('.comfy-original')).toBeHidden();
});
