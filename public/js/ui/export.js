'use strict';

import { state, dom, elMap } from '../core/state.js';
import { isCard, toast } from '../core/util.js';
import { selectMany } from '../board/editing.js';

// Export the board, or just the selection, as a PNG image or a PDF page —
// e.g. select a group of references and send it to a client for approval.
// The browser renders the cards itself (html-to-image), so the file looks
// like the screen. Libraries are served locally from /vendor.

const PAD = 40;
const MAX_SIDE = 12000;   // stay inside browser canvas limits

const loaded = new Map();
function loadScript(src) {
  if (!loaded.has(src)) {
    loaded.set(src, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.onload = resolve;
      s.onerror = () => { loaded.delete(src); reject(new Error('não foi possível carregar ' + src)); };
      document.head.appendChild(s);
    }));
  }
  return loaded.get(src);
}

function fileName(ext) {
  const title = (state.view.canvas && state.view.canvas.title) || 'board';
  return title.replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 80) + '.' + ext;
}

// Items to include: the selection (plus everything inside selected frames and
// lines between included cards), or the whole board.
function chosenItems() {
  const top = state.view.items.filter(it => !it.parentItemId && it.type !== 'line');
  const picked = top.filter(it => state.selectedIds.has(it.id));
  return picked.length ? picked : top;
}

function bounds(items) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const it of items) {
    const el = elMap.get(it.id);
    const w = el ? el.offsetWidth : (it.w || 240), h = el ? el.offsetHeight : (it.h || 120);
    minX = Math.min(minX, it.x); minY = Math.min(minY, it.y);
    maxX = Math.max(maxX, it.x + w); maxY = Math.max(maxY, it.y + h);
  }
  return { x: minX - PAD, y: minY - PAD, w: maxX - minX + PAD * 2, h: maxY - minY + PAD * 2 };
}

// The exported image is rendered inside an SVG, which cannot reach the page's
// web fonts. Embed only the basic-Latin files of the current font pair (a few
// hundred KB) instead of every font the page declares.
const fontCache = new Map();
async function usedFontCSS() {
  const root = getComputedStyle(document.documentElement);
  const families = ['--serif', '--sans'].map(v => root.getPropertyValue(v).split(',')[0].trim().replace(/["']/g, ''));
  const rules = [];
  for (const sheet of document.styleSheets) {
    let list;
    try { list = sheet.cssRules; } catch (_) { continue; }
    for (const rule of list) {
      if (!(rule instanceof CSSFontFaceRule)) continue;
      const family = rule.style.getPropertyValue('font-family').replace(/["']/g, '').trim();
      if (!families.includes(family) || !/U\+0+-0*FF\b/i.test(rule.style.getPropertyValue('unicode-range'))) continue;
      const src = rule.style.getPropertyValue('src');
      const url = (src.match(/url\(["']?([^"')]+)["']?\)/) || [])[1];
      if (!url) continue;
      const abs = new URL(url, sheet.href).href;
      if (!fontCache.has(abs)) {
        fontCache.set(abs, fetch(abs).then(r => r.blob()).then(blob => new Promise(resolve => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.readAsDataURL(blob);
        })));
      }
      const data = await fontCache.get(abs);
      rules.push(`@font-face { font-family: "${family}"; font-style: ${rule.style.getPropertyValue('font-style') || 'normal'}; ` +
        `font-weight: ${rule.style.getPropertyValue('font-weight') || '400'}; src: url(${data}) format("woff2"); }`);
    }
  }
  return rules.join('\n');
}

const CHROME = ['card-tools', 'link-handle', 'resize', 'fmt-bar', 'connections-preview'];

async function capture(type) {
  const items = chosenItems();
  if (!items.length) { toast('Nada para exportar'); return null; }
  await loadScript('/vendor/html-to-image.js');
  const keep = new Set(items.map(it => it.id));
  for (const it of state.view.items) {
    if (it.parentItemId && keep.has(it.parentItemId)) keep.add(it.id);
    if (it.type === 'line' && keep.has(it.data.from) && keep.has(it.data.to)) keep.add(it.id);
  }
  const box = bounds(items);
  const pixelRatio = Math.max(0.25, Math.min(2, MAX_SIDE / Math.max(box.w, box.h)));
  const previous = { selected: [...state.selectedIds], primary: state.selectedId };
  selectMany([], { expandGroups: false });   // no selection outlines in the file
  document.body.classList.add('exporting');
  const wanted = node => {
    if (!(node instanceof Element)) return true;
    if (CHROME.some(c => node.classList.contains(c))) return false;
    if (node.classList.contains('item') && !node.classList.contains('in-column')) return keep.has(node.dataset.id);
    if (node.dataset && node.dataset.lineId) return keep.has(node.dataset.lineId);
    return true;
  };
  try {
    const options = {
      width: box.w, height: box.h, pixelRatio, filter: wanted, cacheBust: false,
      fontEmbedCSS: await usedFontCSS(),
      backgroundColor: getComputedStyle(document.body).getPropertyValue('--canvas-bg').trim() || '#efeff1',
      style: { transform: `translate(${-box.x}px, ${-box.y}px)`, width: box.w + 'px', height: box.h + 'px' }
    };
    const url = type === 'jpeg' ? await window.htmlToImage.toJpeg(dom.world, { ...options, quality: 0.92 })
      : await window.htmlToImage.toPng(dom.world, options);
    return { url, box, pixelRatio };
  } finally {
    document.body.classList.remove('exporting');
    selectMany(previous.selected, { primary: previous.primary, expandGroups: false });
  }
}

function download(url, name) {
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
}

export async function exportPng() {
  toast('Gerando imagem…');
  try {
    const shot = await capture('png');
    if (!shot) return;
    download(shot.url, fileName('png'));
    toast('Imagem exportada');
  } catch (err) {
    toast('Falha ao exportar: ' + err.message);
  }
}

export async function exportPdf() {
  toast('Gerando PDF…');
  try {
    const [shot] = await Promise.all([capture('jpeg'), loadScript('/vendor/jspdf.umd.min.js')]);
    if (!shot) return;
    const { jsPDF } = window.jspdf;
    const landscape = shot.box.w >= shot.box.h;
    const pdf = new jsPDF({ orientation: landscape ? 'landscape' : 'portrait', unit: 'px', format: [shot.box.w, shot.box.h], hotfixes: ['px_scaling'] });
    pdf.setProperties({ title: (state.view.canvas && state.view.canvas.title) || 'Board', creator: 'Milaclone' });
    pdf.addImage(shot.url, 'JPEG', 0, 0, shot.box.w, shot.box.h);
    pdf.save(fileName('pdf'));
    toast('PDF exportado');
  } catch (err) {
    toast('Falha ao exportar: ' + err.message);
  }
}

export function exportLabel(kind) {
  const n = state.view.items.filter(it => state.selectedIds.has(it.id) && isCard(it) && !it.parentItemId).length;
  return `Exportar ${n ? 'seleção' : 'board'} como ${kind}`;
}
