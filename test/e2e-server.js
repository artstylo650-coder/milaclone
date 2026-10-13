'use strict';

// Cross-platform Playwright server bootstrap. Keeping cleanup and environment
// setup in Node makes the test command work on Windows, macOS, and Linux.
const fs = require('fs');
const path = require('path');

// EXPLORE_DATA / EXPLORE_PORT let scripts/explore.js run its own copy.
const dataDir = process.env.EXPLORE_DATA || path.join(__dirname, '..', '.e2e-data');
fs.rmSync(dataDir, { recursive: true, force: true });
process.env.DATA_DIR = dataDir;
process.env.UPLOAD_DIR = path.join(dataDir, 'uploads');
process.env.HOST = '127.0.0.1';
process.env.PORT = process.env.EXPLORE_PORT || '4322';
// translation calls go to the fake MyMemory that e2e/notes.spec.js starts on 4398
process.env.TRANSLATE_API = 'http://127.0.0.1:4398';
// not a git checkout: the update check answers at once and never touches the network
process.env.UPDATE_REPO_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'milaclone-nogit-'));
require('../server');
