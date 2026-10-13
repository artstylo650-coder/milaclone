'use strict';

// Finding and viewing things: Ctrl+K search across boards, double-click quick
// add, and the full-size image viewer.

const { test, expect } = require('@playwright/test');
const sharp = require('sharp');
const { freshCanvas } = require('./helpers');

test('Ctrl+K finds a note on another board and jumps to it', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  const tag = 'lote' + Date.now().toString(36);
  const noteId = await page.evaluate(async ({ id, tag }) => {
    const post = body => fetch('/api/item', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
    const board = await post({ canvasId: id, type: 'board', x: 100, y: 100, data: { title: 'Arquivo Morto' } });
    const note = await post({ canvasId: board.data.childCanvasId, type: 'note', x: 2400, y: 1800, data: { title: 'Fornecedor de botões ' + tag, body: '' } });
    return note.id;
  }, { id: canvasId, tag });
  await page.reload();
  await page.keyboard.press('Control+k');
  await page.locator('.cmdk-input').fill('fornecedor botoes ' + tag);
  const row = page.locator('.cmdk-row', { hasText: 'Fornecedor de botões' });
  await expect(row).toContainText('Em Arquivo Morto');
  await page.keyboard.press('Enter');
  await expect(page.locator('#crumbs .current')).toHaveText('Arquivo Morto');
  const note = page.locator(`[data-id="${noteId}"]`);
  await expect(note).toHaveClass(/selected/);
  await expect(note).toBeInViewport();
});

test('double-clicking empty canvas adds the chosen card at that spot', async ({ page }) => {
  await freshCanvas(page);
  await page.mouse.dblclick(500, 380);
  await expect(page.locator('.cmdk-input')).toBeFocused();
  await page.keyboard.type('tarefas');
  await page.keyboard.press('Enter');
  const todo = page.locator('.item.type-todo');
  await expect(todo).toHaveCount(1);
  const box = await todo.boundingBox();
  expect(Math.abs(box.x + box.width / 2 - 500)).toBeLessThan(40);
});

test('double-clicking a photo opens the original in the viewer', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  const png = await sharp({ create: { width: 1600, height: 1000, channels: 3, background: '#335577' } }).png().toBuffer();
  for (const [i, x] of [[0, 200], [1, 600]]) {
    const up = await (await page.request.post('/api/upload', { multipart: { file: { name: `foto-${i}.png`, mimeType: 'image/png', buffer: png } } })).json();
    await page.request.post('/api/item', { data: { canvasId, type: 'image', x, y: 200, w: 260, data: { src: up.src, name: `foto-${i}.png`, naturalW: 1600, naturalH: 1000 } } });
  }
  await page.reload();
  await page.locator('.item.type-image').first().dblclick();
  const viewer = page.locator('.lightbox');
  await expect(viewer).toBeVisible();
  await expect(viewer.locator('.lb-name')).toHaveText('foto-0.png');
  await expect.poll(() => viewer.locator('.lb-img').evaluate(img => img.naturalWidth)).toBe(1600);
  await page.keyboard.press('ArrowRight');
  await expect(viewer.locator('.lb-name')).toHaveText('foto-1.png');
  await expect(viewer.locator('.lb-count')).toHaveText('2 / 2');
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  await expect(page.locator('.item.type-image')).toHaveCount(2);
});
