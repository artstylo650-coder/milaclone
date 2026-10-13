'use strict';

// Every HTTP endpoint of the app: canvases, items, uploads and thumbnails,
// transfers, undo/redo, search, trash, backups, live events and the ComfyUI
// bridge. Mutating requests are wrapped in an undo step (see history.js).

const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const {
  db, stmt, id, rootCanvasId,
  rowToItem, breadcrumb, itemsForCanvas, deleteItemDeep
} = require('./db');
const history = require('./history');
const trash = require('./trash');
const backup = require('./backup');
const comfy = require('./comfy');
const events = require('./events');
const translator = require('./translate');
const updater = require('./update');
const appVersion = require('./version');
require('./migrate').run();   // bring an older database up to date (snapshot first when it changes anything)
const os = require('os');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'public', 'uploads');
const THUMB_DIR = path.join(UPLOAD_DIR, 'thumbs');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(THUMB_DIR, { recursive: true });

const BOARD_ICONS = [
  'layout-grid', 'book-open', 'monitor', 'clock', 'heart', 'house', 'lightbulb',
  'palette', 'briefcase', 'sparkles', 'glasses', 'landmark', 'compass', 'camera',
  'music', 'pen-tool', 'layers', 'folder', 'star', 'zap', 'globe', 'cpu', 'leaf', 'target'
];
const randomBoardIcon = () => BOARD_ICONS[Math.floor(Math.random() * BOARD_ICONS.length)];

const ALLOWED_UPLOAD = (mime) =>
  /^image\//.test(mime) ||
  /^text\//.test(mime) ||
  mime === 'application/pdf' ||
  mime === 'application/msword' ||
  mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
  mime === 'application/vnd.ms-excel' ||
  mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
  mime === 'application/vnd.ms-powerpoint' ||
  mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
  mime === 'application/zip' ||
  mime === 'application/json';

const router = express.Router();

// Every synchronous mutating request is one undo step (see history.js).
// Handlers must finish their writes before returning for this to capture them.
const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
const clientOf = req => String(req.get('X-Client-Id') || '').slice(0, 64);
router.use('/api', (req, res, next) => {
  if (!MUTATING.has(req.method) || req.path === '/upload' || req.path.startsWith('/history') ||
      req.path.startsWith('/backup')) return next();
  history.begin(String(req.get('X-Undo-Key') || '').slice(0, 120), clientOf(req));
  try { next(); } finally { events.publish(history.end(), clientOf(req)); }
});
router.get('/api/history', (req, res) => res.json(history.status(clientOf(req))));
const stepped = (result, req) => { if (result.ok) events.publish(result.canvasIds, clientOf(req)); return result; };
router.post('/api/history/undo', (req, res) => res.json(stepped(history.undo(clientOf(req)), req)));
router.post('/api/history/redo', (req, res) => res.json(stepped(history.redo(clientOf(req)), req)));
router.get('/api/events', events.subscribe);

router.post('/api/transfer', (req, res) => {
  try { res.json(require('./transfer')(req.body || {})); }
  catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : 'Falha ao copiar ou mover' }); }
});
const thumbnailJobs = new Map();
const failedThumbnails = new Set();
let thumbnailWorkers = 0;
const thumbnailQueue = [];

function scheduleThumbnail(work) {
  return new Promise((resolve, reject) => {
    thumbnailQueue.push({ work, resolve, reject });
    pumpThumbnails();
  });
}

function pumpThumbnails() {
  while (thumbnailWorkers < 2 && thumbnailQueue.length) {
    const job = thumbnailQueue.shift();
    thumbnailWorkers += 1;
    Promise.resolve().then(job.work).then(job.resolve, job.reject).finally(() => {
      thumbnailWorkers -= 1;
      pumpThumbnails();
    });
  }
}

function ensureThumbnail(item, source, cached) {
  if (fs.existsSync(cached)) return Promise.resolve(cached);
  if (failedThumbnails.has(item.id)) return Promise.reject(new Error('unsupported image'));
  if (thumbnailJobs.has(item.id)) return thumbnailJobs.get(item.id);
  const job = scheduleThumbnail(async () => {
    if (!fs.existsSync(cached)) {
      await sharp(source)
        .rotate()
        .resize({ width: 720, height: 720, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 78, effort: 3 })
        .toFile(cached);
    }
    return cached;
  }).catch(err => {
    failedThumbnails.add(item.id);
    throw err;
  }).finally(() => thumbnailJobs.delete(item.id));
  thumbnailJobs.set(item.id, job);
  return job;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '').toLowerCase().replace(/[^.a-z0-9]/g, '');
    cb(null, id('img_') + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ALLOWED_UPLOAD(file.mimetype))
});

