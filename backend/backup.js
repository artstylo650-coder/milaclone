'use strict';

// Backups.
// - Automatic: a consistent SQLite snapshot (db.backup) into DATA_DIR/backups
//   every BACKUP_INTERVAL_HOURS, keeping the newest BACKUP_KEEP files. Photos
//   are never deleted by the app, so the database is what needs protecting.
// - Export: a .tar.gz with the database snapshot plus every upload.
// - Restore: replaces all boards with the archive's content, inside one
//   transaction on the live handle, after taking a "before-restore" snapshot.

const fs = require('fs');
const os = require('os');
const path = require('path');
const tar = require('tar');
const Database = require('better-sqlite3');
const { db, DB_FILE } = require('./db');

// Point BACKUP_DIR at another disk or a NAS mount so a dead drive does not
// take the backups with it.
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(DB_FILE), 'backups');
const INTERVAL_H = Number(process.env.BACKUP_INTERVAL_HOURS) || 24;
const KEEP = Number(process.env.BACKUP_KEEP) || 14;
fs.mkdirSync(BACKUP_DIR, { recursive: true });

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

function snapshots() {
  return fs.readdirSync(BACKUP_DIR).filter(f => /^board-.*\.db$/.test(f)).sort();
}

async function snapshot(reason = 'auto') {
  const file = path.join(BACKUP_DIR, `board-${stamp()}-${reason}.db`);
  await db.backup(file);
  const auto = snapshots().filter(f => f.endsWith('-auto.db'));
  for (const old of auto.slice(0, Math.max(0, auto.length - KEEP))) fs.rmSync(path.join(BACKUP_DIR, old), { force: true });
  return file;
}

function lastSnapshotAt() {
  const files = snapshots();
  if (!files.length) return 0;
  return fs.statSync(path.join(BACKUP_DIR, files[files.length - 1])).mtimeMs;
}

// Snapshot at boot if the last one is older than the interval, then on a timer.
function startAutoBackup() {
  const due = () => Date.now() - lastSnapshotAt() >= INTERVAL_H * 3600000;
  const run = () => { if (due()) snapshot('auto').catch(err => console.error('Backup failed:', err.message)); };
  run();
  const timer = setInterval(run, Math.min(INTERVAL_H * 3600000, 3600000));
  timer.unref();
}

// Streams a .tar.gz containing board.db and uploads/ (without cached thumbnails).
async function exportArchive(uploadDir, out) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'milaclone-export-'));
  try {
    await db.backup(path.join(stage, 'board.db'));
    fs.mkdirSync(path.join(stage, 'uploads'));
    for (const name of fs.readdirSync(uploadDir)) {
      const source = path.join(uploadDir, name);
      if (name === 'thumbs' || !fs.statSync(source).isFile()) continue;
      // hard links avoid copying gigabytes of photos; fall back to a copy
      try { fs.linkSync(source, path.join(stage, 'uploads', name)); }
      catch (_) { fs.copyFileSync(source, path.join(stage, 'uploads', name)); }
    }
    await new Promise((resolve, reject) => {
      tar.c({ gzip: true, cwd: stage, portable: true }, ['board.db', 'uploads'])
        .on('error', reject).pipe(out).on('finish', resolve).on('error', reject);
    });
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

const TABLES = {
  canvases: ['id', 'title', 'parentCanvasId', 'color', 'icon', 'createdAt'],
  items: ['id', 'canvasId', 'parentItemId', 'type', 'x', 'y', 'w', 'h', 'z', 'color', 'data', 'createdAt']
};

// Extracts an uploaded archive, validates it, then swaps the content in.
async function restoreArchive(archivePath, uploadDir) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'milaclone-restore-'));
  try {
    await tar.x({ file: archivePath, cwd: stage, strict: true,
      filter: p => p === 'board.db' || /^uploads\/[^/]+$/.test(p) || p === 'uploads/' });
    const dbFile = path.join(stage, 'board.db');
    if (!fs.existsSync(dbFile)) throw Object.assign(new Error('O arquivo não contém board.db'), { status: 400 });

    const incoming = new Database(dbFile, { readonly: true });
    let rows, rootId;
    try {
      rootId = incoming.prepare("SELECT value FROM meta WHERE key = 'rootCanvasId'").get()?.value;
      if (!rootId) throw new Error('missing root');
      const cols = t => incoming.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
      rows = {};
      for (const [t, wanted] of Object.entries(TABLES)) {
        const have = cols(t);
        const select = wanted.map(c => have.includes(c) ? c : `NULL AS ${c}`).join(', ');
        rows[t] = incoming.prepare(`SELECT ${select} FROM ${t}`).all();
      }
    } catch (_) {
      throw Object.assign(new Error('Este arquivo não é um backup do Milaclone'), { status: 400 });
    } finally {
      incoming.close();
    }

    await snapshot('before-restore');
    for (const name of fs.existsSync(path.join(stage, 'uploads')) ? fs.readdirSync(path.join(stage, 'uploads')) : []) {
      const target = path.join(uploadDir, path.basename(name));
      if (!fs.existsSync(target)) fs.copyFileSync(path.join(stage, 'uploads', name), target);
    }
    db.transaction(() => {
      db.exec('UPDATE history_state SET stepId = NULL; DELETE FROM history_changes; DELETE FROM history_steps; DELETE FROM items; DELETE FROM canvases;');
      for (const [t, cols] of Object.entries(TABLES)) {
        const insert = db.prepare(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(c => '@' + c).join(', ')})`);
        for (const row of rows[t]) insert.run(row);
      }
      db.prepare("INSERT INTO meta (key, value) VALUES ('rootCanvasId', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(rootId);
    })();
    // cached thumbnails are keyed by item id and may now point at other photos
    fs.rmSync(path.join(uploadDir, 'thumbs'), { recursive: true, force: true });
    fs.mkdirSync(path.join(uploadDir, 'thumbs'), { recursive: true });
    return { canvases: rows.canvases.length, items: rows.items.length };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

module.exports = { snapshot, snapshots, startAutoBackup, exportArchive, restoreArchive, BACKUP_DIR };
