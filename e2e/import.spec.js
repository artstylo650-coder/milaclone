'use strict';

const { test, expect } = require('@playwright/test');
const { freshCanvas } = require('./helpers');

const fakePng = name => ({
  name,
  mimeType: 'image/png',
  buffer: Buffer.from('not-a-real-png')
});

test('Image imports multiple files concurrently and places them in a grid', async ({ page }) => {
  await freshCanvas(page);
  let activeUploads = 0;
  let maxActiveUploads = 0;
  await page.route('**/api/upload', async route => {
    activeUploads++;
    maxActiveUploads = Math.max(maxActiveUploads, activeUploads);
    await new Promise(resolve => setTimeout(resolve, 100));
    await route.continue();
    activeUploads--;
  });
  const chooserPromise = page.waitForEvent('filechooser');
  await page.click('.tool[data-tool="image"]');
  const chooser = await chooserPromise;
  expect(chooser.isMultiple()).toBe(true);
  await chooser.setFiles([fakePng('one.png'), fakePng('two.png'), fakePng('three.png')]);

  const images = page.locator('.item.type-image');
  await expect(images).toHaveCount(3);
  expect(maxActiveUploads).toBeGreaterThan(1);
  const first = await images.nth(0).boundingBox();
  const second = await images.nth(1).boundingBox();
  expect(Math.abs(first.x - second.x)).toBeGreaterThan(100);
});

test('an image imported inside a group becomes a group member', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  const groupId = await page.evaluate(async id => {
    const group = await (await fetch('/api/item', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        canvasId: id, type: 'group', x: 300, y: 100, w: 650, h: 550,
        data: { title: 'Photos' }
      })
    })).json();
    await fetch('/api/item/' + group.id, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ z: 0, data: { groupId: group.id } })
    });
    return group.id;
  }, canvasId);
  await page.reload();

  const chooserPromise = page.waitForEvent('filechooser');
  await page.click('.tool[data-tool="image"]');
  const chooser = await chooserPromise;
  await chooser.setFiles(fakePng('inside.png'));
  await expect(page.locator('.item.type-image')).toHaveCount(1);

  const savedGroupId = await page.evaluate(async id => {
    const view = await (await fetch('/api/canvas/' + id)).json();
    return view.items.find(item => item.type === 'image').data.groupId;
  }, canvasId);
  expect(savedGroupId).toBe(groupId);
});

test('dropping files on the canvas imports them at the drop point', async ({ page }) => {
  await freshCanvas(page);
  await page.locator('#stage').evaluate((stage) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['hello'], 'dropped.txt', { type: 'text/plain' }));
    stage.dispatchEvent(new DragEvent('dragover', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    stage.dispatchEvent(new DragEvent('drop', {
      dataTransfer: transfer, bubbles: true, cancelable: true, clientX: 500, clientY: 350
    }));
  });
  await expect(page.locator('.item.type-file .fname')).toHaveText('dropped.txt');
});

test('pasting a URL creates a link card', async ({ page }) => {
  await freshCanvas(page);
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.setData('text/plain', 'https://example.com/catalog');
    document.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: transfer, bubbles: true, cancelable: true
    }));
  });
  await expect(page.locator('.item.type-link .lurl')).toHaveValue('https://example.com/catalog');
});

test('a board with an image renders that image as its cover', async ({ page }) => {
  const parentId = await freshCanvas(page);
  const childId = await page.evaluate(async (canvasId) => {
    const board = await (await fetch('/api/item', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ canvasId, type: 'board', data: { title: 'Photos' } })
    })).json();
    await fetch('/api/item', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        canvasId: board.data.childCanvasId, type: 'image',
        data: { src: '/uploads/cover-test.jpg', name: 'cover-test.jpg' }
      })
    });
    return board.data.childCanvasId;
  }, parentId);
  expect(childId).toBeTruthy();

  await page.reload();
  await expect(page.locator('.item.type-board .tile.preview img')).toHaveAttribute('src', /^\/api\/thumb\/i_/);
});
