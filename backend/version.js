'use strict';

// Which version of Milaclone is running: the number from package.json plus,
// when the code lives in a git checkout, the commit it is on. Read fresh on
// every call so it is right after an update.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// where the program's own files live (UPDATE_REPO_DIR lets tests use a copy)
const ROOT = process.env.UPDATE_REPO_DIR || path.join(__dirname, '..');

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (_) { return null; }
}

function info() {
  let version = '0.0.0';
  try { version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch (_) {}
  return {
    version,
    commit: git(['rev-parse', '--short', 'HEAD']),
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    date: git(['log', '-1', '--format=%cs'])
  };
}

module.exports = { info, ROOT };
