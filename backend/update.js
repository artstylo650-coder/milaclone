'use strict';

// Updating Milaclone from its git repository (the private GitHub copy):
// check() fetches and reports how many commits the checkout is behind and what
// they say; apply() takes a database snapshot, fast-forwards, reinstalls
// dependencies only when package.json/package-lock.json changed, and tells the
// caller to restart (the Windows wrapper restarts the server on exit code 75).
// Both are only reachable from this computer (see routes.js).

const util = require('util');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const run = util.promisify(execFile);
const { ROOT, info } = require('./version');

const RESTART_CODE = 75;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

const sh = (cmd, args, timeout = 60000) => run(cmd, args, { cwd: ROOT, windowsHide: true, timeout, maxBuffer: 10 * 1024 * 1024 });
const git = async (...args) => (await sh('git', args)).stdout.trim();

async function isRepo() {
  try { return (await git('rev-parse', '--is-inside-work-tree')) === 'true'; } catch (_) { return false; }
}

// version of package.json at a given revision, or null
async function versionAt(rev) {
  try { return JSON.parse(await git('show', rev + ':package.json')).version; } catch (_) { return null; }
}

async function check() {
  const current = info();
  if (!await isRepo()) return { ok: false, reason: 'repo', current, message: 'Esta instalação não é um repositório git, então não dá para atualizar por aqui.' };
  let upstream;
  try { upstream = await git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'); }
  catch (_) { return { ok: false, reason: 'upstream', current, message: 'O repositório não tem uma origem configurada para buscar atualizações.' }; }
  try { await sh('git', ['fetch', '--quiet'], 30000); }
  catch (err) { return { ok: false, reason: 'fetch', current, message: 'Não consegui falar com o GitHub (rede ou login). Confira a conexão e o acesso ao repositório.', detail: String(err.stderr || err.message).slice(0, 300) }; }
  const behind = Number(await git('rev-list', '--count', 'HEAD..' + upstream));
  const changes = behind ? (await git('log', '--format=%s', '-n', '20', 'HEAD..' + upstream)).split('\n').filter(Boolean) : [];
  const dirty = (await git('status', '--porcelain', '--untracked-files=no')).length > 0;
  return { ok: true, current, latest: behind ? await versionAt(upstream) : current.version, behind, changes, dirty };
}

function install() {
  if (process.env.UPDATE_SKIP_INSTALL) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const args = ['install', '--no-audit', '--no-fund'];
    const child = process.platform === 'win32'
      ? spawn('cmd.exe', ['/d', '/c', 'npm', ...args], { cwd: ROOT, windowsHide: true })
      : spawn('npm', args, { cwd: ROOT });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve() : reject(new Error('npm install falhou: ' + out.slice(-300)))));
  });
}

let applying = false;

async function apply() {
  if (applying) throw fail('Uma atualização já está em andamento.', 409);
  const state = await check();
  if (!state.ok) throw fail(state.message, 409);
  if (!state.behind) return { updated: false, message: 'Você já está na versão mais recente.', current: state.current };
  if (state.dirty) throw fail('Há alterações locais nos arquivos do programa. Salve ou descarte essas alterações (git) antes de atualizar.', 409);
  applying = true;
  try {
    // the boards are the only thing an update could hurt: snapshot first
    const backup = require('./backup');
    const snapshot = await backup.snapshot('before-update');
    const before = await git('rev-parse', 'HEAD');
    await git('pull', '--ff-only', '--quiet');
    const changed = (await git('diff', '--name-only', before, 'HEAD')).split('\n');
    const reinstalled = changed.includes('package-lock.json') || changed.includes('package.json');
    if (reinstalled) await install();
    return { updated: true, restart: true, from: before.slice(0, 7), to: await git('rev-parse', '--short', 'HEAD'),
      reinstalled, snapshot: path.basename(snapshot), changes: state.changes, current: info() };
  } finally { applying = false; }
}

module.exports = { check, apply, RESTART_CODE };
