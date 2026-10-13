'use strict';

// Lines between cards: drag a card's link handle onto another card, label the
// line from its context menu, and see it follow moves, copies and deletes.

const { test, expect } = require('@playwright/test');
const { freshCanvas } = require('./helpers');

async function seedNotes(page, canvasId) {
  const ids = await page.evaluate(async id => {
    const out = [];
    for (const [x, title] of [[160, 'Ideia'], [620, 'Resultado']]) {
      const it = await (await fetch('/api/item', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ canvasId: id, type: 'note', x, y: 220, data: { title, body: '' } })
      })).json();
      out.push(it.id);
    }
    return out;
  }, canvasId);
  await page.reload();
  return ids;
}

async function connect(page, fromId, toId) {
  const from = page.locator(`[data-id="${fromId}"]`);
  await from.hover();
  const handle = await from.locator('.link-handle').boundingBox();
  const target = await page.locator(`[data-id="${toId}"]`).boundingBox();
  const created = page.waitForResponse(r => r.url().endsWith('/api/item') && r.request().method() === 'POST');
  await page.mouse.move(handle.x + 8, handle.y + 8);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 });
  await expect(page.locator(`[data-id="${toId}"]`)).toHaveClass(/link-target/);
  await page.mouse.up();
  await created;
}

test('dragging the link handle onto another card draws a line that survives reload', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  const [a, b] = await seedNotes(page, canvasId);
  await connect(page, a, b);
  await expect(page.locator('.line-link')).toHaveCount(1);
  await expect(page.locator('.line-head')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('.line-link')).toHaveCount(1);
  // the board card count ignores lines
  const count = await page.evaluate(async id => {
    const root = (await (await fetch('/api/root')).json()).rootCanvasId;
    const view = await (await fetch('/api/canvas/' + root)).json();
    return view.items.find(it => it.data.childCanvasId === id)._childCount;
  }, canvasId);
  expect(count).toBe(2);
});

test('a line gets a label and both arrows from its menu, and goes when a card is deleted', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  const [a, b] = await seedNotes(page, canvasId);
  await connect(page, a, b);
  await page.keyboard.press('Escape');

  const ra = await page.locator(`[data-id="${a}"]`).boundingBox();
  const rb = await page.locator(`[data-id="${b}"]`).boundingBox();
  const mid = { x: (ra.x + ra.width + rb.x) / 2, y: ra.y + ra.height / 2 };
  await page.mouse.click(mid.x, mid.y, { button: 'right' });
  await page.locator('#ctxmenu .ctx-item', { hasText: 'Adicionar texto' }).click();
  await page.locator('.panel input').fill('aprovado');
  await page.locator('.panel-btn', { hasText: 'Salvar' }).click();
  await expect(page.locator('.line-label')).toHaveText('aprovado');

  await page.mouse.click(mid.x, mid.y, { button: 'right' });
  await page.locator('#ctxmenu .ctx-item', { hasText: 'Setas nas duas pontas' }).click();
  await expect(page.locator('.line-head')).toHaveCount(2);
  await page.reload();
  await expect(page.locator('.line-label')).toHaveText('aprovado');
  await expect(page.locator('.line-head')).toHaveCount(2);

  await page.locator(`[data-id="${a}"]`).click({ button: 'right' });
  await page.locator('#ctxmenu .ctx-item', { hasText: 'Mover para a lixeira' }).click();
  await expect(page.locator('.line-link')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.line-link')).toHaveCount(0);
});

test('copying both cards copies the line between them', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  const [a, b] = await seedNotes(page, canvasId);
  await connect(page, a, b);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+d');
  await expect(page.locator('.item.type-note')).toHaveCount(4);
  await expect(page.locator('.line-link')).toHaveCount(2);
});

test('dropping the handle on empty canvas offers card types and creates the chosen one connected', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  const [a] = await seedNotes(page, canvasId);
  const from = page.locator(`[data-id="${a}"]`);
  await from.hover();
  const handle = await from.locator('.link-handle').boundingBox();
  await page.mouse.move(handle.x + 8, handle.y + 8);
  await page.mouse.down();
  await page.mouse.move(handle.x + 120, handle.y + 300, { steps: 10 });
  await page.mouse.up();
  const menu = page.locator('#ctxmenu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('.ctx-item')).toContainText(['Nota', 'Lista de tarefas', 'Link', 'Coluna', 'Board']);
  await menu.getByRole('button', { name: /Lista de tarefas/ }).click();
  await expect(page.locator('.item.type-todo')).toHaveCount(1);
  await expect(page.locator('.item.type-note')).toHaveCount(2);
  await expect(page.locator('.line-link')).toHaveCount(1);
});

test('closing the card-type menu after a link drop creates nothing', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  const [a] = await seedNotes(page, canvasId);
  const from = page.locator(`[data-id="${a}"]`);
  await from.hover();
  const handle = await from.locator('.link-handle').boundingBox();
  await page.mouse.move(handle.x + 8, handle.y + 8);
  await page.mouse.down();
  await page.mouse.move(handle.x + 120, handle.y + 300, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator('#ctxmenu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#ctxmenu')).toBeHidden();
  await expect(page.locator('.item')).toHaveCount(2);
  await expect(page.locator('.line-link')).toHaveCount(0);
});
