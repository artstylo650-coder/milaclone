'use strict';

// Note translation between Brazilian Portuguese and English, used to keep a
// twin card next to a prompt: write in Portuguese and the English version
// appears beside it, or paste an English prompt and get the Portuguese one.
//
// No AI and no account: the language is guessed locally from common words and
// accents, and the text goes to the free MyMemory service
// (api.mymemory.translated.net) line by line, so line breaks and item order
// stay as they are. Prompt bits a translator tends to damage are put back
// afterwards: <lora:...> tags, weights such as (word:1.2) and the spacing
// after commas.
//
// Free use is about 5,000 characters a day per address; an e-mail typed in
// ⋯ → Tradução raises it to about 50,000 (MyMemory's own rule).
// TRANSLATE_API points at another MyMemory-compatible server (tests).

const { stmt } = require('./db');

const API = () => process.env.TRANSLATE_API || 'https://api.mymemory.translated.net';
const MAX_CHARS = 20000;
const CHUNK_BYTES = 450;             // MyMemory refuses queries over 500 bytes
const AUTO_MODES = ['prompts', 'all', 'off'];
const LANG = { pt: 'pt-BR', en: 'en-GB' };

const httpError = (message, status = 400) => Object.assign(new Error(message), { status });

// ---- settings ---------------------------------------------------------------

function readSaved() {
  try { return JSON.parse(stmt.getMeta.get('translate.settings')?.value || '{}'); } catch (_) { return {}; }
}

function publicSettings() {
  const saved = readSaved();
  return {
    auto: AUTO_MODES.includes(saved.auto) ? saved.auto : 'prompts',
    email: saved.email || ''
  };
}

function saveSettings(body = {}) {
  const saved = readSaved();
  if (AUTO_MODES.includes(body.auto)) saved.auto = body.auto;
  if (typeof body.email === 'string') {
    const email = body.email.trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError('E-mail inválido');
    if (email) saved.email = email; else delete saved.email;
  }
  stmt.setMeta.run('translate.settings', JSON.stringify(saved));
  return publicSettings();
}

// ---- language guess ---------------------------------------------------------

const PT_WORDS = new Set(('de da do das dos em no na nos nas com uma um umas uns para por que não é são ' +
  'ao à os as pelo pela sem sobre muito mais fundo luz mulher homem cabelo olhos rosto camisa ' +
  'vestido sorriso cidade noite dia céu foto retrato jovem azul vermelho verde preto branco suave').split(' '));
const EN_WORDS = new Set(('the of and with a an in on at for to from by is are this that without over very ' +
  'more background light woman man hair eyes face shirt dress smile city night day sky photo ' +
  'portrait young blue red green black white soft').split(' '));

// 'pt' or 'en' for a note's text.
function guessLanguage(text) {
  const words = text.toLowerCase().match(/[a-zà-ú]+/g) || [];
  let pt = (text.match(/[ãõçâêôáéíóú]/gi) || []).length * 0.5, en = 0;
  for (const w of words) {
    if (PT_WORDS.has(w)) pt++;
    if (EN_WORDS.has(w)) en++;
    if (/(ção|ções|mente|inha|inho)$/.test(w)) pt++;
    if (/(ing|tion|ly)$/.test(w)) en += 0.5;
  }
  return pt > en ? 'pt' : 'en';
}

// ---- MyMemory ---------------------------------------------------------------

async function request(q, from, to, email) {
  const url = new URL('/get', API());
  url.searchParams.set('q', q);
  url.searchParams.set('langpair', `${LANG[from]}|${LANG[to]}`);
  if (email) url.searchParams.set('de', email);
  let res, data;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    data = await res.json();
  } catch (_) {
    throw httpError('Sem conexão com o serviço de tradução. Tente de novo.', 502);
  }
  const status = Number(data.responseStatus) || res.status;
  if (data.quotaFinished || status === 429 || /QUOTA|LIMIT/i.test(String(data.responseDetails || ''))) {
    throw httpError('Limite diário do tradutor gratuito atingido. Tente amanhã ou informe um e-mail em ⋯ → Tradução.', 429);
  }
  if (status !== 200 || typeof data.responseData?.translatedText !== 'string') {
    throw httpError(`O serviço de tradução recusou o texto (${data.responseDetails || status}).`, 502);
  }
  return decodeEntities(data.responseData.translatedText);
}

