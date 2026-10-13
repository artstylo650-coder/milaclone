'use strict';

// Clipboard, context menus and group membership as a user drives them:
// whole-selection copy/paste, cut + paste of a board without losing its
// contents, external paste after an internal copy, and dragging a card out
// of its group.

const { test, expect } = require('@playwright/test');
const { freshCanvas } = require('./helpers');

const TRANSFER = r => r.url().endsWith('/api/transfer') && r.request().method() === 'POST';

async function seed(page, canvasId, items) {
  return page.evaluate(async ({ canvasId, items }) => {
    const ids = [];
    for (const item of items) {
      const created = await (await fetch('/api/item', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ canvasId }, item))
      })).json();
      ids.push(created);
    }
    return ids;
  }, { canvasId, items });
}

async function marquee(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

const twoNotes = [
  { type: 'note', x: 180, y: 180, data: { title: 'First', body: '' } },
  { type: 'note', x: 500, y: 180, data: { title: 'Second', body: '' } }
];

test('keyboard copy + paste duplicates the whole selection and it persists', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  await seed(page, canvasId, twoNotes);
  await page.reload();
  await marquee(page, { x: 150, y: 150 }, { x: 900, y: 520 });
  await expect(page.locator('.item.selected')).toHaveCount(2);

  await page.keyboard.press('Control+c');
  await expect(page.locator('#toast')).toContainText('Copiado: 2 itens');
  const pasted = page.waitForResponse(TRANSFER);
  await page.keyboard.press('Control+v');
  await pasted;
  await expect(page.locator('.item.type-note')).toHaveCount(4);
  await expect(page.locator('.item.selected')).toHaveCount(2);

  await page.reload();
  await expect(page.locator('.item.type-note')).toHaveCount(4);
});

test('cut + paste moves a board to another board with its contents intact', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  const [board, other] = await seed(page, canvasId, [
    { type: 'board', x: 200, y: 200, data: { title: 'Fotos' } },
    { type: 'board', x: 600, y: 200, data: { title: 'Destino' } }
  ]);
  await seed(page, board.data.childCanvasId, [{ type: 'note', x: 100, y: 100, data: { title: 'Inside', body: '' } }]);
  await page.reload();

  await page.locator(`[data-id="${board.id}"] .tile`).click({ button: 'right' });
  await page.locator('#ctxmenu .ctx-item', { hasText: 'Recortar' }).click();
  await expect(page.locator(`[data-id="${board.id}"]`)).toHaveClass(/cut-pending/);

  await page.locator(`[data-id="${other.id}"] .tile`).dblclick();
  await expect(page.locator('#crumbs .current')).toHaveText('Destino');
  await page.mouse.click(700, 400, { button: 'right' });
  const pasted = page.waitForResponse(TRANSFER);
  await page.locator('#ctxmenu .ctx-item', { hasText: 'Colar aqui' }).click();
  await pasted;

  const moved = page.locator(`[data-id="${board.id}"]`);
  await expect(moved).toHaveCount(1);
  await expect(moved).not.toHaveClass(/cut-pending/);
  await moved.locator('.tile').dblclick();
  await expect(page.locator('#crumbs .current')).toHaveText('Fotos');
  await expect(page.locator('.item.type-note textarea.ntitle')).toHaveValue('Inside');

  await page.goto('/#' + canvasId);
  await expect(page.locator(`[data-id="${board.id}"]`)).toHaveCount(0);
});

test('external text still pastes as a note after copying cards', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  await seed(page, canvasId, [twoNotes[0]]);
  await page.reload();
  await page.locator('.item.type-note').click({ button: 'right' });
  await page.locator('#ctxmenu .ctx-item', { hasText: 'Copiar' }).click();

  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.setData('text/plain', 'Texto de fora');
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  });
  await expect(page.locator('.item.type-note')).toHaveCount(2);
  await expect(page.locator('.item.type-note .nbody').last()).toHaveValue('Texto de fora');
});

test('right-click inside a multi-selection keeps it and deletes all of it', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  await seed(page, canvasId, twoNotes);
  await page.reload();
  await marquee(page, { x: 150, y: 150 }, { x: 900, y: 520 });
  await page.locator('.item.type-note').first().click({ button: 'right' });
  await expect(page.locator('.item.selected')).toHaveCount(2);
  await page.locator('#ctxmenu .ctx-item', { hasText: 'Mover 2 itens para a lixeira' }).click();
  await expect(page.locator('.item.type-note')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.item.type-note')).toHaveCount(0);
});

test('empty canvas context menu adds a card where it was opened', async ({ page }) => {
  await freshCanvas(page);
  await page.mouse.click(640, 360, { button: 'right' });
  await page.locator('#ctxmenu .ctx-item', { hasText: 'Adicionar nota' }).click();
  const note = page.locator('.item.type-note');
  await expect(note).toHaveCount(1);
  const box = await note.boundingBox();
  expect(Math.abs(box.x + box.width / 2 - 640)).toBeLessThan(40);
});

test('dragging one card out of its group removes only that card from it', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  await seed(page, canvasId, twoNotes);
  await page.reload();
  await marquee(page, { x: 150, y: 150 }, { x: 900, y: 520 });
  await page.locator('#multiGroup').click();
  await expect(page.locator('.item.type-group')).toHaveCount(1);
  await page.keyboard.press('Escape');

  const first = page.locator('.item.type-note').first();
  const id = await first.getAttribute('data-id');
  const box = await first.boundingBox();
  const saved = page.waitForResponse(r => r.url().includes('/api/item/' + id) && r.request().method() === 'PATCH');
  await page.mouse.move(box.x + 30, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(box.x + 30, box.y + 420, { steps: 10 });
  await page.mouse.up();
  await saved;

  const groups = await page.evaluate(async canvasId => {
    const view = await (await fetch('/api/canvas/' + canvasId)).json();
    return view.items.filter(it => it.type === 'note').map(it => it.data.groupId || null);
  }, canvasId);
  expect(groups.filter(Boolean)).toHaveLength(1);
});