// ---- Canvas ----------------------------------------------------------------
router.get('/api/root', (req, res) => res.json({ rootCanvasId: rootCanvasId() }));

router.get('/api/canvas/:id', (req, res) => {
  const canvas = stmt.getCanvas.get(req.params.id);
  if (!canvas) return res.status(404).json({ error: 'not found' });
  const items = itemsForCanvas(canvas.id).map(it => {
    if (it.type === 'board' && it.data && it.data.childCanvasId) {
      const child = stmt.getCanvas.get(it.data.childCanvasId);
      const count = stmt.childCount.get(it.data.childCanvasId).c;
      const previewRow = stmt.firstImageOnCanvas.get(it.data.childCanvasId);
      return Object.assign({}, it, {
        _childTitle: child ? child.title : 'Board',
        _childCount: count,
        _childColor: child ? child.color : 'slate',
        _childIcon: child ? (child.icon || 'layout-grid') : 'layout-grid',
        _childPreview: previewRow ? '/api/thumb/' + encodeURIComponent(previewRow.id) : null
      });
    }
    return it;
  });
  res.json({ canvas, items, breadcrumb: breadcrumb(canvas.id) });
});

router.patch('/api/canvas/:id', (req, res) => {
  const canvas = stmt.getCanvas.get(req.params.id);
  if (!canvas) return res.status(404).json({ error: 'not found' });
  const { title, color, icon } = req.body || {};
  if (typeof title === 'string') canvas.title = title.slice(0, 200);
  if (typeof color === 'string') canvas.color = color;
  if (typeof icon === 'string') canvas.icon = icon;
  stmt.updateCanvas.run(canvas);
  res.json(canvas);
});

// ---- Items -----------------------------------------------------------------
router.post('/api/item', (req, res) => {
  const b = req.body || {};
  if (!stmt.getCanvas.get(b.canvasId)) return res.status(400).json({ error: 'bad canvasId' });

  const item = {
    id: id('i_'),
    canvasId: b.canvasId,
    parentItemId: b.parentItemId || null,
    type: b.type || 'note',
    x: Math.round(b.x ?? 60),
    y: Math.round(b.y ?? 60),
    w: Math.round(b.w || 240),
    h: b.h != null ? Math.round(b.h) : null,
    z: Math.max(0, stmt.maxZ.get().m || 0) + 1,
    color: b.color || null,
    data: b.data || {},
    createdAt: Date.now()
  };

  db.transaction(() => {
    // A board item owns a freshly created child canvas.
    if (item.type === 'board') {
      const childId = id('c_');
      const icon = (item.data && item.data.icon) || randomBoardIcon();
      stmt.insertCanvas.run({
        id: childId,
        title: item.data.title || 'Board sem nome',
        parentCanvasId: item.canvasId,
        color: item.color || 'slate',
        icon,
        createdAt: Date.now()
      });
      item.data = { childCanvasId: childId };
    }
    stmt.insertItem.run(Object.assign({}, item, { data: JSON.stringify(item.data) }));
  })();

  if (item.type === 'board' && item.data.childCanvasId) {
    const child = stmt.getCanvas.get(item.data.childCanvasId);
    Object.assign(item, {
      _childTitle: child ? child.title : 'Board',
      _childCount: 0,
      _childColor: child ? child.color : 'slate',
      _childIcon: child ? (child.icon || 'layout-grid') : 'layout-grid'
    });
  }

  res.json(item);
});

