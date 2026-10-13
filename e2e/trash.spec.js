'use strict';

// Trash and backup as a user reaches them from the top-bar "More" menu.

const { test, expect } = require('@playwright/test');
const { freshCanvas } = require('./helpers');

test('a deleted note is restored from the trash panel and survives reload', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  await page.evaluate(async id => {
    await fetch('/api/item', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ canvasId: id, type: 'note', x: 300, y: 200, data: { title: 'Recuperar', body: '' } })
    });
  }, canvasId);
  await page.reload();
  const note = page.locator('.item.type-note');
  await note.click({ button: 'right' });
  await page.locator('#ctxmenu .ctx-item', { hasText: 'Mover para a lixeira' }).click();
  await expect(note).toHaveCount(0);

  await page.locator('#appMenuBtn').click();
  await page.locator('#ctxmenu .ctx-item', { hasText: 'Lixeira' }).click();
  const row = page.locator('.trash-row', { hasText: 'Recuperar' }).first();
  await expect(row).toContainText('De fixture');
  await row.getByRole('button', { name: 'Restaurar' }).click();
  await expect(page.locator('.panel')).toHaveCount(0);
  await expect(note).toHaveCount(1);
  await page.reload();
  await expect(note.locator('.ntitle')).toHaveValue('Recuperar');
});

test('Download backup serves a gzip archive', async ({ page }) => {
  await freshCanvas(page);
  await page.locator('#appMenuBtn').click();
  const download = page.waitForEvent('download');
  await page.locator('#ctxmenu .ctx-item', { hasText: 'Baixar backup' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^milaclone-backup-.*\.tar\.gz$/);
});
