'use strict';

const { test, expect } = require('@playwright/test');
const { freshCanvas } = require('./helpers');

async function seedTwoNotes(page) {
  const canvasId = await freshCanvas(page);
  await page.evaluate(async (id) => {
    for (const [x, title] of [[180, 'First'], [500, 'Second']]) {
      await fetch('/api/item', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ canvasId: id, type: 'note', x, y: 180, data: { title, body: '' } })
      });
    }
  }, canvasId);
  await page.reload();
  return canvasId;
}

async function marqueeBoth(page) {
  await page.mouse.move(150, 150);
  await page.mouse.down();
  await page.mouse.move(900, 520, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('.item.selected')).toHaveCount(2);
}

test('left drag selects cards while middle drag remains canvas pan', async ({ page }) => {
  await seedTwoNotes(page);
  await expect(page.locator('#stage')).toHaveCSS('cursor', 'default');
  await marqueeBoth(page);
  await expect(page.locator('#multiActions')).toBeVisible();
  await expect(page.locator('#multiCount')).toHaveText('2 selecionados');
});

test('dragging one selected card moves the whole selection and persists', async ({ page }) => {
  const canvasId = await seedTwoNotes(page);
  await marqueeBoth(page);
  const cards = page.locator('.item.type-note');
  const beforeA = await cards.nth(0).boundingBox();
  const beforeB = await cards.nth(1).boundingBox();

  await page.mouse.move(beforeA.x + 30, beforeA.y + 20);
  await page.mouse.down();
  await page.mouse.move(beforeA.x + 110, beforeA.y + 80, { steps: 8 });
  await page.mouse.up();

  await page.goto('/#' + canvasId);
  const afterA = await cards.nth(0).boundingBox();
  const afterB = await cards.nth(1).boundingBox();
  expect(afterA.x - beforeA.x).toBeGreaterThan(60);
  expect(afterB.x - beforeB.x).toBeGreaterThan(60);
});

test('a group title reselects the group after reload; a card click picks only that card', async ({ page }) => {
  const canvasId = await seedTwoNotes(page);
  await marqueeBoth(page);
  await page.locator('#multiGroup').click();
  await expect(page.locator('#toast')).toContainText('itens agrupados');
  await expect(page.locator('.item.type-group')).toHaveCount(1);

  await page.goto('/#' + canvasId);
  await page.locator('.item.type-note').first().click();
  await expect(page.locator('.item.selected')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await page.locator('.group-title').click();
  await expect(page.locator('.item.selected')).toHaveCount(3);
  await expect(page.locator('#multiUngroup')).toBeVisible();
  await page.locator('#multiUngroup').click();
  await expect(page.locator('.item.type-group')).toHaveCount(0);
  await expect(page.locator('.item.type-note')).toHaveCount(2);
});

test('visual group surrounds its cards and dragging its title moves the contents', async ({ page }) => {
  const canvasId = await seedTwoNotes(page);
  await marqueeBoth(page);
  await page.locator('#multiGroup').click();
  const group = page.locator('.item.type-group');
  const notes = page.locator('.item.type-note');
  const groupBefore = await group.boundingBox();
  const firstBefore = await notes.first().boundingBox();
  const secondBefore = await notes.nth(1).boundingBox();
  expect(groupBefore.x).toBeLessThan(firstBefore.x);
  expect(groupBefore.x + groupBefore.width).toBeGreaterThan(secondBefore.x + secondBefore.width);

  const title = await group.locator('.group-title').boundingBox();
  await page.mouse.move(title.x + 30, title.y + 15);
  await page.mouse.down();
  await page.mouse.move(title.x + 100, title.y + 65, { steps: 8 });
  await page.mouse.up();

  await page.goto('/#' + canvasId);
  const groupAfter = await group.boundingBox();
  const firstAfter = await notes.first().boundingBox();
  expect(groupAfter.x - groupBefore.x).toBeGreaterThan(50);
  expect(firstAfter.x - firstBefore.x).toBeGreaterThan(50);
});

test('dropping an image inside a group adds it to that group', async ({ page }) => {
  const canvasId = await seedTwoNotes(page);
  await marqueeBoth(page);
  await page.locator('#multiGroup').click();
  const groupId = await page.locator('.item.type-group').getAttribute('data-id');

  const imageId = await page.evaluate(async id => {
    const item = await (await fetch('/api/item', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        canvasId: id, type: 'image', x: 900, y: 220, w: 180,
        data: { src: '/uploads/group-test.jpg', name: 'group-test.jpg', naturalW: 2, naturalH: 3 }
      })
    })).json();
    return item.id;
  }, canvasId);
  await page.reload();

  const image = page.locator(`[data-id="${imageId}"]`);
  const group = page.locator(`[data-id="${groupId}"]`);
  const from = await image.boundingBox();
  const into = await group.boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(into.x + into.width / 2, into.y + into.height / 2, { steps: 10 });
  await page.mouse.up();

  const savedGroupId = await page.evaluate(async ({ canvasId, imageId }) => {
    const view = await (await fetch('/api/canvas/' + canvasId)).json();
    return view.items.find(item => item.id === imageId).data.groupId || null;
  }, { canvasId, imageId });
  expect(savedGroupId).toBe(groupId);
});

test('shift-clicking photos selects them without the browser tinting the whole board', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  await page.evaluate(async id => {
    for (const x of [100, 400, 700, 1000]) await fetch('/api/item', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ canvasId: id, type: 'image', x, y: 200, w: 200, data: { src: '/missing.png', name: 'x' } }) });
  }, canvasId);
  await page.reload();
  const imgs = page.locator('.item.type-image');
  await imgs.nth(0).click();
  await imgs.nth(1).click({ modifiers: ['Shift'] });
  await imgs.nth(3).click({ modifiers: ['Shift'] });
  await expect(page.locator('.item.selected')).toHaveCount(3);
  await expect(imgs.nth(2)).not.toHaveClass(/selected/);
  expect(await page.evaluate(() => getSelection().type)).not.toBe('Range');
});
