'use strict';

// Exploratory robot. Starts its own server on throwaway data, seeds a board
// with photos, notes, columns, groups and lines, then drives a real Chromium
// through hundreds of random user actions (seeded, so any run can be replayed)
// and checks after every step that:
//   - no JavaScript error, console error or failing first-party request happened
//   - the board on screen matches the database (cards present, positions equal)
//   - the data is consistent (lines point at cards, group/column links resolve)
//   - no native blue text selection is painted over the board
//   - the multi-selection bar and modals are in a sane state
// Findings are de-duplicated and written to qa-report/explore/ with a
// screenshot and the actions that led to each one.
//
//   node scripts/explore.js [--steps 250] [--seed 1234] [--headed] [--slow 0]

const { chromium } = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : fallback; };
const STEPS = Number(opt('steps', 250));
const SEED = Number(opt('seed', Date.now() % 1e9));
const HEADED = args.includes('--headed');
const SLOW = Number(opt('slow', 0));
const PORT = Number(opt('port', 4331));
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(root, 'qa-report', 'explore');

// ---- seeded randomness -----------------------------------------------------
let s = SEED >>> 0;
const rand = () => { s += 0x6D2B79F5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const int = (a, b) => a + Math.floor(rand() * (b - a + 1));
const pick = arr => arr[Math.floor(rand() * arr.length)];
const WORDS = ['gola', 'punho', 'azul marinho', 'aprovado', 'cliente', 'tecido', 'bordado', 'polo', '**forte**', '- item', 'manga curta', 'referência'];

// ---- server ----------------------------------------------------------------
async function startServer() {
  const dataDir = path.join(root, '.explore-data');
  const child = spawn(process.execPath, [path.join(root, 'test', 'e2e-server.js')], {
    cwd: root, env: { ...process.env, EXPLORE_DATA: dataDir, EXPLORE_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(BASE + '/api/health')).ok) return { child, log: () => log }; } catch (_) {}
    await new Promise(r => setTimeout(r, 150));
  }
  child.kill();
  throw new Error('Server did not start:\n' + log);
}

// ---- seed data -------------------------------------------------------------
const api = async (method, url, body) => (await fetch(BASE + url, {
  method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body)
})).json();

async function upload(w, h, color, name) {
  const png = await sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer();
  const fd = new FormData();
  fd.append('file', new Blob([png], { type: 'image/png' }), name);
  return (await fetch(BASE + '/api/upload', { method: 'POST', body: fd })).json();
}

async function seed() {
  const home = (await api('GET', '/api/root')).rootCanvasId;
  const board = await api('POST', '/api/item', { canvasId: home, type: 'board', x: 120, y: 120, data: { title: 'Explorer' } });
  const id = board.data.childCanvasId;
  const photos = [];
  for (const [i, [w, h, c]] of [[600, 900, '#7a9cc6'], [900, 600, '#c67a9c'], [700, 700, '#9cc67a'], [500, 1000, '#c6b07a'], [1200, 800, '#7ac6c0'], [800, 1100, '#a07ac6']].entries()) {
    const up = await upload(w, h, c, `foto-${i}.png`);
    photos.push(await api('POST', '/api/item', { canvasId: id, type: 'image', x: 80 + (i % 3) * 300, y: 80 + Math.floor(i / 3) * 420, w: 260,
      data: { src: up.src, name: up.name, naturalW: w, naturalH: h } }));
  }
  const notes = [];
  for (const [i, t] of ['Briefing', 'Paleta', 'Pendências'].entries()) {
    notes.push(await api('POST', '/api/item', { canvasId: id, type: 'note', x: 1000, y: 80 + i * 200, data: { title: t, body: i === 1 ? '**Azul** e branco\n- gola\n- punho' : 'texto ' + i } }));
  }
  await api('POST', '/api/item', { canvasId: id, type: 'todo', x: 1300, y: 80, data: { title: 'Tarefas', tasks: [{ id: 'a', text: 'Aprovar gola', done: false }] } });
  const col = await api('POST', '/api/item', { canvasId: id, type: 'column', x: 1300, y: 360, w: 220, data: { title: 'Coluna' } });
  for (let i = 0; i < 2; i++) {
    const up = await upload(600, 800, '#88a', `col-${i}.png`);
    await api('POST', '/api/item', { canvasId: id, type: 'image', parentItemId: col.id, x: 0, y: i, data: { src: up.src, name: up.name, naturalW: 600, naturalH: 800 } });
  }
  const nested = await api('POST', '/api/item', { canvasId: id, type: 'board', x: 1600, y: 80, data: { title: 'Sub board' } });
  await api('POST', '/api/item', { canvasId: nested.data.childCanvasId, type: 'note', x: 100, y: 100, data: { title: 'Dentro' } });
  const group = await api('POST', '/api/item', { canvasId: id, type: 'group', x: 60, y: 900, w: 600, h: 300, data: { title: 'Grupo' } });
  for (const x of [80, 360]) await api('POST', '/api/item', { canvasId: id, type: 'note', x, y: 960, data: { title: 'No grupo', groupId: group.id } });
  await api('POST', '/api/item', { canvasId: id, type: 'line', data: { from: notes[0].id, to: photos[0].id, label: 'ref', arrow: 'end' } });
  return id;
}

