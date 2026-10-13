'use strict';

// Undo / redo journal. SQLite triggers copy every row change on `items` and
// `canvases` into history_changes while a step is open, so every mutating
// route (including deep deletes and transfers) is undoable without per-route
// inverse logic. Steps are opened by the middleware in routes.js around each
// synchronous mutating request; requests carrying the same X-Undo-Key within
// MERGE_MS of each other join one step (one user action = one undo). Each
// browser tab (X-Client-Id) has its own stack, so undo on the laptop never
// reverts something just done on the phone.

const { db } = require('./db');

const MERGE_MS = 5000;
const KEEP_STEPS = 300;

const ITEM_COLS = ['id', 'canvasId', 'parentItemId', 'type', 'x', 'y', 'w', 'h', 'z', 'color', 'data', 'createdAt'];
const CANVAS_COLS = ['id', 'title', 'parentCanvasId', 'color', 'icon', 'createdAt'];
const TABLES = { items: ITEM_COLS, canvases: CANVAS_COLS };

db.exec(`
  CREATE TABLE IF NOT EXISTS history_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT, clientId TEXT NOT NULL DEFAULT '', actionKey TEXT,
    undone INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER
  );
  CREATE TABLE IF NOT EXISTS history_changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, stepId INTEGER NOT NULL,
    tbl TEXT NOT NULL, op TEXT NOT NULL, before TEXT, after TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_history_changes_step ON history_changes(stepId);
  CREATE TABLE IF NOT EXISTS history_state (k INTEGER PRIMARY KEY CHECK (k = 1), stepId INTEGER);
  INSERT OR IGNORE INTO history_state (k, stepId) VALUES (1, NULL);
  UPDATE history_state SET stepId = NULL;
`);

if (!db.prepare('PRAGMA table_info(history_steps)').all().some(c => c.name === 'clientId')) {
  db.exec("ALTER TABLE history_steps ADD COLUMN clientId TEXT NOT NULL DEFAULT ''");
}