router.patch('/api/item/:id', (req, res) => {
  const row = stmt.getItem.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const it = rowToItem(row);
  const b = req.body || {};
  for (const k of ['x', 'y', 'w', 'h', 'z']) {
    if (b[k] != null) it[k] = Math.round(b[k]);
  }
  if (b.color !== undefined) it.color = b.color;
  if (b.parentItemId !== undefined) it.parentItemId = b.parentItemId;
  if (b.canvasId && stmt.getCanvas.get(b.canvasId)) it.canvasId = b.canvasId;
  if (b.data && typeof b.data === 'object') it.data = Object.assign({}, it.data, b.data);

  const isBoard = it.type === 'board' && it.data && it.data.childCanvasId;
  db.transaction(() => {
    if (b.color !== undefined && isBoard) {
      const c = stmt.getCanvas.get(it.data.childCanvasId);
      if (c) { c.color = b.color; stmt.updateCanvas.run(c); }
    }
    // keep nested board canvas title/icon in sync with the card
    if (isBoard && b.data && (b.data.title != null || b.data.icon != null)) {
      const c = stmt.getCanvas.get(it.data.childCanvasId);
      if (c) {
        if (b.data.title != null) c.title = String(b.data.title).slice(0, 200);
        if (b.data.icon != null) c.icon = String(b.data.icon);
        stmt.updateCanvas.run(c);
      }
      // store title/icon only on the canvas; card reads them from there
      delete it.data.title;
      delete it.data.icon;
    }
    stmt.updateItem.run({
      id: it.id,
      canvasId: it.canvasId,
      parentItemId: it.parentItemId ?? null,
      x: it.x, y: it.y, w: it.w, h: it.h ?? null, z: it.z,
      color: it.color ?? null,
      data: JSON.stringify(it.data)
    });
  })();

  res.json(it);
});

// Bulk position update (used after multi-select drags / reflows)
router.patch('/api/items', (req, res) => {
  const updates = (req.body && req.body.updates) || [];
  db.transaction(() => {
    for (const u of updates) {
      const row = stmt.getItem.get(u.id);
      if (!row) continue;
      const it = rowToItem(row);
      for (const k of ['x', 'y', 'w', 'h', 'z']) if (u[k] != null) it[k] = Math.round(u[k]);
      if (u.parentItemId !== undefined) it.parentItemId = u.parentItemId;
      if (u.data && typeof u.data === 'object') it.data = Object.assign({}, it.data, u.data);
      stmt.updateItem.run({
        id: it.id,
        canvasId: it.canvasId,
        parentItemId: it.parentItemId ?? null,
        x: it.x, y: it.y, w: it.w, h: it.h ?? null, z: it.z,
        color: it.color ?? null,
        data: JSON.stringify(it.data)
      });
    }
  })();
  res.json({ ok: true });
});

router.delete('/api/item/:id', (req, res) => {
  if (!stmt.getItem.get(req.params.id)) return res.status(404).json({ error: 'not found' });
  const removed = db.transaction(() => deleteItemDeep(req.params.id, new Set()))();
  trash.add(removed);
  res.json({ ok: true });
});

// ---- Quick notes -----------------------------------------------------------
// Every `todo` card in the tree is a Quick-notes list, wherever it sits on the
// board. The mobile Quick-notes screens read them all in one go instead of
// walking canvases; writes go back through the normal PATCH /api/item route.
router.get('/api/todos', (req, res) => {
  const lists = stmt.todoItems.all().map(rowToItem).map(it => {
    const canvas = stmt.getCanvas.get(it.canvasId);
    return {
      id: it.id,
      canvasId: it.canvasId,
      canvasTitle: canvas ? canvas.title : '',
      title: it.data.title || 'To-do',
      color: it.color || null,
      tags: Array.isArray(it.data.tags) ? it.data.tags : [],
      tasks: Array.isArray(it.data.tasks) ? it.data.tasks : [],
      createdAt: it.createdAt
    };
  });
  res.json({ rootCanvasId: rootCanvasId(), lists });
});

// ---- Upload ----------------------------------------------------------------
router.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  res.json({
    src: '/uploads/' + req.file.filename,
    name: req.file.originalname,
    mime: req.file.mimetype
  });
});

// Render boards from small cached previews instead of decoding every original
// photo in the browser. The original upload remains untouched and available.
router.get('/api/thumb/:id', async (req, res) => {
  const row = stmt.getItem.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const item = rowToItem(row);
  if (item.type !== 'image' || !item.data || typeof item.data.src !== 'string') {
    return res.status(404).json({ error: 'not an image' });
  }

  // Uploaded media is always addressed as /uploads/<generated filename>.
  // basename prevents an old or manually edited item from escaping UPLOAD_DIR.
  const filename = path.basename(item.data.src);
  const source = path.join(UPLOAD_DIR, filename);
  const cached = path.join(THUMB_DIR, item.id + '.webp');
  if (!fs.existsSync(source)) return res.status(404).json({ error: 'source not found' });

  try {
    await ensureThumbnail(item, source, cached);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    return res.sendFile(cached);
  } catch (err) {
    return res.status(422).json({ error: 'thumbnail failed' });
  }
});

