'use strict';

// Two devices on the same board: a card added on one shows up on the other
// without reloading (Server-Sent Events).

const { test, expect } = require('@playwright/test');
const { freshCanvas, place } = require('./helpers');

test('a note created in one window appears in another open on the same board', async ({ page, browser }) => {
  const canvasId = await freshCanvas(page);
  const other = await (await browser.newContext()).newPage();
  await other.goto('/#' + canvasId);
  await expect(other.locator('#crumbs .current')).toHaveText('fixture');
  await expect(other.locator('.item.type-note')).toHaveCount(0);

  await place(page, 'note');
  await expect(other.locator('.item.type-note')).toHaveCount(1, { timeout: 5000 });

  await page.locator('.item.type-note').getByPlaceholder('Escreva uma nota…').fill('vista no outro aparelho');
  await expect(other.locator('.item.type-note .nbody')).toHaveValue('vista no outro aparelho', { timeout: 5000 });
  await other.context().close();
});