const rowJson =(prefix, cols) => `json_object(${cols.map(c => `'${c}', ${prefix}.${c}`).join(', ')})`;
const recording = '(SELECT stepId FROM history_state WHERE k = 1)';
for (const [tbl, cols] of Object.entries(TABLES)) {
  const changed = cols.map(c => `OLD.${c} IS NOT NEW.${c}`).join(' OR ');
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS history_${tbl}_insert AFTER INSERT ON ${tbl}
    WHEN ${recording} IS NOT NULL BEGIN
      INSERT INTO history_changes (stepId, tbl, op, after) VALUES (${recording}, '${tbl}', 'insert', ${rowJson('NEW', cols)});
    END;
    CREATE TRIGGER IF NOT EXISTS history_${tbl}_update AFTER UPDATE ON ${tbl}
    WHEN ${recording} IS NOT NULL AND (${changed}) BEGIN
      INSERT INTO history_changes (stepId, tbl, op, before, after)
      VALUES (${recording}, '${tbl}', 'update', ${rowJson('OLD', cols)}, ${rowJson('NEW', cols)});
    END;
    CREATE TRIGGER IF NOT EXISTS history_${tbl}_delete AFTER DELETE ON ${tbl}
    WHEN ${recording} IS NOT NULL BEGIN
      INSERT INTO history_changes (stepId, tbl, op, before) VALUES (${recording}, '${tbl}', 'delete', ${rowJson('OLD', cols)});
    END;
  `);
}

const q = {
  setState: db.prepare('UPDATE history_state SET stepId = ? WHERE k = 1'),
  lastDone: db.prepare('SELECT * FROM history_steps WHERE clientId = ? AND undone = 0 ORDER BY id DESC LIMIT 1'),
  firstUndone: db.prepare('SELECT * FROM history_steps WHERE clientId = ? AND undone = 1 ORDER BY id ASC LIMIT 1'),
  insertStep: db.prepare('INSERT INTO history_steps (clientId, actionKey, updatedAt) VALUES (?, ?, ?)'),
  touchStep: db.prepare('UPDATE history_steps SET updatedAt = ? WHERE id = ?'),
  markStep: db.prepare('UPDATE history_steps SET undone = ? WHERE id = ?'),
  countChanges: db.prepare('SELECT COUNT(*) AS c FROM history_changes WHERE stepId = ?'),
  lastSeq: db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM history_changes'),
  changesSince: db.prepare('SELECT * FROM history_changes WHERE stepId = ? AND seq > ?'),
  changes: db.prepare('SELECT * FROM history_changes WHERE stepId = ? ORDER BY seq'),
  deleteStep: db.prepare('DELETE FROM history_steps WHERE id = ?'),
  clearRedo: db.prepare(`DELETE FROM history_changes
                         WHERE stepId IN (SELECT id FROM history_steps WHERE clientId = ? AND undone = 1)`),
  clearRedoSteps: db.prepare('DELETE FROM history_steps WHERE clientId = ? AND undone = 1'),
  pruneChanges: db.prepare('DELETE FROM history_changes WHERE stepId <= ?'),
  pruneSteps: db.prepare('DELETE FROM history_steps WHERE id <= ?'),
  counts: db.prepare('SELECT SUM(undone = 0) AS undo, SUM(undone = 1) AS redo FROM history_steps WHERE clientId = ?')
};
const writeRow = Object.fromEntries(Object.entries(TABLES).map(([tbl, cols]) => [tbl,
  db.prepare(`INSERT OR REPLACE INTO ${tbl} (${cols.join(', ')}) VALUES (${cols.map(c => '@' + c).join(', ')})`)]));
const deleteRow = Object.fromEntries(Object.keys(TABLES).map(tbl => [tbl, db.prepare(`DELETE FROM ${tbl} WHERE id = ?`)]));

let open = null;   // { id, created, clientId, startSeq }

function begin(actionKey, clientId = '') {
  const now = Date.now();
  const last = q.lastDone.get(clientId);
  if (actionKey && last && last.actionKey === actionKey && now - last.updatedAt < MERGE_MS && !q.firstUndone.get(clientId)) {
    q.touchStep.run(now, last.id);
    open = { id: last.id, created: false, clientId };
  } else {
    open = { id: Number(q.insertStep.run(clientId, actionKey || null, now).lastInsertRowid), created: true, clientId };
  }
  open.startSeq = q.lastSeq.get().s;
  q.setState.run(open.id);
}

// Closes the request's step; returns the canvases this request changed so
// other devices can be told to refresh.
function end() {
  if (!open) return [];
  q.setState.run(null);
  const step = open;
  open = null;
  const fresh = q.changesSince.all(step.id, step.startSeq);
  if (!fresh.length) {
    if (step.created && !q.countChanges.get(step.id).c) q.deleteStep.run(step.id);
    return [];
  }
  // A new change invalidates whatever was undone before it.
  db.transaction(() => {
    q.clearRedo.run(step.clientId);
    q.clearRedoSteps.run(step.clientId);
    if (step.id > KEEP_STEPS) { q.pruneChanges.run(step.id - KEEP_STEPS); q.pruneSteps.run(step.id - KEEP_STEPS); }
  })();
  return canvasesOf(fresh);
}

function canvasesOf(changes) {
  const ids = new Set();
  for (const c of changes) {
    for (const raw of [c.before, c.after]) {
      if (!raw) continue;
      const row = JSON.parse(raw);
      if (c.tbl === 'items') ids.add(row.canvasId);
      else { ids.add(row.id); if (row.parentCanvasId) ids.add(row.parentCanvasId); }
    }
  }
  return [...ids];
}

function apply(step, direction) {
  const changes = q.changes.all(step.id);
  const ordered = direction === 'undo' ? [...changes].reverse() : changes;
  db.transaction(() => {
    for (const c of ordered) {
      const target = direction === 'undo' ? c.before : c.after;
      const row = target ? JSON.parse(target) : null;
      if (row) writeRow[c.tbl].run(row);
      else deleteRow[c.tbl].run(JSON.parse(c.before || c.after).id);
    }
    q.markStep.run(direction === 'undo' ? 1 : 0, step.id);
  })();
  return { ok: true, canvasIds: canvasesOf(changes), ...status(step.clientId) };
}

function status(clientId = '') {
  const { undo, redo } = q.counts.get(clientId);
  return { canUndo: !!undo, canRedo: !!redo };
}

function undo(clientId = '') {
  const step = q.lastDone.get(clientId);
  return step ? apply(step, 'undo') : { ok: false, ...status(clientId) };
}

function redo(clientId = '') {
  const step = q.firstUndone.get(clientId);
  return step ? apply(step, 'redo') : { ok: false, ...status(clientId) };
}

module.exports = { begin, end, undo, redo, status };