// ---- the session -----------------------------------------------------------
async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const server = await startServer();
  const browser = await chromium.launch({ headless: !HEADED, slowMo: SLOW });
  const findings = new Map();
  const history = [];
  let step = 0;
  try {
    const canvasId = await seed();
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
    const page = await context.newPage();
    page.setDefaultTimeout(6000);   // a stuck click reports why instead of hanging
    const errors = [];
    let inflight = 0;
    // keep the first app frame of the stack so the report points at the code
    const where = e => ((e.stack || '').split('\n').find(l => l.includes('/js/')) || '').trim().replace(/^at\s+/, '');
    page.on('pageerror', e => errors.push('Page error: ' + e.message + (where(e) ? ' @ ' + where(e) : '')));
    page.on('console', m => { if (m.type() === 'error' && !/fonts\.g|unpkg|ERR_INTERNET|net::ERR_NAME/.test(m.text())) errors.push('Console error: ' + m.text()); });
    page.on('request', r => { if (!r.url().includes('/api/events')) inflight++; });
    const done = r => { if (!r.url().includes('/api/events')) inflight = Math.max(0, inflight - 1); };
    page.on('requestfinished', done);
    page.on('requestfailed', r => {
      done(r);
      const t = r.failure()?.errorText || '';
      if (r.url().startsWith(BASE) && !/ERR_ABORTED/.test(t)) errors.push(`Request failed: ${r.method()} ${new URL(r.url()).pathname} ${t}`);
    });
    page.on('response', r => {
      if (r.url().startsWith(BASE) && r.status() >= 500) errors.push(`HTTP ${r.status()} on ${r.request().method()} ${new URL(r.url()).pathname}`);
    });

    const settle = async () => {
      await page.waitForTimeout(450);   // debounced saves and nudges
      for (let i = 0; i < 60 && inflight > 0; i++) await page.waitForTimeout(100);
      await page.waitForTimeout(120);
    };

    const record = async (message, detail = '') => {
      const key = message.replace(/[ijcbtw]_[A-Za-z0-9_-]{6,}/g, '<id>').replace(/\d+(\.\d+)?/g, '<n>');
      if (findings.has(key)) { findings.get(key).count++; return; }
      const shot = path.join(OUT, `finding-${findings.size + 1}.png`);
      await page.screenshot({ path: shot }).catch(() => {});
      findings.set(key, { message, detail, step, count: 1, screenshot: path.relative(root, shot), steps: history.slice(-12) });
      process.stderr.write(`  ✗ step ${step}: ${message}\n`);
    };

    // -- what the user sees vs what is stored -------------------------------
    async function check() {
      for (const e of errors.splice(0)) await record(e);
      const ui = await page.evaluate(() => {
        const canvas = location.hash.slice(1);
        const overlays = ['.panel', '.cmdk', '.lightbox'].filter(sel => document.querySelector(sel)).length;
        const cards = [...document.querySelectorAll('#world > .item')].map(el => ({
          id: el.dataset.id, left: parseFloat(el.style.left), top: parseFloat(el.style.top),
          dragging: el.classList.contains('dragging')
        }));
        const selected = document.querySelectorAll('#world .item.selected').length;
        const bar = document.getElementById('multiActions');
        return { canvas, overlays, cards, selected, barHidden: bar ? bar.hidden : true,
          selType: getSelection().type, editing: !!document.querySelector('.item.editing') };
      });
      if (ui.selType === 'Range' && !ui.editing) await record('Native text selection is painted over the board (blue tint)');
      if (ui.overlays > 1) await record('More than one modal is open at the same time');
      if (ui.selected >= 2 && ui.barHidden) await record('Several cards selected but the selection bar is hidden');
      if (ui.overlays || !ui.canvas) return;
      const res = await fetch(BASE + '/api/canvas/' + ui.canvas);
      if (!res.ok) { await record(`Board in the address bar does not exist (HTTP ${res.status})`); return; }
      const view = await res.json();
      const items = view.items;
      const byId = new Map(items.map(it => [it.id, it]));
      const top = items.filter(it => !it.parentItemId && it.type !== 'line');
      const shown = new Map(ui.cards.map(c => [c.id, c]));
      for (const it of top) {
        const c = shown.get(it.id);
        if (!c) { await record(`A ${it.type} card stored on this board is not on screen`, it.id); continue; }
        if (!c.dragging && (Math.abs(c.left - it.x) > 1 || Math.abs(c.top - it.y) > 1)) {
          await record(`A ${it.type} card is shown at a different position than saved`, `${it.id} screen ${c.left},${c.top} db ${it.x},${it.y}`);
        }
      }
      for (const c of ui.cards) if (!byId.has(c.id)) await record('A card on screen is not stored in the database', c.id);
      for (const it of items) {
        if (it.type === 'line' && (!byId.has(it.data.from) || !byId.has(it.data.to))) await record('A line points at a card that no longer exists on its board', it.id);
        const g = it.data && it.data.groupId;
        if (g && it.type !== 'group' && (!byId.has(g) || byId.get(g).type !== 'group')) await record(`A ${it.type} card belongs to a group that does not exist`, it.id);
        if (it.parentItemId && (!byId.has(it.parentItemId) || byId.get(it.parentItemId).type !== 'column')) await record(`A ${it.type} card is inside a column that does not exist`, it.id);
        if (!Number.isFinite(it.x) || !Number.isFinite(it.y)) await record(`A ${it.type} card has an invalid position`, it.id);
      }
    }

    // -- helpers for actions --------------------------------------------------
    const stage = { x0: 80, y0: 70, x1: 1380, y1: 880 };
    const randomPoint = () => ({ x: int(stage.x0 + 20, stage.x1 - 220), y: int(stage.y0 + 20, stage.y1 - 100) });
    const cardsOnScreen = (selector = '#world > .item') => page.$$eval(selector, els => els.map(el => {
      const r = el.getBoundingClientRect();
      return { id: el.dataset.id, type: [...el.classList].find(c => c.startsWith('type-'))?.slice(5), x: r.x, y: r.y, w: r.width, h: r.height };
    }).filter(c => c.x > 70 && c.y > 60 && c.x + 40 < innerWidth && c.y + 30 < innerHeight && c.w > 10));
    const someCard = async (filter = () => true) => { const list = (await cardsOnScreen()).filter(filter); return list.length ? pick(list) : null; };
    const centerOf = c => ({ x: c.x + Math.min(c.w / 2, 60), y: c.y + Math.min(c.h / 2, 30) });
    const drag = async (from, to, steps = 8) => { await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps }); await page.mouse.up(); };
    const ctxItem = async (text) => { const item = page.locator('#ctxmenu .ctx-item:not([disabled])', { hasText: text }).first(); if (await item.count()) { await item.click(); return true; } return false; };
    // centres of matching elements that a real click would hit (not covered
    // by another card, inside the window)
    const reachable = sel => page.$$eval(sel, els => els.map(el => {
      const r = el.getBoundingClientRect();
      const p = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      const hit = document.elementFromPoint(p.x, p.y);
      return hit && (hit === el || el.contains(hit)) && p.x > 70 && p.y > 60 && p.x < innerWidth && p.y < innerHeight ? p : null;
    }).filter(Boolean));
    const closeAll = async () => { for (let i = 0; i < 3; i++) await page.keyboard.press('Escape'); };

    const actions = [
      [6, 'create a card with a rail tool', async () => {
        const tool = pick(['note', 'link', 'todo', 'board', 'column', 'comment']);
        // a selected board swaps the rail for its own properties
        if (!await page.locator('#railCreate').isVisible()) await closeAll();
        await page.click(`#railCreate .tool[data-tool="${tool}"]`);
        const p = randomPoint(); await page.mouse.click(p.x, p.y);
        if (tool !== 'board') await page.keyboard.type(pick(WORDS));
        await page.keyboard.press('Escape');
        return tool;
      }],
      [4, 'quick add by double-clicking empty canvas', async () => {
        const p = randomPoint();
        if (await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.item'), p)) return 'skipped (card there)';
        await page.mouse.dblclick(p.x, p.y);
        await page.keyboard.type(pick(['nota', 'tarefas', 'coluna', 'comentário', 'link']));
        await page.keyboard.press('Enter');
        await page.keyboard.press('Escape');
      }],
      [7, 'type into a card', async () => {
        const c = await someCard(c => ['note', 'todo', 'comment', 'link'].includes(c.type));
        if (!c) return 'no text card';
        await page.mouse.click(c.x + 30, c.y + 20);
        await page.keyboard.type(' ' + pick(WORDS));
        await page.keyboard.press('Escape');
      }],
      [12, 'drag a card', async () => {
        const c = await someCard(c => c.type !== 'group');
        if (!c) return 'no card';
        const from = { x: c.x + Math.min(c.w - 12, 40), y: c.y + 8 };
        await drag(from, { x: from.x + int(-250, 250), y: from.y + int(-200, 200) });
        await page.keyboard.press('Escape');
      }],
      [6, 'marquee select', async () => {
        const a = randomPoint(), b = { x: a.x + int(150, 600), y: a.y + int(120, 400) };
        await drag(a, b, 6);
      }],
      [5, 'shift-click several cards', async () => {
        const list = (await cardsOnScreen()).filter(c => c.type !== 'group');
        for (let i = 0; i < Math.min(3, list.length); i++) {
          const c = pick(list);
          await page.mouse.click(c.x + 10, c.y + 10, { modifiers: i ? ['Shift'] : [] });
        }
        await page.keyboard.press('Escape');
      }],
      [4, 'group or ungroup the selection', async () => {
        if (await page.locator('#multiGroup').isVisible()) { await page.click('#multiGroup'); return 'group'; }
        const g = page.locator('#world > .item.type-group .group-title').first();
        if (await g.count() && await g.isVisible()) { await g.click(); await page.keyboard.press('Control+Shift+G'); return 'ungroup'; }
        return 'nothing selected';
      }],
      [3, 'align the selection', async () => {
        if (!await page.locator('#multiAlign').isVisible()) return 'no multi-selection';
        await page.click('#multiAlign');
        await ctxItem(pick(['Alinhar à esquerda', 'Alinhar no topo', 'Centralizar na horizontal', 'Distribuir na horizontal', 'Organizar em grade']));
      }],
      [5, 'copy / cut / paste / duplicate', async () => {
        const c = await someCard(c => c.type !== 'group');
        if (!c) return 'no card';
        await page.mouse.click(c.x + 10, c.y + 8);
        await page.keyboard.press('Escape');
        const op = pick(['Control+D', 'copy-paste', 'cut-paste']);
        if (op === 'Control+D') await page.keyboard.press('Control+D');
        else { await page.keyboard.press(op === 'copy-paste' ? 'Control+C' : 'Control+X'); await page.waitForTimeout(120); await page.keyboard.press('Control+V'); }
        return op;
      }],
      [6, 'undo / redo', async () => {
        const n = int(1, 3);
        for (let i = 0; i < n; i++) { await page.keyboard.press(rand() < 0.75 ? 'Control+Z' : 'Control+Shift+Z'); await page.waitForTimeout(250); }
        return n + ' times';
      }],
      [3, 'delete the selection', async () => {
        const c = await someCard();
        if (!c) return 'no card';
        await page.mouse.click(c.x + 8, c.y + 8);
        await page.keyboard.press('Escape');
        await page.keyboard.press('Delete');
      }],
      [3, 'open a board or go back', async () => {
        const tiles = await reachable('#world > .item.type-board .tile');
        if (rand() < 0.5 && tiles.length) { const p = pick(tiles); await page.mouse.dblclick(p.x, p.y); return 'open'; }
        const crumbs = page.locator('#crumbs .crumb:not(.current)');
        if (await crumbs.count()) { await crumbs.last().click(); return 'back'; }
        return 'stay';
      }],
      [4, 'zoom, pan or fit', async () => {
        const op = pick(['wheel', 'zoom', 'fit', 'space-pan']);
        if (op === 'wheel') { await page.mouse.move(700, 450); await page.mouse.wheel(int(-300, 300), int(-300, 300)); }
        if (op === 'zoom') await page.click(pick(['#zoomIn', '#zoomOut']));
        if (op === 'fit') await page.keyboard.press('f');
        if (op === 'space-pan') { await page.keyboard.down('Space'); await drag(randomPoint(), randomPoint(), 5); await page.keyboard.up('Space'); }
        return op;
      }],
      [4, 'connect two cards with a line', async () => {
        const list = (await cardsOnScreen()).filter(c => !['group', 'board'].includes(c.type));
        if (list.length < 2) return 'not enough cards';
        const a = pick(list), b = pick(list.filter(c => c.id !== a.id));
        await page.mouse.move(a.x + a.w / 2, a.y + a.h / 2);
        const handle = page.locator(`#world > .item[data-id="${a.id}"] > .link-handle`);
        if (!await handle.isVisible()) return 'handle hidden';
        const hb = await handle.boundingBox();
        await drag({ x: hb.x + 8, y: hb.y + 8 }, centerOf(b), 10);
        await page.keyboard.press('Escape');
      }],
      [3, 'drag a card into a column', async () => {
        const col = page.locator('#world > .item.type-column .col-body').first();
        if (!await col.count() || !await col.isVisible()) return 'no column';
        const c = await someCard(c => ['note', 'image', 'todo', 'link'].includes(c.type));
        if (!c) return 'no card';
        const box = await col.boundingBox();
        await drag({ x: c.x + 20, y: c.y + 8 }, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, 12);
      }],
      [2, 'change a column layout', async () => {
        const buttons = await reachable('#world .col-layout');
        if (!buttons.length) return 'no reachable column';
        const p = pick(buttons);
        await page.mouse.click(p.x, p.y);
      }],
      [3, 'tag a card', async () => {
        const c = await someCard(c => c.type !== 'group');
        if (!c) return 'no card';
        await page.mouse.click(c.x + 8, c.y + 8, { button: 'right' });
        if (!await ctxItem('Tags')) { await closeAll(); return 'no tags item'; }
        await page.locator('.panel input').fill(pick(['aprovado', 'cliente', 'revisar']));
        await page.locator('.panel-btn', { hasText: 'Salvar' }).click();
      }],
      [2, 'filter by tag or color', async () => {
        await page.click('#filterBtn');
        const items = page.locator('#ctxmenu .ctx-item:not([disabled])');
        const n = await items.count();
        if (n) await items.nth(int(0, n - 1)).click();
      }],
      [3, 'search with Ctrl+K', async () => {
        await page.keyboard.press('Control+k');
        await page.keyboard.type(pick(['gola', 'Briefing', 'dentro', 'fit', 'zzz', 'foto']));
        await page.waitForTimeout(400);
        await page.keyboard.press(rand() < 0.6 ? 'Enter' : 'Escape');
      }],
      [3, 'view a photo full size', async () => {
        const c = await someCard(c => c.type === 'image');
        if (!c) return 'no photo';
        await page.mouse.dblclick(c.x + c.w / 2, c.y + c.h / 2);
        for (let i = 0; i < int(0, 3); i++) await page.keyboard.press(pick(['ArrowRight', 'ArrowLeft', '+', '0']));
        await page.keyboard.press('Escape');
      }],
      [3, 'resize a card', async () => {
        const c = await someCard(c => !['board', 'group'].includes(c.type));
        if (!c) return 'no card';
        await page.mouse.click(c.x + 8, c.y + 8);
        const handle = page.locator(`#world > .item[data-id="${c.id}"] > .resize`);
        if (!await handle.count() || !await handle.isVisible()) return 'no handle';
        const hb = await handle.boundingBox();
        await drag({ x: hb.x + 8, y: hb.y + 8 }, { x: hb.x + int(-80, 160), y: hb.y + int(-40, 120) }, 6);
        await page.keyboard.press('Escape');
      }],
      [4, 'pick a random context-menu entry', async () => {
        const c = await someCard();
        if (!c) return 'no card';
        await page.mouse.click(c.x + 8, c.y + 8, { button: 'right' });
        const items = page.locator('#ctxmenu .ctx-item:not([disabled])');
        const n = await items.count();
        if (!n) return 'empty menu';
        const item = items.nth(int(0, n - 1));
        const label = await item.innerText();
        await item.click();
        if (await page.locator('.panel').count()) await closeAll();
        return label.split('\n')[0];
      }],
      [2, 'restore something from the trash', async () => {
        await page.click('#appMenuBtn');
        await ctxItem('Lixeira');
        const restore = page.locator('.trash-row .panel-btn', { hasText: 'Restaurar' }).first();
        if (await restore.count()) { await restore.click(); return 'restored'; }
        await closeAll();
        return 'trash empty';
      }],
      [3, 'nudge with the arrow keys', async () => {
        const c = await someCard(c => c.type !== 'group');
        if (!c) return 'no card';
        await page.mouse.click(c.x + 8, c.y + 8);
        await page.keyboard.press('Escape');
        for (let i = 0; i < int(1, 6); i++) await page.keyboard.press(pick(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']));
      }],
      [2, 'reload the page', async () => { await page.reload(); }]
    ];
    const total = actions.reduce((sum, a) => sum + a[0], 0);
    const choose = () => { let r = rand() * total; for (const a of actions) { r -= a[0]; if (r <= 0) return a; } return actions[0]; };

    await page.goto(BASE + '/#' + canvasId);
    await page.locator('#crumbs .current').waitFor();
    await settle();
    await check();
    for (step = 1; step <= STEPS; step++) {
      const [, name, run] = choose();
      let note = '';
      try {
        if (await page.locator('.panel, .cmdk, .lightbox').count()) await closeAll();
        note = (await Promise.race([run(), new Promise((_, rej) => setTimeout(() => rej(new Error('action timed out')), 15000))])) || '';
      } catch (err) {
        note = 'action error: ' + err.message.split('\n')[0];
        // a click Playwright cannot perform usually means something covers the control
        const why = (err.message.match(/<[^>]+>(?: from <[^>]+> subtree)? intercepts pointer events/) || [])[0];
        // only app controls count: board content may legitimately be covered by other cards
        const chrome = /#rail|#topbar|#multi|#ctxmenu|\.panel|#appMenuBtn|#filterBtn|#zoom/.test(err.message);
        if (chrome && why) await record(`Could not "${name}": ${why}`);
        else if (chrome && /timed out|Timeout/.test(err.message)) await record(`Could not "${name}": ${err.message.split('\n').slice(0, 3).join(' ')}`);
      }
      history.push(`${step}. ${name}${note ? ' — ' + note : ''}`);
      await settle();
      try { await check(); } catch (err) { await record('Checker crashed: ' + err.message.split('\n')[0]); }
      if (step % 10 === 0) process.stdout.write(`  step ${step}/${STEPS}, ${findings.size} finding(s)\n`);
      if (step % 40 === 0) { await page.reload(); await settle(); await check(); }
    }
  } finally {
    await browser.close();
    server.child.kill();
  }

  const list = [...findings.values()];
  const md = [`# Exploration report`, '', `Seed **${SEED}**, ${STEPS} steps — replay with \`node scripts/explore.js --seed ${SEED} --steps ${STEPS}\`.`, '',
    list.length ? `## ${list.length} finding(s)` : '## No findings', ''];
  list.forEach((f, i) => {
    md.push(`### ${i + 1}. ${f.message}`, '', `First seen at step ${f.step}, ${f.count} time(s). ${f.detail ? 'Detail: `' + f.detail + '`' : ''}`,
      '', `Screenshot: \`${f.screenshot}\``, '', 'Steps before it:', '', ...f.steps.map(x => '- ' + x), '');
  });
  md.push('## All steps', '', ...history.map(x => '- ' + x));
  fs.writeFileSync(path.join(OUT, 'report.md'), md.join('\n'));
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ seed: SEED, steps: STEPS, findings: list, history }, null, 2));
  console.log(`\nSeed ${SEED}: ${list.length} finding(s). Report: qa-report/explore/report.md`);
  process.exitCode = list.length ? 1 : 0;
}

main().catch(err => { console.error(err); process.exitCode = 2; });
