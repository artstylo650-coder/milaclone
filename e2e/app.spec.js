'use strict';

// Milaclone as an app: the browser can install it (manifest, icons, service
// worker) and the "Sobre o Milaclone" panel shows the running version and the
// update state. The test server runs from a folder that is not a git checkout
// (test/e2e-server.js), so no check ever reaches the network.

const { test, expect } = require('@playwright/test');
const { freshCanvas } = require('./helpers');

test('the page is installable: manifest, icons and a service worker', async ({ page }) => {
  await freshCanvas(page);
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBe('/manifest.webmanifest');
  const manifest = await (await page.request.get(href)).json();
  expect(manifest.name).toBe('Milaclone');
  expect(manifest.display).toBe('standalone');
  expect(manifest.start_url).toBe('/');
  const sizes = manifest.icons.map(i => i.sizes);
  expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
  expect(manifest.icons.some(i => i.purpose === 'maskable')).toBe(true);
  for (const icon of manifest.icons) {
    const r = await page.request.get(icon.src);
    expect(r.status()).toBe(200);
    expect(r.headers()['content-type']).toContain('image/png');
  }
  expect((await page.request.get('/icons/milaclone.ico')).status()).toBe(200);
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(1);
  const registered = await page.evaluate(async () => (await navigator.serviceWorker.ready).active ? true : false);
  expect(registered).toBe(true);
});

test('Sobre o Milaclone shows the version and says why it cannot update here', async ({ page }) => {
  await freshCanvas(page);
  await page.locator('#appMenuBtn').click();
  await page.locator('#ctxmenu .ctx-item', { hasText: 'Sobre o Milaclone' }).click();
  const panel = page.locator('.panel');
  await expect(panel).toContainText(/Milaclone v\d+\.\d+\.\d+/);
  await expect(panel.locator('.about-result')).toContainText('não é um repositório git');
  await expect(panel.getByRole('button', { name: 'Verificar de novo' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Atualizar agora' })).toHaveCount(0);
});
