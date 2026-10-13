'use strict';

// Undo / redo as a user drives it: keyboard, toolbar buttons, and multi-request
// actions (grouping) undone in one step.

const { test, expect } = require('@playwright/test');
const { freshCanvas, place, leaveEdit } = require('./helpers');

const HISTORY = r => r.url().includes('/api/history/') && r.request().method() === 'POST';

async function seedNotes(page, canvasId) {
  await page.evaluate(async id => {
    for (const [x, title] of [[180, 'First'], [500, 'Second']]) {
      await fetch('/api/item', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ canvasId: id, type: 'note', x, y: 180, data: { title, body: '' } })
      });
    }
  }, canvasId);
  await page.reload();
}

test('Ctrl+Z restores a deleted card and Ctrl+Shift+Z deletes it again', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  await seedNotes(page, canvasId);
  const notes = page.locator('.item.type-note');
  await notes.first().click();
  await page.keyboard.press('Escape');
  await notes.first().click({ button: 'right' });
  await page.locator('#ctxmenu .ctx-item', { hasText: 'Mover para a lixeira' }).click();
  await expect(notes).toHaveCount(1);

  let done = page.waitForResponse(HISTORY);
  await page.keyboard.press('Control+z');
  await done;
  await expect(notes).toHaveCount(2);
  await expect(page.locator('#toast')).toContainText('Desfeito');

  done = page.waitForResponse(HISTORY);
  await page.keyboard.press('Control+Shift+z');
  await done;
  await expect(notes).toHaveCount(1);
  await page.reload();
  await expect(notes).toHaveCount(1);
});

test('grouping is one undo step and the toolbar buttons track history', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  await seedNotes(page, canvasId);
  await expect(page.locator('#undoBtn')).toBeDisabled();
  await page.mouse.move(150, 150);
  await page.mouse.down();
  await page.mouse.move(900, 520, { steps: 8 });
  await page.mouse.up();
  await page.locator('#multiGroup').click();
  await expect(page.locator('.item.type-group')).toHaveCount(1);
  await expect(page.locator('#undoBtn')).toBeEnabled();

  await page.locator('#undoBtn').click();
  await expect(page.locator('.item.type-group')).toHaveCount(0);
  await expect(page.locator('.item.type-note')).toHaveCount(2);
  const groupIds = await page.evaluate(async id => {
    const view = await (await fetch('/api/canvas/' + id)).json();
    return view.items.map(it => it.data.groupId || null);
  }, canvasId);
  expect(groupIds.filter(Boolean)).toHaveLength(0);
  await expect(page.locator('#undoBtn')).toBeDisabled();
  await expect(page.locator('#redoBtn')).toBeEnabled();
});

test('undo reverts a typed note body in one step', async ({ page }) => {
  await freshCanvas(page);
  await place(page, 'note');
  const body = page.locator('.item.type-note').getByPlaceholder('Escreva uma nota…');
  const saved = page.waitForResponse(r => r.url().includes('/api/item/') && r.request().method() === 'PATCH');
  await body.pressSequentially('Rascunho', { delay: 20 });
  await saved;
  await leaveEdit(page);
  const done = page.waitForResponse(HISTORY);
  await page.keyboard.press('Control+z');
  await done;
  await expect(page.locator('.item.type-note')).toHaveCount(1);
  await expect(page.locator('.item.type-note').getByPlaceholder('Escreva uma nota…')).toHaveValue('');
});