// ---- Search ----------------------------------------------------------------
// Accent- and case-insensitive match over every card's text and every board
// title, across the whole tree. Single-user boards are small enough to scan.
const fold = v => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const allItems = db.prepare("SELECT * FROM items WHERE type NOT IN ('group', 'line', 'column')");
const allCanvases = db.prepare('SELECT * FROM canvases');

function itemText(it) {
  const d = it.data || {};
  const parts = [d.title, d.body, d.name, d.url, d.label, d.prompt, ...(Array.isArray(d.tags) ? d.tags.map(t => '#' + t) : [])];
  if (Array.isArray(d.tasks)) parts.push(...d.tasks.map(t => t.text));
  return parts.filter(Boolean).join('\n');
}

router.get('/api/search', (req, res) => {
  const terms = fold(req.query.q).split(/\s+/).filter(Boolean);
  if (!terms.length) return res.json({ results: [] });
  const canvases = new Map(allCanvases.all().map(c => [c.id, c]));
  const hit = text => { const f = fold(text); return terms.every(t => f.includes(t)); };
  const results = [];
  for (const c of canvases.values()) {
    if (hit(c.title)) results.push({ kind: 'board', canvasId: c.id, title: c.title || 'Board sem nome',
      where: canvases.get(c.parentCanvasId)?.title || '' });
  }
  for (const row of allItems.all()) {
    const it = rowToItem(row);
    if (it.type === 'board') continue;   // found through its canvas title
    const text = itemText(it);
    if (!text || !hit(text)) continue;
    const firstLine = text.split('\n').map(s => s.trim()).find(Boolean) || '';
    results.push({ kind: 'item', id: it.id, type: it.type, canvasId: it.canvasId,
      title: firstLine.slice(0, 140), where: canvases.get(it.canvasId)?.title || '' });
    if (results.length >= 80) break;
  }
  res.json({ results: results.slice(0, 80) });
});

// ---- ComfyUI bridge (see comfy.js) ----------------------------------------
const comfyRoute = fn => async (req, res) => {
  try { res.json(await fn(req)); }
  catch (err) { res.status(err.status || 502).json({ error: err.message || 'Falha na chamada ao ComfyUI' }); }
};
// requests from this computer only (not through a proxy): they may name the
// file that starts ComfyUI, and start it
const fromThisComputer = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && !req.get('x-forwarded-for');
router.get('/api/comfy/settings', comfyRoute(req => ({ ...comfy.publicSettings(), canLaunch: fromThisComputer(req) })));
router.put('/api/comfy/settings', comfyRoute(req => ({ ...comfy.saveSettings(req.body, { trusted: fromThisComputer(req) }), canLaunch: fromThisComputer(req) })));
router.post('/api/comfy/launch', comfyRoute(req => {
  if (!fromThisComputer(req)) throw Object.assign(new Error('Só é possível ligar o ComfyUI a partir do próprio computador.'), { status: 403 });
  return comfy.startLocal();
}));
// ---- Version and updates (see update.js) ---------------------------------------
router.get('/api/version', (req, res) => res.json(appVersion.info()));
const localOnly = fn => async (req, res) => {
  if (!fromThisComputer(req)) return res.status(403).json({ error: 'Atualizar só é possível a partir do próprio computador.' });
  try { await fn(req, res); } catch (err) { res.status(err.status || 500).json({ error: err.message || 'Falha na atualização' }); }
};
router.get('/api/update/check', localOnly(async (req, res) => res.json(await updater.check())));
router.post('/api/update/apply', localOnly(async (req, res) => {
  const result = await updater.apply();
  res.json(result);
  // the Windows wrapper (scripts/windows/servidor.ps1) starts the server again on this code
  if (result.updated && !process.env.UPDATE_NO_EXIT) setTimeout(() => process.exit(updater.RESTART_CODE), 500);
}));
router.post('/api/comfy/recover/:id', comfyRoute(req => comfy.recover(req.params.id, UPLOAD_DIR)));
router.post('/api/comfy/test', comfyRoute(() => comfy.testConnection()));
router.get('/api/comfy/workflows', comfyRoute(() => ({ workflows: comfy.listWorkflows() })));
router.post('/api/comfy/workflows', comfyRoute(req => {
  try { return comfy.addWorkflow(req.body && req.body.name, req.body && req.body.json); }
  catch (err) { throw Object.assign(err, { status: err.status || 400, message: err instanceof SyntaxError ? 'Este arquivo não é um JSON válido' : err.message }); }
}));
router.get('/api/comfy/workflows/:id', comfyRoute(req => comfy.workflowDetail(req.params.id)));
router.put('/api/comfy/workflows/:id/exposed', comfyRoute(req => comfy.setExposed(req.params.id, req.body && req.body.exposed, req.body && req.body.scalable)));
router.delete('/api/comfy/workflows/:id', comfyRoute(req => ({ ok: comfy.removeWorkflow(req.params.id) })));
router.post('/api/comfy/run/:id', comfyRoute(req => comfy.run(req.params.id, UPLOAD_DIR)));
router.get('/api/comfy/plan/:id', comfyRoute(req => comfy.planView(req.params.id, UPLOAD_DIR)));
router.get('/api/comfy/enhance-settings', comfyRoute(() => comfy.enhanceView()));
router.put('/api/comfy/enhance-settings', comfyRoute(req => comfy.saveEnhance(req.body)));
router.post('/api/comfy/enhance', comfyRoute(req => comfy.enhance(req.body && req.body.ids, UPLOAD_DIR)));
router.post('/api/comfy/cancel/:id', comfyRoute(req => comfy.cancel(req.params.id)));
router.get('/api/comfy/status/:id', comfyRoute(req => comfy.status(req.params.id)));
comfy.setChangeListener(canvasIds => events.publish(canvasIds));
comfy.resume(UPLOAD_DIR);

