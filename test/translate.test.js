'use strict';

// Note translation against a fake MyMemory server: language guess, both
// directions, structure kept line by line (tags, weights, comma spacing, list
// markers), settings, and the daily-limit message.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'translate-test-'));
process.env.DATA_DIR = TMP;
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');

const express = require('express');
const { fakeTranslator, received } = require('./fake-translator');

let base, servers = [];
const listen = app => new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); servers.push(s); });

test.before(async () => {
  const fake = await listen(fakeTranslator());
  process.env.TRANSLATE_API = 'http://127.0.0.1:' + fake.address().port;
  const app = express();
  app.use(express.json());
  app.use(require('../backend/routes'));
  const s = await listen(app);
  base = 'http://127.0.0.1:' + s.address().port;
});
test.after(async () => {
  for (const s of servers) { s.closeAllConnections(); await new Promise(r => s.close(r)); }
  require('../backend/db').db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const send = (m, p, b) => fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b && JSON.stringify(b) })
  .then(async r => ({ status: r.status, body: await r.json() }));

test('language guess', () => {
  const { guessLanguage } = require('../backend/translate');
  assert.equal(guessLanguage('retrato de uma mulher com camisa azul'), 'pt');
  assert.equal(guessLanguage('portrait of a woman with a blue shirt'), 'en');
  assert.equal(guessLanguage('iluminação cinematográfica'), 'pt');
});

test('Portuguese becomes English keeping lines, weights and tags', async () => {
  const { status, body } = await send('POST', '/api/translate', {
    title: 'Prompt', body: 'retrato de mulher, fundo vermelho, (luz:1.2), <lora:x_v2:0.8>\n\n- [ ] camisa azul'
  });
  assert.equal(status, 200);
  assert.equal(body.sourceLanguage, 'pt');
  assert.equal(body.targetLanguage, 'en');
  assert.equal(body.title, 'Prompt');
  assert.equal(body.body, 'portrait of woman, background red, (light:1.2), <lora:x_v2:0.8>\n\n- [ ] shirt blue');
  assert.ok(received.every(r => r.pair === 'pt-BR|en-GB'));
});

test('English becomes Portuguese, one request per line', async () => {
  const before = received.length;
  const { body } = await send('POST', '/api/translate', { title: '', body: 'portrait of woman\nblue shirt' });
  assert.equal(body.targetLanguage, 'pt');
  assert.equal(body.body, 'retrato de mulher\nazul camisa');
  assert.deepEqual(received.slice(before).map(r => r.q).sort(), ['blue shirt', 'portrait of woman']);
});

test('settings keep the mode and an optional e-mail sent along', async () => {
  assert.equal((await send('PUT', '/api/translate/settings', { email: 'not-an-email' })).status, 400);
  const saved = (await send('PUT', '/api/translate/settings', { auto: 'all', email: 'me@example.com' })).body;
  assert.deepEqual(saved, { auto: 'all', email: 'me@example.com' });
  const before = received.length;
  await send('POST', '/api/translate', { body: 'retrato' });
  assert.equal(received[before].email, 'me@example.com');
  await send('PUT', '/api/translate/settings', { email: '' });
});

test('empty notes and the daily limit give clear messages', async () => {
  assert.equal((await send('POST', '/api/translate', { title: ' ', body: '' })).status, 400);
  const quota = await send('POST', '/api/translate', { body: 'quota' });
  assert.equal(quota.status, 429);
  assert.match(quota.body.error, /Limite diário/);
});
