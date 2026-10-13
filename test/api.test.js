'use strict';

// Backend API + db integrity suite. Zero deps: node:test + global fetch.
// Runs against a throwaway DATA_DIR so it never touches real board data.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point db.js at a fresh temp dir BEFORE requiring it (it opens the DB on load).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'board-test-'));
process.env.DATA_DIR = TMP;
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');

const express = require('express');
const app = express();
app.use(express.json());
app.use(require('../backend/routes'));

let base;
let server;
test.before(async () => {
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(async () => {
  await new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  });
  require('../backend/db').db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// tiny fetch helpers
const get = (p) => fetch(base + p).then(async r => ({ status: r.status, body: await r.json() }));
const send = (m, p, b) => fetch(base + p, {
  method: m, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b)
}).then(async r => ({ status: r.status, body: await r.json() }));

async function root() { return (await get('/api/root')).body.rootCanvasId; }

test('health + root seeded', async () => {
  assert.deepEqual((await get('/api/health')).body, { ok: true });
  const id = await root();
  assert.match(id, /^c_/);
  const { body } = await get('/api/canvas/' + id);
  assert.equal(body.canvas.title, 'Home');
  assert.deepEqual(body.items, []);
  assert.equal(body.breadcrumb.length, 1);
});

test('unknown canvas 404', async () => {
  assert.equal((await get('/api/canvas/nope')).status, 404);
});

test('create item validates canvasId', async () => {
  assert.equal((await send('POST', '/api/item', { canvasId: 'nope', type: 'note' })).status, 400);
});

test('create note: rounds coords, assigns z, defaults', async () => {
  const canvasId = await root();
  const { body } = await send('POST', '/api/item', { canvasId, type: 'note', x: 10.7, y: 20.2 });
  assert.match(body.id, /^i_/);
  assert.equal(body.x, 11);
  assert.equal(body.y, 20);
  assert.equal(body.w, 240);      // default width
  assert.ok(body.z >= 1);
  // item now shows up on the canvas
  const view = (await get('/api/canvas/' + canvasId)).body;
  assert.ok(view.items.some(i => i.id === body.id));
});

test('patch item moves and updates color', async () => {
  const canvasId = await root();
  const it = (await send('POST', '/api/item', { canvasId, type: 'note' })).body;
  const upd = (await send('PATCH', '/api/item/' + it.id, { x: 5, y: 6, color: 'teal' })).body;
  assert.equal(upd.x, 5);
  assert.equal(upd.color, 'teal');
  assert.equal((await send('PATCH', '/api/item/badid', { x: 1 })).status, 404);
});

test('board item creates + syncs a child canvas', async () => {
  const canvasId = await root();
  const board = (await send('POST', '/api/item', { canvasId, type: 'board', color: 'green', data: { title: 'Sprint' } })).body;
  const childId = board.data.childCanvasId;
  assert.ok(childId, 'board owns a child canvas');

  // parent canvas surfaces child title/count/color
  const view = (await get('/api/canvas/' + canvasId)).body;
  const card = view.items.find(i => i.id === board.id);
  assert.equal(card._childTitle, 'Sprint');
  assert.equal(card._childCount, 0);
  assert.equal(card._childColor, 'green');
  assert.ok(card._childIcon, 'board gets a default Lucide icon');

  // renaming/recoloring/icon the card writes through to the child canvas
  await send('PATCH', '/api/item/' + board.id, { color: 'red', data: { title: 'Renamed', icon: 'heart' } });
  const child = (await get('/api/canvas/' + childId)).body.canvas;
  assert.equal(child.title, 'Renamed');
  assert.equal(child.color, 'red');
  assert.equal(child.icon, 'heart');
  const view2 = (await get('/api/canvas/' + canvasId)).body;
  assert.equal(view2.items.find(i => i.id === board.id)._childIcon, 'heart');
});

test('board item surfaces its first image as a preview', async () => {
  const canvasId = await root();
  const board = (await send('POST', '/api/item', { canvasId, type: 'board', data: { title: 'Photos' } })).body;
  await send('POST', '/api/item', {
    canvasId: board.data.childCanvasId,
    type: 'image',
    data: { src: '/uploads/cover.jpg', name: 'cover.jpg' }
  });

  const view = (await get('/api/canvas/' + canvasId)).body;
  assert.match(view.items.find(i => i.id === board.id)._childPreview, /^\/api\/thumb\/i_/);
});

test('create comment and file items', async () => {
  const canvasId = await root();
  const comment = (await send('POST', '/api/item', { canvasId, type: 'comment', data: { body: 'hi' } })).body;
  assert.equal(comment.type, 'comment');
  assert.equal(comment.data.body, 'hi');
  const file = (await send('POST', '/api/item', {
    canvasId, type: 'file', data: { src: '/uploads/x.pdf', name: 'x.pdf', mime: 'application/pdf' }
  })).body;
  assert.equal(file.type, 'file');
  assert.equal(file.data.name, 'x.pdf');
});

test('upload accepts pdf', async () => {
  const canvasId = await root();
  void canvasId;
  const fd = new FormData();
  fd.append('file', new Blob(['%PDF-1.4'], { type: 'application/pdf' }), 'doc.pdf');
  const r = await fetch(base + '/api/upload', { method: 'POST', body: fd });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.match(body.src, /^\/uploads\//);
  assert.equal(body.name, 'doc.pdf');
  assert.equal(body.mime, 'application/pdf');
});

test('image cards are served as cached WebP thumbnails', async () => {
  const canvasId = await root();
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  );
  const fd = new FormData();
  fd.append('file', new Blob([png], { type: 'image/png' }), 'pixel.png');
  const uploaded = await fetch(base + '/api/upload', { method: 'POST', body: fd }).then(r => r.json());
  const image = (await send('POST', '/api/item', {
    canvasId, type: 'image', data: { src: uploaded.src, name: uploaded.name }
  })).body;

  const first = await fetch(base + '/api/thumb/' + image.id);
  assert.equal(first.status, 200);
  assert.match(first.headers.get('content-type'), /^image\/webp/);
  assert.ok((await first.arrayBuffer()).byteLength > 0);
  const cached = await fetch(base + '/api/thumb/' + image.id);
  assert.equal(cached.status, 200);
  assert.match(cached.headers.get('cache-control'), /immutable/);
});

test('patch canvas clamps title, sets color', async () => {
  const canvasId = await root();
  const long = 'x'.repeat(500);
  const c = (await send('PATCH', '/api/canvas/' + canvasId, { title: long, color: 'blue' })).body;
  assert.equal(c.title.length, 200);
  assert.equal(c.color, 'blue');
});

test('bulk patch repositions many items', async () => {
  const canvasId = await root();
  const a = (await send('POST', '/api/item', { canvasId, type: 'note' })).body;
  const b = (await send('POST', '/api/item', { canvasId, type: 'note' })).body;
  await send('PATCH', '/api/items', { updates: [{ id: a.id, x: 100 }, { id: b.id, y: 200 }, { id: 'ghost', x: 9 }] });
  const view = (await get('/api/canvas/' + canvasId)).body;
  assert.equal(view.items.find(i => i.id === a.id).x, 100);
  assert.equal(view.items.find(i => i.id === b.id).y, 200);
});

test('delete cascades: column children go with the column', async () => {
  const canvasId = await root();
  const col = (await send('POST', '/api/item', { canvasId, type: 'column' })).body;
  const child = (await send('POST', '/api/item', { canvasId, type: 'note', parentItemId: col.id })).body;
  await send('DELETE', '/api/item/' + col.id);
  const ids = (await get('/api/canvas/' + canvasId)).body.items.map(i => i.id);
  assert.ok(!ids.includes(col.id));
  assert.ok(!ids.includes(child.id), 'child deleted with its column');
});

test('delete cascades: nested board subtree is removed', async () => {
  const canvasId = await root();
  const board = (await send('POST', '/api/item', { canvasId, type: 'board', data: { title: 'B' } })).body;
  const childId = board.data.childCanvasId;
  // put an item inside the nested board
  const inner = (await send('POST', '/api/item', { canvasId: childId, type: 'note' })).body;
  await send('DELETE', '/api/item/' + board.id);
  // child canvas is gone (404) and its item is unreachable
  assert.equal((await get('/api/canvas/' + childId)).status, 404);
  assert.equal((await send('PATCH', '/api/item/' + inner.id, { x: 1 })).status, 404);
});

test('quick notes: lists every todo card with its canvas + tasks', async () => {
  const canvasId = await root();
  const board = (await send('POST', '/api/item', { canvasId, type: 'board', data: { title: 'Nested' } })).body;
  const nested = board.data.childCanvasId;
  const tasks = [{ id: 't1', text: 'Floss', done: false, starred: true, due: '2026-08-07', tags: ['routine'], note: 'nightly' }];
  const a = (await send('POST', '/api/item', {
    canvasId, type: 'todo', color: 'blue', data: { title: 'Nightly Routine', tags: ['routine'], tasks }
  })).body;
  const b = (await send('POST', '/api/item', { canvasId: nested, type: 'todo', data: { title: 'Deep list' } })).body;

  const { status, body } = await get('/api/todos');
  assert.equal(status, 200);
  assert.equal(body.rootCanvasId, canvasId);

  const first = body.lists.find(l => l.id === a.id);
  assert.equal(first.title, 'Nightly Routine');
  assert.equal(first.canvasId, canvasId);
  assert.equal(first.color, 'blue');
  assert.deepEqual(first.tags, ['routine']);
  assert.deepEqual(first.tasks, tasks);          // extra task fields survive the round trip

  // todo cards on nested canvases are listed too, and report the canvas they live on
  const deep = body.lists.find(l => l.id === b.id);
  assert.equal(deep.canvasTitle, 'Nested');
  assert.deepEqual(deep.tasks, []);              // missing tasks default to an empty list

  // non-todo cards never show up
  assert.ok(!body.lists.some(l => l.id === board.id));
});

test('quick notes: task edits round-trip through PATCH /api/item', async () => {
  const canvasId = await root();
  const list = (await send('POST', '/api/item', {
    canvasId, type: 'todo', data: { title: 'Errands', tasks: [{ id: 't1', text: 'Milk', done: false }] }
  })).body;
  const tasks = [{ id: 't1', text: 'Milk', done: true, starred: true, due: '2026-08-07', tags: ['life'], note: 'oat', noteStyle: { b: true } }];
  await send('PATCH', '/api/item/' + list.id, { data: { tasks } });
  await send('PATCH', '/api/item/' + list.id, { data: { tags: ['life'] } });

  const saved = (await get('/api/todos')).body.lists.find(l => l.id === list.id);
  assert.deepEqual(saved.tasks, tasks);
  assert.deepEqual(saved.tags, ['life']);
  assert.equal(saved.title, 'Errands');          // shallow data merge keeps the title
});

test('deleting a group frame keeps its cards and frees them', async () => {
  const canvasId = await root();
  const group = (await send('POST', '/api/item', { canvasId, type: 'group', w: 400, h: 300 })).body;
  const card = (await send('POST', '/api/item', { canvasId, type: 'note', data: { title: 'Kept', groupId: group.id } })).body;
  await send('DELETE', '/api/item/' + group.id);
  const items = (await get('/api/canvas/' + canvasId)).body.items;
  assert.ok(!items.some(i => i.id === group.id));
  const kept = items.find(i => i.id === card.id);
  assert.equal(kept.data.groupId, null);
  assert.equal(kept.data.title, 'Kept');
});

test('bulk patch merges data fields', async () => {
  const canvasId = await root();
  const a = (await send('POST', '/api/item', { canvasId, type: 'note', data: { title: 'A', groupId: 'g1' } })).body;
  await send('PATCH', '/api/items', { updates: [{ id: a.id, x: 5, data: { groupId: null } }] });
  const saved = (await get('/api/canvas/' + canvasId)).body.items.find(i => i.id === a.id);
  assert.equal(saved.x, 5);
  assert.equal(saved.data.groupId, null);
  assert.equal(saved.data.title, 'A');
});

test('transfer copy duplicates a board with its whole subtree', async () => {
  const canvasId = await root();
  const board = (await send('POST', '/api/item', { canvasId, type: 'board', data: { title: 'Refs' } })).body;
  await send('POST', '/api/item', { canvasId: board.data.childCanvasId, type: 'note', data: { title: 'Inside' } });
  const { status, body } = await send('POST', '/api/transfer', { ids: [board.id], canvasId, x: 900, y: 900 });
  assert.equal(status, 200);
  const view = (await get('/api/canvas/' + canvasId)).body;
  const copy = view.items.find(i => i.id === body.ids[0]);
  assert.equal(copy.x, 900);
  assert.notEqual(copy.data.childCanvasId, board.data.childCanvasId);
  assert.equal(copy._childTitle, 'Refs copy');
  const inner = (await get('/api/canvas/' + copy.data.childCanvasId)).body.items;
  assert.deepEqual(inner.map(i => i.data.title), ['Inside']);
});

test('transfer move (cut + paste) keeps a board and its contents', async () => {
  const canvasId = await root();
  const source = (await send('POST', '/api/item', { canvasId, type: 'board', data: { title: 'From' } })).body;
  const target = (await send('POST', '/api/item', { canvasId, type: 'board', data: { title: 'To' } })).body;
  const board = (await send('POST', '/api/item', { canvasId: source.data.childCanvasId, type: 'board', data: { title: 'Moved' } })).body;
  const inner = (await send('POST', '/api/item', { canvasId: board.data.childCanvasId, type: 'note', data: { title: 'Safe' } })).body;
  const { body } = await send('POST', '/api/transfer', { ids: [board.id], canvasId: target.data.childCanvasId, x: 10, y: 10, move: true });
  assert.deepEqual(body.ids, [board.id]);
  assert.equal((await get('/api/canvas/' + source.data.childCanvasId)).body.items.length, 0);
  const moved = (await get('/api/canvas/' + target.data.childCanvasId)).body.items[0];
  assert.equal(moved.id, board.id);
  const nested = (await get('/api/canvas/' + board.data.childCanvasId)).body;
  assert.equal(nested.canvas.parentCanvasId, target.data.childCanvasId);
  assert.ok(nested.items.some(i => i.id === inner.id));
});

test('transfer refuses to paste a board inside itself', async () => {
  const canvasId = await root();
  const board = (await send('POST', '/api/item', { canvasId, type: 'board', data: { title: 'Loop' } })).body;
  const { status } = await send('POST', '/api/transfer', { ids: [board.id], canvasId: board.data.childCanvasId, move: true });
  assert.equal(status, 400);
});

test('transfer places a card taken out of a column where the column is', async () => {
  const canvasId = await root();
  const col = (await send('POST', '/api/item', { canvasId, type: 'column', x: 1200, y: 800 })).body;
  const card = (await send('POST', '/api/item', { canvasId, type: 'note', parentItemId: col.id, x: 0, y: 3 })).body;
  const { body } = await send('POST', '/api/transfer', { ids: [card.id], canvasId });
  const copy = (await get('/api/canvas/' + canvasId)).body.items.find(i => i.id === body.ids[0]);
  assert.equal(copy.parentItemId, null);
  assert.equal(copy.x, 1224);
  assert.equal(copy.y, 824);
});

const keyed = (m, p, b, key) => fetch(base + p, {
  method: m, headers: { 'Content-Type': 'application/json', 'X-Undo-Key': key }, body: JSON.stringify(b)
}).then(async r => ({ status: r.status, body: await r.json() }));

test('undo removes a created card and redo brings it back', async () => {
  const canvasId = await root();
  const note = (await send('POST', '/api/item', { canvasId, type: 'note', data: { title: 'Undo me' } })).body;
  const undone = (await send('POST', '/api/history/undo')).body;
  assert.equal(undone.ok, true);
  assert.ok(undone.canvasIds.includes(canvasId));
  assert.ok(!(await get('/api/canvas/' + canvasId)).body.items.some(i => i.id === note.id));
  assert.equal((await send('POST', '/api/history/redo')).body.ok, true);
  const back = (await get('/api/canvas/' + canvasId)).body.items.find(i => i.id === note.id);
  assert.equal(back.data.title, 'Undo me');
});

test('undo of a board delete restores the board, its canvas and contents', async () => {
  const canvasId = await root();
  const board = (await send('POST', '/api/item', { canvasId, type: 'board', data: { title: 'Precious' } })).body;
  const inner = (await send('POST', '/api/item', { canvasId: board.data.childCanvasId, type: 'note', data: { title: 'Inside' } })).body;
  await send('DELETE', '/api/item/' + board.id);
  assert.equal((await get('/api/canvas/' + board.data.childCanvasId)).status, 404);
  await send('POST', '/api/history/undo');
  const view = (await get('/api/canvas/' + board.data.childCanvasId)).body;
  assert.equal(view.canvas.title, 'Precious');
  assert.ok(view.items.some(i => i.id === inner.id));
});

test('requests sharing an undo key form one step; a new change clears redo', async () => {
  const canvasId = await root();
  const a = (await send('POST', '/api/item', { canvasId, type: 'note', x: 0 })).body;
  await keyed('PATCH', '/api/item/' + a.id, { x: 10 }, 'drag-1');
  await keyed('PATCH', '/api/item/' + a.id, { x: 20 }, 'drag-1');
  await send('POST', '/api/history/undo');
  const x = (await get('/api/canvas/' + canvasId)).body.items.find(i => i.id === a.id).x;
  assert.equal(x, 0);
  assert.equal((await get('/api/history')).body.canRedo, true);
  await send('PATCH', '/api/item/' + a.id, { y: 5 });
  assert.equal((await get('/api/history')).body.canRedo, false);
});

test('no-op writes do not create undo steps', async () => {
  const canvasId = await root();
  const a = (await send('POST', '/api/item', { canvasId, type: 'note', x: 7 })).body;
  await send('PATCH', '/api/item/' + a.id, { x: 7 });
  await send('POST', '/api/history/undo');   // undoes the create, not the no-op
  assert.ok(!(await get('/api/canvas/' + canvasId)).body.items.some(i => i.id === a.id));
});

test('each client has its own undo stack', async () => {
  const canvasId = await root();
  const as = (client, m, p, b) => fetch(base + p, {
    method: m, headers: { 'Content-Type': 'application/json', 'X-Client-Id': client }, body: b && JSON.stringify(b)
  }).then(r => r.json());
  const mine = await as('laptop', 'POST', '/api/item', { canvasId, type: 'note' });
  const theirs = await as('phone', 'POST', '/api/item', { canvasId, type: 'note' });
  assert.equal((await as('laptop', 'POST', '/api/history/undo')).ok, true);
  const ids = (await get('/api/canvas/' + canvasId)).body.items.map(i => i.id);
  assert.ok(!ids.includes(mine.id));
  assert.ok(ids.includes(theirs.id));
});

test('deleted board goes to the trash and restores with its contents', async () => {
  const canvasId = await root();
  const board = (await send('POST', '/api/item', { canvasId, type: 'board', data: { title: 'Lixo' } })).body;
  const inner = (await send('POST', '/api/item', { canvasId: board.data.childCanvasId, type: 'note', data: { title: 'Dentro' } })).body;
  await send('DELETE', '/api/item/' + board.id);
  const entry = (await get('/api/trash')).body.entries.find(e => e.itemId === board.id);
  assert.equal(entry.label, 'Lixo');
  assert.equal(entry.type, 'board');
  const restored = (await send('POST', '/api/trash/' + entry.id + '/restore')).body;
  assert.equal(restored.canvasId, canvasId);
  const nested = (await get('/api/canvas/' + board.data.childCanvasId)).body;
  assert.ok(nested.items.some(i => i.id === inner.id));
  assert.ok(!(await get('/api/trash')).body.entries.some(e => e.itemId === board.id));
});

test('trash restore falls back to Home when the original board is gone', async () => {
  const canvasId = await root();
  const board = (await send('POST', '/api/item', { canvasId, type: 'board', data: { title: 'Pai' } })).body;
  const note = (await send('POST', '/api/item', { canvasId: board.data.childCanvasId, type: 'note', data: { title: 'Órfã' } })).body;
  await send('DELETE', '/api/item/' + note.id);
  await send('DELETE', '/api/item/' + board.id);
  const entry = (await get('/api/trash')).body.entries.find(e => e.itemId === note.id);
  const restored = (await send('POST', '/api/trash/' + entry.id + '/restore')).body;
  assert.equal(restored.canvasId, canvasId);
  assert.ok((await get('/api/canvas/' + canvasId)).body.items.some(i => i.id === note.id));
});

test('deleting a card removes lines attached to it; group frames skip the trash', async () => {
  const canvasId = await root();
  const a = (await send('POST', '/api/item', { canvasId, type: 'note' })).body;
  const b = (await send('POST', '/api/item', { canvasId, type: 'note' })).body;
  const line = (await send('POST', '/api/item', { canvasId, type: 'line', data: { from: a.id, to: b.id } })).body;
  const group = (await send('POST', '/api/item', { canvasId, type: 'group' })).body;
  await send('DELETE', '/api/item/' + a.id);
  await send('DELETE', '/api/item/' + group.id);
  const ids = (await get('/api/canvas/' + canvasId)).body.items.map(i => i.id);
  assert.ok(!ids.includes(line.id));
  const entries = (await get('/api/trash')).body.entries;
  assert.ok(!entries.some(e => e.itemId === group.id));
  // restoring the card brings its line back because the other end still exists
  await send('POST', '/api/trash/' + entries.find(e => e.itemId === a.id).id + '/restore');
  assert.ok((await get('/api/canvas/' + canvasId)).body.items.some(i => i.id === line.id));
});

test('search finds cards and boards ignoring accents and case', async () => {
  const canvasId = await root();
  const board = (await send('POST', '/api/item', { canvasId, type: 'board', data: { title: 'Uniformes Escolares' } })).body;
  const note = (await send('POST', '/api/item', { canvasId: board.data.childCanvasId, type: 'note', data: { title: 'Cor da gola', body: 'Aprovação do cliente' } })).body;
  await send('POST', '/api/item', { canvasId, type: 'todo', data: { title: 'Lista', tasks: [{ id: 't', text: 'Comprar tecido azul' }] } });
  let r = (await get('/api/search?q=' + encodeURIComponent('APROVACAO gola'))).body.results;
  assert.equal(r.length, 1);
  assert.equal(r[0].id, note.id);
  assert.equal(r[0].where, 'Uniformes Escolares');
  r = (await get('/api/search?q=uniformes')).body.results;
  assert.ok(r.some(x => x.kind === 'board' && x.canvasId === board.data.childCanvasId));
  r = (await get('/api/search?q=tecido')).body.results;
  assert.equal(r[0].type, 'todo');
});

test('backup export + restore round-trips boards and uploads (runs last)', async () => {
  const canvasId = await root();
  const keep = (await send('POST', '/api/item', { canvasId, type: 'note', data: { title: 'Backed up' } })).body;
  const archive = await fetch(base + '/api/backup/export');
  assert.equal(archive.status, 200);
  const bytes = Buffer.from(await archive.arrayBuffer());
  assert.ok(bytes.length > 100);
  const later = (await send('POST', '/api/item', { canvasId, type: 'note', data: { title: 'After' } })).body;
  await send('DELETE', '/api/item/' + keep.id);

  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: 'application/gzip' }), 'backup.tar.gz');
  const result = await fetch(base + '/api/backup/restore', { method: 'POST', body: fd }).then(r => r.json());
  assert.ok(result.items > 0);
  const ids = (await get('/api/canvas/' + canvasId)).body.items.map(i => i.id);
  assert.ok(ids.includes(keep.id));
  assert.ok(!ids.includes(later.id));
  assert.ok((await get('/api/backup')).body.snapshots.some(f => f.endsWith('-before-restore.db')));

  const bad = new FormData();
  bad.append('file', new Blob([Buffer.from('nope')]), 'x.tar.gz');
  assert.equal((await fetch(base + '/api/backup/restore', { method: 'POST', body: bad })).status >= 400, true);
});
