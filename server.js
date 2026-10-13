'use strict';

// Entry point: Express app that serves the static frontend (public/), the
// uploads folder, the export libraries under /vendor, and the JSON API from
// backend/routes.js. Also starts the automatic database snapshots.

const express = require('express');
const path = require('path');
const { DB_FILE } = require('./backend/db');

const PORT = process.env.PORT || 4321;
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
// ComfyUI workflows exported in API format can be a few megabytes
app.use(express.json({ limit: '20mb' }));
app.use('/uploads', express.static(process.env.UPLOAD_DIR || path.join(__dirname, 'public', 'uploads')));
// Export libraries are served from node_modules so PNG/PDF export works offline.
app.get('/vendor/html-to-image.js', (req, res) => res.sendFile(require.resolve('html-to-image/dist/html-to-image.js')));
app.get('/vendor/jspdf.umd.min.js', (req, res) => res.sendFile(require.resolve('jspdf/dist/jspdf.umd.min.js')));
app.use('/vendor/fonts', express.static(path.join(__dirname, 'node_modules', '@fontsource-variable'), { maxAge: '30d' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(require('./backend/routes'));

require('./backend/backup').startAutoBackup();

app.listen(PORT, HOST, () => {
  console.log(`\n  Canvas board running at http://${HOST}:${PORT}`);
  console.log(`  Data stored in ${DB_FILE}\n`);
});
