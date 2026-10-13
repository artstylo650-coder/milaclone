'use strict';

// Writing in notes: a click lands the caret where it was clicked, Enter in the
// title moves on to the body, and a prompt note gets a translated twin that
// follows edits in both directions (fake MyMemory server on port 4398).

const { test, expect } = require('@playwright/test');
const { freshCanvas, place } = require('./helpers');
const { fakeTranslator } = require('../test/fake-translator');

// one fake API on a fixed port: run this file's tests in one worker
test.describe.configure({ mode: 'serial' });
let fake;
test.beforeAll(async () => { fake = await new Promise(r => { const s = fakeTranslator().listen(4398, '127.0.0.1', () => r(s)); }); });
test.afterAll(async () => { fake.closeAllConnections(); await new Promise(r => fake.close(r)); });

async function seedNote(page, canvasId, data) {
  const id = await page.evaluate(async ({ canvasId, data }) => (await (await fetch('/api/item', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ canvasId, type: 'note', x: 200, y: 200, w: 280, data })
  })).json()).id, { canvasId, data });
  await page.reload();
  return page.locator(`[data-id="${id}"]`);
}

test('clicking an empty note body starts typing in the body, not the title', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  const note = await seedNote(page, canvasId, { title: '', body: '' });
  const body = note.locator('.nbody');
  const box = await body.boundingBox();
  await page.mouse.click(box.x + 20, box.y + box.height / 2);
  await expect(body).toBeFocused();
  await page.keyboard.type('corpo');
  await expect(body).toHaveValue('corpo');
  await expect(note.locator('.ntitle')).toHaveValue('');
});

test('a click inside the title puts the caret at that spot', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  const note = await seedNote(page, canvasId, { title: 'AAAAAAAA BBBBBBBB', body: '' });
  const title = note.locator('.ntitle');
  const box = await title.boundingBox();
  await page.mouse.click(box.x + 4, box.y + box.height / 2);   // before the first letter
  await expect(title).toBeFocused();
  await page.keyboard.type('X');
  await expect(title).toHaveValue('XAAAAAAAA BBBBBBBB');
});

test('dragging the mouse inside a field being edited selects text', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  const note = await seedNote(page, canvasId, { title: 'um titulo comprido aqui', body: 'primeira linha do texto' });
  for (const sel of ['.ntitle', '.nbody']) {
    const field = note.locator(sel);
    const view = note.locator('.nbody-view');
    const box = await (sel === '.nbody' && await view.isVisible() ? view : field).boundingBox();
    await page.mouse.click(box.x + 6, box.y + 8);   // enter edit mode
    await expect(field).toBeFocused();
    const live = await field.boundingBox();
    await page.mouse.move(live.x + 4, live.y + 8);
    await page.mouse.down();
    await page.mouse.move(live.x + live.width / 2, live.y + 8, { steps: 8 });
    await page.mouse.up();
    const picked = await field.evaluate(f => f.value.slice(f.selectionStart, f.selectionEnd));
    expect(picked.length).toBeGreaterThan(3);
    await expect(page.locator('.marquee')).toHaveCount(0);
    await expect(note).not.toHaveClass(/dragging/);
    await page.keyboard.press('Escape');
  }
});

test('Enter in the title jumps to the body', async ({ page }) => {
  await freshCanvas(page);
  await place(page, 'note');
  const note = page.locator('.item.type-note');
  await page.keyboard.type('Prompt');
  await page.keyboard.press('Enter');
  await page.keyboard.type('texto da nota');
  await expect(note.locator('.ntitle')).toHaveValue('Prompt');
  await expect(note.locator('.nbody')).toHaveValue('texto da nota');
});

test('a prompt note gets a translated twin that follows edits both ways', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  await page.evaluate(() => fetch('/api/translate/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ auto: 'prompts' }) }));
  const note = await seedNote(page, canvasId, { title: 'Prompt', body: '' });
  const bodyBox = await note.locator('.nbody').boundingBox();
  await page.mouse.click(bodyBox.x + 10, bodyBox.y + bodyBox.height / 2);
  await page.keyboard.type('retrato de mulher, fundo vermelho');
  await page.keyboard.press('Escape');

  const notes = page.locator('.item.type-note');
  await expect(notes).toHaveCount(2, { timeout: 10000 });
  const twin = notes.nth(1);
  await expect(twin.locator('.nbody')).toHaveValue('portrait of woman, background red');
  await expect(twin.locator('.lang-badge')).toHaveText('EN');
  await expect(note.locator('.lang-badge')).toHaveText('PT');
  await expect(page.locator('.line-label')).toHaveText('EN');

  // editing the English twin updates the Portuguese original
  await twin.locator('.nbody-view').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(', blue shirt');
  await page.keyboard.press('Escape');
  await expect(note.locator('.nbody')).toHaveValue('retrato de mulher, fundo vermelho, azul camisa', { timeout: 10000 });

  await page.reload();
  await expect(notes).toHaveCount(2);
  await expect(page.locator('.line-link')).toHaveCount(1);
});

test('any note can be translated from its menu', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  const note = await seedNote(page, canvasId, { title: 'Ideia', body: 'blue shirt' });
  await note.click({ button: 'right' });
  await page.locator('#ctxmenu .ctx-item', { hasText: 'Traduzir' }).click();
  await expect(page.locator('.item.type-note')).toHaveCount(2, { timeout: 10000 });
  await expect(page.locator('.item.type-note').nth(1).locator('.nbody')).toHaveValue('azul camisa');
});
