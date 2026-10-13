'use strict';

import { state, dom, elMap } from '../core/state.js';
import { applyCam } from './viewport.js';

// Overview of the whole board in the bottom-right corner: every card as a
// small block plus the visible area as a frame. Click or drag on it to move
// the view. Hidden on phones and when turned off from the More menu.

const W = 200, H = 130, PAD = 10;
let canvas = null, frame = 0, map = null;

export function minimapEnabled() {
  try { return localStorage.getItem('minimap') !== '0'; } catch (_) { return true; }
}

export function toggleMinimap() {
  const next = !minimapEnabled();
  try { localStorage.setItem('minimap', next ? '1' : '0'); } catch (_) {}
  canvas.hidden = !next;
  if (next) requestMinimap();
}

// block colors follow the current theme's CSS variables
const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const typeColor = type => ({ image: cssVar('--ink-faint'), board: cssVar('--ink-soft'), group: 'rgba(124,77,255,.22)', comfy: '#7c4dff' })[type] || cssVar('--line-strong');

function paint() {
  frame = 0;
  if (!canvas || canvas.hidden || !state.view.canvas) return;
  const items = state.view.items.filter(it => !it.parentItemId && it.type !== 'line');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== W * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const stage = dom.stage.getBoundingClientRect();
  const view = { x: -state.cam.x / state.cam.scale, y: -state.cam.y / state.cam.scale,
    w: stage.width / state.cam.scale, h: stage.height / state.cam.scale };
  const sizeOf = it => { const el = elMap.get(it.id); return { w: el ? el.offsetWidth : (it.w || 240), h: el ? el.offsetHeight : (it.h || 120) }; };
  let minX = view.x, minY = view.y, maxX = view.x + view.w, maxY = view.y + view.h;
  for (const it of items) {
    const s = sizeOf(it);
    minX = Math.min(minX, it.x); minY = Math.min(minY, it.y);
    maxX = Math.max(maxX, it.x + s.w); maxY = Math.max(maxY, it.y + s.h);
  }
  const scale = Math.min((W - PAD * 2) / (maxX - minX || 1), (H - PAD * 2) / (maxY - minY || 1));
  const ox = PAD + ((W - PAD * 2) - (maxX - minX) * scale) / 2 - minX * scale;
  const oy = PAD + ((H - PAD * 2) - (maxY - minY) * scale) / 2 - minY * scale;
  map = { scale, ox, oy };
  const accent = cssVar('--accent');
  for (const it of items) {
    const s = sizeOf(it);
    ctx.fillStyle = state.selectedIds.has(it.id) ? accent : typeColor(it.type);
    ctx.fillRect(ox + it.x * scale, oy + it.y * scale, Math.max(2, s.w * scale), Math.max(2, s.h * scale));
  }
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = 0.1; ctx.fillStyle = accent;
  ctx.fillRect(ox + view.x * scale, oy + view.y * scale, view.w * scale, view.h * scale);
  ctx.globalAlpha = 1;
  ctx.strokeRect(ox + view.x * scale, oy + view.y * scale, view.w * scale, view.h * scale);
}

export function requestMinimap() {
  if (!frame) frame = requestAnimationFrame(paint);
}

function moveTo(e) {
  if (!map) return;
  const r = canvas.getBoundingClientRect();
  const wx = (e.clientX - r.left - map.ox) / map.scale;
  const wy = (e.clientY - r.top - map.oy) / map.scale;
  const stage = dom.stage.getBoundingClientRect();
  state.cam.x = stage.width / 2 - wx * state.cam.scale;
  state.cam.y = stage.height / 2 - wy * state.cam.scale;
  applyCam();
}

export function initMinimap() {
  canvas = document.getElementById('minimap');
  if (!canvas) return;
  canvas.hidden = !minimapEnabled();
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation();
    canvas.setPointerCapture(e.pointerId);
    moveTo(e);
    const move = ev => moveTo(ev);
    const up = () => { canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerup', up); };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
  });
  window.addEventListener('resize', requestMinimap);
}
