'use strict';

// Organizing a board: formatted notes, align/nudge/snap, the minimap, and
// tags with the board filter.

const { test, expect } = require('@playwright/test');
const { freshCanvas } = require('./helpers');

async function seed(page, canvasId, notes) {
  const ids = await page.evaluate(async ({ canvasId, notes }) => {
    const out = [];
    for (const n of notes) {
      const it = await (await fetch('/api/item', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ canvasId, type: 'note', ...n }) })).json();
      out.push(it.id);
    }
    return out;
  }, { canvasId, notes });
  await page.reload();
  return ids;
}
const saved = (page, canvasId, id) => page.evaluate(async ({ canvasId, id }) =>
  (await (await fetch('/api/canvas/' + canvasId)).json()).items.find(i => i.id === id), { canvasId, id });

test('note bodies render Markdown and edit as plain text', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  const [id] = await seed(page, canvasId, [{ x: 200, y: 200, data: { title: 'Pauta', body: '**Urgente** hoje\n- [x] gola\n- [ ] punho\n<b>sem html</b>' } }]);
  const note = page.locator(`[data-id="${id}"]`);
  await expect(note.locator('.nbody-view strong')).toHaveText('Urgente');
  await expect(note.locator('.nbody-view .md-check li')).toHaveCount(2);
  await expect(note.locator('.nbody-view b')).toHaveCount(0);
  await expect(note.locator('.nbody')).toBeHidden();
  await note.locator('.nbody-view').click();
  const body = note.locator('.nbody');
  await expect(body).toBeVisible();
  await expect(body).toBeFocused();
  await body.press('Control+End');
  await body.press('Enter');
  await body.press('Control+b');
  await expect(body).toHaveValue(/\*\*text\*\*$/);
  await expect(note.locator('.fmt-bar')).toBeVisible();
});

test('align top, arrow-key nudge and snap to grid all persist', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  const [a, b] = await seed(page, canvasId, [{ x: 180, y: 160, data: { title: 'A' } }, { x: 520, y: 260, data: { title: 'B' } }]);
  await page.mouse.move(150, 120); await page.mouse.down();
  await page.mouse.move(900, 560, { steps: 8 }); await page.mouse.up();
  await page.locator('#multiAlign').click();
  const aligned = page.waitForResponse(r => r.url().endsWith('/api/items'));
  await page.locator('#ctxmenu .ctx-item', { hasText: 'Alinhar no topo' }).click();
  await aligned;
  expect((await saved(page, canvasId, b)).y).toBe(160);

  await page.keyboard.press('Escape');
  await page.locator(`[data-id="${a}"]`).click();
  await expect(page.locator(`[data-id="${a}"]`)).toHaveClass(/editing/);
  await page.keyboard.press('Escape');   // leaves the field, keeps the card selected
  await expect(page.locator(`[data-id="${a}"]`)).toHaveClass(/selected/);
  await expect(page.locator(`[data-id="${a}"]`)).not.toHaveClass(/editing/);
  const nudged = page.waitForResponse(r => r.url().endsWith('/api/items'));
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  await nudged;
  expect((await saved(page, canvasId, a)).x).toBe(183);

  await page.locator('#appMenuBtn').click();
  await page.locator('#ctxmenu .ctx-item', { hasText: 'Grade magnética' }).click();
  const box = await page.locator(`[data-id="${b}"]`).boundingBox();
  const moved = page.waitForResponse(r => r.url().includes('/api/item/' + b) && r.request().method() === 'PATCH');
  await page.mouse.move(box.x + 40, box.y + 10); await page.mouse.down();
  await page.mouse.move(box.x + 117, box.y + 63, { steps: 6 }); await page.mouse.up();
  await moved;
  const snapped = await saved(page, canvasId, b);
  expect(snapped.x % 22).toBe(0);
  expect(snapped.y % 22).toBe(0);
  await page.evaluate(() => localStorage.removeItem('snapToGrid'));
});

test('clicking the minimap moves the view', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  await seed(page, canvasId, [{ x: 0, y: 0, data: { title: 'Perto' } }, { x: 4000, y: 3000, data: { title: 'Longe' } }]);
  const map = page.locator('#minimap');
  await expect(map).toBeVisible();
  const before = await page.locator('#world').getAttribute('style');
  const r = await map.boundingBox();
  await page.mouse.click(r.x + r.width - 14, r.y + r.height - 14);
  await expect(page.locator('#world')).not.toHaveAttribute('style', before);
  await expect(page.locator('.item', { has: page.locator('textarea.ntitle').filter({ hasText: '' }) }).last()).toBeVisible();
});

test('tags show on cards, filter the board and are searchable', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  const [a, b] = await seed(page, canvasId, [{ x: 180, y: 200, data: { title: 'Com tag' } }, { x: 520, y: 200, data: { title: 'Sem tag' } }]);
  await page.locator(`[data-id="${a}"]`).click({ button: 'right' });
  await page.locator('#ctxmenu .ctx-item', { hasText: 'Tags…' }).click();
  await page.locator('.panel input').fill('Aprovado, cliente x');
  await page.locator('.panel-btn', { hasText: 'Salvar' }).click();
  await expect(page.locator(`[data-id="${a}"] .tag-chip`)).toHaveText(['#aprovado', '#cliente-x']);
  await page.reload();
  await expect(page.locator(`[data-id="${a}"] .tag-chip`)).toHaveCount(2);

  await page.locator('#filterBtn').click();
  await page.locator('#ctxmenu .ctx-item', { hasText: '#aprovado' }).click();
  await expect(page.locator(`[data-id="${b}"]`)).toHaveClass(/filtered-out/);
  await expect(page.locator(`[data-id="${a}"]`)).not.toHaveClass(/filtered-out/);
  await expect(page.locator('#filterBtn')).toContainText('#aprovado');
  await page.locator('#filterBtn').click();
  await page.locator('#ctxmenu .ctx-item', { hasText: 'Mostrar todos os cards' }).click();
  await expect(page.locator(`[data-id="${b}"]`)).not.toHaveClass(/filtered-out/);

  await page.keyboard.press('Control+k');
  await page.locator('.cmdk-input').fill('#cliente-x com tag');
  await expect(page.locator('.cmdk-row', { hasText: 'Com tag' })).toHaveCount(1);
});
