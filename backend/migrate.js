'use strict';

// Database migrations. Every change to the shape of the data that old
// databases need goes in MIGRATIONS as the next numbered entry; each runs once,
// in order, inside a transaction, and the number reached is kept in `meta`
// (schemaVersion). Before any migration beyond the baseline runs, a snapshot of
// the database is written next to the automatic backups, so an update can
// always be rolled back by restoring that file.
//
// Tables created with CREATE TABLE IF NOT EXISTS at start-up (comfy_jobs,
// history_changes…) and the older "ALTER TABLE … ADD COLUMN, ignore if it is
// there" lines stay as they are: they are idempotent and predate this file.

const path = require('path');
const { db, stmt } = require('./db');

const MIGRATIONS = [
  { id: 1, name: 'baseline', up() { /* the schema as of v1.0.0 */ } }
];

const currentVersion = () => Number((stmt.getMeta.get('schemaVersion') || {}).value || 0);

function snapshotBefore(id) {
  const { BACKUP_DIR } = require('./backup');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const file = path.join(BACKUP_DIR, `board-${stamp}-before-migration-${id}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);   // synchronous, consistent copy
  return file;
}

function run(list = MIGRATIONS) {
  const from = currentVersion();
  const pending = list.filter(m => m.id > from).sort((a, b) => a.id - b.id);
  const ran = [];
  let snapshot = null;
  for (const m of pending) {
    if (m.id > 1 && !snapshot) snapshot = snapshotBefore(m.id);
    db.transaction(() => { m.up(db); stmt.setMeta.run('schemaVersion', String(m.id)); })();
    ran.push(m.name);
  }
  return { from, to: currentVersion(), ran, snapshot };
}

module.exports = { run, currentVersion, MIGRATIONS };
