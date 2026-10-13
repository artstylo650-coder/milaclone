'use strict';

// Exporting a board as PNG and a selection as PDF from the More menu.

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const sharp = require('sharp');
const { freshCanvas } = require('./helpers');

test('the board exports as a PNG that contains the cards', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  await page.evaluate(async id => {
    for (const [x, color] of [[100, 'red'], [500, 'blue']]) {
      await fetch('/api/item', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ canvasId: id, type: 'note', x, y: 120, color, data: { title: 'Exportar ' + color, body: 'texto' } }) });
    }
  }, canvasId);
  await page.reload();
  await page.locator('#appMenuBtn').click();
  const download = page.waitForEvent('download');
  await page.locator('#ctxmenu .ctx-item', { hasText: 'Exportar board como PNG' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('fixture.png');
  const meta = await sharp(fs.readFileSync(await file.path())).metadata();
  // two 240px cards 400px apart plus padding, at 2x
  expect(meta.width).toBeGreaterThan(1000);
  const stats = await sharp(fs.readFileSync(await file.path())).stats();
  expect(stats.channels[0].stdev).toBeGreaterThan(5);   // not a blank image
});

test('a selection exports as a PDF', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  await page.evaluate(async id => {
    await fetch('/api/item', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ canvasId: id, type: 'note', x: 200, y: 200, data: { title: 'Só esta', body: '' } }) });
  }, canvasId);
  await page.reload();
  await page.locator('.item.type-note').click();
  await page.keyboard.press('Escape');
  await page.locator('#appMenuBtn').click();
  const download = page.waitForEvent('download');
  await page.locator('#ctxmenu .ctx-item', { hasText: 'Exportar seleção como PDF' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('fixture.pdf');
  const head = fs.readFileSync(await file.path()).subarray(0, 5).toString();
  expect(head).toBe('%PDF-');
  await expect(page.locator('.item.type-note')).toHaveClass(/selected/);
});
