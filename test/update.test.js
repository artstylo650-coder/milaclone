'use strict';

// Version, migrations and updating from git, against throw-away repositories:
// a bare "origin", the checkout the server runs from, and a second clone that
// publishes a newer version.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'update-test-'));
const origin = path.join(TMP, 'origin.git');
const app = path.join(TMP, 'app');
const dev = path.join(TMP, 'dev');
process.env.DATA_DIR = path.join(TMP, 'data');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.UPDATE_REPO_DIR = app;
process.env.UPDATE_SKIP_INSTALL = '1';
process.env.UPDATE_NO_EXIT = '1';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const writePkg = (dir, version) => fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version }));

const express = require('express');
let server, base;

test.before(async () => {
  git(TMP, 'init', '--bare', '-b', 'main', origin);
  git(TMP, 'clone', origin, app);
  git(app, 'checkout', '-b', 'main');
  writePkg(app, '1.0.0');
  fs.writeFileSync(path.join(app, 'tracked.txt'), 'one');
  git(app, 'add', '-A'); git(app, 'commit', '-m', 'Versão 1.0.0');
  git(app, 'push', '-u', 'origin', 'main');
  git(TMP, 'clone', origin, dev);
  writePkg(dev, '1.1.0');
  fs.writeFileSync(path.join(dev, 'novo.txt'), 'novo');
  git(dev, 'add', '-A'); git(dev, 'commit', '-m', 'Nova função de teste');
  git(dev, 'push', 'origin', 'main');

  const a = express();
  a.use(express.json());
  a.use(require('../backend/routes'));
  await new Promise(r => { server = a.listen(0, '127.0.0.1', r); });
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(async () => {
  server.closeAllConnections(); await new Promise(r => server.close(r));
  require('../backend/db').db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const send = (m, p, headers = {}) => fetch(base + p, { method: m, headers }).then(async r => ({ status: r.status, body: await r.json() }));

test('the running version and commit are reported', async () => {
  const v = (await send('GET', '/api/version')).body;
  assert.equal(v.version, '1.0.0');
  assert.match(v.commit, /^[0-9a-f]{7,}$/);
  assert.equal(v.branch, 'main');
});

test('migrations run once, in order, and snapshot the database before a real change', () => {
  const migrate = require('../backend/migrate');
  const { db } = require('../backend/db');
  assert.equal(migrate.currentVersion(), 1, 'the baseline is recorded when the server starts');
  const list = [
    ...migrate.MIGRATIONS,
    { id: 2, name: 'tabela de teste', up(d) { d.exec('CREATE TABLE mig_test (a TEXT)'); } },
    { id: 3, name: 'coluna de teste', up(d) { d.exec('ALTER TABLE mig_test ADD COLUMN b TEXT'); } }
  ];
  const first = migrate.run(list);
  assert.deepEqual(first.ran, ['tabela de teste', 'coluna de teste']);
  assert.equal(first.to, 3);
  assert.ok(first.snapshot && fs.existsSync(first.snapshot), 'a snapshot was taken first');
  assert.ok(db.prepare("SELECT name FROM pragma_table_info('mig_test')").all().some(c => c.name === 'b'));
  assert.deepEqual(migrate.run(list).ran, [], 'nothing runs twice');
  // a failing migration changes nothing and keeps the version
  const bad = [...list, { id: 4, name: 'quebra', up(d) { d.exec('CREATE TABLE ok_before (a TEXT)'); throw new Error('boom'); } }];
  assert.throws(() => migrate.run(bad), /boom/);
  assert.equal(migrate.currentVersion(), 3);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'ok_before'").get().n, 0);
});

test('updates are only reachable from this computer', async () => {
  const proxied = await send('GET', '/api/update/check', { 'X-Forwarded-For': '203.0.113.9' });
  assert.equal(proxied.status, 403);
  assert.equal((await send('POST', '/api/update/apply', { 'X-Forwarded-For': '203.0.113.9' })).status, 403);
});

test('check sees the newer commit and apply pulls it, with a snapshot first', async () => {
  const check = (await send('GET', '/api/update/check')).body;
  assert.equal(check.ok, true);
  assert.equal(check.behind, 1);
  assert.equal(check.latest, '1.1.0');
  assert.deepEqual(check.changes, ['Nova função de teste']);
  assert.equal(check.dirty, false);

  // local edits to tracked files stop the update
  fs.writeFileSync(path.join(app, 'tracked.txt'), 'mexi aqui');
  const dirty = await send('POST', '/api/update/apply');
  assert.equal(dirty.status, 409);
  assert.match(dirty.body.error, /alterações locais/);
  git(app, 'checkout', '--', 'tracked.txt');

  const done = (await send('POST', '/api/update/apply')).body;
  assert.equal(done.updated, true);
  assert.equal(done.restart, true);
  assert.match(done.snapshot, /before-update\.db$/);
  assert.ok(fs.existsSync(path.join(app, 'novo.txt')));
  assert.equal((await send('GET', '/api/version')).body.version, '1.1.0');

  const again = (await send('GET', '/api/update/check')).body;
  assert.equal(again.behind, 0);
  assert.equal((await send('POST', '/api/update/apply')).body.updated, false);
});
