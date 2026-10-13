'use strict';

import { state } from '../core/state.js';
import { lucideEl, refreshIcons } from '../core/util.js';

// Full-screen viewer for the original photo behind an image card. Wheel or
// pinch zooms at the pointer, drag pans, double-click toggles fit / 100%,
// arrow keys walk through the board's images in reading order. While open it
// owns the keyboard (main.js checks isLightboxOpen()).

let box = null;
let list = [];
let index = 0;
let view = { scale: 1, x: 0, y: 0 };
let natural = { w: 1, h: 1 };

export function isLightboxOpen() { return !!box; }

function boardImages() {
  return state.view.items
    .filter(it => it.type === 'image' && it.data && it.data.src)
    .sort((a, b) => (Math.round(a.y / 120) - Math.round(b.y / 120)) || (a.x - b.x));
}

function apply() {
  const img = box.querySelector('.lb-img');
  img.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  box.querySelector('.lb-zoom').textContent = Math.round(view.scale * 100) + '%';
}

function fit() {
  if (!box) return;   // a photo can finish loading after the viewer closed
  const stage = box.querySelector('.lb-stage').getBoundingClientRect();
  const scale = Math.min(1, (stage.width - 48) / natural.w, (stage.height - 48) / natural.h);
  view = { scale, x: (stage.width - natural.w * scale) / 2, y: (stage.height - natural.h * scale) / 2 };
  apply();
}

function zoomAt(factor, cx, cy) {
  const stage = box.querySelector('.lb-stage').getBoundingClientRect();
  const px = cx - stage.left, py = cy - stage.top;
  const scale = Math.max(0.05, Math.min(8, view.scale * factor));
  view.x = px - (px - view.x) * (scale / view.scale);
  view.y = py - (py - view.y) * (scale / view.scale);
  view.scale = scale;
  apply();
}

function show(i) {
  index = (i + list.length) % list.length;
  const it = list[index];
  const img = box.querySelector('.lb-img');
  box.querySelector('.lb-name').textContent = it.data.name || 'Imagem';
  box.querySelector('.lb-count').textContent = list.length > 1 ? `${index + 1} / ${list.length}` : '';
  box.querySelector('.lb-open').href = it.data.src;
  const dl = box.querySelector('.lb-download');
  dl.href = it.data.src; dl.download = it.data.name || '';
  natural = { w: it.data.naturalW || 1200, h: it.data.naturalH || 900 };
  img.onload = () => { if (img !== box?.querySelector('.lb-img')) return; natural = { w: img.naturalWidth, h: img.naturalHeight }; fit(); };
  img.src = it.data.src;
  fit();
}

function button(cls, icon, label, onClick) {
  const b = document.createElement(onClick ? 'button' : 'a');
  if (onClick) { b.type = 'button'; b.onclick = onClick; }
  b.className = 'lb-btn ' + cls;
  b.title = label; b.setAttribute('aria-label', label);
  b.appendChild(lucideEl(icon));
  return b;
}

export function closeLightbox() {
  if (!box) return;
  box.remove();
  box = null;
}

export function openLightbox(itemId) {
  list = boardImages();
  const start = list.findIndex(it => it.id === itemId);
  if (start < 0) return;
  closeLightbox();
  box = document.createElement('div');
  box.className = 'lightbox';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Visualizador de imagem');
  const bar = document.createElement('div');
  bar.className = 'lb-bar';
  const name = document.createElement('span'); name.className = 'lb-name';
  const count = document.createElement('span'); count.className = 'lb-count';
  const zoom = document.createElement('span'); zoom.className = 'lb-zoom';
  const open = button('lb-open', 'external-link', 'Abrir original em nova aba');
  open.target = '_blank'; open.rel = 'noopener';
  const download = button('lb-download', 'download', 'Baixar original');
  bar.append(name, count, zoom,
    button('', 'zoom-out', 'Diminuir zoom', () => { const r = stageRect(); zoomAt(1 / 1.25, r.x, r.y); }),
    button('', 'zoom-in', 'Aumentar zoom', () => { const r = stageRect(); zoomAt(1.25, r.x, r.y); }),
    button('', 'maximize', 'Ajustar à tela', fit),
    open, download,
    button('lb-close', 'x', 'Fechar (Esc)', closeLightbox));
  const stage = document.createElement('div');
  stage.className = 'lb-stage';
  const img = document.createElement('img');
  img.className = 'lb-img'; img.alt = ''; img.draggable = false;
  stage.appendChild(img);
  const prev = button('lb-prev', 'chevron-left', 'Anterior (←)', () => show(index - 1));
  const next = button('lb-next', 'chevron-right', 'Próxima (→)', () => show(index + 1));
  if (list.length < 2) { prev.hidden = true; next.hidden = true; }
  box.append(bar, stage, prev, next);
  document.body.appendChild(box);
  refreshIcons(box);

  stage.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(Math.exp(-e.deltaY * 0.002), e.clientX, e.clientY); }, { passive: false });
  stage.addEventListener('dblclick', (e) => {
    if (Math.abs(view.scale - 1) < 0.01) fit(); else zoomAt(1 / view.scale, e.clientX, e.clientY);
  });
  const pointers = new Map();
  let pinch = null;
  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) };
    }
  });
  stage.addEventListener('pointermove', (e) => {
    const last = pointers.get(e.pointerId);
    if (!last) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      zoomAt(dist / pinch.dist, (a.x + b.x) / 2, (a.y + b.y) / 2);
      pinch.dist = dist;
      return;
    }
    view.x += e.clientX - last.x; view.y += e.clientY - last.y;
    apply();
  });
  const drop = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; };
  stage.addEventListener('pointerup', drop);
  stage.addEventListener('pointercancel', drop);
  show(start);
}

function stageRect() {
  const r = box.querySelector('.lb-stage').getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

document.addEventListener('keydown', (e) => {
  if (!box) return;
  if (e.key === 'Escape') closeLightbox();
  else if (e.key === 'ArrowLeft') show(index - 1);
  else if (e.key === 'ArrowRight') show(index + 1);
  else if (e.key === '+' || e.key === '=') { const r = stageRect(); zoomAt(1.25, r.x, r.y); }
  else if (e.key === '-') { const r = stageRect(); zoomAt(1 / 1.25, r.x, r.y); }
  else if (e.key === '0') fit();
  else return;
  e.preventDefault(); e.stopImmediatePropagation();
}, true);
window.addEventListener('resize', () => { if (box) fit(); });
