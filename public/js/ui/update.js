'use strict';

// "Sobre o Milaclone": the running version and updating from the git
// repository. The server only answers update requests from this computer. An
// update takes a database snapshot first, pulls, and restarts the server; this
// panel waits for it to come back and reloads the page.

import { toast } from '../core/util.js';
import { openPanel, closePanel, confirmDialog } from './panel.js';

const get = async (url) => { const r = await fetch(url); return { status: r.status, ...(await r.json().catch(() => ({}))) }; };
const post = async (url) => { const r = await fetch(url, { method: 'POST' }); return { status: r.status, ...(await r.json().catch(() => ({}))) }; };

const label = (v) => (v ? `v${v.version}${v.commit ? ' · ' + v.commit : ''}` : '');

export async function openAbout() {
  const wrap = document.createElement('div');
  wrap.className = 'about';
  const current = await get('/api/version').catch(() => null);
  const heading = document.createElement('p');
  heading.className = 'about-version';
  heading.textContent = 'Milaclone ' + label(current);
  const sub = document.createElement('p');
  sub.className = 'panel-text muted small';
  sub.textContent = current && current.date ? `Versão de ${current.date}` : '';
  const result = document.createElement('div');
  result.className = 'about-result';
  result.setAttribute('role', 'status');
  const buttons = document.createElement('div');
  buttons.className = 'about-actions';
  wrap.append(heading, sub, result, buttons);

  const showCheck = async () => {
    buttons.replaceChildren();
    result.textContent = 'Procurando atualizações…';
    const c = await get('/api/update/check');
    result.replaceChildren();
    if (c.error || c.ok === false) {
      result.textContent = c.error || c.message;
    } else if (!c.behind) {
      result.textContent = 'Você está na versão mais recente.';
    } else {
      const title = document.createElement('p');
      title.className = 'panel-text';
      title.textContent = `Há ${c.behind} atualização${c.behind > 1 ? 'ões' : ''}${c.latest && c.latest !== c.current.version ? ` (versão ${c.latest})` : ''}:`;
      const list = document.createElement('ul');
      list.className = 'about-changes';
      for (const line of c.changes) { const li = document.createElement('li'); li.textContent = line; list.appendChild(li); }
      result.append(title, list);
      if (c.dirty) {
        const warn = document.createElement('p');
        warn.className = 'panel-text muted small';
        warn.textContent = 'Há alterações locais nos arquivos do programa; salve ou descarte antes de atualizar.';
        result.appendChild(warn);
      } else {
        const go = document.createElement('button');
        go.type = 'button'; go.className = 'panel-btn primary'; go.textContent = 'Atualizar agora';
        go.onclick = () => applyUpdate(c);
        buttons.appendChild(go);
      }
    }
    const again = document.createElement('button');
    again.type = 'button'; again.className = 'panel-btn'; again.textContent = 'Verificar de novo';
    again.onclick = showCheck;
    buttons.appendChild(again);
  };

  openPanel({ title: 'Sobre o Milaclone', body: wrap, actions: [{ label: 'Fechar', fn: closePanel }] });
  showCheck();
}

async function applyUpdate(c) {
  if (!await confirmDialog(`Atualizar para ${c.latest ? 'a versão ' + c.latest : 'a versão nova'}? Um backup dos boards é feito antes e o Milaclone reinicia em alguns segundos.`, { confirm: 'Atualizar' })) { openAbout(); return; }
  toast('Atualizando…');
  const r = await post('/api/update/apply');
  if (r.error) { toast(r.error); openAbout(); return; }
  if (!r.updated) { toast(r.message || 'Nada para atualizar'); return; }
  toast('Atualizado. Reiniciando…');
  // wait for the server to go down and come back, then load the new version
  const before = Date.now();
  const tick = async () => {
    const v = await fetch('/api/version', { cache: 'no-store' }).then(x => x.json()).catch(() => null);
    if (v && Date.now() - before > 1500) { location.reload(); return; }
    if (Date.now() - before > 90000) { toast('O Milaclone não voltou sozinho. Abra-o de novo.'); return; }
    setTimeout(tick, 1000);
  };
  setTimeout(tick, 1500);
}

// once a day, quietly: a toast when the repository has something new
export async function checkInBackground() {
  if (navigator.webdriver) return;   // automated browsers (tests) never go to the network
  try {
    const last = Number(localStorage.getItem('updateCheckedAt') || 0);
    if (Date.now() - last < 12 * 3600 * 1000) return;
    localStorage.setItem('updateCheckedAt', String(Date.now()));
    const c = await get('/api/update/check');
    if (c.ok && c.behind) toast(`Há uma atualização do Milaclone (⋯ → Sobre o Milaclone)`);
  } catch (_) { /* offline or not this computer: say nothing */ }
}