function decodeEntities(s) {
  return s.replace(/&#39;|&quot;|&amp;|&lt;|&gt;/g, m => ({ '&#39;': "'", '&quot;': '"', '&amp;': '&', '&lt;': '<', '&gt;': '>' })[m]);
}

const bytes = s => Buffer.byteLength(s, 'utf8');

// Cut a line that is too long on its own at commas, then spaces.
function splitLong(line) {
  if (bytes(line) <= CHUNK_BYTES) return [line];
  const parts = [];
  let cur = '';
  for (const piece of line.split(/(?<=,\s?)|(?<=\s)/)) {
    if (cur && bytes(cur + piece) > CHUNK_BYTES) { parts.push(cur); cur = ''; }
    cur += piece;
  }
  if (cur) parts.push(cur);
  return parts;
}

// Translate a list of single lines, one request each (a batch joined by line
// breaks comes back with words moved across lines), a few at a time.
async function translateLines(lines, from, to, email) {
  const out = new Array(lines.length);
  let next = 0;
  const worker = async () => {
    while (next < lines.length) {
      const i = next++;
      out[i] = (await request(lines[i], from, to, email)).replace(/\n/g, ' ');
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, lines.length) }, worker));
  return out;
}

// ---- structure --------------------------------------------------------------

// Lines with no letters (blank, numbers, separators) or made only of tags are
// kept as they are, and so is a bare "Prompt" heading (the word is used as is
// in Portuguese; translators turn it into "imediato").
const needsTranslation = line => /[A-Za-zÀ-ú]/.test(line.replace(/<[^>]*>/g, '')) &&
  !/^\s*[#*_]*\s*prompts?\s*[:*_]*\s*$/i.test(line);

const LEAD = /^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|#+\s+|>\s+)?/;

// Put back what translators damage, using the original line as reference.
function repair(original, translated) {
  let out = translated.replace(/^\s+|\s+$/g, '');
  // <lora:...>-style tags, in order, exactly as written
  const tags = original.match(/<[^>]*>/g) || [];
  let t = 0;
  out = out.replace(/<[^>]*>/g, m => (t < tags.length ? tags[t++] : m));
  // weights: (word:1,2) -> (word:1.2)
  out = out.replace(/:\s*(\d+),(\d+)(?=\s*[)\]])/g, ':$1.$2');
  // "a, b" stays "a, b" and "a,b" stays "a,b"
  if (/,\s/.test(original) && !/,[^\s]/.test(original)) out = out.replace(/,(?=[^\s\d])/g, ', ');
  // leading indentation, list markers and checkboxes keep their exact form
  const lead = original.match(LEAD)[0];
  return lead ? lead + out.replace(LEAD, '') : out;
}

// Translate one note. Returns { sourceLanguage, targetLanguage, title, body }.
async function translate({ title = '', body = '' } = {}) {
  title = String(title || ''); body = String(body || '');
  if (!title.trim() && !body.trim()) throw httpError('Nada para traduzir');
  if (title.length + body.length > MAX_CHARS) throw httpError('Texto longo demais para traduzir de uma vez');
  const from = guessLanguage(title + '\n' + body);
  const to = from === 'pt' ? 'en' : 'pt';
  const { email } = publicSettings();

  // every line of title and body, long ones cut into pieces
  const all = [title, ...body.split('\n')];
  const pieces = [];   // { line, text }
  all.forEach((line, i) => {
    if (needsTranslation(line)) for (const text of splitLong(line)) pieces.push({ line: i, text });
  });
  const done = await translateLines(pieces.map(p => p.text), from, to, email);
  const rebuilt = all.map(line => (needsTranslation(line) ? '' : line));
  pieces.forEach((p, i) => { rebuilt[p.line] += (rebuilt[p.line] && !/\s$/.test(rebuilt[p.line]) ? ' ' : '') + done[i]; });
  const fixed = all.map((line, i) => (needsTranslation(line) ? repair(line, rebuilt[i]) : line));
  return { sourceLanguage: from, targetLanguage: to, title: fixed[0], body: fixed.slice(1).join('\n') };
}

module.exports = { translate, publicSettings, saveSettings, guessLanguage, repair };
