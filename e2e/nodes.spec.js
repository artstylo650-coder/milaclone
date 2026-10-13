'use strict';

const { test, expect } = require('@playwright/test');
const { freshCanvas } = require('./helpers');

test('nodes connect through ports and the connection survives reload', async ({ page }) => {
  const canvasId = await freshCanvas(page);
  await page.evaluate(async id => {
    const create = (x, title) => fetch('/api/item', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        canvasId: id, type: 'node', x, y: 260, w: 260,
        data: { title, inputs: ['input'], outputs: ['output'], connections: [] }
      })
    });
    await create(260, 'Source');
    await create(760, 'Target');
  }, canvasId);
  await page.reload();

  const output = page.locator('.item.node').first().locator('.node-port.output');
  const input = page.locator('.item.node').nth(1).locator('.node-port.input');
  const from = await output.boundingBox();
  const to = await input.boundingBox();
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.className || '', {
    x: to.x + to.width / 2, y: to.y + to.height / 2
  });
  expect(hit).toContain('input');
  const outputHit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.className || '', {
    x: from.x + from.width / 2, y: from.y + from.height / 2
  });
  expect(outputHit).toContain('output');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await expect(input).toHaveClass(/connect-target/);
  await page.mouse.up();

  await expect(page.locator('.node-connection:not(.preview)')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('.node-connection:not(.preview)')).toHaveCount(1);
});

test('unfinished Node tool is not offered as a working feature', async ({ page }) => {
  await freshCanvas(page);
  await expect(page.locator('[data-tool="node"]')).toHaveCount(0);
});