// ---- Translation (see translate.js) -----------------------------------------
router.get('/api/translate/settings', (req, res) => res.json(translator.publicSettings()));
router.put('/api/translate/settings', (req, res) => {
  try { res.json(translator.saveSettings(req.body || {})); }
  catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});
router.post('/api/translate', async (req, res) => {
  try { res.json(await translator.translate(req.body || {})); }
  catch (err) { res.status(err.status || 500).json({ error: err.status ? err.message : 'Falha na tradução' }); }
});

// ---- Trash -----------------------------------------------------------------
router.get('/api/trash', (req, res) => res.json({ entries: trash.list() }));
router.post('/api/trash/:id/restore', (req, res) => {
  const restored = trash.restore(req.params.id);
  if (!restored) return res.status(404).json({ error: 'not found' });
  res.json(restored);
});
router.delete('/api/trash/:id', (req, res) => res.json({ ok: trash.purge(req.params.id) }));
router.delete('/api/trash', (req, res) => res.json({ removed: trash.empty() }));

// ---- Backup ----------------------------------------------------------------
router.get('/api/backup', (req, res) => res.json({ snapshots: backup.snapshots(), dir: backup.BACKUP_DIR }));
router.post('/api/backup/snapshot', async (req, res) => {
  try { res.json({ file: path.basename(await backup.snapshot('manual')) }); }
  catch (err) { res.status(500).json({ error: 'Falha no backup' }); }
});
router.get('/api/backup/export', async (req, res) => {
  res.set('Content-Type', 'application/gzip');
  res.attachment(`milaclone-backup-${new Date().toISOString().slice(0, 10)}.tar.gz`);
  try { await backup.exportArchive(UPLOAD_DIR, res); }
  catch (err) { if (!res.headersSent) res.status(500).json({ error: 'Falha ao exportar' }); else res.destroy(err); }
});
const restoreUpload = multer({ dest: os.tmpdir() });
router.post('/api/backup/restore', restoreUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  try { res.json(await backup.restoreArchive(req.file.path, UPLOAD_DIR)); events.publish('all'); }
  catch (err) { res.status(err.status || 500).json({ error: err.status ? err.message : 'Falha ao restaurar' }); }
  finally { fs.rmSync(req.file.path, { force: true }); }
});

router.get('/api/health', (req, res) => res.json({ ok: true }));

module.exports = router;
