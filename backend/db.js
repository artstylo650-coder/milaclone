'use strict';

// SQLite connection, schema, prepared statements and tree helpers
// (breadcrumbs, deep delete). Opened on require; every other backend module
// builds on it.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'board.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Storage: a SQLite database queried directly on every request.
// ---------------------------------------------------------------------------
const id = (p = '') => p + crypto.randomBytes(9).toString('base64url');

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS canvases (
    id TEXT PRIMARY KEY, title TEXT, parentCanvasId TEXT, color TEXT, createdAt INTEGER
  );
  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY, canvasId TEXT NOT NULL, parentItemId TEXT, type TEXT,
    x INTEGER, y INTEGER, w INTEGER, h INTEGER, z INTEGER, color TEXT,
    data TEXT, createdAt INTEGER
  );
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  CREATE INDEX IF NOT EXISTS idx_items_canvas ON items(canvasId);
  CREATE INDEX IF NOT EXISTS idx_items_parent ON items(parentItemId);
`);

// Additive column for existing DBs
const cols = db.prepare("PRAGMA table_info(canvases)").all().map(c => c.name);
if (!cols.includes('icon')) db.exec('ALTER TABLE canvases ADD COLUMN icon TEXT');

// Prepared statements (created once, reused per request).
const stmt = {
  getMeta: db.prepare(`SELECT value FROM meta WHERE key = ?`),
  setMeta: db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
                       ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
  getCanvas: db.prepare(`SELECT * FROM canvases WHERE id = ?`),
  insertCanvas: db.prepare(`INSERT INTO canvases (id, title, parentCanvasId, color, icon, createdAt)
                            VALUES (@id, @title, @parentCanvasId, @color, @icon, @createdAt)`),
  updateCanvas: db.prepare(`UPDATE canvases SET title = @title, color = @color, icon = @icon WHERE id = @id`),
  deleteCanvas: db.prepare(`DELETE FROM canvases WHERE id = ?`),
  boardItemsOnCanvas: db.prepare(`SELECT * FROM items WHERE canvasId = ? AND type = 'board'`),
  getItem: db.prepare(`SELECT * FROM items WHERE id = ?`),
  itemsForCanvas: db.prepare(`SELECT * FROM items WHERE canvasId = ? ORDER BY COALESCE(z, 0), createdAt, id`),
  itemsByParent: db.prepare(`SELECT * FROM items WHERE parentItemId = ?`),
  todoItems: db.prepare(`SELECT * FROM items WHERE type = 'todo' ORDER BY createdAt, id`),
  itemsByCanvas: db.prepare(`SELECT * FROM items WHERE canvasId = ?`),
  firstImageOnCanvas: db.prepare(`SELECT id, data FROM items
                                  WHERE canvasId = ? AND type = 'image'
                                  ORDER BY createdAt, id LIMIT 1`),
  groupMembers: db.prepare(`SELECT * FROM items WHERE canvasId = ? AND id != ?
                            AND json_extract(data, '$.groupId') = ?`),
  linesTouching: db.prepare(`SELECT * FROM items WHERE canvasId = ? AND type = 'line'
                             AND (json_extract(data, '$.from') = ? OR json_extract(data, '$.to') = ?)`),
  maxZ: db.prepare(`SELECT MAX(z) AS m FROM items`),
  childCount: db.prepare(`SELECT COUNT(*) AS c FROM items
                          WHERE canvasId = ? AND parentItemId IS NULL AND type NOT IN ('group', 'line')`),
  insertItem: db.prepare(`INSERT INTO items (id, canvasId, parentItemId, type, x, y, w, h, z, color, data, createdAt)
                          VALUES (@id, @canvasId, @parentItemId, @type, @x, @y, @w, @h, @z, @color, @data, @createdAt)`),
  updateItem: db.prepare(`UPDATE items SET canvasId=@canvasId, parentItemId=@parentItemId, x=@x, y=@y, w=@w, h=@h,
                          z=@z, color=@color, data=@data WHERE id=@id`),
  deleteItem: db.prepare(`DELETE FROM items WHERE id = ?`)
};

// Seed a root 'Home' canvas on first run.
if (!stmt.getMeta.get('rootCanvasId')) {
  const rootId = id('c_');
  db.transaction(() => {
    stmt.insertCanvas.run({ id: rootId, title: 'Home', parentCanvasId: null, color: 'slate', icon: null, createdAt: Date.now() });
    stmt.setMeta.run('rootCanvasId', rootId);
  })();
}
function rootCanvasId() {
  return stmt.getMeta.get('rootCanvasId')?.value;
}

process.on('SIGINT', () => { db.close(); process.exit(0); });
process.on('SIGTERM', () => { db.close(); process.exit(0); });

// ---------------------------------------------------------------------------
// Mapping helpers: rows <-> API objects. `data` is stored as a JSON string but
// the API (and the frontend) always work with it as an object.
// ---------------------------------------------------------------------------
function rowToItem(row) {
  return Object.assign({}, row, { data: row.data ? JSON.parse(row.data) : {} });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function breadcrumb(canvasId) {
  const trail = [];
  let cur = stmt.getCanvas.get(canvasId);
  let guard = 0;
  while (cur && guard++ < 100) {
    trail.unshift({ id: cur.id, title: cur.title });
    cur = cur.parentCanvasId ? stmt.getCanvas.get(cur.parentCanvasId) : null;
  }
  return trail;
}

function itemsForCanvas(canvasId) {
  return stmt.itemsForCanvas.all(canvasId).map(rowToItem);
}

// Recursively collect a canvas and all canvases nested beneath it.
function collectDescendantCanvases(canvasId, acc) {
  acc.add(canvasId);
  for (const row of stmt.boardItemsOnCanvas.all(canvasId)) {
    const data = row.data ? JSON.parse(row.data) : {};
    if (data.childCanvasId && !acc.has(data.childCanvasId)) {
      collectDescendantCanvases(data.childCanvasId, acc);
    }
  }
  return acc;
}

// Recursively delete an item, its parented children, and any nested board subtree.
// Assumes it runs inside a transaction. `visited` guards against parent cycles.
// `removed` (optional) collects every deleted row so the caller can keep it
// in the trash: [{ tbl: 'items' | 'canvases', row }].
function deleteItemDeep(itemId, visited, removed = []) {
  if (visited.has(itemId)) return removed;
  visited.add(itemId);
  const it = stmt.getItem.get(itemId);
  if (!it) return removed;
  // delete children parented to this item (e.g. cards inside a column)
  for (const child of stmt.itemsByParent.all(itemId)) {
    deleteItemDeep(child.id, visited, removed);
  }
  const data = it.data ? JSON.parse(it.data) : {};
  // a group frame only owns its members by reference: free them, keep the cards
  if (it.type === 'group') {
    for (const member of stmt.groupMembers.all(it.canvasId, itemId, itemId)) {
      const memberData = member.data ? JSON.parse(member.data) : {};
      memberData.groupId = null;
      stmt.updateItem.run({ ...member, data: JSON.stringify(memberData) });
    }
  }
  // lines attached to this card have nothing left to connect
  for (const line of stmt.linesTouching.all(it.canvasId, itemId, itemId)) {
    if (visited.has(line.id)) continue;
    visited.add(line.id);
    removed.push({ tbl: 'items', row: line });
    stmt.deleteItem.run(line.id);
  }
  // if it owns a nested board canvas, remove that whole subtree
  if (it.type === 'board' && data.childCanvasId) {
    const canvases = collectDescendantCanvases(data.childCanvasId, new Set());
    for (const cid of canvases) {
      for (const sub of stmt.itemsByCanvas.all(cid)) {
        removed.push({ tbl: 'items', row: sub });
        stmt.deleteItem.run(sub.id);
      }
      const canvas = stmt.getCanvas.get(cid);
      if (canvas) removed.push({ tbl: 'canvases', row: canvas });
      stmt.deleteCanvas.run(cid);
    }
  }
  removed.push({ tbl: 'items', row: it });
  stmt.deleteItem.run(itemId);
  return removed;
}

module.exports = {
  DB_FILE, db, stmt, id, rootCanvasId,
  rowToItem, breadcrumb, itemsForCanvas, deleteItemDeep
};
