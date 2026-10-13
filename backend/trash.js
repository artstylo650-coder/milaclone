'use strict';

// Trash: a user delete keeps every removed row (the card, column children,
// nested boards and their contents) so it can be restored later. Entries
// expire after TRASH_DAYS. Group frames and lone lines are not trashed —
// deleting a frame never deletes its cards.

const { db, stmt, id, rootCanvasId } = require('./db');

const TRASH_DAYS = Number(process.env.TRASH_DAYS) || 30;

db.exec(`
  CREATE TABLE IF NOT EXISTS trash (
    id TEXT PRIMARY KEY, itemId TEXT NOT NULL, canvasId TEXT, type TEXT,
    label TEXT, deletedAt INTEGER NOT NULL, rows TEXT NOT NULL
  );
`);

const q = {
  insert: db.prepare(`INSERT INTO trash (id, itemId, canvasId, type, label, deletedAt, rows)
                      VALUES (@id, @itemId, @canvasId, @type, @label, @deletedAt, @rows)`),
  list: db.prepare('SELECT id, itemId, canvasId, type, label, deletedAt FROM trash ORDER BY deletedAt DESC'),
  get: db.prepare('SELECT * FROM trash WHERE id = ?'),
  remove: db.prepare('DELETE FROM trash WHERE id = ?'),
  empty: db.prepare('DELETE FROM trash'),
  expire: db.prepare('DELETE FROM trash WHERE deletedAt < ?'),
  insertItem: db.prepare(`INSERT OR REPLACE INTO items (id, canvasId, parentItemId, type, x, y, w, h, z, color, data, createdAt)
                          VALUES (@id, @canvasId, @parentItemId, @type, @x, @y, @w, @h, @z, @color, @data, @createdAt)`),
  insertCanvas: db.prepare(`INSERT OR REPLACE INTO canvases (id, title, parentCanvasId, color, icon, createdAt)
                            VALUES (@id, @title, @parentCanvasId, @color, @icon, @createdAt)`)
};

function labelFor(row, removed) {
  const data = row.data ? JSON.parse(row.data) : {};
  if (row.type === 'board') {
    const child = removed.find(r => r.tbl === 'canvases' && r.row.id === data.childCanvasId);
    return child ? child.row.title : 'Board';
  }
  const text = data.title || data.body || data.name || data.url || '';
  return String(text).split('\n')[0].slice(0, 120);
}

function add(removed) {
  const root = removed.length && removed[removed.length - 1];
  if (!root || root.tbl !== 'items' || root.row.type === 'group' || root.row.type === 'line') return null;
  const entry = {
    id: id('t_'), itemId: root.row.id, canvasId: root.row.canvasId, type: root.row.type,
    label: labelFor(root.row, removed), deletedAt: Date.now(),
    rows: JSON.stringify(removed.filter(r => !(r.tbl === 'items' && r.row.type === 'group')))
  };
  q.insert.run(entry);
  return entry.id;
}

// An entry whose card is back (e.g. after undo) is not in the trash anymore.
function list() {
  q.expire.run(Date.now() - TRASH_DAYS * 86400000);
  return q.list.all().filter(entry => {
    if (!stmt.getItem.get(entry.itemId)) return true;
    q.remove.run(entry.id);
    return false;
  }).map(entry => Object.assign(entry, {
    canvasTitle: (stmt.getCanvas.get(entry.canvasId) || {}).title || null
  }));
}

// Puts every row back. If the board the card lived on is gone too, the card
// lands on Home instead.
function restore(entryId) {
  const entry = q.get.get(entryId);
  if (!entry) return null;
  const rows = JSON.parse(entry.rows);
  const canvasIds = new Set(rows.filter(r => r.tbl === 'canvases').map(r => r.row.id));
  const home = rootCanvasId();
  const target = stmt.getCanvas.get(entry.canvasId) ? entry.canvasId : home;
  db.transaction(() => {
    for (const { tbl, row } of rows.filter(r => r.tbl === 'canvases')) {
      const parentOk = canvasIds.has(row.parentCanvasId) || stmt.getCanvas.get(row.parentCanvasId);
      q.insertCanvas.run(Object.assign({}, row, { parentCanvasId: parentOk ? row.parentCanvasId : target }));
    }
    const itemIds = new Set(rows.filter(r => r.tbl === 'items').map(r => r.row.id));
    for (const { tbl, row } of rows.filter(r => r.tbl === 'items')) {
      const onOwnCanvas = canvasIds.has(row.canvasId);
      const next = Object.assign({}, row);
      if (!onOwnCanvas && !stmt.getCanvas.get(row.canvasId)) next.canvasId = target;
      if (next.parentItemId && !itemIds.has(next.parentItemId) && !stmt.getItem.get(next.parentItemId)) next.parentItemId = null;
      if (row.type === 'line') {
        const data = JSON.parse(row.data || '{}');
        const exists = key => itemIds.has(data[key]) || stmt.getItem.get(data[key]);
        if (!exists('from') || !exists('to')) continue;
      }
      q.insertItem.run(next);
    }
    q.remove.run(entryId);
  })();
  return { canvasId: target, itemId: entry.itemId };
}

module.exports = {
  add, list, restore,
  purge: entryId => q.remove.run(entryId).changes > 0,
  empty: () => q.empty.run().changes
};
