'use strict';

const { test: base, expect } = require('@playwright/test');
const sharp = require('sharp');
const { freshCanvas, place } = require('./helpers');

// Fail for first-party runtime/network errors, including broken thumbnails.
// External fonts/icons are optional and aren't a dependency of acceptance.
const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    const failures = [];
    page.on('pageerror', error => failures.push(error.message));
    page.on('response', response => {
      if (response.url().startsWith(testInfo.project.use.baseURL) && response.status() >= 400)
        failures.push(`${response.status()} ${response.url()}`);
    });
    page.on('requestfailed', request => {
      if (request.url().startsWith(testInfo.project.use.baseURL) && !request.failure()?.errorText.includes('ERR_ABORTED'))
        failures.push(`${request.failure()?.errorText} ${request.url()}`);
    });
    await use(page);
    await testInfo.attach('browser-errors', { body: JSON.stringify(failures, null, 2), contentType: 'application/json' });
    expect(failures, 'No first-party runtime or network failures').toEqual([]);
  }
});

async function photos(count) {
  const buffer = await sharp({ create: { width: 1200, height: 1600, channels: 3, background: '#7794bb' } }).png().toBuffer();
  return Array.from({ length: count }, (_, i) => ({ name: `reference-${i}.png`, mimeType: 'image/png', buffer }));
}

async function upload(page, files) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Fotos', exact: true }).click();
  await (await chooser).setFiles(files);
}

test('photo project: create board, import, group, append, move, reload and reopen', async ({ page }) => {
  test.setTimeout(60000);
  await freshCanvas(page);
  await place(page, 'board');
  const board = page.locator('.item.type-board').last();
  await board.locator('.btitle').click();
  const renamed = page.waitForResponse(r => r.url().includes('/api/item/') && r.request().method() === 'PATCH');
  await board.getByPlaceholder('Nome do board').fill('Catalogo de uniformes');
  await renamed;
  await page.keyboard.press('Escape');
  await board.locator('.tile').dblclick();
  await expect(page.locator('#crumbs .current')).toHaveText('Catalogo de uniformes');
  const boardUrl = page.url();

  await upload(page, await photos(2));
  const images = page.locator('.item.type-image');
  await expect(images).toHaveCount(2);
  await expect.poll(() => images.locator('img').evaluateAll(imgs => imgs.every(img => img.complete && img.naturalWidth > 0 && img.naturalWidth <= 720))).toBe(true);
  await page.keyboard.press('Control+a');
  await page.getByRole('button', { name: 'Agrupar', exact: true }).click();
  const group = page.locator('.item.type-group');
  await expect(group).toHaveCount(1);
  await expect(page.locator('#toast')).toContainText('itens agrupados');

  // Move frame away from the viewport center, then append through the picker.
  const title = await group.locator('.group-title').boundingBox();
  const moved = page.waitForResponse(r => r.url().endsWith('/api/items') && r.request().method() === 'PATCH');
  await page.mouse.move(title.x + 50, title.y + 15);
  await page.mouse.down();
  await page.mouse.move(title.x + 290, title.y + 15, { steps: 8 });
  await page.mouse.up();
  await moved;
  await upload(page, await photos(3));
  await expect(images).toHaveCount(5);
  await page.getByRole('button', { name: 'Ajustar à tela' }).click();
  await expect.poll(async () => {
    const frame = await group.boundingBox();
    const boxes = await images.all();
    for (const image of boxes) {
      const r = await image.boundingBox();
      if (r.x < frame.x || r.y < frame.y || r.x + r.width > frame.x + frame.width + 2 || r.y + r.height > frame.y + frame.height + 2) return false;
    }
    return true;
  }).toBe(true);
  // Every new image must belong to the frame, even after a genuine reload.
  await page.reload();
  await expect(images).toHaveCount(5);
  await group.locator('.group-title').click();
  await expect(page.locator('.item.selected')).toHaveCount(6);
  const beforeMove = await images.evaluateAll(els => els.map(el => ({ id: el.dataset.id, x: el.getBoundingClientRect().x })));
  const handle = await group.locator('.group-title').boundingBox();
  const savedMove = page.waitForResponse(r => r.url().endsWith('/api/items') && r.request().method() === 'PATCH');
  await page.mouse.move(handle.x + 40, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + 100, handle.y + handle.height / 2, { steps: 8 });
  await page.mouse.up();
  await savedMove;
  for (const previous of beforeMove) {
    await expect.poll(async () => (await page.locator(`[data-id="${previous.id}"]`).boundingBox()).x - previous.x).toBeGreaterThan(55);
  }
  await page.getByRole('button', { name: 'Desagrupar', exact: true }).click();
  await expect(group).toHaveCount(0);
  await expect(images).toHaveCount(5);
  await page.locator('#crumbs .crumb').nth(1).click();
  const cover = page.locator('.item.type-board').filter({ has: page.locator('input.btitle') }).last();
  await expect.poll(() => cover.locator('.preview img').evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
  await cover.locator('.tile').dblclick();
  await expect(page).toHaveURL(boardUrl);
  await expect(images).toHaveCount(5);
});

test('quick edits to title and body both survive reload', async ({ page }) => {
  await freshCanvas(page);
  await place(page, 'note');
  const note = page.locator('.item.type-note');
  const saved = page.waitForResponse(r => r.url().includes('/api/item/') && r.request().method() === 'PATCH');
  await note.getByPlaceholder('Título', { exact: true }).fill('Aprovacao');
  await note.getByPlaceholder('Escreva uma nota…').fill('Revisar a cor da gola');
  await saved;
  await page.reload();
  await expect(note.getByPlaceholder('Título', { exact: true })).toHaveValue('Aprovacao');
  await expect(note.getByPlaceholder('Escreva uma nota…')).toHaveValue('Revisar a cor da gola');
});

test('Space drag over a photo pans the view without moving its saved position', async ({ page }) => {
  await freshCanvas(page);
  await upload(page, await photos(1));
  const image = page.locator('.item.type-image');
  await expect(image).toHaveCount(1);
  const position = await image.getAttribute('style');
  const before = await image.boundingBox();
  await page.keyboard.down('Space');
  await page.mouse.move(before.x + 50, before.y + 50);
  await page.mouse.down();
  await page.mouse.move(before.x + 170, before.y + 90, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  await expect.poll(async () => (await image.boundingBox()).x - before.x).toBeGreaterThan(100);
  await expect(image).toHaveAttribute('style', position);
});

test('24 real photos decode as previews and remain navigable', async ({ page }, testInfo) => {
  test.setTimeout(60000);
  await freshCanvas(page);
  const started = Date.now();
  await upload(page, await photos(24));
  await expect(page.locator('.item.type-image')).toHaveCount(24);
  await page.getByRole('button', { name: 'Ajustar à tela' }).click();
  await expect.poll(() => page.locator('.item.type-image img').evaluateAll(imgs => imgs.every(img => img.complete && img.naturalWidth > 0 && img.naturalWidth <= 720)), { timeout: 20000 }).toBe(true);
  await page.keyboard.press('Control+a');
  await expect(page.locator('.item.selected')).toHaveCount(24);
  await page.getByRole('button', { name: 'Agrupar', exact: true }).click();
  await expect(page.locator('.item.type-group')).toHaveCount(1);
  await testInfo.attach('batch-time', { body: JSON.stringify({ photos: 24, elapsedMs: Date.now() - started }), contentType: 'application/json' });
});
